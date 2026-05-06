//! Phase 6 — background scheduler that picks Ready
//! [`Requirement`](harness_core::Requirement)s with an assignee,
//! mints a fresh-session [`RequirementRun`](harness_core::RequirementRun),
//! drives the agent loop, persists the result, and (when the
//! requirement carries a [`VerificationPlan`](harness_core::VerificationPlan))
//! auto-runs verification against it.
//!
//! Goals + non-goals match the work-orchestration proposal's "v1
//! 受限 auto" cut:
//!
//! - **Off by default.** `JARVIS_WORK_MODE=auto` opts in.
//! - **One unit per tick** (configurable). Nothing parallel here:
//!   each pickup spawns its own task so the tick stays short, but
//!   the next tick won't double-pick a requirement that already
//!   has a Pending/Running run from this loop.
//! - **Retry cap.** A requirement that has hit `max_retries`
//!   failed runs is skipped; an operator can clear them via the
//!   doctor endpoints (Phase 5b/5c).
//! - **No approval bypass.** The agent template the loop builds
//!   on top of carries whatever `Approver` the binary was
//!   started with. If the approver blocks, the run terminates
//!   like a manual one would.
//! - **Best-effort verification.** When the requirement has a
//!   verification plan, we run it after the agent loop and
//!   reuse the existing `apply_verification`-style fan-out (so
//!   the same WS frames + Activity rows fire as for manual
//!   `/verify`). The plan failing doesn't crash the loop.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness_core::{
    ActivityActor, ActivityKind, AgentProfile, CommandResult, Conversation, ConversationMetadata,
    Message, Project, Requirement, RequirementRun, RequirementRunEvent, RequirementRunLogLevel,
    RequirementRunStatus, RequirementStatus, RequirementTodo, RequirementTodoCreator,
    RequirementTodoEvidence, RequirementTodoKind, RequirementTodoStatus, TriageState,
    VerificationPlan, VerificationResult, VerificationStatus,
};
use harness_requirement::{build_default_manifest, render_manifest_summary};
use serde::Deserialize;
use serde_json::json;
use tracing::{info, warn};

use crate::state::AppState;
use crate::verification;
use crate::worktree::{self, WorktreeMode, WorktreeOutcome};

/// Top-level switch for the auto loop. Wire form is
/// `off | auto`. Default `Off`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AutoMode {
    #[default]
    Off,
    Auto,
}

impl AutoMode {
    /// Parse the env-var wire form. Unknown / blank → `None` so
    /// the binary's startup can `tracing::warn!` rather than fail.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "" | "off" => Self::Off,
            "auto" => Self::Auto,
            _ => return None,
        })
    }
}

/// Knobs sourced from `JARVIS_WORK_*` env vars.
///
/// `tick_seconds` and `max_units_per_tick` together cap the
/// scheduler's appetite. `max_retries` is the ceiling on failed
/// runs per requirement before the loop stops re-picking it (so
/// a broken LLM endpoint can't burn money in a loop).
/// `run_timeout_ms` caps the agent loop's wall-clock budget per
/// pickup — same envelope the manual WS runs would have if you
/// stuck a `tokio::time::timeout` on them.
#[derive(Debug, Clone)]
pub struct AutoModeConfig {
    pub mode: AutoMode,
    pub tick_seconds: u64,
    pub max_units_per_tick: usize,
    pub max_retries: usize,
    pub run_timeout_ms: u64,
    /// Let the scheduler run approved requirements even when the
    /// card has no explicit assignee. The run then uses
    /// `default_assignee` when it resolves, otherwise the server's
    /// default provider/model. On by default so unassigned approved
    /// work falls back to Jarvis instead of waiting for a manual
    /// assignment; `WORKFLOW.md` / env can still opt out.
    pub allow_unassigned: bool,
    /// AgentProfile id or exact display name to use when a
    /// requirement is unassigned. If it cannot be resolved and
    /// `allow_unassigned` is true, the run still proceeds with the
    /// server default route.
    pub default_assignee: Option<String>,
    /// Optional workflow prompt template loaded from `WORKFLOW.md`.
    /// When present it replaces the generic seed prompt. A tiny
    /// token replacement pass supports both Jarvis and Symphony-ish
    /// names, e.g. `{{ requirement.title }}` / `{{ issue.title }}`.
    pub workflow_prompt: Option<String>,
}

impl Default for AutoModeConfig {
    fn default() -> Self {
        Self {
            mode: AutoMode::Off,
            tick_seconds: 30,
            max_units_per_tick: 1,
            max_retries: 1,
            run_timeout_ms: 5 * 60 * 1000,
            allow_unassigned: true,
            default_assignee: None,
            workflow_prompt: None,
        }
    }
}

/// Parsed subset of a Symphony-style `WORKFLOW.md`.
///
/// Jarvis intentionally treats this as a small policy overlay rather
/// than a new source of truth. Front matter supplies scheduler knobs;
/// the Markdown body becomes the unattended run prompt template.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoWorkflow {
    pub mode: Option<AutoMode>,
    pub tick_seconds: Option<u64>,
    pub max_units_per_tick: Option<usize>,
    pub max_retries: Option<usize>,
    pub run_timeout_ms: Option<u64>,
    pub allow_unassigned: Option<bool>,
    pub default_assignee: Option<String>,
    pub prompt_template: Option<String>,
}

impl AutoWorkflow {
    /// Load a workflow file if it exists. Missing file is `Ok(None)`
    /// so the binary can probe `<workspace>/WORKFLOW.md` by default
    /// without making the file mandatory.
    pub fn load(path: &Path) -> Result<Option<Self>, String> {
        match std::fs::read_to_string(path) {
            Ok(raw) => Self::from_markdown(&raw).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read {}: {e}", path.display())),
        }
    }

    pub fn from_markdown(raw: &str) -> Result<Self, String> {
        let (front_matter, body) = split_front_matter(raw)?;
        let mut out = match front_matter {
            Some(yaml) if !yaml.trim().is_empty() => {
                let parsed: WorkflowFrontMatter =
                    serde_yaml::from_str(yaml).map_err(|e| format!("parse workflow yaml: {e}"))?;
                parsed.into_workflow()
            }
            _ => Self::default(),
        };
        let prompt = body.trim();
        if !prompt.is_empty() {
            out.prompt_template = Some(prompt.to_string());
        }
        Ok(out)
    }

