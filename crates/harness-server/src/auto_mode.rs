//! Phase 6 — background scheduler that picks Ready
//! [`Requirement`](harness_project::Requirement)s,
//! mints a fresh-session [`RequirementRun`](harness_project::RequirementRun),
//! drives the agent loop, persists the result, and (when the
//! requirement carries a [`VerificationPlan`](harness_project::VerificationPlan))
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use harness_core::{Conversation, ConversationMetadata, Message};
use harness_project::{ActivityActor, ActivityKind, CommandResult, Project, ProjectMemory, ProjectMemoryKind, Requirement, RequirementRun, RequirementRunEvent, RequirementRunLogLevel, RequirementRunStatus, RequirementStatus, RequirementTodoEvidence, RequirementTodoKind, RequirementTodoStatus, TriageState, VerificationPlan, VerificationResult, VerificationStatus};
use harness_requirement::{build_default_manifest, render_manifest_summary};
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, info, warn};

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

    /// Inverse of [`Self::from_wire`]. Stable string the REST layer
    /// returns so clients can match against the same names the env
    /// var accepts.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Auto => "auto",
        }
    }
}

/// Knobs sourced from `JARVIS_WORK_*` env vars.
///
/// Three orthogonal dials govern the scheduler's appetite:
///
/// - `tick_seconds` — how often the picker wakes up.
/// - `max_units_per_tick` — burst budget. Cap on how many candidates
///   the picker can spawn-task in a single tick. Defends against a
///   single tick stampeding the LLM API even before the global cap
///   kicks in.
/// - `max_concurrent_units` — true global concurrency. Each spawned
///   drive task acquires a [`Semaphore`] permit before calling the
///   provider; if all permits are held, extra spawns wait in the
///   semaphore's queue rather than racing for tokens. This is the
///   knob the user reaches for when "agents are stomping each
///   other's rate limits". Default `2` mirrors Symphony's small
///   default pool (most LLM rate limits comfortably absorb 2 in
///   parallel for typical agent loops).
///
/// `max_retries` is the ceiling on failed runs per requirement
/// before the loop stops re-picking it (so a broken LLM endpoint
/// can't burn money in a loop). `run_timeout_ms` caps the agent
/// loop's wall-clock budget per pickup — same envelope the manual
/// WS runs would have if you stuck a `tokio::time::timeout` on
/// them.
#[derive(Debug, Clone)]
pub struct AutoModeConfig {
    pub mode: AutoMode,
    pub tick_seconds: u64,
    pub max_units_per_tick: usize,
    /// Global concurrency cap. Permits-in-flight ceiling for the
    /// drive task pool. See type-level docs.
    pub max_concurrent_units: usize,
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
    /// v1.0 SubAgent — opt-in: when set, requirements with
    /// `AcceptancePolicy::Subagent` whose work agent flips to Done
    /// instead pause at Review and dispatch the reviewer subagent
    /// (`subagent.review`). The reviewer's terminal call to
    /// `requirement.review_verdict` then flips the row to Done (on
    /// pass) or InProgress (on fail) with the commentary attached.
    /// Default `false` so existing deployments keep the pre-v1.0
    /// auto-flip semantics. Sourced from `JARVIS_REVIEWER_AUTO_ACCEPT`.
    pub reviewer_auto_accept: bool,
}

