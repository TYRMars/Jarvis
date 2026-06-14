//! Server-side executor for declarative [`WorkflowDefinition`]s.
//!
//! A workflow is a tree of [`WorkflowStep`]s. This module walks the tree
//! and executes each leaf `Agent` step by driving the **existing** agent
//! loop (`AppState::build_agent_with` + `Agent::run`), exactly as
//! `auto_mode::drive_one_with_prompt` drives a single requirement run —
//! the workflow runtime is a thin orchestration layer on top, never new
//! execution machinery.
//!
//! Composition of steps mirrors Claude Code's workflow primitives:
//!
//! - `Pipeline` / `Phase` run children **sequentially**, threading each
//!   child's final assistant text forward as `{{ prev }}`.
//! - `Parallel` runs children **concurrently** (one task, `join_all`,
//!   bounded by a [`Semaphore`]); [`JoinPolicy`] decides whether a child
//!   failure fails the group.
//! - `Agent` steps interpolate `{{ prev }}` and `{{ outputs.<key> }}`
//!   into their prompt and record their output under `output_key`.
//!
//! The orchestrator runs at the **server layer** (calling `Agent::run`
//! directly), never as a tool the agent invokes — so it sidesteps the
//! v1.0 subagent-recursion guard.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::join_all;
use harness_core::{Conversation, ConversationMetadata, Message};
use harness_project::{ActivityActor, ActivityKind, Requirement};
use harness_requirement::{build_default_manifest, render_manifest_summary};
use harness_workflow::{
    JoinPolicy, WorkflowDefinition, WorkflowRun, WorkflowRunStatus, WorkflowStep, WorkflowStepKind,
    WorkflowStepResult,
};
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};
use tracing::{info, warn};

use crate::auto_mode::record_activity;
use crate::state::AppState;

/// How many `Agent` steps may hit the LLM concurrently within one
/// workflow run. Conservative default — parallel steps are an
/// optimisation, not a throughput contract.
const MAX_PARALLEL_AGENTS: usize = 4;

/// Per-step interpolation map: `output_key` → final assistant text.
type Outputs = HashMap<String, String>;

/// Mint a fresh [`WorkflowRun`], persist it `Running`, and execute the
/// definition to completion. Used by the auto loop (awaited inline).
///
/// `requirement` binds the run to a kanban card: its manifest seeds the
/// system prompt, its conversations get linked, and Activity rows are
/// emitted. Pass `None` for an ad-hoc run.
///
/// A workflow whose terminal status is [`WorkflowRunStatus::Failed`]
/// surfaces as `Err` so the caller (the auto loop) can observe the
/// failure — otherwise a fully-failed run would be indistinguishable
/// from success at the orchestration layer, and the loop's retry /
/// backoff guards (which key off failure signals) would never engage.
pub(crate) async fn drive_workflow(
    state: &AppState,
    def: &WorkflowDefinition,
    requirement: Option<&Requirement>,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
) -> Result<WorkflowRun, String> {
    let store = state
        .workflows
        .clone()
        .ok_or_else(|| "workflow store missing".to_string())?;
    let run = WorkflowRun::new(def.id.clone(), requirement.map(|r| r.id.clone()));
    if let Err(e) = store.upsert_run(&run).await {
        warn!(error = %e, workflow_id = %def.id, "workflow: persist running run failed");
    }
    let run = execute_workflow_run(state, def, requirement, run, workspace_override, timeout_ms).await;
    if run.status == WorkflowRunStatus::Failed {
        return Err(run
            .error
            .clone()
            .unwrap_or_else(|| "one or more workflow steps failed".to_string()));
    }
    Ok(run)
}