    pub fn apply_to(self, cfg: &mut AutoModeConfig) {
        if let Some(v) = self.mode {
            cfg.mode = v;
        }
        if let Some(v) = self.tick_seconds {
            cfg.tick_seconds = v.max(1);
        }
        if let Some(v) = self.max_units_per_tick {
            cfg.max_units_per_tick = v.max(1);
        }
        if let Some(v) = self.max_retries {
            cfg.max_retries = v;
        }
        if let Some(v) = self.run_timeout_ms {
            cfg.run_timeout_ms = v.max(1);
        }
        if let Some(v) = self.allow_unassigned {
            cfg.allow_unassigned = v;
        }
        if let Some(v) = self.default_assignee.filter(|s| !s.trim().is_empty()) {
            cfg.default_assignee = Some(v.trim().to_string());
        }
        if let Some(v) = self.prompt_template.filter(|s| !s.trim().is_empty()) {
            cfg.workflow_prompt = Some(v);
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct WorkflowFrontMatter {
    #[serde(default)]
    automation: Option<AutomationYaml>,
    #[serde(default)]
    polling: Option<PollingYaml>,
    #[serde(default)]
    agent: Option<AgentYaml>,
}

#[derive(Debug, Default, Deserialize)]
struct AutomationYaml {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    tick_seconds: Option<u64>,
    #[serde(default)]
    max_units_per_tick: Option<usize>,
    #[serde(default)]
    max_retries: Option<usize>,
    #[serde(default)]
    run_timeout_ms: Option<u64>,
    #[serde(default)]
    allow_unassigned: Option<bool>,
    #[serde(default, alias = "default_profile")]
    default_assignee: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PollingYaml {
    #[serde(default)]
    interval_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct AgentYaml {
    #[serde(default)]
    max_concurrent_agents: Option<usize>,
    #[serde(default)]
    max_retries: Option<usize>,
    #[serde(default)]
    run_timeout_ms: Option<u64>,
    #[serde(default)]
    allow_unassigned: Option<bool>,
    #[serde(default, alias = "default_assignee")]
    default_profile: Option<String>,
}

impl WorkflowFrontMatter {
    fn into_workflow(self) -> AutoWorkflow {
        let mut out = AutoWorkflow::default();
        if let Some(a) = self.automation {
            out.mode = a.mode.as_deref().and_then(AutoMode::from_wire);
            out.tick_seconds = a.tick_seconds;
            out.max_units_per_tick = a.max_units_per_tick;
            out.max_retries = a.max_retries;
            out.run_timeout_ms = a.run_timeout_ms;
            out.allow_unassigned = a.allow_unassigned;
            out.default_assignee = a.default_assignee;
        }
        if let Some(p) = self.polling.and_then(|p| p.interval_ms) {
            out.tick_seconds = Some(p.saturating_add(999) / 1000);
        }
        if let Some(a) = self.agent {
            if let Some(v) = a.max_concurrent_agents {
                out.max_units_per_tick = Some(v);
            }
            if let Some(v) = a.max_retries {
                out.max_retries = Some(v);
            }
            if let Some(v) = a.run_timeout_ms {
                out.run_timeout_ms = Some(v);
            }
            if let Some(v) = a.allow_unassigned {
                out.allow_unassigned = Some(v);
            }
            if let Some(v) = a.default_profile {
                out.default_assignee = Some(v);
            }
        }
        out
    }
}

fn split_front_matter(raw: &str) -> Result<(Option<&str>, &str), String> {
    let Some(rest) = raw.strip_prefix("---") else {
        return Ok((None, raw));
    };
    let rest = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
        .unwrap_or(rest);
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed == "---" {
            let yaml = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Ok((Some(yaml), body));
        }
        offset += line.len();
    }
    Err("workflow front matter is missing closing `---`".to_string())
}

/// Runtime on/off switch. v1.0 — flipped via
/// `POST /v1/auto-mode {enabled}`. Initial value matches the
/// startup `AutoModeConfig.mode`. The background loop polls the
/// flag every tick (so toggle latency is at most one
/// `tick_seconds`).
#[derive(Debug, Clone, Default)]
pub struct AutoModeRuntime {
    enabled: Arc<AtomicBool>,
    active_requirements: Arc<Mutex<HashSet<String>>>,
}

#[derive(Debug)]
pub(crate) struct RequirementRunClaim {
    requirement_id: String,
    active_requirements: Arc<Mutex<HashSet<String>>>,
}

impl Drop for RequirementRunClaim {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_requirements.lock() {
            active.remove(&self.requirement_id);
        }
    }
}

impl AutoModeRuntime {
    pub fn new(initial: AutoMode) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(matches!(initial, AutoMode::Auto))),
            active_requirements: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, value: bool) {
        self.enabled.store(value, Ordering::SeqCst);
    }

    pub(crate) fn try_claim_requirement(
        &self,
        requirement_id: &str,
    ) -> Option<RequirementRunClaim> {
        let mut active = self.active_requirements.lock().ok()?;
        if !active.insert(requirement_id.to_string()) {
            return None;
        }
        Some(RequirementRunClaim {
            requirement_id: requirement_id.to_string(),
            active_requirements: Arc::clone(&self.active_requirements),
        })
    }
}

/// Spawn the background loop unconditionally. The runtime flag (set
/// from `config.mode` at startup, mutable via the REST handler)
/// gates each tick — when disabled, `tick()` early-returns without
/// touching any store. Spawning unconditionally lets the operator
/// flip auto on at runtime even if the binary started with
/// `JARVIS_WORK_MODE=off`.
pub fn spawn(state: AppState, config: AutoModeConfig) {
    let runtime = state
        .auto_mode_runtime
        .clone()
        .unwrap_or_else(|| AutoModeRuntime::new(config.mode));
    info!(
        tick_s = config.tick_seconds,
        max_units = config.max_units_per_tick,
        max_retries = config.max_retries,
        run_timeout_ms = config.run_timeout_ms,
        initial_enabled = runtime.is_enabled(),
        "auto mode loop starting (runtime-toggleable)"
    );
    tokio::spawn(async move {
        // Tokio's default first-tick is immediate; we want a
        // grace period for the rest of startup to settle.
        let mut interval = tokio::time::interval(Duration::from_secs(config.tick_seconds));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // consume the immediate first tick
        loop {
            interval.tick().await;
            if !runtime.is_enabled() {
                continue;
            }
            if let Err(e) = tick(&state, &config).await {
                warn!(error = %e, "auto mode tick failed");
            }
        }
    });
}

/// Returns "this tick processed N requirements" so callers /
/// tests know whether anything happened.
pub async fn tick(state: &AppState, config: &AutoModeConfig) -> Result<usize, String> {
    let Some(projects) = state.projects.as_ref() else {
        return Ok(0);
    };
    let Some(requirements) = state.requirements.as_ref() else {
        return Ok(0);
    };
    let Some(runs) = state.requirement_runs.as_ref() else {
        return Ok(0);
    };
    let profiles = state.agent_profiles.as_ref();

    let project_rows = projects
        .list(false, 200)
        .await
        .map_err(|e| format!("list projects: {e}"))?;
    let mut picked = 0;

    for project in project_rows {
        if picked >= config.max_units_per_tick {
            break;
        }
        let reqs = requirements
            .list(&project.id)
            .await
            .map_err(|e| format!("list requirements({}): {e}", project.id))?;
        // Pre-index project's requirements by id so the
        // depends_on check below is O(1) per dep instead of
        // re-listing per requirement. Cloned because the next loop
        // also iterates `reqs`.
        let dep_index: std::collections::HashMap<String, RequirementStatus> =
            reqs.iter().map(|r| (r.id.clone(), r.status)).collect();

        for req in &reqs {
            if picked >= config.max_units_per_tick {
                break;
            }
            // --- eligibility filter --------------------------
            if !matches!(
                req.status,
                RequirementStatus::Backlog
                    | RequirementStatus::InProgress
                    | RequirementStatus::Review
            ) {
                continue;
            }
            // v1.0 — Triage gate. Auto loop only consumes
            // user-approved work; agent / scan candidates wait
            // until a human flips them via /approve. This is the
            // structural guarantee that the agent can spawn
            // proposals freely without the executor running them
            // unattended.
            if req.triage_state != TriageState::Approved {
                continue;
            }
            // v1.0 — depends_on. Skip until every listed
            // dependency reaches `done`. Unknown ids (deleted /
            // cross-project) are treated as "not yet done" so a
            // stale ref blocks rather than silently passes.
            if !req.depends_on.iter().all(|dep_id| {
                dep_index
                    .get(dep_id)
                    .map(|s| matches!(s, RequirementStatus::Done))
                    .unwrap_or(false)
            }) {
                continue;
            }
            let mut history = runs
                .list_for_requirement(&req.id)
                .await
                .map_err(|e| format!("list runs({}): {e}", req.id))?;
            reclaim_stale_pending_runs(runs, &mut history, config.run_timeout_ms).await;
            let has_inflight = history.iter().any(|r| {
                matches!(
                    r.status,
                    RequirementRunStatus::Pending | RequirementRunStatus::Running
                )
            });
            if has_inflight {
                continue;
            }
            let failed_count = history
                .iter()
                .filter(|r| matches!(r.status, RequirementRunStatus::Failed))
                .count();
            if failed_count >= config.max_retries {
                continue;
            }
            let profile = match resolve_auto_profile(
                profiles,
                req.assignee_id.as_deref(),
                config.default_assignee.as_deref(),
                config.allow_unassigned,
            )
            .await?
            {
                Some(p) => Some(p),
                None if req.assignee_id.is_some() => continue,
                None if config.allow_unassigned => None,
                None => continue,
            };

            let claim = match state.auto_mode_runtime.as_ref() {
                Some(runtime) => match runtime.try_claim_requirement(&req.id) {
                    Some(claim) => Some(claim),
                    None => continue,
                },
                None => None,
            };
            picked += 1;
            // Spawn so the tick stays short. The next tick will
            // observe the Pending run and skip this requirement.
            let state_clone = state.clone();
            let req_clone = req.clone();
            let workspace = resolve_project_workspace(&project, profile.as_ref(), state);
            let timeout_ms = config.run_timeout_ms;
            let workflow_prompt = config.workflow_prompt.clone();
            tokio::spawn(async move {
                let _claim = claim;
                if let Err(e) = drive_one_with_prompt(
                    &state_clone,
                    &req_clone,
                    profile.as_ref(),
                    Some(workspace),
                    timeout_ms,
                    workflow_prompt,
                )
                .await
                {
                    warn!(
                        requirement_id = %req_clone.id,
                        error = %e,
                        "auto mode drive_one failed"
                    );
                }
            });
        }
    }
    Ok(picked)
}

async fn resolve_auto_profile(
    profiles: Option<&Arc<dyn harness_core::AgentProfileStore>>,
    explicit_assignee: Option<&str>,
    default_assignee: Option<&str>,
    allow_unassigned: bool,
) -> Result<Option<AgentProfile>, String> {
    let Some(store) = profiles else {
        return Ok(None);
    };

    if let Some(id) = explicit_assignee.filter(|s| !s.trim().is_empty()) {
        return store
            .get(id)
            .await
            .map_err(|e| format!("get agent profile({id}): {e}"));
    }

    let Some(selector) = default_assignee.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };

    if let Some(profile) = store
        .get(selector)
        .await
        .map_err(|e| format!("get default agent profile({selector}): {e}"))?
    {
        return Ok(Some(profile));
    }

    let profiles = store
        .list()
        .await
        .map_err(|e| format!("list agent profiles: {e}"))?;
    let by_name = profiles
        .into_iter()
        .find(|p| p.name == selector || p.name.eq_ignore_ascii_case(selector));
    if by_name.is_none() && !allow_unassigned {
        warn!(
            default_assignee = selector,
            "auto mode default assignee did not match an AgentProfile"
        );
    }
    Ok(by_name)
}

async fn reclaim_stale_pending_runs(
    runs: &Arc<dyn harness_core::RequirementRunStore>,
    history: &mut [RequirementRun],
    timeout_ms: u64,
) {
    let timeout_ms = timeout_ms.max(1);
    for run in history.iter_mut() {
        if run.status != RequirementRunStatus::Pending {
            continue;
        }
        if !pending_run_is_stale(run, timeout_ms) {
            continue;
        }
        run.status = RequirementRunStatus::Cancelled;
        run.error
            .get_or_insert_with(|| "stale pending run reclaimed by auto mode".to_string());
        run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        run.push_log(
            RequirementRunLogLevel::Warn,
            "Stale pending run reclaimed",
            Some(json!({
                "timeout_ms": timeout_ms,
                "reason": "pending exceeded auto run timeout without becoming running",
            })),
        );
        if let Err(e) = runs.upsert(run).await {
            warn!(
                run_id = %run.id,
                error = %e,
                "auto mode failed to persist stale pending run reclamation"
            );
        }
    }
}

fn pending_run_is_stale(run: &RequirementRun, timeout_ms: u64) -> bool {
    let Ok(started_at) = chrono::DateTime::parse_from_rfc3339(&run.started_at) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(started_at.with_timezone(&chrono::Utc));
    age.num_milliseconds() > timeout_ms as i64
}

/// Default wall-clock budget for ad-hoc background runs (status
/// flips, REST start_run). Matches `AutoModeConfig::default()` —
/// the auto loop overrides via `JARVIS_WORK_RUN_TIMEOUT_MS`.
pub(crate) const DEFAULT_RUN_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// Fire-and-forget background run for `requirement`. Used by
/// REST handlers (PATCH `/v1/requirements/:id` on a status flip
/// to `in_progress`, POST `/v1/requirements/:id/runs`) to drive
/// the agent loop without blocking the response.
///
/// Idempotent: if a Pending or Running run already exists for the
/// requirement, the spawned task logs an INFO and bails — the
/// existing run is the source of truth, and the next status flip
/// or `start_run` won't double-fire.
///
/// Best-effort: missing stores / dangling assignee profile are
/// logged at WARN, not surfaced. The caller has already returned
/// success to the user, so we never want a background failure to
/// be invisible (the run row would record it anyway), but we
/// also don't want to abort an entire HTTP response because a
/// peripheral lookup failed.
pub(crate) fn spawn_background_run(state: AppState, requirement: Requirement) {
    tokio::spawn(async move {
        let claim = match state.auto_mode_runtime.as_ref() {
            Some(runtime) => match runtime.try_claim_requirement(&requirement.id) {
                Some(claim) => Some(claim),
                None => {
                    info!(
                        requirement_id = %requirement.id,
                        "spawn_background_run: skipping — requirement already claimed"
                    );
                    return;
                }
            },
            None => None,
        };
        let _claim = claim;
        let Some(runs) = state.requirement_runs.as_ref() else {
            warn!(
                requirement_id = %requirement.id,
                "spawn_background_run: requirement run store missing — skipping"
            );
            return;
        };
        match runs.list_for_requirement(&requirement.id).await {
            Ok(history) => {
                let inflight = history.iter().any(|r| {
                    matches!(
                        r.status,
                        RequirementRunStatus::Pending | RequirementRunStatus::Running
                    )
                });
                if inflight {
                    info!(
                        requirement_id = %requirement.id,
                        "spawn_background_run: skipping — in-flight run already exists"
                    );
                    return;
                }
            }
            Err(e) => {
                warn!(
                    requirement_id = %requirement.id,
                    error = %e,
                    "spawn_background_run: list runs failed — skipping"
                );
                return;
            }
        }
        let profile = match (
            requirement.assignee_id.as_deref(),
            state.agent_profiles.as_ref(),
        ) {
            (Some(aid), Some(store)) => match store.get(aid).await {
                Ok(p) => p,
                Err(e) => {
                    warn!(
                        requirement_id = %requirement.id,
                        error = %e,
                        "spawn_background_run: agent profile lookup failed — running without it"
                    );
                    None
                }
            },
            _ => None,
        };
        let workspace = match state.projects.as_ref() {
            Some(projects) => match projects.load(&requirement.project_id).await {
                Ok(Some(project)) => Some(resolve_project_workspace(
                    &project,
                    profile.as_ref(),
                    &state,
                )),
                Ok(None) => {
                    warn!(
                        requirement_id = %requirement.id,
                        project_id = %requirement.project_id,
                        "spawn_background_run: project not found — using server workspace"
                    );
                    None
                }
                Err(e) => {
                    warn!(
                        requirement_id = %requirement.id,
                        error = %e,
                        "spawn_background_run: project lookup failed — using server workspace"
                    );
                    None
                }
            },
            None => None,
        };
        if let Err(e) = drive_one(
            &state,
            &requirement,
            profile.as_ref(),
            workspace,
            DEFAULT_RUN_TIMEOUT_MS,
        )
        .await
        {
            warn!(
                requirement_id = %requirement.id,
                error = %e,
                "spawn_background_run: drive_one failed"
            );
        }
    });
}