impl Default for AutoModeConfig {
    fn default() -> Self {
        Self {
            mode: AutoMode::Off,
            tick_seconds: 30,
            max_units_per_tick: 1,
            // 2 = enough headroom that a slow agent doesn't gate the
            // whole queue, low enough that token / rate-limit budgets
            // stay predictable. Override via JARVIS_WORK_MAX_CONCURRENT
            // or WORKFLOW.md `agent.max_concurrent_agents`.
            max_concurrent_units: 2,
            // 3 instead of 1: a single transient LLM-transport blip
            // (404, DNS, rate-limit timeout) used to permanently park
            // a Requirement at the v1 default, since `consecutive_failed >=
            // max_retries` hard-skips on the next tick. With 3 we can
            // ride out the typical 1–2 minute outage *and* the v1.1
            // exponential-backoff still keeps a stuck Requirement
            // from burning real money in a tight loop. Override via
            // `JARVIS_WORK_MAX_RETRIES` or WORKFLOW.md.
            max_retries: 3,
            run_timeout_ms: 10 * 60 * 1000,
            allow_unassigned: true,
            default_assignee: None,
            workflow_prompt: None,
            reviewer_auto_accept: false,
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
    /// Maps from Symphony YAML `agent.max_concurrent_agents` /
    /// `automation.max_concurrent_units`. `None` = inherit the
    /// `AutoModeConfig` default.
    pub max_concurrent_units: Option<usize>,
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
        if let Some(v) = self.max_concurrent_units {
            cfg.max_concurrent_units = v.max(1);
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
    /// Optional global concurrency cap exposed at automation level
    /// (mirror of `agent.max_concurrent_agents` for users who'd
    /// rather group all scheduler dials under `automation:`).
    #[serde(default)]
    max_concurrent_units: Option<usize>,
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
            out.max_concurrent_units = a.max_concurrent_units;
            out.max_retries = a.max_retries;
            out.run_timeout_ms = a.run_timeout_ms;
            out.allow_unassigned = a.allow_unassigned;
            out.default_assignee = a.default_assignee;
        }
        if let Some(p) = self.polling.and_then(|p| p.interval_ms) {
            out.tick_seconds = Some(p.saturating_add(999) / 1000);
        }
        if let Some(a) = self.agent {
            // `agent.max_concurrent_agents` always meant "how many
            // agents run in parallel" — the original mapping to
            // `max_units_per_tick` was a misnomer. From v1.1 it
            // routes to the real global concurrency cap.
            if let Some(v) = a.max_concurrent_agents {
                out.max_concurrent_units = Some(v);
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
///
/// Beyond the on/off bit this also owns:
///
/// - `active_requirements`: per-requirement reentrancy guard so the
///   same row never runs twice in parallel.
/// - `concurrency_gate`: process-wide [`Semaphore`] of size
///   `max_concurrent_units`. Each spawned drive task acquires one
///   permit before invoking the LLM; surplus tasks wait in the
///   semaphore's FIFO queue rather than racing for tokens. This is
///   the actual queue users tune when "agents step on each other's
///   rate limits".
#[derive(Debug, Clone)]
pub struct AutoModeRuntime {
    enabled: Arc<AtomicBool>,
    active_requirements: Arc<Mutex<HashSet<String>>>,
    concurrency_gate: Arc<Semaphore>,
    /// Wall-clock timestamp (RFC-3339) of the most recent tick the
    /// scheduler observed — written before the enable gate, so the
    /// dashboard can show "loop alive, just paused" vs. "loop never
    /// started". `None` until the first tick fires.
    last_tick_at: Arc<Mutex<Option<String>>>,
    /// Hot-reloadable override for `AutoModeConfig::max_retries`.
    /// Sentinel `0` means "no override; use the static config value".
    /// Operators flip this via `POST /v1/auto-mode {max_retries}`
    /// when a transient outage parks a backlog under the static cap.
    max_retries_override: Arc<AtomicUsize>,
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

impl Default for AutoModeRuntime {
    fn default() -> Self {
        Self::with_capacity(
            AutoMode::Off,
            AutoModeConfig::default().max_concurrent_units,
        )
    }
}

impl AutoModeRuntime {
    /// Convenience constructor that picks the default concurrency
    /// pool size. Call [`Self::with_capacity`] to plumb through the
    /// resolved config value.
    pub fn new(initial: AutoMode) -> Self {
        Self::with_capacity(initial, AutoModeConfig::default().max_concurrent_units)
    }

    /// Build a runtime with an explicit concurrency cap. The binary
    /// resolves `max_concurrent_units` (env > workflow > default)
    /// and threads it here so the semaphore matches what `tick`
    /// promises.
    pub fn with_capacity(initial: AutoMode, max_concurrent_units: usize) -> Self {
        let permits = max_concurrent_units.max(1);
        Self {
            enabled: Arc::new(AtomicBool::new(matches!(initial, AutoMode::Auto))),
            active_requirements: Arc::new(Mutex::new(HashSet::new())),
            concurrency_gate: Arc::new(Semaphore::new(permits)),
            last_tick_at: Arc::new(Mutex::new(None)),
            max_retries_override: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, value: bool) {
        self.enabled.store(value, Ordering::SeqCst);
    }

    /// Read the current override. `None` means "use the static
    /// config value"; `Some(n)` is the runtime-set ceiling.
    pub fn max_retries_override(&self) -> Option<usize> {
        match self.max_retries_override.load(Ordering::SeqCst) {
            0 => None,
            n => Some(n),
        }
    }

    /// Set the runtime override for `max_retries`. `None` clears it
    /// (picker falls back to `AutoModeConfig::max_retries`).
    pub fn set_max_retries_override(&self, value: Option<usize>) {
        self.max_retries_override
            .store(value.unwrap_or(0), Ordering::SeqCst);
    }

    /// Picker-facing accessor: prefers the runtime override, falls
    /// back to the static config.
    pub fn effective_max_retries(&self, config: &AutoModeConfig) -> usize {
        self.max_retries_override().unwrap_or(config.max_retries)
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

    /// Hand a clone of the concurrency gate to a spawned task so
    /// it can `gate.acquire_owned().await` before doing work.
    /// Returning the `Arc<Semaphore>` (not a permit) keeps the
    /// acquisition lazy — the spawn happens immediately, the wait
    /// happens inside the spawned future.
    pub(crate) fn concurrency_gate(&self) -> Arc<Semaphore> {
        Arc::clone(&self.concurrency_gate)
    }

    /// Available permits — useful for diagnostics / tests. Snapshot
    /// only; not intended as a synchronisation primitive.
    pub fn available_permits(&self) -> usize {
        self.concurrency_gate.available_permits()
    }

    /// RFC-3339 timestamp of the most recent tick observed by the
    /// scheduler loop, or `None` when no tick has fired yet (very
    /// early after boot, or in tests that don't spawn the loop).
    pub fn last_tick_at(&self) -> Option<String> {
        self.last_tick_at.lock().ok().and_then(|g| g.clone())
    }

    /// Stamp "now" as the latest tick timestamp. Called by the
    /// `spawn` loop before it consults the enable flag, so the
    /// dashboard's "last tick" reading reflects loop liveness even
    /// while auto mode is paused.
    pub fn record_tick(&self) {
        if let Ok(mut guard) = self.last_tick_at.lock() {
            *guard = Some(chrono::Utc::now().to_rfc3339());
        }
    }
}

/// Spawn the background loop unconditionally. The runtime flag (set
/// from `config.mode` at startup, mutable via the REST handler)
/// gates each tick — when disabled, `tick()` early-returns without
/// touching any store. Spawning unconditionally lets the operator
/// flip auto on at runtime even if the binary started with
/// `JARVIS_WORK_MODE=off`.
pub fn spawn(state: AppState, config: AutoModeConfig) {
    let runtime = state.auto_mode_runtime.clone().unwrap_or_else(|| {
        AutoModeRuntime::with_capacity(config.mode, config.max_concurrent_units)
    });
    info!(
        tick_s = config.tick_seconds,
        max_units = config.max_units_per_tick,
        max_concurrent = config.max_concurrent_units,
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
            runtime.record_tick();
            // Always reap stale Pending/Running rows, even when the
            // auto loop is disabled. Pending rows accumulate from
            // REST `start_run` invocations and from agent runs that
            // crashed between "minted" and "terminal status write".
            // Skipping the reaper while auto mode is off would leave
            // ghost rows pinning their requirements forever — see
            // the `feat/auto_project` investigation that motivated
            // this split.
            reap_all_stale_inflight_runs(&state, &config).await;
            if !runtime.is_enabled() {
                continue;
            }
            if let Err(e) = tick(&state, &config).await {
                warn!(error = %e, "auto mode tick failed");
            }
        }
    });
}

/// Sweep `RequirementRunStore::list_all` and reap any stale
/// Pending/Running rows. Decoupled from [`tick`] so it runs whether
/// or not auto mode is enabled — the reaper is a pure governance
/// action (no new runs minted, no LLM call), so the enable gate
/// doesn't need to apply.
///
/// Errors are logged, never propagated: the spawn loop must keep
/// ticking even if a single sweep fails (e.g. transient store
/// hiccup). The hard cap of 500 rows per pass matches the store
/// trait's recommended soft cap; in practice the inflight set is
/// tiny (<10 typical), so the cap mostly defends against an
/// unreaped backlog from before the watchdog was wired up.
async fn reap_all_stale_inflight_runs(state: &AppState, config: &AutoModeConfig) {
    let Some(runs) = state.requirement_runs.as_ref() else {
        return;
    };
    match runs.list_all(500).await {
        Ok(mut rows) => {
            reclaim_stale_pending_runs(runs, &mut rows, config.run_timeout_ms).await;
        }
        Err(e) => {
            warn!(error = %e, "auto mode reaper: list_all failed; skipping this sweep");
        }
    }
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
    let project_rows = projects
        .list(false, 200)
        .await
        .map_err(|e| format!("list projects: {e}"))?;
    let mut picked = 0;

    for project in project_rows {
        if picked >= config.max_units_per_tick {
            break;
        }
        if !project.automation.auto_mode_enabled {
            debug!(
                project_id = %project.id,
                project_slug = %project.slug,
                reason = "project_auto_mode_disabled",
                "auto mode skipping project"
            );
            continue;
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
        // Structural deadlock detection for the depends_on gate:
        // requirements that sit on — or transitively behind — a
        // dependency cycle can never satisfy the gate, so they are
        // surfaced once as a `blocked` row rather than skipped in
        // silence forever (issue #97).
        let cycle_blocked = cycle_blocked_requirement_ids(&reqs);

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
                debug!(
                    requirement_id = %req.id,
                    status = req.status.as_wire(),
                    reason = "ineligible_status",
                    "auto mode skipping requirement"
                );
                continue;
            }
            // v1.0 — Triage gate. Auto loop only consumes
            // user-approved work; agent / scan candidates wait
            // until a human flips them via /approve. This is the
            // structural guarantee that the agent can spawn
            // proposals freely without the executor running them
            // unattended.
            if req.triage_state != TriageState::Approved {
                debug!(
                    requirement_id = %req.id,
                    triage_state = req.triage_state.as_wire(),
                    reason = "not_approved",
                    "auto mode skipping requirement"
                );
                continue;
            }
            // v1.0 — depends_on gate. Skip until every listed
            // dependency reaches `done`. Three distinct failure
            // shapes; the first two are *permanent* deadlocks that we
            // surface once as an operator-visible `blocked` Activity
            // row instead of an endless silent skip (issue #97):
            //
            //  - self-dependency  → a row that lists its own id can
            //    never be `done` while blocked, so it blocks itself
            //    forever.
            //  - dependency cycle → A→B, B→A: no member ever reaches
            //    `done`, so all members (and anything behind them)
            //    stall permanently.
            //
            // Unknown ids (deleted / cross-project) stay a silent
            // `debug!` skip: they fail safe (block rather than run the
            // wrong thing), and a block on a genuinely deleted dep is
            // the intended behaviour. Cross-project deps are not
            // resolved across stores in v1 — author them within a
            // single project.
            if req.depends_on.iter().any(|d| d == &req.id) {
                record_blocked_once(state, &req.id, "self_dependency", json!({ "dep": req.id }))
                    .await;
                debug!(
                    requirement_id = %req.id,
                    reason = "self_dependency",
                    "auto mode skipping requirement (self-dependency deadlock)"
                );
                continue;
            }
            if cycle_blocked.contains(req.id.as_str()) {
                record_blocked_once(
                    state,
                    &req.id,
                    "dependency_cycle",
                    json!({ "depends_on": req.depends_on }),
                )
                .await;
                debug!(
                    requirement_id = %req.id,
                    reason = "dependency_cycle",
                    "auto mode skipping requirement (dependency cycle)"
                );
                continue;
            }
            if let Some(blocking_dep) = req.depends_on.iter().find(|dep_id| {
                !dep_index
                    .get(dep_id.as_str())
                    .map(|s| matches!(s, RequirementStatus::Done))
                    .unwrap_or(false)
            }) {
                debug!(
                    requirement_id = %req.id,
                    blocking_dep = %blocking_dep,
                    reason = "dep_not_done",
                    "auto mode skipping requirement"
                );
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
                debug!(
                    requirement_id = %req.id,
                    reason = "inflight_run",
                    "auto mode skipping requirement"
                );
                continue;
            }
            // v1.2 — under default acceptance (`reviewer_auto_accept
            // = false`) a Review row whose latest run completed
            // cleanly has no autonomous path to Done: nothing in
            // the system flips its boilerplate execution-checklist
            // todos, no reviewer subagent dispatches, and re-running
            // the agent loop produces the same outcome. Re-pickup
            // just burns LLM cycles (and, when the provider has
            // partial outages, accelerates the retry budget burn-
            // down). Skip until something else advances the row:
            // an operator click, the reviewer flag flipping on, or
            // a requirement touch that bumps `updated_at`. The
            // existing reviewer-flag path is unchanged — when
            // `reviewer_auto_accept=true`, re-pickup is expected
            // because that's what dispatches the reviewer subagent.
            if req.status == RequirementStatus::Review
                && !config.reviewer_auto_accept
                && history
                    .iter()
                    .any(|r| matches!(r.status, RequirementRunStatus::Completed))
            {
                debug!(
                    requirement_id = %req.id,
                    reason = "review_completed_awaiting_acceptance",
                    "auto mode skipping requirement"
                );
                continue;
            }
            // v1.1 — count failures since the most recent success,
            // not all-time. Without this a Requirement that fails
            // once is permanently locked out at the default
            // `max_retries=1` even after a manual fix that lands a
            // Completed run. Cancelled rows (timeout reaper, manual
            // abort) are skipped: they're neither success nor
            // failure for retry budgeting.
            //
            // v1.2 — `effective_max_retries` consults the runtime
            // override first so an operator can hot-bump the cap
            // (POST `/v1/auto-mode {max_retries}`) without a
            // restart. Default sentinel (`0`) falls back to the
            // static config.
            let consecutive_failed = consecutive_failed_since_last_success(&history);
            let max_retries = match state.auto_mode_runtime.as_ref() {
                Some(rt) => rt.effective_max_retries(config),
                None => config.max_retries,
            };
            if consecutive_failed >= max_retries {
                debug!(
                    requirement_id = %req.id,
                    consecutive_failed,
                    max_retries,
                    reason = "retries_exceeded",
                    "auto mode skipping requirement"
                );
                continue;
            }
            // v1.1 — exponential backoff between consecutive
            // failures. Bounded by `FAILURE_BACKOFF_MAX_MS`.
            // Without this, a Requirement that fails twice in a
            // row gets retried 30s later (the next tick) and burns
            // its remaining retry budget against a transient fault
            // — rate limits, network, the sort of thing that
            // recovers on its own given a few minutes.
            let backoff_ms = failure_backoff_ms(consecutive_failed, config.tick_seconds);
            if let Some(latest_failed) = most_recent_failed_run(&history) {
                if let Some(remaining_ms) = failure_backoff_remaining_ms(latest_failed, backoff_ms)
                {
                    debug!(
                        requirement_id = %req.id,
                        consecutive_failed,
                        backoff_ms,
                        remaining_ms,
                        reason = "failure_backoff",
                        "auto mode skipping requirement"
                    );
                    continue;
                }
            }
            let claim = match state.auto_mode_runtime.as_ref() {
                Some(runtime) => match runtime.try_claim_requirement(&req.id) {
                    Some(claim) => Some(claim),
                    None => {
                        debug!(
                            requirement_id = %req.id,
                            reason = "claim_taken",
                            "auto mode skipping requirement"
                        );
                        continue;
                    }
                },
                None => None,
            };
            picked += 1;
            // Spawn so the tick stays short. The next tick will
            // observe the Pending run and skip this requirement.
            //
            // The spawned future is gated on the runtime's
            // concurrency semaphore — when N agents are already
            // running (N = `max_concurrent_units`), additional
            // spawns wait at `acquire_owned().await` until a permit
            // frees. This is the actual "queue" that controls how
            // many requirements pound the LLM in parallel.
            let state_clone = state.clone();
            let req_clone = req.clone();
            let workspace = resolve_project_workspace(&project, state);
            let timeout_ms = config.run_timeout_ms;
            let workflow_prompt = config.workflow_prompt.clone();
            let gate = state
                .auto_mode_runtime
                .as_ref()
                .map(AutoModeRuntime::concurrency_gate);
            tokio::spawn(async move {
                // Hold the per-requirement claim across the wait so
                // the same row can't be picked again while we're
                // queued. `acquire_owned` returns a permit tied to
                // the lifetime of the spawned task — drop on
                // completion releases the slot for the next waiter.
                let _claim = claim;
                let _permit: Option<OwnedSemaphorePermit> = match gate {
                    Some(gate) => match gate.acquire_owned().await {
                        Ok(permit) => Some(permit),
                        Err(_) => {
                            // Semaphore closed mid-wait → runtime is
                            // shutting down; bail without running.
                            warn!(
                                requirement_id = %req_clone.id,
                                "auto mode concurrency gate closed; aborting drive"
                            );
                            return;
                        }
                    },
                    None => None,
                };
                if let Err(e) = drive_one_with_prompt(
                    &state_clone,
                    &req_clone,
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

/// Safety multiplier applied to `run_timeout_ms` before reaping a
/// stuck `Running` row. The agent loop itself is wrapped in a
/// `tokio::time::timeout(run_timeout_ms)` ([`drive_one_with_prompt`]),
/// so any healthy run must terminate at or before that boundary.
/// We give it 3x headroom before declaring it abandoned, which
/// covers verification + DB write tail latency without ever
/// pre-empting a live task.
const RUNNING_STALE_MULTIPLIER: u64 = 3;

/// Reap in-flight runs whose age exceeds the configured wall-clock
/// budget. Two cases the same routine handles:
///
/// * `Pending` — minted by REST `start_run` but the WS client never
///   flipped it to `Running` (disconnected, browser closed, etc.).
///   Reaped after `run_timeout_ms`.
/// * `Running` — minted by [`drive_one_with_prompt`], typically
///   stuck because the spawned tokio task panicked between
///   "agent.run started" and the terminal status write. Reaped after
///   `run_timeout_ms * RUNNING_STALE_MULTIPLIER` so we never race
///   ahead of a slow-but-healthy run.
///
/// In both cases the row is flipped to `Cancelled` (not `Failed`):
/// `Failed` carries semantics of "the agent loop ran and the LLM /
/// tool produced an error", which we can't claim here — we don't
/// know what happened to the spawned task. `Cancelled` is the
/// neutral "the auto loop gave up on this row" signal, and
/// `failed_count` (used by the `max_retries` guard) deliberately
/// doesn't count it, so a panic'd run doesn't permanently burn
/// a retry slot.
async fn reclaim_stale_pending_runs(
    runs: &Arc<dyn harness_project::RequirementRunStore>,
    history: &mut [RequirementRun],
    timeout_ms: u64,
) {
    let timeout_ms = timeout_ms.max(1);
    let running_threshold_ms = timeout_ms.saturating_mul(RUNNING_STALE_MULTIPLIER);
    for run in history.iter_mut() {
        let (threshold_ms, summary, reason) = match run.status {
            RequirementRunStatus::Pending => (
                timeout_ms,
                "Stale pending run reclaimed",
                "pending exceeded auto run timeout without becoming running",
            ),
            RequirementRunStatus::Running => (
                running_threshold_ms,
                "Stuck running run reclaimed",
                "running exceeded auto run timeout × safety multiplier; assumed abandoned",
            ),
            _ => continue,
        };
        if !inflight_run_is_stale(run, threshold_ms) {
            continue;
        }
        let prior_status = run.status;
        run.status = RequirementRunStatus::Cancelled;
        run.error.get_or_insert_with(|| match prior_status {
            RequirementRunStatus::Pending => "stale pending run reclaimed by auto mode".to_string(),
            RequirementRunStatus::Running => {
                "stuck running run reclaimed by auto mode (assumed abandoned)".to_string()
            }
            _ => "stale run reclaimed by auto mode".to_string(),
        });
        run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        run.push_log(
            RequirementRunLogLevel::Warn,
            summary,
            Some(json!({
                "timeout_ms": threshold_ms,
                "reason": reason,
                "prior_status": prior_status.as_wire(),
            })),
        );
        if let Err(e) = runs.upsert(run).await {
            warn!(
                run_id = %run.id,
                error = %e,
                "auto mode failed to persist stale run reclamation"
            );
        } else {
            warn!(
                run_id = %run.id,
                prior_status = %prior_status.as_wire(),
                threshold_ms,
                "auto mode reclaimed stale in-flight run"
            );
        }
    }
}

fn inflight_run_is_stale(run: &RequirementRun, threshold_ms: u64) -> bool {
    let Ok(started_at) = chrono::DateTime::parse_from_rfc3339(&run.started_at) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(started_at.with_timezone(&chrono::Utc));
    age.num_milliseconds() > threshold_ms as i64
}

/// Hard ceiling on the failure backoff window. One hour matches the
/// `JARVIS_WORK_TICK_SECONDS` documentation upper bound — anything
/// longer and operators are better off flipping the row to Backlog
/// or fixing the underlying failure manually.
const FAILURE_BACKOFF_MAX_MS: u64 = 60 * 60 * 1000;

/// Floor on the per-failure base delay. With `tick_seconds=1` (test
/// fixtures, dev) the raw base would be 1 second and the loop would
/// hammer a flaky LLM. 30 s is short enough that a single transient
/// blip recovers fast and long enough that it's clearly distinct
/// from "next tick".
const FAILURE_BACKOFF_BASE_FLOOR_MS: u64 = 30_000;

/// Count `Failed` runs in `history` (newest-first by store contract)
/// up to and excluding the most recent `Completed` run.
///
/// Why "consecutive": the all-time count made
/// `JARVIS_WORK_MAX_RETRIES=1` (the default) lock a Requirement out
/// of the auto loop on its very first failure, even after an
/// operator manually fixed and successfully ran it. Counting only
/// failures since the last success is what matches the operator's
/// mental model of "retries".
///
/// `Cancelled` rows are skipped (neither a success nor a failure
/// — the timeout reaper or a manual abort wrote them). `Pending` /
/// `Running` shouldn't be in history at this point because the
/// in-flight guard above already short-circuits, but we skip them
/// defensively.
fn consecutive_failed_since_last_success(history: &[RequirementRun]) -> usize {
    let mut count = 0;
    for run in history {
        match run.status {
            RequirementRunStatus::Failed => count += 1,
            RequirementRunStatus::Completed => break,
            RequirementRunStatus::Cancelled
            | RequirementRunStatus::Pending
            | RequirementRunStatus::Running => continue,
        }
    }
    count
}

/// Most recent `Failed` run, or `None` if no failure exists.
/// Relies on `list_for_requirement` returning newest-first.
fn most_recent_failed_run(history: &[RequirementRun]) -> Option<&RequirementRun> {
    history
        .iter()
        .find(|r| matches!(r.status, RequirementRunStatus::Failed))
}

/// Compute the failure backoff window for a given consecutive-failure
/// count. Doubles per failure starting from a `tick_seconds`-derived
/// base, capped at `FAILURE_BACKOFF_MAX_MS`. `consecutive == 0`
/// returns 0 (no backoff for a fresh / post-success requirement).
fn failure_backoff_ms(consecutive: usize, tick_seconds: u64) -> u64 {
    if consecutive == 0 {
        return 0;
    }
    let base = tick_seconds
        .saturating_mul(1000)
        .max(FAILURE_BACKOFF_BASE_FLOOR_MS);
    // The shift ceiling is high enough that the time cap
    // (`FAILURE_BACKOFF_MAX_MS`) is what actually bounds the result
    // for any sane `tick_seconds`. We keep a finite shift purely to
    // avoid touching `1u64 << 64` UB territory if a buggy caller
    // ever passes `consecutive = usize::MAX`.
    let shift = (consecutive - 1).min(16) as u32;
    base.saturating_mul(1u64 << shift)
        .min(FAILURE_BACKOFF_MAX_MS)
}

/// Remaining backoff in ms for `run` (a `Failed` run). `None` when
/// the window has elapsed, when `backoff_ms == 0`, or when the
/// timestamp is unparseable / in the future (clock skew). The
/// future-timestamp case returns `None` to avoid permanently
/// pinning a requirement on a buggy clock.
fn failure_backoff_remaining_ms(run: &RequirementRun, backoff_ms: u64) -> Option<u64> {
    if backoff_ms == 0 {
        return None;
    }
    let reference = run
        .finished_at
        .as_deref()
        .unwrap_or(run.started_at.as_str());
    let parsed = chrono::DateTime::parse_from_rfc3339(reference).ok()?;
    let age_ms = chrono::Utc::now()
        .signed_duration_since(parsed.with_timezone(&chrono::Utc))
        .num_milliseconds();
    if age_ms < 0 {
        return None;
    }
    backoff_ms.checked_sub(age_ms as u64).filter(|&r| r > 0)
}

/// Default wall-clock budget for ad-hoc background runs (status
/// flips, REST start_run). Matches `AutoModeConfig::default()` —
/// the auto loop overrides via `JARVIS_WORK_RUN_TIMEOUT_MS`.
pub(crate) const DEFAULT_RUN_TIMEOUT_MS: u64 = 10 * 60 * 1000;

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
pub fn spawn_background_run(state: AppState, requirement: Requirement) {
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
        let workspace = match state.projects.as_ref() {
            Some(projects) => match projects.load(&requirement.project_id).await {
                Ok(Some(project)) => Some(resolve_project_workspace(&project, &state)),
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
        if let Err(e) = drive_one(&state, &requirement, workspace, DEFAULT_RUN_TIMEOUT_MS).await {
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
/// Runs always use Jarvis' default provider/model route. Requirement
/// assignment and acceptance strategy are no longer part of the
/// unattended execution path; Jarvis drives and verifies against the
/// requirement's execution checklist.
///
/// Errors here are logged but never surfaced — the run row
/// records the failure, which is the durable record an operator
/// will look at.
pub(crate) async fn drive_one(
    state: &AppState,
    requirement: &Requirement,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
) -> Result<(), String> {
    drive_one_with_prompt(state, requirement, workspace_override, timeout_ms, None).await
}

async fn drive_one_with_prompt(
    state: &AppState,
    requirement: &Requirement,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
    workflow_prompt: Option<String>,
) -> Result<(), String> {
    // A requirement bound to a declarative workflow runs the multi-step
    // recipe instead of a single agent turn. The bound workflow must
    // still exist in the store; otherwise we fall through to the normal
    // single-agent path (the binding is a soft reference).
    if let (Some(wf_id), Some(wf_store)) = (
        requirement.workflow_id.as_deref(),
        state.workflows.as_ref(),
    ) {
        match wf_store.get(wf_id).await {
            Ok(Some(def)) => {
                info!(
                    requirement_id = %requirement.id,
                    workflow_id = %wf_id,
                    "auto mode: running bound workflow"
                );
                return drive_one_workflow(state, &def, requirement, workspace_override, timeout_ms)
                    .await;
            }
            Ok(None) => {
                warn!(
                    requirement_id = %requirement.id,
                    workflow_id = %wf_id,
                    "auto mode: bound workflow not found; falling back to single-agent run"
                );
            }
            Err(e) => {
                warn!(error = %e, workflow_id = %wf_id, "auto mode: load bound workflow failed");
            }
        }
    }

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
    let memory_preamble = render_project_memory_preamble(state, &requirement.project_id).await;
    let composed_summary = compose_system_prompt(&memory_preamble, &summary);

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
        ..Default::default()
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
    let synthesized_execution_todos = requirement.ensure_execution_checklist();
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
                "execution_checklist_initialized": synthesized_execution_todos,
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
        capture_failure_memory(state, &requirement, &run).await;
        capture_failure_learning_memory(state, &requirement, &run).await;
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

    // 6. Build Jarvis + drive loop under a timeout.
    run.push_log(
        RequirementRunLogLevel::Info,
        "Agent loop started",
        Some(json!({
            "timeout_ms": timeout_ms,
        })),
    );
    if let Err(e) = run_store.upsert(&run).await {
        warn!(error = %e, "upsert run before agent loop failed");
    }
    // Pin the per-run workspace onto the agent's session scope so
    // every `fs.*`, `code.grep`, `git.*`, `workspace.context`, and
    // `shell.exec` invocation resolves against the Requirement's
    // workspace instead of the harness binary's startup `fs_root`.
    // The plumbing in `harness_core::workspace::with_session_workspace`
    // and `active_workspace_or` has been there since v0; the
    // auto-mode runner just wasn't telling the agent which path to
    // pin. Without this, tools running under an auto-mode pickup
    // either land back at the harness root (read paths) or fail
    // with "path must be relative to the tool root" (write paths),
    // forcing the agent to fall through to `shell.exec` against
    // absolute paths that bypass the sandbox.
    let workspace_for_agent = run
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.clone());
    let agent_result = state.build_agent_with(None, None, |cfg| {
        cfg.session_workspace = Some(workspace_for_agent.clone());
    });
    // Stamp the model id used for this run *before* the agent runs.
    // We persist whatever route was selected so cost attribution
    // works even if the run later fails (the row carries the model
    // it tried, not just successful ones).
    run.model = Some(state.agent_template.model.clone());
    let outcome = match agent_result {
        Ok(agent) => {
            // Run inside an async block so the borrowed `&mut
            // conv_for_run` lives for the timeout's full
            // duration (a `let` outside the block would dangle
            // the temporary across the await).
            let mut conv_for_run = conv.clone();
            let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
                agent.run_with_usage(&mut conv_for_run).await
            })
            .await;
            match result {
                Ok(Ok((_, usage))) => Ok((conv_for_run, usage)),
                Ok(Err(e)) => Err(format!("agent error: {e}")),
                Err(_) => Err(format!("agent timed out after {timeout_ms}ms")),
            }
        }
        Err(e) => Err(format!("agent build: {e}")),
    };

    // 7. Mark run terminal + persist.
    match outcome {
        Ok((final_conv, usage)) => {
            if !usage.is_empty() {
                run.usage = Some(usage);
            }
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

    // The agent can update the execution checklist through
    // requirement.* tools while the run is in flight. Reload before
    // verification/completion so auto_mode judges the durable
    // Jarvis-maintained checklist, not the pre-run clone.
    if let Ok(Some(latest)) = req_store.get(&requirement.id).await {
        requirement = latest;
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
    capture_failure_memory(state, &requirement, &run).await;
    capture_failure_learning_memory(state, &requirement, &run).await;
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

/// Drive a requirement bound to a declarative workflow.
///
/// The workflow runtime mints its own per-step conversations, but the
/// auto loop's re-pickup guards (in-flight dedup, retry cap, failure
/// backoff) and status advancement all key off [`RequirementRun`] rows
/// and the requirement status. The single-agent path
/// (`drive_one_with_prompt`) writes those; the workflow path historically
/// did not, so an approved workflow-bound row was re-dispatched on every
/// tick forever (issue #80). This wraps the workflow dispatch in the same
/// bookkeeping:
///
/// 1. Advance the requirement off `Backlog` and synthesise the execution
///    checklist (so a clean run advances `InProgress` → `Review` instead
///    of staying eligible).
/// 2. Mint a `Running` [`RequirementRun`] **before** dispatch, so a
///    workflow that outlives a tick is seen as in-flight and the next
///    tick skips re-pickup.
/// 3. Mark the run `Completed` / `Failed` from the workflow outcome and
///    advance the requirement — letting the existing retry / backoff
///    guards apply uniformly.
async fn drive_one_workflow(
    state: &AppState,
    def: &harness_workflow::WorkflowDefinition,
    requirement: &Requirement,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
) -> Result<(), String> {
    let req_store = state
        .requirements
        .clone()
        .ok_or_else(|| "requirement store missing".to_string())?;
    let run_store = state
        .requirement_runs
        .clone()
        .ok_or_else(|| "run store missing".to_string())?;

    let workspace = workspace_override
        .clone()
        .or_else(|| state.workspace_root.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    // 1. Advance requirement off Backlog + synthesise the execution
    //    checklist so completion lands at Review (awaiting acceptance)
    //    rather than looping. Mirrors drive_one_with_prompt.
    let mut requirement = requirement.clone();
    let advanced = requirement.status == RequirementStatus::Backlog;
    if advanced {
        requirement.status = RequirementStatus::InProgress;
        requirement.touch();
    }
    requirement.ensure_execution_checklist();
    req_store
        .upsert(&requirement)
        .await
        .map_err(|e| format!("upsert requirement: {e}"))?;

    // 2. Mint a Running run BEFORE dispatch so `has_inflight` sees a
    //    workflow that outlives a tick. The run is not tied to a single
    //    conversation (the workflow links its per-step conversations onto
    //    the requirement itself), so we mint a synthetic id.
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut run = RequirementRun::new(requirement.id.clone(), conversation_id);
    run.status = RequirementRunStatus::Running;
    run.model = Some(state.agent_template.model.clone());
    run.push_log(
        RequirementRunLogLevel::Info,
        "Auto workflow run started",
        Some(json!({
            "workflow_id": def.id,
            "workspace": workspace.display().to_string(),
            "project_id": requirement.project_id.clone(),
        })),
    );
    run_store
        .upsert(&run)
        .await
        .map_err(|e| format!("upsert run: {e}"))?;

    record_activity(
        state,
        &requirement.id,
        ActivityKind::RunStarted,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "workflow_id": def.id,
            "auto": true,
            "workflow": true,
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
                "reason": "auto_workflow_started",
            }),
        )
        .await;
    }

    // 3. Dispatch. A Failed terminal status surfaces as Err.
    let outcome = crate::workflow_runtime::drive_workflow(
        state,
        def,
        Some(&requirement),
        workspace_override,
        timeout_ms,
    )
    .await;

    match outcome {
        Ok(wf_run) => {
            run.summary = Some(truncate_one_line(
                &format!(
                    "Workflow '{}' completed ({} step(s)).",
                    def.name,
                    wf_run.step_results.len()
                ),
                240,
            ));
            run.push_log(
                RequirementRunLogLevel::Success,
                "Workflow completed",
                Some(json!({
                    "workflow_run_id": wf_run.id,
                    "steps": wf_run.step_results.len(),
                })),
            );
            run.finish(RequirementRunStatus::Completed);
        }
        Err(e) => {
            run.push_log(
                RequirementRunLogLevel::Error,
                "Workflow failed",
                Some(json!({ "error": e.clone() })),
            );
            run.error = Some(e);
            run.finish(RequirementRunStatus::Failed);
        }
    }
    if let Err(e) = run_store.upsert(&run).await {
        warn!(error = %e, "upsert finished workflow run failed");
    }

    // The workflow linked its step conversations onto the requirement;
    // reload before advancing so we operate on the durable row.
    if let Ok(Some(latest)) = req_store.get(&requirement.id).await {
        requirement = latest;
    }
    advance_completed_requirement(state, &req_store, &mut requirement, &run).await;
    capture_failure_memory(state, &requirement, &run).await;
    capture_failure_learning_memory(state, &requirement, &run).await;
    record_activity(
        state,
        &requirement.id,
        ActivityKind::RunFinished,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "status": run.status.as_wire(),
            "auto": true,
            "workflow": true,
        }),
    )
    .await;

    Ok(())
}

async fn advance_completed_requirement(
    state: &AppState,
    req_store: &Arc<dyn harness_project::RequirementStore>,
    requirement: &mut Requirement,
    run: &RequirementRun,
) {
    let Some(target_status) = completed_requirement_target_status(requirement, run) else {
        return;
    };

    let prior_status = requirement.status;
    if requirement.status != target_status {
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

    if requirement.execution_checklist_failed_or_blocked() {
        return Some(RequirementStatus::InProgress);
    }

    match requirement.status {
        RequirementStatus::InProgress if needs_review => Some(RequirementStatus::Review),
        RequirementStatus::InProgress | RequirementStatus::Review => {
            if requirement.execution_checklist_passed() {
                Some(RequirementStatus::Done)
            } else {
                Some(RequirementStatus::Review)
            }
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

async fn execute_verification_for_run(
    state: &AppState,
    req_store: &Arc<dyn harness_project::RequirementStore>,
    run_store: &Arc<dyn harness_project::RequirementRunStore>,
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

fn resolve_project_workspace(project: &Project, state: &AppState) -> PathBuf {
    project
        .workspaces
        .first()
        .map(|w| PathBuf::from(&w.path))
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
    let replacements = [
        ("{{ requirement.id }}", req.id.as_str()),
        ("{{ requirement.project_id }}", req.project_id.as_str()),
        ("{{ requirement.title }}", req.title.as_str()),
        ("{{ requirement.description }}", description),
        ("{{ requirement.status }}", req.status.as_wire()),
        ("{{ requirement.triage_state }}", req.triage_state.as_wire()),
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

/// Compute the set of requirement ids that can **never** satisfy
/// their `depends_on` gate because they sit on — or transitively
/// behind — a dependency cycle within the project.
///
/// Only in-project edges are considered: a dep id pointing outside
/// `reqs` (deleted / cross-project) is dropped here so it can't close
/// a cycle; those unknown-id blocks are handled separately by the
/// caller (they fail safe and stay a silent skip).
///
/// Implementation is a Kahn-style peel: a requirement "settles" once
/// every in-project dep it lists has settled. Whatever can't settle
/// is stuck behind a cycle — self-loops (`A→A`) and mutual cycles
/// (`A→B→A`) included.
fn cycle_blocked_requirement_ids(reqs: &[Requirement]) -> HashSet<String> {
    let ids: HashSet<&str> = reqs.iter().map(|r| r.id.as_str()).collect();
    let mut pending: std::collections::HashMap<&str, HashSet<&str>> = reqs
        .iter()
        .map(|r| {
            let deps: HashSet<&str> = r
                .depends_on
                .iter()
                .map(String::as_str)
                .filter(|d| ids.contains(d))
                .collect();
            (r.id.as_str(), deps)
        })
        .collect();
    loop {
        let settled: Vec<&str> = pending
            .iter()
            .filter(|(_, deps)| deps.is_empty())
            .map(|(id, _)| *id)
            .collect();
        if settled.is_empty() {
            break;
        }
        for id in &settled {
            pending.remove(id);
        }
        for deps in pending.values_mut() {
            for id in &settled {
                deps.remove(id);
            }
        }
    }
    pending.keys().map(|id| id.to_string()).collect()
}

/// Append a `Blocked` Activity row for a permanently-deadlocked
/// requirement, but only when the newest existing row isn't already
/// the same block — so the per-tick scheduler surfaces the stall once
/// rather than spamming the timeline every tick. If a later event
/// (run, status change, manual unblock) intervenes, a recurring block
/// re-emits.
async fn record_blocked_once(
    state: &AppState,
    requirement_id: &str,
    reason: &str,
    detail: serde_json::Value,
) {
    let Some(store) = state.activities.as_ref() else {
        return;
    };
    match store.list_for_requirement(requirement_id).await {
        Ok(rows) => {
            if let Some(latest) = rows.first() {
                if latest.kind == ActivityKind::Blocked
                    && latest.body.get("reason").and_then(|v| v.as_str()) == Some(reason)
                {
                    return;
                }
            }
        }
        Err(e) => {
            // Better a possible duplicate row than a silent stall:
            // fall through and emit.
            warn!(error = %e, "auto mode: dedup list for blocked activity failed");
        }
    }
    let mut body = detail;
    if let serde_json::Value::Object(map) = &mut body {
        map.insert("reason".to_string(), json!(reason));
    }
    record_activity(
        state,
        requirement_id,
        ActivityKind::Blocked,
        ActivityActor::System,
        body,
    )
    .await;
}

pub(crate) async fn record_activity(
    state: &AppState,
    requirement_id: &str,
    kind: ActivityKind,
    actor: ActivityActor,
    body: serde_json::Value,
) {
    let Some(store) = state.activities.as_ref() else {
        return;
    };
    let activity = harness_project::Activity::new(requirement_id, kind, actor, body);
    if let Err(e) = store.append(&activity).await {
        warn!(error = %e, "auto mode: activity append failed");
    }
}

/// Compose the synthetic system prompt for an auto run. Order
/// matters: project memory comes first so a "from now on, watch out
/// for X" lesson is the strongest signal the model sees, then the
/// workspace manifest. Empty inputs are skipped, never papered over
/// with empty headers.
fn compose_system_prompt(memory_preamble: &str, manifest_summary: &str) -> String {
    let mut out = String::new();
    if !memory_preamble.is_empty() {
        out.push_str(memory_preamble);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out.push_str(manifest_summary);
    out
}

/// Hard byte budget for the project-memory block injected into the
/// system prompt. Two KiB ≈ ~10 short lessons; older memories spill
/// past the cap and are summarised as "(older memories omitted)".
const PROJECT_MEMORY_PROMPT_BYTES: usize = 2048;

/// Render the project-memory preamble for `project_id`, or an empty
/// string when no store is configured / no rows exist / the store
/// errors. Memories listed newest-first by `updated_at` (the store's
/// contract); older entries past the byte budget are trimmed.
///
/// The header / footer markers (`=== project memory ===`) match the
/// existing `harness_server::project_memory` file-memory convention
/// so an operator reading the system prompt can find the section
/// either way.
async fn render_project_memory_preamble(state: &AppState, project_id: &str) -> String {
    let Some(store) = state.project_memories.as_ref() else {
        return String::new();
    };
    let memories = match store.list(project_id).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(
                project_id,
                error = %e,
                "auto mode: project memory list failed; injecting empty preamble"
            );
            return String::new();
        }
    };
    if memories.is_empty() {
        return String::new();
    }
    let mut out = String::from("=== project memory ===\n");
    out.push_str(
        "Lessons / gotchas captured from prior runs in this project. \
         Treat as hints, not authority — verify before acting.\n\n",
    );
    let mut omitted = 0usize;
    for memory in memories {
        let line = format!("- [{}] {}\n", memory.kind.as_wire(), memory.title.trim());
        if out.len() + line.len() + 64 > PROJECT_MEMORY_PROMPT_BYTES {
            omitted += 1;
            continue;
        }
        out.push_str(&line);
    }
    if omitted > 0 {
        out.push_str(&format!(
            "- … ({omitted} older memorie(s) omitted; see project memory list)\n"
        ));
    }
    out.push_str("=== /project memory ===\n");
    out
}

/// Persist a fresh `ProjectMemory::Gotcha` row distilled from a
/// failed run. No-op when the store isn't configured or `run.status`
/// isn't [`RequirementRunStatus::Failed`]. Failures here are logged
/// at WARN and never propagated — losing a memory write is strictly
/// better than aborting the auto loop.
async fn capture_failure_memory(state: &AppState, requirement: &Requirement, run: &RequirementRun) {
    let Some(store) = state.project_memories.as_ref() else {
        return;
    };
    if run.status != RequirementRunStatus::Failed {
        return;
    }
    let body = render_failure_memory_body(run);
    let memory = ProjectMemory::new(
        &requirement.project_id,
        ProjectMemoryKind::Gotcha,
        format!("Run failed: {}", requirement.title),
        body,
    )
    .with_source(run.id.clone(), requirement.id.clone());
    if let Err(e) = store.upsert(&memory).await {
        warn!(
            run_id = %run.id,
            project_id = %requirement.project_id,
            error = %e,
            "auto mode: project memory capture failed"
        );
    } else {
        debug!(
            run_id = %run.id,
            memory_id = %memory.id,
            project_id = %requirement.project_id,
            "auto mode captured project memory from failed run"
        );
    }
}

/// Render the markdown body of a failure memory. Pulls the run's
/// top-level error and (when available) the failing verification
/// commands' stderr — the two pieces an operator most often needs
/// to remember why this run blew up. The string is truncated to
/// [`ProjectMemory::BODY_CAP`] inside `ProjectMemory::new`, so we
/// can be slightly verbose here without budgeting carefully.
/// Phase 1 self-improving-agent — sibling of
/// [`capture_failure_memory`]. Writes a `MemoryItem` row through the
/// new row-based [`harness_learning::MemoryStore`] when a
/// `RequirementRun` lands in `Failed`. Different store from the
/// existing `ProjectMemoryStore` path: this one lives under
/// `<data-dir>/jarvis/memories/` and is shaped by the
/// self-improving-agent spec (scope / kind / source / pinned / etc.)
/// instead of the older file-based [`harness_project::ProjectMemory`].
///
/// Both fire together by design — Phase 2 will unify the two stores;
/// until then operators see the same failure recorded in both
/// surfaces, which is fine because they're consumed by different
/// product paths (the older one feeds the next run's system prompt,
/// the new one will feed the cross-project Memory UI + reviewer
/// fork). No-op when the new store isn't configured.
async fn capture_failure_learning_memory(
    state: &AppState,
    requirement: &Requirement,
    run: &RequirementRun,
) {
    let Some(store) = state.learning_memory.as_ref() else {
        return;
    };
    if run.status != RequirementRunStatus::Failed {
        return;
    }
    let body = render_failure_memory_body(run);
    let mut item = harness_learning::MemoryItem::new(
        harness_learning::MemoryScope::project(requirement.project_id.clone()),
        harness_learning::MemoryKind::Gotcha,
        format!("Run failed: {}", requirement.title),
        body,
    )
    .with_source(harness_learning::MemorySource::Run {
        run_id: run.id.clone(),
    });
    // Tag with the requirement id so the future Memory UI can offer
    // "show all gotchas for this requirement" without a separate
    // index.
    item = item.with_tag(format!("requirement:{}", requirement.id));
    // Lower confidence than user-typed rows — these are auto-derived
    // signals; the reviewer fork may consolidate them later.
    item.confidence = 0.7;
    match store.upsert(item).await {
        Ok(saved) => {
            debug!(
                run_id = %run.id,
                memory_id = %saved.id,
                project_id = %requirement.project_id,
                "auto mode: failure captured into learning memory store"
            );
        }
        Err(e) => warn!(
            run_id = %run.id,
            project_id = %requirement.project_id,
            error = %e,
            "auto mode: learning memory capture failed"
        ),
    }
}

fn render_failure_memory_body(run: &RequirementRun) -> String {
    let mut body = String::new();
    if let Some(err) = run
        .error
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body.push_str("Error: ");
        body.push_str(err);
        body.push('\n');
    }
    if let Some(verification) = run.verification.as_ref() {
        for cr in &verification.command_results {
            if cr.exit_code == Some(0) {
                continue;
            }
            body.push_str(&format!(
                "\nCommand failed (exit {}): {}\n",
                cr.exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                cr.command.trim()
            ));
            let stderr = cr.stderr.trim();
            if !stderr.is_empty() {
                body.push_str("stderr: ");
                body.push_str(stderr);
                body.push('\n');
            }
        }
    }
    if body.trim().is_empty() {
        body.push_str("No further detail recorded.");
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{AgentConfig, AgentProfile, ChatRequest, ChatResponse, Error, FinishReason, LlmProvider, Message};
use harness_project::{Project, ProjectWorkspace, Requirement, RequirementStatus, RequirementTodo, RequirementTodoCreator, VerificationPlan};
    use harness_store::{
        MemoryActivityStore, MemoryAgentProfileStore, MemoryConversationStore, MemoryMemoryStore,
        MemoryProjectMemoryStore, MemoryProjectStore, MemoryRequirementRunStore,
        MemoryRequirementStore,
    };
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;

    /// Stub LLM that returns a canned assistant message and a
    /// `Stop` finish reason — the agent loop runs exactly one
    /// turn and exits cleanly. `usage` is optional so individual
    /// tests can verify the agent loop forwards usage into the
    /// run row.
    struct CannedLlm {
        reply: String,
        calls: Option<Arc<AtomicUsize>>,
        usage: Option<harness_core::Usage>,
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
                usage: self.usage.clone(),
            })
        }
    }

    fn base_state_with_canned_llm(reply: &str) -> AppState {
        base_state_with_canned_llm_usage(reply, None)
    }

    fn base_state_with_canned_llm_usage(
        reply: &str,
        usage: Option<harness_core::Usage>,
    ) -> AppState {
        use crate::provider_registry::ProviderRegistry;
        let llm: Arc<dyn LlmProvider> = Arc::new(CannedLlm {
            reply: reply.to_string(),
            calls: None,
            usage,
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
            usage: None,
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
            .with_project_memory_store(Arc::new(MemoryProjectMemoryStore::new()))
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
        // `agent.max_concurrent_agents` now drives the real
        // global concurrency cap (was mis-mapped to per-tick burst
        // until v1.1). Per-tick stays at default.
        assert_eq!(c.max_units_per_tick, 1);
        assert_eq!(c.max_concurrent_units, 4);
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
            // High enough that the existing tests aren't gated on
            // the new concurrency cap; the dedicated cap test
            // configures its own value.
            max_concurrent_units: 32,
            max_retries: 2,
            run_timeout_ms: 5_000,
            allow_unassigned: false,
            default_assignee: None,
            workflow_prompt: None,
            reviewer_auto_accept: false,
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
    async fn tick_picks_requirement_without_assignee() {
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
        assert_eq!(n, 1);
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
                assert_eq!(saved.status, RequirementStatus::Review);
                assert!(
                    !saved.todos.is_empty(),
                    "auto mode must initialize the execution checklist"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_skips_project_when_project_auto_mode_disabled() {
        let state = wire_stores(base_state_with_canned_llm("should not run."));
        let (mut proj, prof) = seed_project_and_profile(&state).await;
        proj.automation.auto_mode_enabled = false;
        state.projects.as_ref().unwrap().save(&proj).await.unwrap();

        let mut req = Requirement::new(&proj.id, "paused project");
        req.assignee_id = Some(prof.id.clone());
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
                assert_eq!(saved.status, RequirementStatus::Review);
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("review drive_one never finished within 1s");
    }

    /// Jarvis owns acceptance now: Review rows remain eligible even
    /// when older completed runs exist. The execution checklist, not
    /// reviewer_auto_accept, decides whether the row can move to Done.
    #[tokio::test]
    async fn tick_does_not_re_pick_review_subagent_after_completed_run_under_reviewer_flag() {
        use harness_project::AcceptancePolicy;

        let state = wire_stores(base_state_with_canned_llm("MUST NOT BE CALLED."));
        let (proj, prof) = seed_project_and_profile(&state).await;

        let mut req = Requirement::new(&proj.id, "stuck at review");
        req.status = RequirementStatus::Review;
        // Subagent is the default but spell it out — the guard
        // depends on this.
        req.acceptance_policy = AcceptancePolicy::Subagent;
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        // Plant a Completed run as if `advance_completed_requirement`
        // had just dispatched the reviewer (and the reviewer failed).
        let mut completed = RequirementRun::new(&req.id, "conv-1");
        completed.status = RequirementRunStatus::Completed;
        completed.finished_at = Some(chrono::Utc::now().to_rfc3339());
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&completed)
            .await
            .unwrap();

        let mut c = cfg();
        c.reviewer_auto_accept = true;

        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 1);
    }

    /// Counterpart to the runaway-loop test: a Review row with NO
    /// completed runs (e.g. someone manually dragged a fresh card to
    /// Review on the kanban) is still picker-eligible under the
    /// reviewer_auto_accept flag — the agent runs once, completes,
    /// and `advance_completed_requirement` then dispatches the
    /// reviewer. The guard only fires AFTER a completed run exists.
    #[tokio::test]
    async fn tick_still_picks_review_row_with_no_completed_history_under_reviewer_flag() {
        use harness_project::AcceptancePolicy;

        let state = wire_stores(base_state_with_canned_llm("first review run."));
        let (proj, prof) = seed_project_and_profile(&state).await;

        let mut req = Requirement::new(&proj.id, "fresh review pickup");
        req.status = RequirementStatus::Review;
        req.acceptance_policy = AcceptancePolicy::Subagent;
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut c = cfg();
        c.reviewer_auto_accept = true;

        let n = tick(&state, &c).await.unwrap();
        assert_eq!(
            n, 1,
            "Review row with no completed runs must remain picker-eligible — the guard only blocks once dispatch has already been attempted",
        );
    }

    /// v1.2 — runaway-loop guard. Under default acceptance
    /// (`reviewer_auto_accept = false`), a Review row whose latest
    /// run completed cleanly has no autonomous path forward: nothing
    /// flips its boilerplate execution-checklist todos, no reviewer
    /// subagent dispatches. The picker must stop re-running it on
    /// every tick — that just burns LLM cycles and accelerates the
    /// retry-budget burn-down when the provider has partial outages.
    #[tokio::test]
    async fn tick_skips_review_with_completed_history_when_reviewer_flag_off() {
        use harness_project::AcceptancePolicy;

        let state = wire_stores(base_state_with_canned_llm("MUST NOT BE CALLED."));
        let (proj, prof) = seed_project_and_profile(&state).await;

        let mut req = Requirement::new(&proj.id, "review awaiting acceptance");
        req.status = RequirementStatus::Review;
        req.acceptance_policy = AcceptancePolicy::Subagent;
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut completed = RequirementRun::new(&req.id, "conv-1");
        completed.status = RequirementRunStatus::Completed;
        completed.finished_at = Some(chrono::Utc::now().to_rfc3339());
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&completed)
            .await
            .unwrap();

        // Default: reviewer_auto_accept stays false.
        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(
            n, 0,
            "Review + Completed history under default acceptance must be skipped",
        );
    }

    /// v1.2 — runtime override for `max_retries`. The picker's
    /// retry gate must read the runtime override (set via
    /// `POST /v1/auto-mode {max_retries}`) when present, falling
    /// back to the static `AutoModeConfig::max_retries` only when
    /// the override is unset.
    #[tokio::test]
    async fn tick_picker_honours_runtime_max_retries_override() {
        let state = wire_stores(base_state_with_canned_llm("retry-budget probe."));
        let runtime = AutoModeRuntime::with_capacity(AutoMode::Auto, 4);
        let state = state.with_auto_mode_runtime(runtime.clone());
        let (proj, prof) = seed_project_and_profile(&state).await;

        let mut req = Requirement::new(&proj.id, "wedged on transport faults");
        req.status = RequirementStatus::InProgress;
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        // Plant 2 consecutive failed runs, no successes.
        for i in 0..2 {
            let mut failed = RequirementRun::new(&req.id, format!("conv-{i}"));
            failed.status = RequirementRunStatus::Failed;
            failed.error = Some("agent error: simulated".into());
            // Old timestamp so the v1.1 backoff doesn't gate us.
            failed.finished_at = Some("2026-01-01T00:00:00+00:00".into());
            state
                .requirement_runs
                .as_ref()
                .unwrap()
                .upsert(&failed)
                .await
                .unwrap();
        }

        // Static config caps at 1 → picker would skip.
        let mut c = cfg();
        c.max_retries = 1;
        assert_eq!(
            tick(&state, &c).await.unwrap(),
            0,
            "static max_retries=1 with 2 failed runs must skip",
        );

        // Runtime override of 5 → picker proceeds.
        runtime.set_max_retries_override(Some(5));
        assert_eq!(
            tick(&state, &c).await.unwrap(),
            1,
            "runtime override should beat the static cap on the next tick",
        );

        // Clearing the override restores the static cap.
        runtime.set_max_retries_override(None);
        assert!(runtime.max_retries_override().is_none());
        assert_eq!(
            runtime.effective_max_retries(&c),
            1,
            "cleared override falls back to static cap",
        );
    }

    /// Legacy `AcceptancePolicy::Human` no longer blocks Jarvis.
    /// Jarvis owns both progression and completion.
    #[tokio::test]
    async fn tick_skips_human_acceptance_policy_at_review() {
        use harness_project::AcceptancePolicy;

        let state = wire_stores(base_state_with_canned_llm("review accepted."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "human review");
        req.status = RequirementStatus::Review;
        req.assignee_id = Some(prof.id.clone());
        req.acceptance_policy = AcceptancePolicy::Human;
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1, "Human policy row at Review is still Jarvis-owned");
    }

    /// v1.0 SubAgent — when a run completes against an
    /// `InProgress` row whose `acceptance_policy == Human`, the
    /// requirement advances to Review (not Done). Mirrors the v0
    /// "completed under Subagent → Done" flow but proves the Human
    /// gate kicks in at the right place.
    #[tokio::test]
    async fn tick_advances_human_policy_in_progress_to_review() {
        use harness_project::AcceptancePolicy;

        let state = wire_stores(base_state_with_canned_llm("done"));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "human gate from in_progress");
        req.assignee_id = Some(prof.id.clone());
        req.acceptance_policy = AcceptancePolicy::Human;
        // status defaults to Backlog → first tick will start it.
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1);

        // Wait for the spawned drive task to mark the run terminal,
        // then assert the requirement landed at Review (not Done).
        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            if runs.iter().any(|r| r.status.is_terminal()) {
                let saved = state
                    .requirements
                    .as_ref()
                    .unwrap()
                    .get(&req.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    saved.status,
                    RequirementStatus::Review,
                    "Human policy must hold the row at Review",
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("human-policy drive_one never finished within 1s");
    }

    /// Direct unit test on the pure target-status function — no
    /// async, no stores, just the execution-checklist completion gate.
    #[test]
    fn completed_target_status_respects_execution_checklist() {
        use harness_project::{VerificationResult, VerificationStatus};

        fn run(
            status: RequirementRunStatus,
            verification: Option<VerificationStatus>,
        ) -> RequirementRun {
            let mut r = RequirementRun::new("req", "conv");
            r.status = status;
            if let Some(v) = verification {
                r.verification = Some(VerificationResult {
                    status: v,
                    command_results: vec![],
                    diff_summary: None,
                    notes: None,
                });
            }
            r
        }

        fn req(status: RequirementStatus, todo_statuses: &[RequirementTodoStatus]) -> Requirement {
            let mut r = Requirement::new("proj", "title");
            r.status = status;
            r.todos = todo_statuses
                .iter()
                .enumerate()
                .map(|(idx, status)| {
                    let mut todo = RequirementTodo::new(
                        format!("step {}", idx + 1),
                        RequirementTodoKind::Check,
                    );
                    todo.status = *status;
                    todo
                })
                .collect();
            r
        }

        let r = req(
            RequirementStatus::InProgress,
            &[RequirementTodoStatus::Passed],
        );
        assert_eq!(
            completed_requirement_target_status(&r, &run(RequirementRunStatus::Completed, None)),
            Some(RequirementStatus::Done),
        );

        let r = req(
            RequirementStatus::InProgress,
            &[RequirementTodoStatus::Pending],
        );
        assert_eq!(
            completed_requirement_target_status(&r, &run(RequirementRunStatus::Completed, None)),
            Some(RequirementStatus::Review),
        );

        let r = req(
            RequirementStatus::InProgress,
            &[RequirementTodoStatus::Failed],
        );
        assert_eq!(
            completed_requirement_target_status(&r, &run(RequirementRunStatus::Completed, None)),
            Some(RequirementStatus::InProgress),
        );

        let r = req(
            RequirementStatus::InProgress,
            &[RequirementTodoStatus::Passed],
        );
        assert_eq!(
            completed_requirement_target_status(
                &r,
                &run(
                    RequirementRunStatus::Completed,
                    Some(VerificationStatus::NeedsReview)
                ),
            ),
            Some(RequirementStatus::Review),
        );

        let r = req(RequirementStatus::Review, &[RequirementTodoStatus::Passed]);
        assert_eq!(
            completed_requirement_target_status(&r, &run(RequirementRunStatus::Completed, None)),
            Some(RequirementStatus::Done),
        );

        // Non-terminal runs never advance status.
        let r = req(
            RequirementStatus::InProgress,
            &[RequirementTodoStatus::Passed],
        );
        for non_terminal in [RequirementRunStatus::Pending, RequirementRunStatus::Running] {
            assert_eq!(
                completed_requirement_target_status(&r, &run(non_terminal, None)),
                None,
            );
        }
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
        let mut pass = harness_project::RequirementTodo::new("pass check", RequirementTodoKind::Ci);
        pass.command = Some(pass_cmd.into());
        let mut fail = harness_project::RequirementTodo::new("fail check", RequirementTodoKind::Ci);
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
    async fn tick_reclaims_stale_running_run_after_safety_multiplier() {
        // Models the failure mode the watchdog was extended for:
        // a Running row was minted by `drive_one_with_prompt` but
        // the spawned tokio task panicked before it could write a
        // terminal status. The in-flight guard would otherwise pin
        // this requirement forever; the watchdog must reap it once
        // age > run_timeout_ms * RUNNING_STALE_MULTIPLIER.
        let state = wire_stores(base_state_with_canned_llm("fresh run."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "stale running");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut stuck = RequirementRun::new(&req.id, "stuck-conv");
        stuck.status = RequirementRunStatus::Running;
        // Plant a started_at well past the safety window
        // (multiplier=3, so 60s is way over even with a 5s timeout).
        stuck.started_at = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
        let stuck_id = stuck.id.clone();
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&stuck)
            .await
            .unwrap();

        let mut c = cfg();
        c.run_timeout_ms = 1; // 1ms × 3 = 3ms threshold; 60s row is way past it
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 1, "stuck running should not block a fresh pickup");

        for _ in 0..50 {
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_for_requirement(&req.id)
                .await
                .unwrap();
            let reaped = runs.iter().find(|r| r.id == stuck_id).unwrap();
            assert_eq!(reaped.status, RequirementRunStatus::Cancelled);
            assert!(reaped
                .error
                .as_deref()
                .unwrap_or("")
                .contains("stuck running"));
            if runs
                .iter()
                .any(|r| r.id != stuck_id && r.status == RequirementRunStatus::Completed)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("fresh pickup after stale running reclaim did not finish within 1s");
    }

    #[tokio::test]
    async fn tick_keeps_recent_running_run_inflight() {
        // Inverse of the reap test: a Running row inside the safety
        // window must NOT be touched, otherwise we'd pre-empt
        // legitimate long-running work. The in-flight guard then
        // correctly skips the requirement this tick.
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "live running");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let mut live = RequirementRun::new(&req.id, "live-conv");
        live.status = RequirementRunStatus::Running;
        // started_at = now (well within run_timeout_ms × 3 = 15s)
        let live_id = live.id.clone();
        state
            .requirement_runs
            .as_ref()
            .unwrap()
            .upsert(&live)
            .await
            .unwrap();

        let c = cfg(); // run_timeout_ms = 5_000, threshold = 15_000
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 0, "live running run must block fresh pickup");

        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        let same = runs.iter().find(|r| r.id == live_id).unwrap();
        assert_eq!(
            same.status,
            RequirementRunStatus::Running,
            "live running row must be left alone within the safety window"
        );
        assert!(same.finished_at.is_none(), "no terminal timestamp expected");
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

    /// Stub LLM that records peak concurrency (how many `complete`
    /// calls were in flight at the same moment). Sleeps briefly
    /// inside `complete` so several tasks can pile up if the
    /// semaphore isn't gating them.
    struct ConcurrencyProbeLlm {
        inflight: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        hold_ms: u64,
    }
    #[async_trait::async_trait]
    impl LlmProvider for ConcurrencyProbeLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            let now = self.inflight.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            // Atomic-CAS bump of `peak` to max(peak, now).
            let mut snap = self.peak.load(AtomicOrdering::SeqCst);
            while snap < now {
                match self.peak.compare_exchange(
                    snap,
                    now,
                    AtomicOrdering::SeqCst,
                    AtomicOrdering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(actual) => snap = actual,
                }
            }
            tokio::time::sleep(Duration::from_millis(self.hold_ms)).await;
            self.inflight.fetch_sub(1, AtomicOrdering::SeqCst);
            Ok(ChatResponse {
                message: Message::assistant_text("ok."),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    #[tokio::test]
    async fn auto_mode_semaphore_caps_concurrent_drive_tasks() {
        // Cap at 2; spawn 4 candidates in one tick. The probe LLM
        // records peak in-flight; with the gate working we should
        // never see more than 2 simultaneous `complete` calls even
        // though 4 drive tasks are running.
        use crate::provider_registry::ProviderRegistry;
        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let llm: Arc<dyn LlmProvider> = Arc::new(ConcurrencyProbeLlm {
            inflight: inflight.clone(),
            peak: peak.clone(),
            hold_ms: 80,
        });
        let mut registry = ProviderRegistry::new("canned");
        registry.insert("canned", llm, "canned-model".to_string());
        let cfg_template = AgentConfig::new("canned-model");
        let bare = AppState::from_registry(registry, cfg_template);

        // Pre-create the runtime with capacity=2 so the gate is in
        // place before `tick` runs (mirrors what apps/jarvis::serve
        // does at startup).
        let bare = bare.with_auto_mode_runtime(AutoModeRuntime::with_capacity(AutoMode::Auto, 2));
        let state = wire_stores(bare);
        let (proj, prof) = seed_project_and_profile(&state).await;

        for i in 0..4 {
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
        c.max_units_per_tick = 4; // spawn all four in one tick
        c.max_concurrent_units = 2; // … but only two run in parallel
        c.run_timeout_ms = 5_000;
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 4, "tick should pick up all four candidates");

        // Wait for all spawned drive tasks to finish — generous
        // upper bound: 4 reqs × 80 ms hold ÷ 2 permits ≈ 160 ms,
        // plus per-task setup + agent loop overhead. 5s is plenty
        // and only matters when the cap is broken.
        //
        // Three-way exit condition: (1) no LLM calls in flight,
        // (2) the store has all four run rows (i.e. every spawned
        // drive task got past its initial `Pending` upsert), and
        // (3) none of those rows is still Pending/Running. Without
        // (2) the loop can race-exit on a slow CI runner where the
        // last two drive tasks haven't started yet — leaving a
        // mysterious "completed=2 of 4" failure downstream.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let runs = state
                .requirement_runs
                .as_ref()
                .unwrap()
                .list_all(50)
                .await
                .unwrap();
            let pending_or_running = runs
                .iter()
                .filter(|r| {
                    matches!(
                        r.status,
                        RequirementRunStatus::Pending | RequirementRunStatus::Running
                    )
                })
                .count();
            if inflight.load(AtomicOrdering::SeqCst) == 0
                && runs.len() >= 4
                && pending_or_running == 0
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "drive tasks did not finish within 5s; inflight={} peak={} runs_total={} pending_or_running={}",
                inflight.load(AtomicOrdering::SeqCst),
                peak.load(AtomicOrdering::SeqCst),
                runs.len(),
                pending_or_running,
            );
        }

        // Core assertion: peak in-flight LLM calls never exceeded
        // the configured cap. If the semaphore weren't there, peak
        // would race towards 4.
        let observed_peak = peak.load(AtomicOrdering::SeqCst);
        assert!(
            observed_peak <= 2,
            "concurrency cap broken: peak in-flight LLM calls = {observed_peak}, expected ≤ 2"
        );
        // And every requirement was eventually processed (so the
        // queue drained — no permanent starvation).
        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_all(50)
            .await
            .unwrap();
        let completed = runs
            .iter()
            .filter(|r| matches!(r.status, RequirementRunStatus::Completed))
            .count();
        let total = runs.len();
        let by_status: std::collections::HashMap<&str, usize> =
            runs.iter()
                .fold(std::collections::HashMap::new(), |mut acc, r| {
                    *acc.entry(r.status.as_wire()).or_insert(0) += 1;
                    acc
                });
        assert_eq!(
            completed, 4,
            "all four requirements should drain through the queue; total={total} by_status={by_status:?}"
        );
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
        // Park the dep outside approved auto execution so it doesn't
        // get picked itself while still blocking the child.
        dep.status = RequirementStatus::Review;
        dep.triage_state = TriageState::ProposedByAgent;
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
    async fn auto_run_persists_usage_and_model_onto_run_row() {
        // CannedLlm reports a single Usage; the agent loop should
        // sum it into the run's `usage` field and stamp the model
        // it routed to. Provides the source-of-truth for the
        // /v1/runs/:id token columns.
        let usage = harness_core::Usage {
            prompt_tokens: Some(1234),
            completion_tokens: Some(56),
            cached_prompt_tokens: Some(78),
            reasoning_tokens: Some(9),
        };
        let state = wire_stores(base_state_with_canned_llm_usage(
            "done.",
            Some(usage.clone()),
        ));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "needs token tracking");
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
            if let Some(run) = runs.iter().find(|r| r.status.is_terminal()) {
                assert_eq!(run.status, RequirementRunStatus::Completed);
                let actual = run
                    .usage
                    .as_ref()
                    .expect("agent loop must persist usage onto the run row");
                assert_eq!(actual.prompt_tokens, Some(1234));
                assert_eq!(actual.completion_tokens, Some(56));
                assert_eq!(actual.cached_prompt_tokens, Some(78));
                assert_eq!(actual.reasoning_tokens, Some(9));
                assert_eq!(
                    run.model.as_deref(),
                    Some("canned-model"),
                    "model the run routed to must be stamped on the row"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("usage-aware drive_one did not finish within 1s");
    }

    #[test]
    fn usage_add_merges_per_iteration_counters() {
        let mut total = harness_core::Usage::default();
        total.add(&harness_core::Usage {
            prompt_tokens: Some(100),
            completion_tokens: Some(20),
            cached_prompt_tokens: None,
            reasoning_tokens: Some(5),
        });
        total.add(&harness_core::Usage {
            prompt_tokens: Some(50),
            completion_tokens: None,
            cached_prompt_tokens: Some(30),
            reasoning_tokens: Some(7),
        });
        assert_eq!(total.prompt_tokens, Some(150));
        assert_eq!(total.completion_tokens, Some(20));
        assert_eq!(total.cached_prompt_tokens, Some(30));
        assert_eq!(total.reasoning_tokens, Some(12));
    }

    #[tokio::test]
    async fn reaper_runs_independent_of_enable_flag() {
        // Models the `feat/auto_project` ghost-row case: a Pending
        // row sits in the store while auto mode is disabled; the
        // tick gate would otherwise skip the reaper entirely. The
        // decoupled top-level reaper must reap it regardless.
        let state = wire_stores(base_state_with_canned_llm("ignored"));
        let runs = state.requirement_runs.as_ref().unwrap();
        let mut stale = RequirementRun::new("req-orphan", "conv-orphan");
        stale.status = RequirementRunStatus::Pending;
        stale.started_at = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
        let stale_id = stale.id.clone();
        runs.upsert(&stale).await.unwrap();

        let mut c = cfg();
        c.run_timeout_ms = 1; // make the row well past the threshold

        // Reaper runs without going through `tick()` and without
        // checking the enable flag.
        reap_all_stale_inflight_runs(&state, &c).await;

        let after = runs.get(&stale_id).await.unwrap().unwrap();
        assert_eq!(after.status, RequirementRunStatus::Cancelled);
        assert!(after.finished_at.is_some());
        assert!(after
            .error
            .as_deref()
            .unwrap_or("")
            .contains("stale pending"));
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

    fn fake_run(req_id: &str, status: RequirementRunStatus, started_at: &str) -> RequirementRun {
        let mut r = RequirementRun::new(req_id, "conv");
        r.status = status;
        r.started_at = started_at.to_string();
        if status.is_terminal() {
            r.finished_at = Some(started_at.to_string());
        }
        r
    }

    #[test]
    fn consecutive_failed_resets_after_completed() {
        // Newest-first ordering matches what the store returns.
        let history = vec![
            fake_run("r", RequirementRunStatus::Failed, "2026-05-07T03:00:00Z"),
            fake_run("r", RequirementRunStatus::Completed, "2026-05-07T02:00:00Z"),
            fake_run("r", RequirementRunStatus::Failed, "2026-05-07T01:00:00Z"),
            fake_run("r", RequirementRunStatus::Failed, "2026-05-07T00:00:00Z"),
        ];
        // Only the failure newer than the most recent Completed counts.
        assert_eq!(consecutive_failed_since_last_success(&history), 1);
    }

    #[test]
    fn consecutive_failed_ignores_cancelled_runs() {
        let history = vec![
            fake_run("r", RequirementRunStatus::Cancelled, "2026-05-07T03:00:00Z"),
            fake_run("r", RequirementRunStatus::Failed, "2026-05-07T02:00:00Z"),
            fake_run("r", RequirementRunStatus::Cancelled, "2026-05-07T01:00:00Z"),
            fake_run("r", RequirementRunStatus::Failed, "2026-05-07T00:00:00Z"),
        ];
        // Two Failed, no Completed, two Cancelled in between — counter
        // sees 2. Cancelled (timeout reaper / manual abort) is neither
        // success nor failure for retry budgeting.
        assert_eq!(consecutive_failed_since_last_success(&history), 2);
    }

    #[test]
    fn failure_backoff_grows_then_caps() {
        // tick_seconds=30 → base = 30_000ms, doubling per failure.
        assert_eq!(failure_backoff_ms(0, 30), 0);
        assert_eq!(failure_backoff_ms(1, 30), 30_000);
        assert_eq!(failure_backoff_ms(2, 30), 60_000);
        assert_eq!(failure_backoff_ms(3, 30), 120_000);
        // 6 doublings on a 30s base = 30 * 64 = 1920s = 32min, still
        // under the 1h cap.
        assert_eq!(failure_backoff_ms(7, 30), 30_000 * 64);
        // 13th failure would be 30 * 4096 = ~34h without the cap.
        assert_eq!(failure_backoff_ms(13, 30), FAILURE_BACKOFF_MAX_MS);
        // tick_seconds=1 — base is floored at 30s so dev/test
        // configurations don't hammer.
        assert_eq!(failure_backoff_ms(1, 1), FAILURE_BACKOFF_BASE_FLOOR_MS);
    }

    #[test]
    fn failure_backoff_remaining_handles_clock_skew_and_missing_timestamps() {
        let mut run = RequirementRun::new("req", "conv");
        run.status = RequirementRunStatus::Failed;
        // future-dated finished_at — must NOT pin the requirement.
        run.finished_at = Some((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        assert_eq!(
            failure_backoff_remaining_ms(&run, 60_000),
            None,
            "future timestamp from clock skew must read as elapsed, not blocking"
        );

        run.finished_at = None;
        run.started_at = chrono::Utc::now().to_rfc3339();
        assert!(
            failure_backoff_remaining_ms(&run, 60_000).is_some(),
            "missing finished_at should fall back to started_at"
        );

        run.finished_at = Some("not-a-timestamp".to_string());
        assert_eq!(
            failure_backoff_remaining_ms(&run, 60_000),
            None,
            "unparseable timestamp must read as elapsed (fail open)"
        );
    }

    #[tokio::test]
    async fn tick_picks_again_after_failure_then_success_history() {
        // Old all-time counter would lock this row out forever (any
        // Failed run >= max_retries=1). New consecutive counter sees
        // the Completed run reset the budget.
        let state = wire_stores(base_state_with_canned_llm("retry succeeds."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "post-success retry");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let runs = state.requirement_runs.as_ref().unwrap();
        // Oldest: a Failed run from 2 hours ago.
        let mut failed = RequirementRun::new(&req.id, "c-failed");
        failed.started_at = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        failed.status = RequirementRunStatus::Failed;
        failed.finished_at = Some(failed.started_at.clone());
        runs.upsert(&failed).await.unwrap();
        // Mid: a Completed run from 1 hour ago — resets the counter.
        let mut completed = RequirementRun::new(&req.id, "c-completed");
        completed.started_at = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        completed.status = RequirementRunStatus::Completed;
        completed.finished_at = Some(completed.started_at.clone());
        runs.upsert(&completed).await.unwrap();

        let mut c = cfg();
        c.max_retries = 1; // production default — strictest possible.
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(
            n, 1,
            "consecutive counter should ignore failures before the latest success"
        );
    }

    // Phase 1 self-improving-agent — sibling of the test below
    // (`failed_run_captures_project_memory_with_provenance`). Verifies
    // the new row-based `MemoryStore` write path independent of the
    // older `ProjectMemoryStore` one.

    fn synth_failed_run(req_id: &str, run_id: &str, error: &str) -> RequirementRun {
        // `RequirementRun::new(req_id, conversation_id)` auto-allocates
        // a UUID for `run.id`; we override here so the test can assert
        // the exact provenance round-trips through `MemorySource::Run`.
        let mut run = RequirementRun::new(req_id, "conv-fixture");
        run.id = run_id.to_string();
        run.status = RequirementRunStatus::Failed;
        run.error = Some(error.into());
        run.started_at = chrono::Utc::now().to_rfc3339();
        run.finished_at = Some(run.started_at.clone());
        run
    }

    #[tokio::test]
    async fn capture_failure_learning_memory_writes_gotcha_with_run_source() {
        let state = base_state_with_canned_llm("ignored").with_user_memory_store(Arc::new(
            MemoryMemoryStore::new(),
        ));
        let mut req = Requirement::new("proj-1", "Title goes here");
        req.id = "req-fixture".into();
        let run = synth_failed_run(&req.id, "run-fixture", "tests panicked");

        capture_failure_learning_memory(&state, &req, &run).await;

        let rows = state
            .learning_memory
            .as_ref()
            .unwrap()
            .list(harness_learning::MemoryFilter::default())
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "exactly one gotcha per failed run");
        let m = &rows[0];
        assert_eq!(m.kind, harness_learning::MemoryKind::Gotcha);
        match &m.scope {
            harness_learning::MemoryScope::Project { project_id } => {
                assert_eq!(project_id, "proj-1");
            }
            other => panic!("expected Project scope, got {other:?}"),
        }
        match &m.source {
            harness_learning::MemorySource::Run { run_id } => {
                assert_eq!(run_id, "run-fixture");
            }
            other => panic!("expected Run source, got {other:?}"),
        }
        assert!(m.title.contains("Title goes here"));
        assert!(m.body.contains("tests panicked"));
        assert!(m.tags.iter().any(|t| t == "requirement:req-fixture"));
        assert!((m.confidence - 0.7).abs() < f32::EPSILON);
    }

    #[tokio::test]
    async fn capture_failure_learning_memory_skips_non_failed_runs() {
        let state = base_state_with_canned_llm("ignored").with_user_memory_store(Arc::new(
            MemoryMemoryStore::new(),
        ));
        let req = Requirement::new("proj-x", "ok one");
        let mut run = synth_failed_run(&req.id, "rid", "unused");
        run.status = RequirementRunStatus::Completed;
        capture_failure_learning_memory(&state, &req, &run).await;
        let rows = state
            .learning_memory
            .as_ref()
            .unwrap()
            .list(harness_learning::MemoryFilter::default())
            .await
            .unwrap();
        assert!(rows.is_empty(), "completed runs must not write a gotcha");
    }

    #[tokio::test]
    async fn capture_failure_learning_memory_no_op_when_store_missing() {
        // Don't wire a learning_memory store at all — function must
        // return silently without panicking.
        let state = base_state_with_canned_llm("ignored");
        assert!(state.learning_memory.is_none());
        let req = Requirement::new("proj-y", "no store");
        let run = synth_failed_run(&req.id, "r1", "boom");
        capture_failure_learning_memory(&state, &req, &run).await;
        // No assertion possible; not panicking is the test.
    }

    #[tokio::test]
    async fn failed_run_captures_project_memory_with_provenance() {
        // Verification-only path: failing command marks the run
        // Failed; auto loop must drop a `gotcha` memory carrying the
        // run + requirement ids + the stderr we'll care about next
        // time.
        let project_dir = tempfile::tempdir().unwrap();
        let (state, _llm_calls) = state_with_counting_llm("ignored");
        let state = wire_stores(state).with_workspace_root(project_dir.path().to_path_buf());
        let mut proj = Project::new("Memory capture", "instructions");
        proj.slug = "memory-capture".into();
        state.projects.as_ref().unwrap().save(&proj).await.unwrap();
        let prof = AgentProfile::new("Auto Alice", "canned", "canned-model");
        state
            .agent_profiles
            .as_ref()
            .unwrap()
            .upsert(&prof)
            .await
            .unwrap();

        let fail_cmd = "printf 'boom from cmd' >&2; exit 7";
        let mut req = Requirement::new(&proj.id, "boom requirement");
        req.assignee_id = Some(prof.id.clone());
        req.verification_plan = Some(VerificationPlan {
            commands: vec![fail_cmd.into()],
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        });
        let mut todo = harness_project::RequirementTodo::new("fails", RequirementTodoKind::Ci);
        todo.command = Some(fail_cmd.into());
        req.todos = vec![todo];
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
                assert_eq!(run.status, RequirementRunStatus::Failed);
                let memories = state
                    .project_memories
                    .as_ref()
                    .unwrap()
                    .list(&proj.id)
                    .await
                    .unwrap();
                assert_eq!(memories.len(), 1, "exactly one gotcha per failed run");
                let m = &memories[0];
                assert_eq!(m.kind, ProjectMemoryKind::Gotcha);
                assert_eq!(m.project_id, proj.id);
                assert_eq!(m.source_run_id.as_deref(), Some(run.id.as_str()));
                assert_eq!(m.source_requirement_id.as_deref(), Some(req.id.as_str()));
                assert!(
                    m.title.contains("boom requirement"),
                    "title should reference the requirement: {}",
                    m.title
                );
                assert!(
                    m.body.contains("boom from cmd"),
                    "body should retain stderr context: {}",
                    m.body
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("verification-only failure did not finalize within 1s");
    }

    #[tokio::test]
    async fn project_memory_is_injected_into_next_run_system_prompt() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let memory = ProjectMemory::new(
            &proj.id,
            ProjectMemoryKind::Gotcha,
            "Cargo build needs nightly toolchain",
            "Last run failed because rustc was on stable; rerun with rustup default nightly.",
        );
        state
            .project_memories
            .as_ref()
            .unwrap()
            .upsert(&memory)
            .await
            .unwrap();

        let mut req = Requirement::new(&proj.id, "fresh pickup with memory");
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
            if let Some(run) = runs.iter().find(|r| r.status.is_terminal()) {
                assert_eq!(run.status, RequirementRunStatus::Completed);
                let convo = state
                    .store
                    .as_ref()
                    .unwrap()
                    .load(&run.conversation_id)
                    .await
                    .unwrap()
                    .expect("conversation should be saved");
                let system = convo
                    .messages
                    .iter()
                    .find_map(|m| match m {
                        Message::System { content, .. } => Some(content.clone()),
                        _ => None,
                    })
                    .expect("system message should exist");
                assert!(
                    system.contains("=== project memory ==="),
                    "system prompt should include the project memory section: {system}"
                );
                assert!(
                    system.contains("Cargo build needs nightly toolchain"),
                    "system prompt should include the memory title: {system}"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("drive_one with memory did not finish within 1s");
    }

    #[tokio::test]
    async fn tick_blocks_within_failure_backoff_then_unblocks() {
        let state = wire_stores(base_state_with_canned_llm("ok after backoff."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "backoff guarded");
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let runs = state.requirement_runs.as_ref().unwrap();
        let mut recent = RequirementRun::new(&req.id, "c-fresh");
        recent.status = RequirementRunStatus::Failed;
        // finished just now → backoff window fully open.
        recent.started_at = chrono::Utc::now().to_rfc3339();
        recent.finished_at = Some(recent.started_at.clone());
        runs.upsert(&recent).await.unwrap();

        let mut c = cfg();
        c.max_retries = 5; // not the gate we're testing
        c.tick_seconds = 30; // 30s base ≥ floor; keeps test fast
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 0, "fresh failure must be in backoff window");

        // Backdate the failure past the backoff window.
        let mut backdated = recent.clone();
        backdated.started_at = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        backdated.finished_at = Some(backdated.started_at.clone());
        runs.upsert(&backdated).await.unwrap();
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 1, "elapsed backoff window must let the row through");
    }

    // ---- depends_on cycle detection (issue #97) -----------------------

    /// Build a requirement with a known id and dependency list, so the
    /// graph-shape tests below can wire edges deterministically.
    fn req_with_deps(id: &str, deps: &[&str]) -> Requirement {
        let mut r = Requirement::new("proj", id);
        r.id = id.to_string();
        r.depends_on = deps.iter().map(|s| s.to_string()).collect();
        r
    }

    #[test]
    fn cycle_detection_flags_self_loop() {
        let reqs = vec![req_with_deps("a", &["a"])];
        let blocked = cycle_blocked_requirement_ids(&reqs);
        assert!(blocked.contains("a"), "self-loop must be flagged");
    }

    #[test]
    fn cycle_detection_flags_mutual_cycle_and_dependents() {
        // a→b, b→a (cycle); c→a (behind the cycle); d standalone.
        let reqs = vec![
            req_with_deps("a", &["b"]),
            req_with_deps("b", &["a"]),
            req_with_deps("c", &["a"]),
            req_with_deps("d", &[]),
        ];
        let blocked = cycle_blocked_requirement_ids(&reqs);
        assert!(blocked.contains("a"), "cycle member a flagged");
        assert!(blocked.contains("b"), "cycle member b flagged");
        assert!(blocked.contains("c"), "dependent behind cycle flagged");
        assert!(!blocked.contains("d"), "standalone row not flagged");
    }

    #[test]
    fn cycle_detection_ignores_acyclic_and_unknown_deps() {
        // a→b→done-chain is acyclic; e depends on an unknown
        // (cross-project / deleted) id, which must NOT count as a
        // cycle (the unknown-id block is handled by the caller).
        let reqs = vec![
            req_with_deps("a", &["b"]),
            req_with_deps("b", &[]),
            req_with_deps("e", &["external-id"]),
        ];
        let blocked = cycle_blocked_requirement_ids(&reqs);
        assert!(blocked.is_empty(), "no cycles → empty set, got {blocked:?}");
    }

    #[tokio::test]
    async fn tick_surfaces_self_dependency_as_blocked_activity() {
        let state = wire_stores(base_state_with_canned_llm("done."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "self blocked");
        req.status = RequirementStatus::Backlog;
        req.triage_state = TriageState::Approved;
        req.assignee_id = Some(prof.id.clone());
        req.depends_on = vec![req.id.clone()];
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 0, "self-dependency must not be picked up");

        let acts = state
            .activities
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        let blocked: Vec<_> = acts
            .iter()
            .filter(|a| a.kind == ActivityKind::Blocked)
            .collect();
        assert_eq!(blocked.len(), 1, "exactly one blocked row surfaced");
        assert_eq!(
            blocked[0].body.get("reason").and_then(|v| v.as_str()),
            Some("self_dependency")
        );

        // A second tick must NOT re-emit (dedup on newest row).
        let _ = tick(&state, &cfg()).await.unwrap();
        let acts2 = state
            .activities
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        let blocked2 = acts2.iter().filter(|a| a.kind == ActivityKind::Blocked).count();
        assert_eq!(blocked2, 1, "blocked row must not be re-emitted each tick");
    }


    /// Regression (issue #80): a requirement bound to a declarative
    /// workflow must mint a `RequirementRun` and advance its status, so
    /// the auto loop's in-flight / retry guards and status filter apply.
    /// Before the fix the workflow branch returned before any bookkeeping,
    /// so the same approved row was re-dispatched on every tick forever.
    #[tokio::test]
    async fn tick_workflow_requirement_mints_run_and_is_not_re_picked() {
        use harness_workflow::{WorkflowDefinition, WorkflowStep, WorkflowStepKind};

        let state = wire_stores(base_state_with_canned_llm("workflow step done."))
            .with_workflows(Arc::new(harness_store::MemoryWorkflowStore::new()));
        let (proj, prof) = seed_project_and_profile(&state).await;

        // One-step workflow the requirement binds to.
        let mut def = WorkflowDefinition::new("wf");
        def.steps.push(WorkflowStep::new(
            "only step",
            WorkflowStepKind::Agent {
                prompt: "do the thing".into(),
                subagent: None,
                model: None,
                output_key: None,
            },
        ));
        state.workflows.as_ref().unwrap().upsert(&def).await.unwrap();

        let mut req = Requirement::new(&proj.id, "workflow-bound");
        req.workflow_id = Some(def.id.clone());
        req.assignee_id = Some(prof.id.clone());
        state
            .requirements
            .as_ref()
            .unwrap()
            .upsert(&req)
            .await
            .unwrap();

        // First tick picks the row exactly once.
        let n = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n, 1, "workflow-bound requirement should be picked once");

        // Wait for the spawned workflow run to advance the requirement
        // off Backlog (which happens after the run lands terminal).
        let mut advanced = None;
        for _ in 0..50 {
            let saved = state
                .requirements
                .as_ref()
                .unwrap()
                .get(&req.id)
                .await
                .unwrap()
                .unwrap();
            if saved.status != RequirementStatus::Backlog {
                advanced = Some(saved);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let saved = advanced.expect("workflow requirement never advanced off Backlog");
        // A clean run lands at Review (awaiting acceptance), not eligible
        // for re-pickup once a completed run exists.
        assert_eq!(saved.status, RequirementStatus::Review);

        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        assert_eq!(runs.len(), 1, "exactly one RequirementRun should be minted");
        assert_eq!(runs[0].status, RequirementRunStatus::Completed);

        // Second tick must NOT re-dispatch — the core of the bug.
        let n2 = tick(&state, &cfg()).await.unwrap();
        assert_eq!(n2, 0, "completed workflow row must not be re-picked");
        let runs = state
            .requirement_runs
            .as_ref()
            .unwrap()
            .list_for_requirement(&req.id)
            .await
            .unwrap();
        assert_eq!(runs.len(), 1, "no second run may be minted on re-tick");
    }
}
