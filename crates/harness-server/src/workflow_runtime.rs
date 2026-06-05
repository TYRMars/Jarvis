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
    Ok(execute_workflow_run(state, def, requirement, run, workspace_override, timeout_ms).await)
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
        if let Some(store) = self.state.store.as_ref() {
            if let Err(e) = store.save_envelope(&conversation_id, &conv, &metadata).await {
                warn!(error = %e, "workflow: save conversation failed");
            }
        }

        let workspace = self.workspace.clone();
        let agent = match self.state.build_agent_with(None, model, |cfg| {
            cfg.session_workspace = Some(workspace.clone());
        }) {
            Ok(agent) => agent,
            Err(e) => {
                return single(WorkflowStepResult::failed(
                    step,
                    None,
                    format!("agent build: {e}"),
                ));
            }
        };

        let mut conv_for_run = conv.clone();
        let result = timeout(Duration::from_millis(self.timeout_ms), async {
            agent.run(&mut conv_for_run).await
        })
        .await;

        match result {
            Ok(Ok(_)) => {
                if let Some(store) = self.state.store.as_ref() {
                    if let Err(e) = store.save_envelope(&conversation_id, &conv_for_run, &metadata).await
                    {
                        warn!(error = %e, "workflow: re-save conversation failed");
                    }
                }
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
}