/// One end-to-end pickup: mint conversation + worktree, build
/// agent, drive `agent.run` under a timeout, persist outcome,
/// auto-verify if the requirement carries a plan.
///
/// `profile` is optional. When present, its `provider` / `model` /
/// `system_prompt` are used to route the LLM call and prefix the
/// manifest summary. When `None`, the run uses the binary's default
/// provider+model (`state.build_agent(None, None)`) — this is the
/// path taken by the ad-hoc background run triggered from a status
/// flip on a requirement without an assignee.
///
/// Errors here are logged but never surfaced — the run row
/// records the failure, which is the durable record an operator
/// will look at.
pub(crate) async fn drive_one(
    state: &AppState,
    requirement: &Requirement,
    profile: Option<&AgentProfile>,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
) -> Result<(), String> {
    drive_one_with_prompt(
        state,
        requirement,
        profile,
        workspace_override,
        timeout_ms,
        None,
    )
    .await
}

async fn drive_one_with_prompt(
    state: &AppState,
    requirement: &Requirement,
    profile: Option<&AgentProfile>,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
    workflow_prompt: Option<String>,
) -> Result<(), String> {
    let req_store = state
        .requirements
        .clone()
        .ok_or_else(|| "requirement store missing".to_string())?;
    let run_store = state
        .requirement_runs
        .clone()
        .ok_or_else(|| "run store missing".to_string())?;
    let convo_store = state
        .store
        .clone()
        .ok_or_else(|| "conversation store missing".to_string())?;

    // 1. Manifest.
    let workspace = workspace_override
        .or_else(|| state.workspace_root.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let manifest = build_default_manifest(&workspace, requirement).await;
    let summary = render_manifest_summary(&manifest);
    let composed_summary = match profile.and_then(|p| p.system_prompt.as_deref()) {
        Some(p) if !p.trim().is_empty() => {
            format!("=== assignee instructions ===\n{}\n\n{}", p.trim(), summary)
        }
        _ => summary,
    };

    // 2. Mint conversation: system (manifest) + user (seed prompt).
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut conv = Conversation::new();
    conv.push(Message::system(composed_summary));
    conv.push(Message::user(seed_prompt(
        requirement,
        workflow_prompt.as_deref(),
    )));
    let metadata = ConversationMetadata {
        project_id: Some(requirement.project_id.clone()),
    };
    convo_store
        .save_envelope(&conversation_id, &conv, &metadata)
        .await
        .map_err(|e| format!("save conversation: {e}"))?;
    if let Some(workspaces) = state.workspaces.as_ref() {
        let path = std::fs::canonicalize(&workspace).unwrap_or_else(|_| workspace.clone());
        let path_str = path.display().to_string();
        let _ = workspaces.touch(&path_str);
        workspaces.bind(&conversation_id, &path_str);
    }

    // 3. Update requirement: link conversation + auto-advance Backlog.
    let mut requirement = requirement.clone();
    let advanced = requirement.status == RequirementStatus::Backlog;
    if advanced {
        requirement.status = RequirementStatus::InProgress;
        requirement.touch();
    }
    let synthesized_verification_todos = ensure_verification_plan_todos(&mut requirement);
    requirement.link_conversation(conversation_id.clone());
    req_store
        .upsert(&requirement)
        .await
        .map_err(|e| format!("upsert requirement: {e}"))?;

    // 4. Mint run + worktree (mirrors start_run).
    let mut run = RequirementRun::new(requirement.id.clone(), conversation_id.clone());
    run.status = RequirementRunStatus::Running;
    run.push_log(
        RequirementRunLogLevel::Info,
        "Auto run started",
        Some(json!({
            "workspace": workspace.display().to_string(),
            "conversation_id": conversation_id.clone(),
            "project_id": requirement.project_id.clone(),
            "profile_id": profile.as_ref().map(|p| p.id.clone()),
        })),
    );
    if state.worktree_mode == WorktreeMode::PerRun {
        if let Some(root) = state.worktree_root.as_ref() {
            match worktree::create_worktree(&workspace, root, &run.id, !state.worktree_allow_dirty)
                .await
            {
                WorktreeOutcome::Created(p) => {
                    run.worktree_path = Some(p.display().to_string());
                    run.push_log(
                        RequirementRunLogLevel::Success,
                        "Worktree created",
                        Some(json!({ "path": p.display().to_string() })),
                    );
                }
                WorktreeOutcome::Refused(reason) => {
                    info!(run_id = %run.id, reason = %reason, "auto mode: worktree refused; using main checkout");
                    run.push_log(
                        RequirementRunLogLevel::Warn,
                        "Worktree creation refused; using main checkout",
                        Some(json!({ "reason": reason })),
                    );
                }
            }
        }
    }
    run_store
        .upsert(&run)
        .await
        .map_err(|e| format!("upsert run: {e}"))?;

    // 5. Audit: System actor for the auto pickup.
    record_activity(
        state,
        &requirement.id,
        ActivityKind::RunStarted,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "conversation_id": conversation_id,
            "auto": true,
            "profile_id": profile.map(|p| p.id.clone()),
        }),
    )
    .await;
    if advanced {
        record_activity(
            state,
            &requirement.id,
            ActivityKind::StatusChange,
            ActivityActor::System,
            json!({
                "from": "backlog",
                "to": "in_progress",
                "reason": "auto_run_started",
            }),
        )
        .await;
    }

    // Command-backed checklist cards can be executed without an
    // LLM turn. This is the Project automation path for CI/CD style
    // requirements: the durable TODOs describe exactly what to run,
    // and verification writes evidence back onto those TODOs.
    if is_verification_only_requirement(&requirement) {
        let workspace_for_verify = run
            .worktree_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.clone());
        let plan = requirement
            .verification_plan
            .clone()
            .ok_or_else(|| "verification-only requirement missing plan".to_string())?;
        run.summary = Some("Ran verification commands from requirement TODOs.".to_string());
        run.push_log(
            RequirementRunLogLevel::Info,
            "Verification-only run will execute TODO commands",
            Some(json!({
                "commands": plan.commands.len(),
                "workspace": workspace_for_verify.display().to_string(),
                "todos_created_from_plan": synthesized_verification_todos,
            })),
        );
        execute_verification_for_run(
            state,
            &req_store,
            &run_store,
            &mut requirement,
            &mut run,
            &workspace_for_verify,
            &plan,
        )
        .await;
        advance_completed_requirement(state, &req_store, &mut requirement, &run).await;
        record_activity(
            state,
            &requirement.id,
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({
                "run_id": run.id,
                "status": run.status.as_wire(),
                "auto": true,
                "mode": "verification_only",
            }),
        )
        .await;
        return Ok(());
    }

    // 6. Build agent + drive loop under a timeout. With a
    // profile we honour its provider+model+prompt; without one we
    // fall back to the binary's default route (same path the chat
    // UI uses), so a status-flip trigger still has a working LLM
    // even on requirements that were never assigned.
    run.push_log(
        RequirementRunLogLevel::Info,
        "Agent loop started",
        Some(json!({
            "timeout_ms": timeout_ms,
            "profile_id": profile.as_ref().map(|p| p.id.clone()),
        })),
    );
    if let Err(e) = run_store.upsert(&run).await {
        warn!(error = %e, "upsert run before agent loop failed");
    }
    let agent_result = match profile {
        Some(p) => state.build_agent_with(Some(&p.provider), Some(&p.model), |cfg| {
            if let Some(prompt) = p.system_prompt.as_deref() {
                if !prompt.trim().is_empty() {
                    // Already prepended into conv's system message;
                    // we leave the agent template's own
                    // system_prompt alone so it doesn't compound.
                    let _ = prompt;
                }
            }
            cfg.model = p.model.clone();
        }),
        None => state.build_agent(None, None),
    };
    let outcome = match agent_result {
        Ok(agent) => {
            // Run inside an async block so the borrowed `&mut
            // conv_for_run` lives for the timeout's full
            // duration (a `let` outside the block would dangle
            // the temporary across the await).
            let mut conv_for_run = conv.clone();
            let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
                agent.run(&mut conv_for_run).await
            })
            .await;
            match result {
                Ok(Ok(_)) => Ok(conv_for_run),
                Ok(Err(e)) => Err(format!("agent error: {e}")),
                Err(_) => Err(format!("agent timed out after {timeout_ms}ms")),
            }
        }
        Err(e) => Err(format!("agent build: {e}")),
    };

    // 7. Mark run terminal + persist.
    match outcome {
        Ok(final_conv) => {
            // Re-save conversation with the assistant's reply.
            if let Err(e) = convo_store
                .save_envelope(&conversation_id, &final_conv, &metadata)
                .await
            {
                warn!(error = %e, "save conversation after agent run failed");
            }
            // Pull the last assistant message as the run summary.
            // Assistant.content is Option<String> on the message
            // type; the agent loop usually fills it in but
            // tool-only turns leave it None.
            let summary = final_conv
                .messages
                .iter()
                .rev()
                .find_map(|m| match m {
                    Message::Assistant {
                        content: Some(c), ..
                    } if !c.trim().is_empty() => Some(c.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            run.summary = if summary.trim().is_empty() {
                None
            } else {
                Some(truncate_one_line(&summary, 240))
            };
            run.push_log(
                RequirementRunLogLevel::Success,
                "Agent loop completed",
                Some(json!({
                    "summary": run.summary.clone(),
                })),
            );
            run.finish(RequirementRunStatus::Completed);
        }
        Err(e) => {
            run.push_log(
                RequirementRunLogLevel::Error,
                "Agent loop failed",
                Some(json!({ "error": e.clone() })),
            );
            run.error = Some(e);
            run.finish(RequirementRunStatus::Failed);
        }
    }
    if let Err(e) = run_store.upsert(&run).await {
        warn!(error = %e, "upsert finished run failed");
    }

    // 8. Auto-verify when the requirement carries a plan.
    if let Some(plan) = requirement.verification_plan.as_ref() {
        let workspace_for_verify = run
            .worktree_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.clone());
        let plan = plan.clone();
        execute_verification_for_run(
            state,
            &req_store,
            &run_store,
            &mut requirement,
            &mut run,
            &workspace_for_verify,
            &plan,
        )
        .await;
    }
    advance_completed_requirement(state, &req_store, &mut requirement, &run).await;
    record_activity(
        state,
        &requirement.id,
        ActivityKind::RunFinished,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "status": run.status.as_wire(),
            "auto": true,
        }),
    )
    .await;

    Ok(())
}