/// Execute `def` against a **pre-minted** `run` (already persisted as
/// `Running` by the caller). The manual `/run` route uses this so it can
/// return `202` + the run id immediately and let execution proceed in a
/// spawned task.
pub(crate) async fn execute_workflow_run(
    state: &AppState,
    def: &WorkflowDefinition,
    requirement: Option<&Requirement>,
    mut run: WorkflowRun,
    workspace_override: Option<PathBuf>,
    timeout_ms: u64,
) -> WorkflowRun {
    let store = state.workflows.clone();

    // Record this run as alive in-process for its whole duration. The
    // stale-run reaper skips runs in this set, so it never reclaims a
    // run that is still executing here — only rows orphaned by a crash
    // (whose liveness set died with the process) age out. The guard
    // clears the entry on completion *and* on task abort.
    let _inflight = state.workflow_run_gate.mark_inflight(run.id.clone());

    // Base system prompt: a requirement contributes its context manifest
    // (same builder the auto loop uses); ad-hoc runs get a generic frame.
    let workspace = workspace_override
        .or_else(|| state.workspace_root.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let base_system = match requirement {
        Some(req) => {
            let manifest = build_default_manifest(&workspace, req).await;
            render_manifest_summary(&manifest)
        }
        None => format!(
            "You are executing the '{}' workflow. Complete each step's instruction precisely.",
            def.name
        ),
    };

    if let Some(req) = requirement {
        record_activity(
            state,
            &req.id,
            ActivityKind::RunStarted,
            ActivityActor::System,
            json!({ "workflow": true, "workflow_id": def.id, "workflow_run_id": run.id }),
        )
        .await;
    }

    let ctx = Ctx {
        state: state.clone(),
        workspace,
        base_system,
        project_id: requirement.map(|r| r.project_id.clone()),
        timeout_ms,
        sem: Arc::new(Semaphore::new(MAX_PARALLEL_AGENTS)),
    };

    let outcome = ctx.exec_sequential(&def.steps, None, Outputs::new()).await;
    run.step_results = outcome.results;
    if outcome.failed {
        run.error = Some("one or more workflow steps failed".to_string());
        run.finish(WorkflowRunStatus::Failed);
    } else {
        run.finish(WorkflowRunStatus::Succeeded);
    }
    if let Some(store) = store.as_ref() {
        if let Err(e) = store.upsert_run(&run).await {
            warn!(error = %e, workflow_id = %def.id, "workflow: persist final run failed");
        }
    }

    // Link every step conversation back onto the requirement and record
    // a finish Activity, so the run shows up in the card's existing
    // Conversations / Activity drawers.
    if let Some(req) = requirement {
        if let Some(req_store) = state.requirements.as_ref() {
            if let Ok(Some(mut latest)) = req_store.get(&req.id).await {
                let mut changed = false;
                for r in &run.step_results {
                    if let Some(cid) = r.conversation_id.as_ref() {
                        if latest.link_conversation(cid.clone()) {
                            changed = true;
                        }
                    }
                }
                if changed {
                    if let Err(e) = req_store.upsert(&latest).await {
                        warn!(error = %e, "workflow: link conversations failed");
                    }
                }
            }
        }
        record_activity(
            state,
            &req.id,
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({
                "workflow": true,
                "workflow_id": def.id,
                "workflow_run_id": run.id,
                "status": run.status.as_wire(),
                "steps": run.step_results.len(),
            }),
        )
        .await;
    }

    run
}

/// Reconcile a run that a spawned executor may have left mid-flight: if
/// the persisted run is still `Running`, flip it to `Failed` so a panic
/// (whose terminal-status write never ran) can't leave it hanging in
/// flight forever. No-op when the store is absent or the run already
/// reached a terminal state.
pub(crate) async fn fail_run_if_running(state: &AppState, run_id: &str, error: &str) {
    let Some(store) = state.workflows.as_ref() else {
        return;
    };
    match store.get_run(run_id).await {
        Ok(Some(mut run)) if run.status == WorkflowRunStatus::Running => {
            run.error = Some(error.to_string());
            run.finish(WorkflowRunStatus::Failed);
            if let Err(e) = store.upsert_run(&run).await {
                warn!(error = %e, run_id = %run_id, "workflow: persist panicked run failed");
            }
        }
        Ok(_) => {}
        Err(e) => {
            warn!(error = %e, run_id = %run_id, "workflow: reconcile panicked run failed");
        }
    }
}

/// Owned execution context — cloned once from `&AppState` so the
/// recursive async methods don't fight lifetime threading.
struct Ctx {
    state: AppState,
    workspace: PathBuf,
    base_system: String,
    project_id: Option<String>,
    timeout_ms: u64,
    sem: Arc<Semaphore>,
}

/// Accumulated result of executing a step (or a group of steps).
#[derive(Default)]
struct ExecResult {
    /// Flattened leaf results in execution order.
    results: Vec<WorkflowStepResult>,
    /// Final assistant text of the last leaf — threaded as `{{ prev }}`.
    last_output: Option<String>,
    /// `output_key` → output bindings produced by this subtree.
    produced: Vec<(String, String)>,
    /// `true` when a hard failure occurred that should stop a sequential
    /// parent (and fail an `AllRequired` parallel parent).
    failed: bool,
}

impl Ctx {
    /// Run `steps` in order, threading `prev` and accumulating `outputs`.
    /// Stops at the first failed step (downstream steps usually depend on
    /// upstream output).
    async fn exec_sequential(
        &self,
        steps: &[WorkflowStep],
        mut prev: Option<String>,
        mut outputs: Outputs,
    ) -> ExecResult {
        let mut acc = ExecResult::default();
        for step in steps {
            let r = self.exec_step(step, prev.clone(), &outputs).await;
            for (k, v) in &r.produced {
                outputs.insert(k.clone(), v.clone());
            }
            acc.produced.extend(r.produced);
            acc.results.extend(r.results);
            if r.last_output.is_some() {
                prev = r.last_output.clone();
                acc.last_output = r.last_output;
            }
            if r.failed {
                acc.failed = true;
                break;
            }
        }
        acc
    }

    /// Dispatch one step by kind. Recursive arms are boxed so the
    /// async future stays finite-sized.
    async fn exec_step(
        &self,
        step: &WorkflowStep,
        prev: Option<String>,
        outputs: &Outputs,
    ) -> ExecResult {
        match &step.kind {
            WorkflowStepKind::Agent {
                prompt,
                subagent,
                model,
                output_key,
            } => {
                self.exec_agent(
                    step,
                    prompt,
                    subagent.as_deref(),
                    model.as_deref(),
                    output_key.as_deref(),
                    prev,
                    outputs,
                )
                .await
            }
            WorkflowStepKind::Pipeline { steps } => {
                Box::pin(self.exec_sequential(steps, prev, outputs.clone())).await
            }
            WorkflowStepKind::Phase { title, steps } => {
                info!(phase = %title, "workflow: entering phase");
                Box::pin(self.exec_sequential(steps, prev, outputs.clone())).await
            }
            WorkflowStepKind::Parallel { steps, join } => {
                Box::pin(self.exec_parallel(steps, prev, outputs.clone(), *join)).await
            }
        }
    }

    /// Run children concurrently. All children see the same incoming
    /// `prev` + `outputs` snapshot; their `output_key`s are merged after
    /// the join (last-writer-wins on collisions).
    async fn exec_parallel(
        &self,
        steps: &[WorkflowStep],
        prev: Option<String>,
        outputs: Outputs,
        join: JoinPolicy,
    ) -> ExecResult {
        let futures = steps
            .iter()
            .map(|s| self.exec_step(s, prev.clone(), &outputs));
        let child_results = join_all(futures).await;

        let mut acc = ExecResult::default();
        let mut any_failed = false;
        for r in child_results {
            acc.results.extend(r.results);
            acc.produced.extend(r.produced);
            if r.failed {
                any_failed = true;
            }
        }
        // Parallel groups don't thread a single `prev` downstream.
        acc.last_output = None;
        acc.failed = matches!(join, JoinPolicy::AllRequired) && any_failed;
        acc
    }

    /// The leaf: drive one agent turn. The subagent path is forward-
    /// compat — until `AppState` exposes a subagent registry, a step that
    /// names a subagent still runs the main agent loop (logged), so the
    /// recipe degrades gracefully rather than erroring.
    #[allow(clippy::too_many_arguments)]
    async fn exec_agent(
        &self,
        step: &WorkflowStep,
        prompt: &str,
        subagent: Option<&str>,
        model: Option<&str>,
        output_key: Option<&str>,
        prev: Option<String>,
        outputs: &Outputs,
    ) -> ExecResult {
        // Bound how many agent loops run concurrently across the run.
        let _permit = self.sem.acquire().await;
        if let Some(name) = subagent {
            info!(
                subagent = %name,
                step = %step.name,
                "workflow: subagent delegation not yet wired; running main agent"
            );
        }

        let rendered = render_template(prompt, prev.as_deref(), outputs);
        let conversation_id = uuid::Uuid::new_v4().to_string();
        let mut conv = Conversation::new();
        conv.push(Message::system(self.base_system.clone()));
        conv.push(Message::user(rendered));
        let metadata = ConversationMetadata {
            project_id: self.project_id.clone(),
            ..Default::default()
        };

        let workspace = self.workspace.clone();
        let agent = match self.state.build_agent_with(None, model, |cfg| {
            cfg.session_workspace = Some(workspace.clone());
        }) {
            Ok(agent) => agent,
            Err(e) => {
                // Build failed before the conversation was persisted — there is
                // nothing to orphan and no conversation to reference.
                return single(WorkflowStepResult::failed(
                    step,
                    None,
                    format!("agent build: {e}"),
                ));
            }
        };

        // Persist the initial conversation only once we hold a runnable agent,
        // so a build failure can't leave an orphaned envelope that no step
        // result references.
        if let Some(store) = self.state.store.as_ref() {
            if let Err(e) = store.save_envelope(&conversation_id, &conv, &metadata).await {
                warn!(error = %e, "workflow: save conversation failed");
            }
        }

        let mut conv_for_run = conv.clone();
        let result = timeout(Duration::from_millis(self.timeout_ms), async {
            agent.run(&mut conv_for_run).await
        })
        .await;

        // Persist the final conversation in every terminal branch — success,
        // error, and timeout. The error/timeout step results still attach
        // `conversation_id`, so without this re-save the failure drill-down
        // would show only the initial system + user envelope and discard all
        // the tool calls / assistant turns that led up to the failure.
        if let Some(store) = self.state.store.as_ref() {
            if let Err(e) = store.save_envelope(&conversation_id, &conv_for_run, &metadata).await {
                warn!(error = %e, "workflow: re-save conversation failed");
            }
        }

        match result {
            Ok(Ok(_)) => {
                let output = last_assistant_text(&conv_for_run);
                let mut acc = ExecResult {
                    last_output: Some(output.clone()),
                    ..Default::default()
                };
                acc.results
                    .push(WorkflowStepResult::ok(step, Some(conversation_id), output.clone()));
                if let Some(key) = output_key {
                    acc.produced.push((key.to_string(), output));
                }
                acc
            }
            Ok(Err(e)) => single(WorkflowStepResult::failed(
                step,
                Some(conversation_id),
                format!("agent error: {e}"),
            )),
            Err(_) => single(WorkflowStepResult::failed(
                step,
                Some(conversation_id),
                format!("agent timed out after {}ms", self.timeout_ms),
            )),
        }
    }
}

/// Wrap a single failed step result into an [`ExecResult`] that fails
/// its sequential parent.
fn single(result: WorkflowStepResult) -> ExecResult {
    ExecResult {
        failed: result.status == WorkflowRunStatus::Failed,
        results: vec![result],
        ..Default::default()
    }
}

/// Interpolate `{{ prev }}` and `{{ outputs.<key> }}` into a prompt.
/// Both spaced (`{{ prev }}`) and tight (`{{prev}}`) forms are honoured.
/// Unknown placeholders are left untouched.
fn render_template(prompt: &str, prev: Option<&str>, outputs: &Outputs) -> String {
    let mut out = prompt.to_string();
    let prev_val = prev.unwrap_or("");
    out = out
        .replace("{{ prev }}", prev_val)
        .replace("{{prev}}", prev_val);
    for (key, value) in outputs {
        out = out
            .replace(&format!("{{{{ outputs.{key} }}}}"), value)
            .replace(&format!("{{{{outputs.{key}}}}}"), value);
    }
    out
}

/// Safety multiplier applied to `run_timeout_ms` before reaping a stuck
/// `Running` workflow row. A healthy run's *steps* are each wrapped in
/// `tokio::time::timeout(run_timeout_ms)`, but a multi-step workflow can
/// legitimately span several step budgets — so we give the whole run 3×
/// headroom (matching the auto loop's `RUNNING_STALE_MULTIPLIER`) before
/// declaring it abandoned. Runs still alive in-process are never reaped
/// regardless of age (the `is_active` check below), so this threshold
/// only ever bites genuinely orphaned rows.
const WORKFLOW_RUNNING_STALE_MULTIPLIER: u64 = 3;

/// Default cadence (seconds) for the background stale-run reaper.
pub const DEFAULT_WORKFLOW_REAP_SECONDS: u64 = 60;

/// Sweep the workflow run store and reclaim runs stuck `Running` /
/// `Pending` past their wall-clock budget — the orphans left behind when
/// a process is killed mid-run (issue #78). Such a row would otherwise
/// stay `Running` forever, since the task that owned it died without
/// writing a terminal status.
///
/// Skips any run still alive in *this* process (present in the
/// [`WorkflowRunGate`](crate::workflow_concurrency::WorkflowRunGate)
/// liveness set) — those finalize themselves. Returns the number of rows
/// reclaimed. No-ops (returns 0) when the workflow store is unconfigured.
///
/// Like the auto loop's reaper, orphans are flipped to `Cancelled` (the
/// neutral "we gave up on this row" state), not `Failed` — we don't know
/// what happened to the dead task, only that it never finished.
pub async fn reap_stale_workflow_runs(state: &AppState, timeout_ms: u64) -> usize {
    let Some(store) = state.workflows.as_ref() else {
        return 0;
    };
    let runs = match store.list_runs(None, None).await {
        Ok(runs) => runs,
        Err(e) => {
            warn!(error = %e, "workflow reaper: list_runs failed; skipping sweep");
            return 0;
        }
    };
    let timeout_ms = timeout_ms.max(1);
    let running_threshold_ms = timeout_ms.saturating_mul(WORKFLOW_RUNNING_STALE_MULTIPLIER);
    let mut reaped = 0;
    for mut run in runs {
        let threshold_ms = match run.status {
            WorkflowRunStatus::Pending => timeout_ms,
            WorkflowRunStatus::Running => running_threshold_ms,
            _ => continue,
        };
        // Still executing here — leave it alone; it'll finalize itself.
        if state.workflow_run_gate.is_active(&run.id) {
            continue;
        }
        if !workflow_run_is_stale(&run, threshold_ms) {
            continue;
        }
        let prior = run.status;
        run.error.get_or_insert_with(|| {
            "stuck workflow run reclaimed (assumed abandoned after process restart)".to_string()
        });
        run.finish(WorkflowRunStatus::Cancelled);
        if let Err(e) = store.upsert_run(&run).await {
            warn!(run_id = %run.id, error = %e, "workflow reaper: persist failed");
            continue;
        }
        warn!(
            run_id = %run.id,
            prior_status = %prior.as_wire(),
            threshold_ms,
            "workflow reaper reclaimed stale in-flight run"
        );
        reaped += 1;
    }
    reaped
}

/// `true` when `run`'s age exceeds `threshold_ms`. A run whose
/// `started_at` doesn't parse is treated as *not* stale (we'd rather
/// leave a malformed row than reap it on a parse error).
fn workflow_run_is_stale(run: &WorkflowRun, threshold_ms: u64) -> bool {
    let Ok(started_at) = chrono::DateTime::parse_from_rfc3339(&run.started_at) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(started_at.with_timezone(&chrono::Utc));
    age.num_milliseconds() > threshold_ms as i64
}

/// Spawn the background workflow stale-run reaper: one sweep immediately
/// (catching orphans left by a prior process), then every `tick_seconds`.
/// No-ops without a workflow store. `tick_seconds` and `timeout_ms` are
/// both clamped to ≥1.
pub fn spawn_workflow_reaper(state: AppState, tick_seconds: u64, timeout_ms: u64) {
    if state.workflows.is_none() {
        return;
    }
    let tick_seconds = tick_seconds.max(1);
    info!(tick_seconds, timeout_ms, "workflow stale-run reaper started");
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(tick_seconds));
        loop {
            tick.tick().await;
            let reaped = reap_stale_workflow_runs(&state, timeout_ms).await;
            if reaped > 0 {
                info!(count = reaped, "workflow reaper reclaimed stale runs");
            }
        }
    });
}

