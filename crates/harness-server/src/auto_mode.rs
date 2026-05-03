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

use std::path::PathBuf;
use std::time::Duration;

use harness_core::{
    ActivityActor, ActivityKind, AgentProfile, Conversation, ConversationMetadata, Message,
    Requirement, RequirementRun, RequirementRunEvent, RequirementRunStatus, RequirementStatus,
    VerificationStatus,
};
use harness_requirement::{build_default_manifest, render_manifest_summary};
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
}

impl Default for AutoModeConfig {
    fn default() -> Self {
        Self {
            mode: AutoMode::Off,
            tick_seconds: 30,
            max_units_per_tick: 1,
            max_retries: 1,
            run_timeout_ms: 5 * 60 * 1000,
        }
    }
}

/// Spawn the background loop. No-op when `config.mode == Off` —
/// the binary calls this unconditionally and the function decides
/// whether to actually start anything.
pub fn spawn(state: AppState, config: AutoModeConfig) {
    if config.mode == AutoMode::Off {
        return;
    }
    info!(
        tick_s = config.tick_seconds,
        max_units = config.max_units_per_tick,
        max_retries = config.max_retries,
        run_timeout_ms = config.run_timeout_ms,
        "auto mode loop starting"
    );
    tokio::spawn(async move {
        // Tokio's default first-tick is immediate; we want a
        // grace period for the rest of startup to settle.
        let mut interval = tokio::time::interval(Duration::from_secs(config.tick_seconds));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // consume the immediate first tick
        loop {
            interval.tick().await;
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
    let Some(profiles) = state.agent_profiles.as_ref() else {
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
        let reqs = requirements
            .list(&project.id)
            .await
            .map_err(|e| format!("list requirements({}): {e}", project.id))?;
        for req in reqs {
            if picked >= config.max_units_per_tick {
                break;
            }
            // --- eligibility filter --------------------------
            if !matches!(
                req.status,
                RequirementStatus::Backlog | RequirementStatus::InProgress
            ) {
                continue;
            }
            let Some(assignee_id) = req.assignee_id.clone() else {
                continue;
            };
            let history = runs
                .list_for_requirement(&req.id)
                .await
                .map_err(|e| format!("list runs({}): {e}", req.id))?;
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
            let Ok(Some(profile)) = profiles.get(&assignee_id).await else {
                // Assignee dangling. Skip silently — the user
                // can clean up via PATCH /v1/requirements/:id.
                continue;
            };

            picked += 1;
            // Spawn so the tick stays short. The next tick will
            // observe the Pending run and skip this requirement.
            let state_clone = state.clone();
            let req_clone = req.clone();
            let timeout_ms = config.run_timeout_ms;
            tokio::spawn(async move {
                if let Err(e) = drive_one(&state_clone, &req_clone, &profile, timeout_ms).await {
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

/// One end-to-end pickup: mint conversation + worktree, build
/// agent, drive `agent.run` under a timeout, persist outcome,
/// auto-verify if the requirement carries a plan.
///
/// Errors here are logged but never surfaced — the run row
/// records the failure, which is the durable record an operator
/// will look at.
async fn drive_one(
    state: &AppState,
    requirement: &Requirement,
    profile: &AgentProfile,
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
    let convo_store = state
        .store
        .clone()
        .ok_or_else(|| "conversation store missing".to_string())?;

    // 1. Manifest.
    let workspace = state
        .workspace_root
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let manifest = build_default_manifest(&workspace, requirement).await;
    let summary = render_manifest_summary(&manifest);
    let composed_summary = match profile.system_prompt.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            format!("=== assignee instructions ===\n{}\n\n{}", p.trim(), summary)
        }
        _ => summary,
    };

    // 2. Mint conversation: system (manifest) + user (seed prompt).
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut conv = Conversation::new();
    conv.push(Message::system(composed_summary));
    conv.push(Message::user(seed_prompt(requirement)));
    let metadata = ConversationMetadata {
        project_id: Some(requirement.project_id.clone()),
    };
    convo_store
        .save_envelope(&conversation_id, &conv, &metadata)
        .await
        .map_err(|e| format!("save conversation: {e}"))?;

    // 3. Update requirement: link conversation + auto-advance Backlog.
    let mut requirement = requirement.clone();
    let advanced = requirement.status == RequirementStatus::Backlog;
    if advanced {
        requirement.status = RequirementStatus::InProgress;
        requirement.touch();
    }
    requirement.link_conversation(conversation_id.clone());
    req_store
        .upsert(&requirement)
        .await
        .map_err(|e| format!("upsert requirement: {e}"))?;

    // 4. Mint run + worktree (mirrors start_run).
    let mut run = RequirementRun::new(requirement.id.clone(), conversation_id.clone());
    run.status = RequirementRunStatus::Running;
    if state.worktree_mode == WorktreeMode::PerRun {
        if let Some(root) = state.worktree_root.as_ref() {
            match worktree::create_worktree(&workspace, root, &run.id, !state.worktree_allow_dirty)
                .await
            {
                WorktreeOutcome::Created(p) => {
                    run.worktree_path = Some(p.display().to_string());
                }
                WorktreeOutcome::Refused(reason) => {
                    info!(run_id = %run.id, reason = %reason, "auto mode: worktree refused; using main checkout");
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
            "profile_id": profile.id,
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

    // 6. Build agent + drive loop under a timeout.
    let agent_result = state.build_agent_with(
        Some(&profile.provider),
        Some(&profile.model),
        |cfg| {
            if let Some(prompt) = profile.system_prompt.as_deref() {
                if !prompt.trim().is_empty() {
                    // Already prepended into conv's system message;
                    // we leave the agent template's own
                    // system_prompt alone so it doesn't compound.
                    let _ = prompt;
                }
            }
            cfg.model = profile.model.clone();
        },
    );
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
            run.finish(RequirementRunStatus::Completed);
        }
        Err(e) => {
            run.error = Some(e);
            run.finish(RequirementRunStatus::Failed);
        }
    }
    if let Err(e) = run_store.upsert(&run).await {
        warn!(error = %e, "upsert finished run failed");
    }
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

    // 8. Auto-verify when the requirement carries a plan.
    if let Some(plan) = requirement.verification_plan.as_ref() {
        let workspace_for_verify = run
            .worktree_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.clone());
        let result =
            verification::execute_plan(&workspace_for_verify, plan, verification::DEFAULT_TIMEOUT_MS)
                .await;
        let verified_status = result.status;
        run.verification = Some(result.clone());
        // If the run is still non-terminal (rare — the agent
        // succeeded but the plan flips it Failed) update too.
        if matches!(verified_status, VerificationStatus::Failed) && !run.status.is_terminal() {
            run.finish(RequirementRunStatus::Failed);
        }
        if let Err(e) = run_store.upsert(&run).await {
            warn!(error = %e, "upsert run after verification failed");
        }
        run_store.broadcast(RequirementRunEvent::Verified {
            run_id: run.id.clone(),
            result: result.clone(),
        });
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
    }

    Ok(())
}

/// Compose the user message that seeds the agent run. Uses the
/// requirement's title + description; falls back to title alone
/// when description is absent.
fn seed_prompt(req: &Requirement) -> String {
    let mut out = String::new();
    out.push_str("Please complete this requirement and reply with a one-line summary of what you did.\n\n");
    out.push_str(&req.title);
    if let Some(desc) = req.description.as_deref() {
        if !desc.trim().is_empty() {
            out.push_str("\n\n");
            out.push_str(desc.trim());
        }
    }
    out
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
        Message, Project, Requirement, RequirementStatus,
    };
    use harness_store::{
        MemoryActivityStore, MemoryAgentProfileStore, MemoryConversationStore,
        MemoryProjectStore, MemoryRequirementRunStore, MemoryRequirementStore,
    };
    use std::sync::Arc;

    /// Stub LLM that returns a canned assistant message and a
    /// `Stop` finish reason — the agent loop runs exactly one
    /// turn and exits cleanly.
    struct CannedLlm {
        reply: String,
    }
    #[async_trait::async_trait]
    impl LlmProvider for CannedLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
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
        });
        let cfg = AgentConfig::new("canned-model");
        let mut registry = ProviderRegistry::new("canned");
        registry.insert("canned", llm, "canned-model".to_string());
        AppState::from_registry(registry, cfg)
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

    fn cfg() -> AutoModeConfig {
        AutoModeConfig {
            mode: AutoMode::Auto,
            tick_seconds: 9999,
            max_units_per_tick: 5,
            max_retries: 2,
            run_timeout_ms: 5_000,
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
        state.requirements.as_ref().unwrap().upsert(&req).await.unwrap();

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
    async fn tick_picks_eligible_requirement_and_drives_agent() {
        let state = wire_stores(base_state_with_canned_llm("hello world."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "auto pickup");
        req.assignee_id = Some(prof.id.clone());
        state.requirements.as_ref().unwrap().upsert(&req).await.unwrap();

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
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("drive_one never finished within 1s");
    }

    #[tokio::test]
    async fn tick_skips_requirement_with_inflight_run() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "has inflight");
        req.assignee_id = Some(prof.id.clone());
        state.requirements.as_ref().unwrap().upsert(&req).await.unwrap();

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
    async fn tick_skips_when_max_retries_exceeded() {
        let state = wire_stores(base_state_with_canned_llm("ok."));
        let (proj, prof) = seed_project_and_profile(&state).await;
        let mut req = Requirement::new(&proj.id, "broken");
        req.assignee_id = Some(prof.id.clone());
        state.requirements.as_ref().unwrap().upsert(&req).await.unwrap();

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
            state.requirements.as_ref().unwrap().upsert(&req).await.unwrap();
        }
        let mut c = cfg();
        c.max_units_per_tick = 2;
        let n = tick(&state, &c).await.unwrap();
        assert_eq!(n, 2);
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