async fn advance_completed_requirement(
    state: &AppState,
    req_store: &Arc<dyn harness_core::RequirementStore>,
    requirement: &mut Requirement,
    run: &RequirementRun,
) {
    let Some(target_status) = completed_requirement_target_status(requirement, run) else {
        return;
    };

    let prior_status = requirement.status;
    requirement.status = target_status;
    requirement.touch();
    if let Err(e) = req_store.upsert(requirement).await {
        warn!(error = %e, "upsert requirement after completed run failed");
        return;
    }

    record_activity(
        state,
        &requirement.id,
        ActivityKind::StatusChange,
        ActivityActor::System,
        json!({
            "from": prior_status.as_wire(),
            "to": requirement.status.as_wire(),
            "auto": true,
            "run_id": run.id,
        }),
    )
    .await;
}

fn completed_requirement_target_status(
    requirement: &Requirement,
    run: &RequirementRun,
) -> Option<RequirementStatus> {
    if run.status != RequirementRunStatus::Completed {
        return None;
    }

    let needs_review = matches!(
        run.verification.as_ref().map(|v| v.status),
        Some(VerificationStatus::NeedsReview)
    );

    match (requirement.status, needs_review) {
        (RequirementStatus::InProgress, true) => Some(RequirementStatus::Review),
        (RequirementStatus::InProgress | RequirementStatus::Review, _) => {
            Some(RequirementStatus::Done)
        }
        _ => None,
    }
}

fn is_verification_only_requirement(req: &Requirement) -> bool {
    let Some(plan) = req.verification_plan.as_ref() else {
        return false;
    };
    let plan_commands: Vec<&str> = plan
        .commands
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if plan_commands.is_empty() || req.todos.is_empty() {
        return false;
    }

    req.todos.iter().all(|todo| {
        let Some(command) = todo
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return false;
        };
        matches!(
            todo.kind,
            RequirementTodoKind::Check
                | RequirementTodoKind::Ci
                | RequirementTodoKind::Deploy
                | RequirementTodoKind::Review
        ) && plan_commands.contains(&command)
    })
}

fn ensure_verification_plan_todos(req: &mut Requirement) -> bool {
    if !req.todos.is_empty() {
        return false;
    }
    let Some(plan) = req.verification_plan.as_ref() else {
        return false;
    };
    let commands: Vec<String> = plan
        .commands
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();
    if commands.is_empty() {
        return false;
    }

    req.todos = commands
        .into_iter()
        .map(|command| {
            let mut todo = RequirementTodo::new(
                format!("Run verification: {command}"),
                RequirementTodoKind::Check,
            );
            todo.command = Some(command);
            todo.created_by = RequirementTodoCreator::Workflow;
            todo
        })
        .collect();
    req.touch();
    true
}

async fn execute_verification_for_run(
    state: &AppState,
    req_store: &Arc<dyn harness_core::RequirementStore>,
    run_store: &Arc<dyn harness_core::RequirementRunStore>,
    requirement: &mut Requirement,
    run: &mut RequirementRun,
    workspace: &Path,
    plan: &VerificationPlan,
) -> VerificationResult {
    if mark_verification_todos_running(requirement, plan) {
        if let Err(e) = req_store.upsert(requirement).await {
            warn!(error = %e, "upsert requirement before verification failed");
        }
    }
    run.push_log(
        RequirementRunLogLevel::Info,
        "Verification started",
        Some(json!({
            "workspace": workspace.display().to_string(),
            "commands": plan.commands.len(),
            "timeout_ms": verification::DEFAULT_TIMEOUT_MS,
            "auto": true,
        })),
    );
    if let Err(e) = run_store.upsert(run).await {
        warn!(error = %e, "upsert run before verification failed");
    }

    let result =
        verification::execute_plan(workspace, plan, verification::DEFAULT_TIMEOUT_MS).await;
    let status = result.status;
    run.verification = Some(result.clone());
    run.push_verification_logs(&result);
    apply_verification_result_to_todos(requirement, &run.id, &result);
    if let Err(e) = req_store.upsert(requirement).await {
        warn!(error = %e, "upsert requirement after verification failed");
    }

    match status {
        VerificationStatus::Failed => {
            run.status = RequirementRunStatus::Failed;
            run.error
                .get_or_insert_with(|| "verification failed".to_string());
            run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        VerificationStatus::Passed
        | VerificationStatus::NeedsReview
        | VerificationStatus::Skipped => {
            if matches!(
                run.status,
                RequirementRunStatus::Pending | RequirementRunStatus::Running
            ) {
                run.finish(RequirementRunStatus::Completed);
            }
        }
    }

    if let Err(e) = run_store.upsert(run).await {
        warn!(error = %e, "upsert run after verification failed");
    }
    run_store.broadcast(RequirementRunEvent::Verified {
        run_id: run.id.clone(),
        result: result.clone(),
    });
    if run.status.is_terminal() {
        run_store.broadcast(RequirementRunEvent::Finished(run.clone()));
    }
    record_activity(
        state,
        &requirement.id,
        ActivityKind::VerificationFinished,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "status": result.status.as_wire(),
            "auto": true,
        }),
    )
    .await;
    result
}