/// The most recent non-empty assistant message text, or `""`.
fn last_assistant_text(conv: &Conversation) -> String {
    conv.messages
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::Assistant {
                content: Some(c), ..
            } if !c.trim().is_empty() => Some(c.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubLlm;

    #[async_trait::async_trait]
    impl harness_core::LlmProvider for StubLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    fn test_state() -> AppState {
        let cfg = harness_core::AgentConfig::new("stub-model");
        let agent = Arc::new(harness_core::Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent).with_workflows(Arc::new(harness_store::MemoryWorkflowStore::new()))
    }

    #[tokio::test]
    async fn fail_run_if_running_flips_running_to_failed() {
        let state = test_state();
        let store = state.workflows.clone().unwrap();
        let run = WorkflowRun::new("wf", None);
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();

        fail_run_if_running(&state, &run_id, "workflow run panicked").await;

        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Failed);
        assert_eq!(got.error.as_deref(), Some("workflow run panicked"));
        assert!(got.finished_at.is_some());
    }

    #[tokio::test]
    async fn fail_run_if_running_leaves_terminal_run_untouched() {
        let state = test_state();
        let store = state.workflows.clone().unwrap();
        let mut run = WorkflowRun::new("wf", None);
        run.finish(WorkflowRunStatus::Succeeded);
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();

        fail_run_if_running(&state, &run_id, "should not apply").await;

        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Succeeded);
        assert!(got.error.is_none());
    }

    #[test]
    fn render_template_substitutes_prev_and_outputs() {
        let mut outputs = Outputs::new();
        outputs.insert("research".into(), "FINDINGS".into());
        let rendered = render_template(
            "Use {{ prev }} and {{ outputs.research }} and {{outputs.research}}",
            Some("PREV"),
            &outputs,
        );
        assert_eq!(rendered, "Use PREV and FINDINGS and FINDINGS");
    }

    #[test]
    fn render_template_leaves_unknown_placeholders() {
        let rendered = render_template("keep {{ outputs.missing }}", None, &Outputs::new());
        assert_eq!(rendered, "keep {{ outputs.missing }}");
    }

    #[test]
    fn single_failed_marks_failed() {
        let step = WorkflowStep::new(
            "s",
            WorkflowStepKind::Agent {
                prompt: "p".into(),
                subagent: None,
                model: None,
                output_key: None,
            },
        );
        let r = single(WorkflowStepResult::failed(&step, None, "boom".into()));
        assert!(r.failed);
        assert_eq!(r.results.len(), 1);
    }

    struct ReaperStubLlm;

    #[async_trait::async_trait]
    impl harness_core::LlmProvider for ReaperStubLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    fn reaper_state() -> AppState {
        let cfg = harness_core::AgentConfig::new("stub-model");
        let agent = Arc::new(harness_core::Agent::new(Arc::new(ReaperStubLlm) as _, cfg));
        AppState::new(agent).with_workflows(Arc::new(harness_store::MemoryWorkflowStore::new()))
    }

    fn run_with_age(status: WorkflowRunStatus, age_ms: i64) -> WorkflowRun {
        let mut run = WorkflowRun::new("wf-1", None);
        run.status = status;
        run.started_at = (chrono::Utc::now() - chrono::Duration::milliseconds(age_ms)).to_rfc3339();
        run
    }

    #[tokio::test]
    async fn reaper_reclaims_old_running_run() {
        let state = reaper_state();
        let store = state.workflows.clone().unwrap();
        // Older than timeout × 3.
        let run = run_with_age(WorkflowRunStatus::Running, 10_000);
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();

        let reaped = reap_stale_workflow_runs(&state, 1_000).await;
        assert_eq!(reaped, 1);
        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Cancelled);
        assert!(got.finished_at.is_some());
        assert!(got.error.is_some());
    }

    #[tokio::test]
    async fn reaper_leaves_fresh_running_run() {
        let state = reaper_state();
        let store = state.workflows.clone().unwrap();
        let run = run_with_age(WorkflowRunStatus::Running, 100);
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();

        let reaped = reap_stale_workflow_runs(&state, 60_000).await;
        assert_eq!(reaped, 0);
        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Running);
    }

    #[tokio::test]
    async fn reaper_skips_runs_alive_in_process() {
        let state = reaper_state();
        let store = state.workflows.clone().unwrap();
        let run = run_with_age(WorkflowRunStatus::Running, 10_000);
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();
        // Mark it alive locally — the reaper must not touch it despite age.
        let _guard = state.workflow_run_gate.mark_inflight(run_id.clone());

        let reaped = reap_stale_workflow_runs(&state, 1_000).await;
        assert_eq!(reaped, 0);
        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Running);
    }

    #[tokio::test]
    async fn reaper_ignores_terminal_runs() {
        let state = reaper_state();
        let store = state.workflows.clone().unwrap();
        let mut run = run_with_age(WorkflowRunStatus::Succeeded, 10_000);
        run.finished_at = Some(chrono::Utc::now().to_rfc3339());
        let run_id = run.id.clone();
        store.upsert_run(&run).await.unwrap();

        let reaped = reap_stale_workflow_runs(&state, 1_000).await;
        assert_eq!(reaped, 0);
        let got = store.get_run(&run_id).await.unwrap().unwrap();
        assert_eq!(got.status, WorkflowRunStatus::Succeeded);
    }

    /// Two-step LLM: first reply asks for one tool call, the second errors —
    /// modelling an agent that fails *after* producing tool calls / assistant
    /// turns.
    struct FailAfterToolLlm {
        iter: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl harness_core::LlmProvider for FailAfterToolLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            use std::sync::atomic::Ordering;
            if self.iter.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(harness_core::ChatResponse {
                    message: Message::Assistant {
                        content: None,
                        tool_calls: vec![harness_core::ToolCall {
                            id: "call_1".into(),
                            name: "noop".into(),
                            arguments: serde_json::json!({}),
                        }],
                        reasoning_content: None,
                        cache: None,
                    },
                    finish_reason: harness_core::FinishReason::ToolCalls,
                    response_id: None,
                    usage: None,
                })
            } else {
                // The assistant tool-call turn + tool result are already in the
                // conversation by now; this error drives the `Ok(Err(_))` branch.
                Err(harness_core::Error::Provider("boom".into()))
            }
        }
    }

    struct NoopTool;

    #[async_trait::async_trait]
    impl harness_core::Tool for NoopTool {
        fn name(&self) -> &str {
            "noop"
        }
        fn description(&self) -> &str {
            "no-op test tool"
        }
        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({"type": "object"})
        }
        async fn invoke(
            &self,
            _: serde_json::Value,
        ) -> Result<String, harness_core::BoxError> {
            Ok("noop-result".into())
        }
    }

    /// Regression (issue #131): when the agent loop fails, the partial
    /// conversation — the tool calls / assistant turns produced before the
    /// failure — must be re-saved under the step's `conversation_id`, not left
    /// as the bare initial system + user envelope. Otherwise the failure
    /// drill-down is empty exactly when it's most useful.
    #[tokio::test]
    async fn error_path_resaves_partial_conversation() {
        use harness_core::ConversationStore;
        use std::sync::atomic::AtomicUsize;

        let mut registry = harness_core::ToolRegistry::new();
        registry.register(NoopTool);
        let cfg = harness_core::AgentConfig::new("stub-model").with_tools(registry);
        let agent = Arc::new(harness_core::Agent::new(
            Arc::new(FailAfterToolLlm {
                iter: AtomicUsize::new(0),
            }) as _,
            cfg,
        ));
        let store = Arc::new(harness_store::MemoryConversationStore::new());
        let state = AppState::new(agent).with_store(store.clone());

        let ctx = Ctx {
            state,
            workspace: std::env::temp_dir(),
            base_system: "sys".into(),
            project_id: None,
            timeout_ms: 30_000,
            sem: Arc::new(Semaphore::new(1)),
        };

        let step = WorkflowStep::new(
            "s",
            WorkflowStepKind::Agent {
                prompt: "go".into(),
                subagent: None,
                model: None,
                output_key: None,
            },
        );

        let result = ctx
            .exec_agent(&step, "go", None, None, None, None, &Outputs::new())
            .await;

        // The step failed but still references a conversation id.
        assert!(result.failed);
        let cid = result.results[0]
            .conversation_id
            .clone()
            .expect("failed step keeps its conversation id");

        // The persisted envelope must include the assistant tool-call turn and
        // the tool result produced before the failure — not just system + user.
        let conv = store
            .load(&cid)
            .await
            .unwrap()
            .expect("conversation persisted");
        assert!(
            conv.messages.len() > 2,
            "partial conversation should be re-saved on the error path, got {} messages",
            conv.messages.len()
        );
        assert!(
            conv.messages
                .iter()
                .any(|m| matches!(m, Message::Tool { .. })),
            "tool result produced before the failure must be persisted"
        );
    }
}