fn mark_verification_todos_running(req: &mut Requirement, plan: &VerificationPlan) -> bool {
    let commands: std::collections::HashSet<&str> = plan
        .commands
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let mut changed = false;
    for todo in &mut req.todos {
        let Some(command) = todo
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if commands.contains(command) && !matches!(todo.status, RequirementTodoStatus::Running) {
            todo.status = RequirementTodoStatus::Running;
            todo.touch();
            changed = true;
        }
    }
    if changed {
        req.touch();
    }
    changed
}

fn apply_verification_result_to_todos(
    req: &mut Requirement,
    run_id: &str,
    result: &VerificationResult,
) {
    let by_command: std::collections::HashMap<&str, &CommandResult> = result
        .command_results
        .iter()
        .map(|r| (r.command.trim(), r))
        .collect();
    let mut changed = false;
    for todo in &mut req.todos {
        let Some(command) = todo
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let Some(command_result) = by_command.get(command) else {
            continue;
        };
        todo.status = if command_result.exit_code == Some(0) {
            RequirementTodoStatus::Passed
        } else {
            RequirementTodoStatus::Failed
        };
        todo.evidence = Some(RequirementTodoEvidence {
            run_id: Some(run_id.to_string()),
            exit_code: command_result.exit_code,
            stdout_excerpt: excerpt(&command_result.stdout, 4096),
            stderr_excerpt: excerpt(&command_result.stderr, 4096),
            artifact_url: None,
            note: Some(format!(
                "verification {} in {}ms",
                todo.status.as_wire(),
                command_result.duration_ms
            )),
        });
        todo.touch();
        changed = true;
    }
    if changed {
        req.touch();
    }
}

fn excerpt(s: &str, cap: usize) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= cap {
        return Some(trimmed.to_string());
    }
    let mut out: String = trimmed.chars().take(cap).collect();
    out.push('…');
    Some(out)
}

fn resolve_project_workspace(
    project: &Project,
    profile: Option<&AgentProfile>,
    state: &AppState,
) -> PathBuf {
    project
        .workspaces
        .first()
        .map(|w| PathBuf::from(&w.path))
        .or_else(|| {
            profile
                .and_then(|p| p.default_workspace.as_deref())
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| state.workspace_root.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Compose the user message that seeds the agent run. Uses the
/// requirement's title + description; falls back to title alone
/// when description is absent.
fn seed_prompt(req: &Requirement, workflow_prompt: Option<&str>) -> String {
    if let Some(template) = workflow_prompt.filter(|s| !s.trim().is_empty()) {
        return render_seed_template(template, req);
    }
    let mut out = String::new();
    out.push_str(
        "Please complete this requirement and reply with a one-line summary of what you did.\n\n",
    );
    out.push_str(&req.title);
    if let Some(desc) = req.description.as_deref() {
        if !desc.trim().is_empty() {
            out.push_str("\n\n");
            out.push_str(desc.trim());
        }
    }
    if !req.todos.is_empty() {
        out.push_str("\n\nStructured TODO/checklist items to complete or update with evidence:\n");
        for todo in &req.todos {
            out.push_str("- [");
            out.push_str(todo.status.as_wire());
            out.push_str("] ");
            out.push_str(todo.kind.as_wire());
            out.push_str(": ");
            out.push_str(&todo.title);
            if let Some(command) = todo.command.as_deref().filter(|s| !s.trim().is_empty()) {
                out.push_str(" — command: `");
                out.push_str(command.trim());
                out.push('`');
            }
            if !todo.depends_on.is_empty() {
                out.push_str(" — depends_on: ");
                out.push_str(&todo.depends_on.join(", "));
            }
            out.push('\n');
        }
    }
    out
}

fn render_seed_template(template: &str, req: &Requirement) -> String {
    let description = req.description.as_deref().unwrap_or("");
    let assignee = req.assignee_id.as_deref().unwrap_or("");
    let replacements = [
        ("{{ requirement.id }}", req.id.as_str()),
        ("{{ requirement.project_id }}", req.project_id.as_str()),
        ("{{ requirement.title }}", req.title.as_str()),
        ("{{ requirement.description }}", description),
        ("{{ requirement.status }}", req.status.as_wire()),
        ("{{ requirement.triage_state }}", req.triage_state.as_wire()),
        ("{{ requirement.assignee_id }}", assignee),
        // Symphony-compatible aliases. Jarvis requirements are the
        // local issue model for this scheduler, so these let teams
        // reuse most of a Symphony prompt body unchanged.
        ("{{ issue.id }}", req.id.as_str()),
        ("{{ issue.identifier }}", req.id.as_str()),
        ("{{ issue.title }}", req.title.as_str()),
        ("{{ issue.description }}", description),
        ("{{ issue.state }}", req.status.as_wire()),
    ];
    replacements
        .into_iter()
        .fold(template.trim().to_string(), |acc, (needle, value)| {
            acc.replace(needle, value)
        })
}

fn truncate_one_line(s: &str, cap: usize) -> String {
    let one = s.lines().next().unwrap_or("").trim();
    if one.chars().count() > cap {
        let mut t: String = one.chars().take(cap).collect();
        t.push('…');
        t
    } else {
        one.to_string()
    }
}

async fn record_activity(
    state: &AppState,
    requirement_id: &str,
    kind: ActivityKind,
    actor: ActivityActor,
    body: serde_json::Value,
) {
    let Some(store) = state.activities.as_ref() else {
        return;
    };
    let activity = harness_core::Activity::new(requirement_id, kind, actor, body);
    if let Err(e) = store.append(&activity).await {
        warn!(error = %e, "auto mode: activity append failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{
        AgentConfig, AgentProfile, ChatRequest, ChatResponse, Error, FinishReason, LlmProvider,
        Message, Project, ProjectWorkspace, Requirement, RequirementStatus, RequirementTodoCreator,
        VerificationPlan,
    };
    use harness_store::{
        MemoryActivityStore, MemoryAgentProfileStore, MemoryConversationStore, MemoryProjectStore,
        MemoryRequirementRunStore, MemoryRequirementStore,
    };
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;

    /// Stub LLM that returns a canned assistant message and a
    /// `Stop` finish reason — the agent loop runs exactly one
    /// turn and exits cleanly.
    struct CannedLlm {
        reply: String,
        calls: Option<Arc<AtomicUsize>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for CannedLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            if let Some(calls) = self.calls.as_ref() {
                calls.fetch_add(1, AtomicOrdering::SeqCst);
            }
            Ok(ChatResponse {
                message: Message::assistant_text(&self.reply),
                finish_reason: FinishReason::Stop,
                response_id: None,
            })
        }
    }

    fn base_state_with_canned_llm(reply: &str) -> AppState {
        use crate::provider_registry::ProviderRegistry;
        let llm: Arc<dyn LlmProvider> = Arc::new(CannedLlm {
            reply: reply.to_string(),
            calls: None,
        });
        let cfg = AgentConfig::new("canned-model");
        let mut registry = ProviderRegistry::new("canned");
        registry.insert("canned", llm, "canned-model".to_string());
        AppState::from_registry(registry, cfg)
    }

    fn state_with_counting_llm(reply: &str) -> (AppState, Arc<AtomicUsize>) {
        use crate::provider_registry::ProviderRegistry;
        let calls = Arc::new(AtomicUsize::new(0));
        let llm: Arc<dyn LlmProvider> = Arc::new(CannedLlm {
            reply: reply.to_string(),
            calls: Some(calls.clone()),
        });
        let cfg = AgentConfig::new("canned-model");
        let mut registry = ProviderRegistry::new("canned");
        registry.insert("canned", llm, "canned-model".to_string());
        (AppState::from_registry(registry, cfg), calls)
    }

    fn wire_stores(state: AppState) -> AppState {
        state
            .with_store(Arc::new(MemoryConversationStore::new()))
            .with_project_store(Arc::new(MemoryProjectStore::new()))
            .with_requirement_store(Arc::new(MemoryRequirementStore::new()))
            .with_run_store(Arc::new(MemoryRequirementRunStore::new()))
            .with_activity_store(Arc::new(MemoryActivityStore::new()))
            .with_agent_profile_store(Arc::new(MemoryAgentProfileStore::new()))
    }

    #[test]
    fn parse_wire_modes() {
        assert_eq!(AutoMode::from_wire(""), Some(AutoMode::Off));
        assert_eq!(AutoMode::from_wire("off"), Some(AutoMode::Off));
        assert_eq!(AutoMode::from_wire("auto"), Some(AutoMode::Auto));
        assert_eq!(AutoMode::from_wire("nonsense"), None);
    }

    #[test]
    fn runtime_requirement_claims_are_exclusive_and_release() {
        let runtime = AutoModeRuntime::new(AutoMode::Auto);
        let claim = runtime
            .try_claim_requirement("req-1")
            .expect("first claim should win");

        assert!(
            runtime.try_claim_requirement("req-1").is_none(),
            "same requirement cannot be claimed twice"
        );

        drop(claim);
        assert!(
            runtime.try_claim_requirement("req-1").is_some(),
            "claim drop releases the requirement"
        );
    }

    #[test]
    fn workflow_front_matter_overlays_scheduler_policy() {
        let raw = r#"---
automation:
  mode: auto
  max_retries: 3
  allow_unassigned: true
  default_assignee: Auto Alice
polling:
  interval_ms: 1500
agent:
  max_concurrent_agents: 4
---
Do {{ requirement.title }} in {{ issue.state }}.
"#;
        let wf = AutoWorkflow::from_markdown(raw).unwrap();
        let mut c = AutoModeConfig::default();
        wf.apply_to(&mut c);
        assert_eq!(c.mode, AutoMode::Auto);
        assert_eq!(c.tick_seconds, 2);
        assert_eq!(c.max_units_per_tick, 4);
        assert_eq!(c.max_retries, 3);
        assert!(c.allow_unassigned);
        assert_eq!(c.default_assignee.as_deref(), Some("Auto Alice"));
        assert_eq!(
            c.workflow_prompt.as_deref(),
            Some("Do {{ requirement.title }} in {{ issue.state }}.")
        );
    }

    #[test]
    fn workflow_prompt_template_renders_requirement_tokens() {
        let mut req = Requirement::new("p1", "ship auto mode");
        req.status = RequirementStatus::InProgress;
        req.description = Some("make it run".into());
        let rendered = seed_prompt(
            &req,
            Some(
                "Ticket {{ issue.identifier }}: {{ requirement.title }} / \
                 {{ requirement.description }} / {{ issue.state }}",
            ),
        );
        assert!(rendered.contains(&req.id));
        assert!(rendered.contains("ship auto mode"));
        assert!(rendered.contains("make it run"));
        assert!(rendered.contains("in_progress"));
    }

    fn cfg() -> AutoModeConfig {
        AutoModeConfig {
            mode: AutoMode::Auto,
            tick_seconds: 9999,
            max_units_per_tick: 5,
            max_retries: 2,
            run_timeout_ms: 5_000,
            allow_unassigned: false,
            default_assignee: None,
            workflow_prompt: None,
        }
    }

    async fn seed_project_and_profile(state: &AppState) -> (Project, AgentProfile) {
        let mut proj = Project::new("Project 1", "instructions");
        proj.slug = "p1".into();
        state.projects.as_ref().unwrap().save(&proj).await.unwrap();
        let prof = AgentProfile::new("Auto Alice", "canned", "canned-model");
        state
            .agent_profiles
            .as_ref()
            .unwrap()
            .upsert(&prof)
            .await
            .unwrap();
        (proj, prof)
    }

    #[tokio::test]
    async fn tick_skips_requirement_without_assignee() {
        let state = wire_stores(base_state_with_canned_llm("done."));
        let (proj, _) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "no assignee");
        req.status = RequirementStatus::Backlog;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0);
        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        assert!(runs.is_empty());
    }

    #[tokio::test]
    async fn tick_can_run_unassigned_requirement_when_enabled() {
        let state = wire_stores(base_state_with_canned_llm("default route done."));
        let (proj, _) = seed_project_and_profile(&state).await;
        let req = Requirement::new(&proj.id, "no assignee but allowed");
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut c = cfg();
        c.allow_unassigned = true;
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 1);

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if runs.iter().any(|r| r.status.is_terminal()) {
                let r = runs.iter().find(|r| r.status.is_terminal()).unwrap();
                assert_eq!(r.status, RequirementRunStatus::Completed);
                assert_eq!(r.summary.as_deref(), Some("default route done."));
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("unassigned drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_picks_eligible_requirement_and_drives_agent() {
        let state = wire_stores(base_state_with_canned_llm("hello world."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "auto pickup");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1);

        // Wait for the spawned drive_one to finish. The canned
        // LLM returns immediately so a short sleep is enough.
        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if runs.iter().any(|r| r.status.is_terminal()) {
                let r = runs.iter().find(|r| r.status.is_terminal()).unwrap();
                assert_eq!(r.status, RequirementRunStatus::Completed);
                assert_eq!(r.summary.as_deref(), Some("hello world."));
                let saved = state
                    .requirements
                    .as_ref()
                    .unwrap()
                    .get(&req.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.status, RequirementStatus::Done);
                let n = tick(&state, &cfg()).await.unwrap();
                assert_eq!(n, 0, "completed work should not be picked again");
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_picks_review_requirement_and_completes_it() {
        let state = wire_stores(base_state_with_canned_llm("review accepted."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "auto review");
        req.status = RequirementStatus::Review;
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1);

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if runs.iter().any(|r| r.status.is_terminal()) {
                let r = runs.iter().find(|r| r.status.is_terminal()).unwrap();
                assert_eq!(r.status, RequirementRunStatus::Completed);
                assert_eq!(r.summary.as_deref(), Some("review accepted."));
                let saved = state
                    .requirements
                    .as_ref()
                    .unwrap()
                    .get(&req.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.status, RequirementStatus::Done);
                let n = tick(&state, &cfg()).await.unwrap();
                assert_eq!(n, 0, "done requirement should not be picked again");
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("review drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_runs_verification_in_project_workspace() {
        let fallback = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let (state, llm_calls) = state_with_counting_llm("should not be used");
        let state = wire_stores(state).with_workspace_root(fallback.path().to_path_buf());
        let mut proj = Project::new("Project Workspace", "instructions");
        proj.slug = "project-workspace".into();
        let project_path = std::fs::canonicalize(project_dir.path()).unwrap();
        proj.set_workspaces(vec![ProjectWorkspace::new(
            project_path.display().to_string(),
        )]);
        state.projects.as_ref().unwrap().save(&proj).await.unwrap();
        let prof = AgentProfile::new("Auto Alice", "canned", "canned-model");
        state
            .agent_profiles
            .as_ref()
            .unwrap()
            .upsert(&prof)
            .await
            .unwrap();
        let mut req = Requirement::new(&proj.id, "verify cwd");
        req.assignee_id = Some(prof.id.clone());
        req.verification_plan = Some(VerificationPlan {
            commands: vec!["pwd > auto-cwd.txt".into()],
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        });
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1);

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if let Some(run) = runs.iter().find(|r| r.status.is_terminal()) {
                assert_eq!(llm_calls.load(AtomicOrdering::SeqCst), 0);
                assert_eq!(run.status, RequirementRunStatus::Completed);
                let output_path = project_dir.path().join("auto-cwd.txt");
                let cwd = std::fs::read_to_string(output_path).unwrap();
                assert_eq!(cwd.trim(), project_path.display().to_string());
                assert!(!fallback.path().join("auto-cwd.txt").exists());
                let saved = state
                    .requirements
                    .as_ref()
                    .unwrap()
                    .get(&req.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.status, RequirementStatus::Done);
                assert_eq!(saved.todos.len(), 1);
                assert_eq!(saved.todos[0].created_by, RequirementTodoCreator::Workflow);
                assert_eq!(saved.todos[0].status, RequirementTodoStatus::Passed);
                assert_eq!(saved.todos[0].evidence.as_ref().unwrap().exit_code, Some(0));
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("project workspace verification did not finish within 1s");
    }

    #[tokio::test]
    async fn tick_runs_command_todos_without_llm_and_writes_evidence() {
        let project_dir = tempfile::tempdir().unwrap();
        let (state, llm_calls) = state_with_counting_llm("should not be used");
        let state = wire_stores(state).with_workspace_root(project_dir.path().to_path_buf());
        let mut proj = Project::new("Command TODOs", "instructions");
        proj.slug = "command-todos".into();
        state.projects.as_ref().unwrap().save(&proj).await.unwrap();
        let prof = AgentProfile::new("Auto Alice", "canned", "canned-model");
        state
            .agent_profiles
            .as_ref()
            .unwrap()
            .upsert(&prof)
            .await
            .unwrap();

        let pass_cmd = "printf ok";
        let fail_cmd = "printf nope >&2; exit 7";
        let mut req = Requirement::new(&proj.id, "run command todos");
        req.assignee_id = Some(prof.id.clone());
        req.verification_plan = Some(VerificationPlan {
            commands: vec![pass_cmd.into(), fail_cmd.into()],
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        });
        let mut pass = harness_core::RequirementTodo::new("pass check", RequirementTodoKind::Ci);
        pass.command = Some(pass_cmd.into());
        let mut fail = harness_core::RequirementTodo::new("fail check", RequirementTodoKind::Ci);
        fail.command = Some(fail_cmd.into());
        req.todos = vec![pass, fail];
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1);

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if let Some(run) = runs.iter().find(|r| r.status.is_terminal()) {
                assert_eq!(llm_calls.load(AtomicOrdering::SeqCst), 0);
                assert_eq!(run.status, RequirementRunStatus::Failed);
                assert_eq!(
                    run.verification.as_ref().map(|v| v.status),
                    Some(VerificationStatus::Failed)
                );
                let saved = state
                    .requirements
                    .as_ref()
                    .unwrap()
                    .get(&req.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.todos[0].status, RequirementTodoStatus::Passed);
                assert_eq!(saved.todos[0].evidence.as_ref().unwrap().exit_code, Some(0));
                assert_eq!(saved.status, RequirementStatus::InProgress);
                assert_eq!(saved.todos[1].status, RequirementTodoStatus::Failed);
                assert_eq!(saved.todos[1].evidence.as_ref().unwrap().exit_code, Some(7));
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("verification-only drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_skips_requirement_with_inflight_run() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "has inflight");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        // Plant an in-flight run.
        let mut existing = RequirementRun::new(&req.id, "conv-1");
        existing.status = RequirementRunStatus::Running;
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&existing)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "should have skipped (already running)");
    }

    #[tokio::test]
    async fn tick_skips_requirement_already_claimed_by_manual_trigger() {
        let runtime = AutoModeRuntime::new(AutoMode::Auto);
        let state =
            wire_stores(base_state_with_canned_llm("ok.")).with_auto_mode_runtime(runtime.clone());
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "claimed elsewhere");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();
        let _claim = runtime
            .try_claim_requirement(&req.id)
            .expect("manual trigger should claim first");

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "claimed requirement should not be double-picked");
        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        assert!(runs.is_empty());
    }

    #[tokio::test]
    async fn tick_reclaims_stale_pending_run_before_pickup() {
        let state = wire_stores(base_state_with_canned_llm("fresh run."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "stale pending");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut stale = RequirementRun::new(&req.id, "stale-conv");
        stale.status = RequirementRunStatus::Pending;
        stale.started_at = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
        let stale_id = stale.id.clone();
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&stale)
            .await
            .unwrap();

        let mut c = cfg();
        c.run_timeout_ms = 1;
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 1, "stale pending should not block a fresh pickup");

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            let stale = runs.iter().find(|r| r.id == stale_id).unwrap();
            assert_eq!(stale.status, RequirementRunStatus::Cancelled);
            assert!(stale
                .error
                .as_deref()
                .unwrap_or("")
                .contains("stale pending"));
            if runs
                .iter()
                .any(|r| r.id != stale_id && r.status == RequirementRunStatus::Completed)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("fresh pickup after stale pending reclaim did not finish within 1s");
    }

    #[tokio::test]
    async fn tick_skips_when_max_retries_exceeded() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "broken");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        // Plant 2 failed runs. With max_retries=2 the loop refuses.
        for i in 0..2 {
            let mut r = RequirementRun::new(&req.id, format!("c-{i}"));
            r.finish(RequirementRunStatus::Failed);
            state
                .requirement_runs
                .as_ref()
                .unwrap()
                .upsert(&r)
                .await
                .unwrap();
        }

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "max_retries should block pickup");
    }

    #[tokio::test]
    async fn tick_respects_max_units_per_tick() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        for i in 0..3 {
            let mut req = Requirement::new(&proj.id, format!("req-{i}"));
            req.assignee_id = Some(prof.id.clone());
            state
                .requirements
                .as_ref()
                .unwrap()
                .upsert(&req)
                .await
                .unwrap();
        }
        let mut c = cfg();
        c.max_units_per_tick = 2;
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn tick_skips_proposed_by_agent_until_approved() {
        // v1.0 — auto loop must NOT consume rows whose triage_state
        // is `proposed_by_agent` (or `proposed_by_scan`). The
        // structural triage gate is the single guarantee that lets
        // the agent freely create candidates without the executor
        // running them unattended.
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "agent proposed");
        req.assignee_id = Some(prof.id.clone());
        req.triage_state = TriageState::ProposedByAgent;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "proposed_by_agent must wait for human approval");

        // Flip to approved and the same row is now eligible.
        req.triage_state = TriageState::Approved;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();
        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1, "approved row should be picked up");
    }

    #[tokio::test]
    async fn tick_skips_until_depends_on_done() {
        // v1.0 — depends_on. A requirement with an outstanding
        // dependency should not be picked. Once the dependency
        // flips to `done`, it becomes eligible.
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;

        let mut dep = Requirement::new(&proj.id, "dep first");
        // Park the dep in Review without an assignee so it doesn't
        // get picked itself while still blocking the child.
        dep.status = RequirementStatus::Review;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&dep)
            .await
            .unwrap();

        let mut child = Requirement::new(&proj.id, "child waits");
        child.assignee_id = Some(prof.id.clone());
        child.depends_on = vec![dep.id.clone()];
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&child)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "child should wait while dep != done");

        // Mark dep done. Child becomes eligible.
        dep.status = RequirementStatus::Done;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&dep)
            .await
            .unwrap();
        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1, "child should now be picked once dep is done");
    }

    #[tokio::test]
    async fn off_mode_spawn_is_a_no_op() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        // Just verify that calling spawn with Off doesn't panic
        // and doesn't actually start a task. Hard to assert "no
        // task spawned" directly; the smoke test is "the
        // function returns immediately".
        spawn(state, AutoModeConfig::default());
    }
}
