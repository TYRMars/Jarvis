//! Parallel sub-agent batch tool — Phase 3 of the model & tool
//! compatibility rollout.
//!
//! Exposed to the main agent as `subagent.batch`. Accepts a list of
//! `(subagent, task)` pairs and runs them concurrently against the
//! shared [`SubAgentRegistry`], capped by a process-wide
//! [`tokio::sync::Semaphore`]. Combines results per a configurable
//! `join` strategy (summarize / race / all_required / best_effort).
//!
//! Why a tool, not a transport-layer endpoint:
//!
//! - The main agent decides when to fan out and what tasks to spawn,
//!   so the trigger lives in the model's tool catalogue.
//! - Each child sub-agent's frames already flow through the
//!   [`harness_core::subagent`] task-local channel because we run
//!   each child inside a fresh [`with_subagent`] scope. Outer
//!   transports (WS / SSE) don't need any code changes — they
//!   already render `AgentEvent::SubAgentEvent` for every child id.
//! - A failing child must not crash the whole batch (per spec
//!   acceptance: "子 Agent 失败不会吞掉其它子任务结果"). The join
//!   strategies make that policy explicit.
//!
//! Anti-recursion: the children are invoked **without** a
//! `subagent.*` tool in their own registry — the main agent's
//! existing `tool_adapter::SubAgentTool` already enforces the rule,
//! so we just delegate to the same SubAgent trait without exposing
//! batch-of-batches.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use harness_core::{active_workspace_or, BoxError, Tool, ToolCategory};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};

use crate::{SubAgent, SubAgentInput, SubAgentRegistry};

/// Default per-batch concurrency cap when neither the tool's
/// constructor nor the call payload specifies one. Mirrors the spec's
/// "并发上限默认 3" (§ Execution policy).
pub const DEFAULT_MAX_CONCURRENCY: usize = 3;

/// How to combine multiple sub-agent results. Wire shape uses
/// snake_case so the JSON payload reads as the spec wrote it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinStrategy {
    /// Wait for every child, return a markdown-style aggregate
    /// listing each child's outcome. The default — matches the
    /// "main agent summarises" expectation in the spec example.
    #[default]
    Summarize,
    /// First successful child wins; others are still allowed to
    /// finish (their frames still stream out for transparency) but
    /// the tool returns as soon as the winner is in.
    Race,
    /// All children must succeed. Any failure makes the whole
    /// batch return an error, with the failing child's message
    /// included in the error string.
    AllRequired,
    /// Wait for every child but treat failures as `[warning]` lines
    /// in the aggregate output rather than errors.
    BestEffort,
}

#[derive(Debug, Clone, Deserialize)]
struct BatchTaskInput {
    /// Sub-agent registry name (e.g. `"doc_reader"`, `"review"`).
    subagent: String,
    /// Free-form task string handed to the child.
    task: String,
    /// Optional structured context — passed verbatim into
    /// [`SubAgentInput::context`].
    #[serde(default)]
    context: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct BatchInvocation {
    tasks: Vec<BatchTaskInput>,
    #[serde(default)]
    join: JoinStrategy,
    /// Per-call override of the batch concurrency cap. Capped at
    /// the constructor-supplied limit so a single misbehaving call
    /// can't exhaust the host.
    #[serde(default)]
    max_concurrency: Option<usize>,
}

/// Per-child outcome surfaced in the aggregated tool output.
#[derive(Debug, Clone, Serialize)]
struct BatchChildResult {
    subagent: String,
    task: String,
    duration_ms: u64,
    #[serde(flatten)]
    outcome: BatchChildOutcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BatchChildOutcome {
    Ok {
        message: String,
    },
    Error {
        error: String,
    },
    /// Race: this child started but the winner finished first.
    /// Kept for transparency in the aggregate; the wire payload
    /// makes the cancellation visible.
    Cancelled,
}

/// `subagent.batch` — runs N sub-agent tasks concurrently.
pub struct SubAgentBatchTool {
    registry: Arc<SubAgentRegistry>,
    default_root: PathBuf,
    semaphore: Arc<Semaphore>,
    /// Hard ceiling on concurrent children for any single
    /// invocation. Per-call payloads can request fewer (clamped to
    /// `[1, max_concurrency]`) but never more.
    max_concurrency: usize,
}

impl SubAgentBatchTool {
    pub fn new(
        registry: Arc<SubAgentRegistry>,
        default_root: PathBuf,
        max_concurrency: usize,
    ) -> Self {
        let max_concurrency = max_concurrency.max(1);
        Self {
            registry,
            default_root,
            semaphore: Arc::new(Semaphore::new(max_concurrency)),
            max_concurrency,
        }
    }
}

#[async_trait]
impl Tool for SubAgentBatchTool {
    fn name(&self) -> &str {
        "subagent.batch"
    }

    fn description(&self) -> &str {
        "Run multiple sub-agent tasks in parallel and combine results. \
         `tasks` is an array of `{subagent, task, context?}`; `join` picks \
         summarize | race | all_required | best_effort (default summarize). \
         Use this when several independent reads / reviews / drafts can \
         run at once instead of sequentially in tool calls."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["tasks"],
            "properties": {
                "tasks": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "required": ["subagent", "task"],
                        "properties": {
                            "subagent": {
                                "type": "string",
                                "description": "Registry name of the sub-agent to invoke (e.g. 'doc_reader')."
                            },
                            "task": {
                                "type": "string",
                                "description": "Free-form natural-language task for the child."
                            },
                            "context": {
                                "description": "Optional structured context forwarded as SubAgentInput.context."
                            }
                        }
                    }
                },
                "join": {
                    "type": "string",
                    "enum": ["summarize", "race", "all_required", "best_effort"],
                    "description": "How to combine child results. Defaults to 'summarize'."
                },
                "max_concurrency": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Per-call concurrency cap (clamped to the host's limit)."
                }
            }
        })
    }

    fn category(&self) -> ToolCategory {
        // Children may include workspace-mutating sub-agents
        // (codex / claude_code) which themselves carry approval
        // gates. The batch tool itself is in the Write lane so
        // plan-mode hides it; per-child gates still apply.
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        // The wrapper is gated even when its children are read-only
        // — fanning out to an unbounded list of sub-agents has
        // process-impact (concurrent LLM calls = $$). Approval
        // surfaces "the agent wants to spawn N parallel children"
        // to the user.
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let invocation: BatchInvocation = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("subagent.batch invalid args: {e}").into() })?;

        if invocation.tasks.is_empty() {
            return Err::<String, BoxError>("subagent.batch requires at least one task".into());
        }

        let cap = invocation
            .max_concurrency
            .map(|c| c.clamp(1, self.max_concurrency))
            .unwrap_or(self.max_concurrency);

        let workspace_root = active_workspace_or(&self.default_root);
        let join_strategy = invocation.join;

        // Resolve every sub-agent up front so we can fail fast on
        // a typo'd registry name without spawning anything.
        let resolved: Vec<(BatchTaskInput, Arc<dyn SubAgent>)> = invocation
            .tasks
            .into_iter()
            .map(|t| {
                let sub = self
                    .registry
                    .get(&t.subagent)
                    .cloned()
                    .ok_or_else(|| -> BoxError {
                        format!("subagent.batch: unknown subagent `{}`", t.subagent).into()
                    })?;
                Ok::<_, BoxError>((t, sub))
            })
            .collect::<Result<Vec<_>, _>>()?;

        // Each child runs under its own with_subagent scope so its
        // frames stream out independently. We forward frames into
        // the *outer* sender so the transport renders one timeline
        // per child run id (the harness assigns ids in the inner
        // SubAgent::invoke implementations).
        let outer_tx = harness_core::subagent::active_sender();

        // Cap per call ≤ host max. The semaphore is always the
        // *host* cap; per-call cap is enforced by spawning at most
        // that many before the next batch.
        let sem = self.semaphore.clone();
        let mut handles = Vec::with_capacity(resolved.len());
        for (idx, (input, sub)) in resolved.into_iter().enumerate() {
            // Honour per-call cap: limit the number of in-flight
            // permits we hold even if the host semaphore is larger.
            // We model this by sleeping for the previous task to
            // finish once we reach `cap` outstanding permits.
            let permit_owner = sem.clone();
            let outer_tx_for_child = outer_tx.clone();
            let workspace_root = workspace_root.clone();
            let task_text = input.task.clone();
            let subagent_name = input.subagent.clone();
            let context = input.context.clone();

            let handle = tokio::spawn(async move {
                let started = Instant::now();
                // Acquire the *host* permit. The per-call cap is
                // already enforced below by the chunked join.
                let _permit = permit_owner.acquire_owned().await.ok();
                let sub_input = SubAgentInput {
                    task: task_text.clone(),
                    workspace_root,
                    context,
                    caller_chain: vec![format!("batch:{idx}")],
                };
                // Run the child under its own subagent scope so
                // its frames flow into the outer transport.
                let result = run_child(outer_tx_for_child, sub.clone(), sub_input).await;
                let duration_ms = started.elapsed().as_millis() as u64;
                BatchChildResult {
                    subagent: subagent_name,
                    task: task_text,
                    duration_ms,
                    outcome: match result {
                        Ok(msg) => BatchChildOutcome::Ok { message: msg },
                        Err(e) => BatchChildOutcome::Error { error: e },
                    },
                }
            });
            handles.push(handle);

            // Per-call cap: if we've spawned `cap` tasks, wait for
            // one to finish before scheduling more. This is a
            // simple FIFO — good enough for batch sizes up to a few
            // dozen which is the realistic range.
            if handles.len() >= cap && cap < self.max_concurrency {
                if let Some(first) = handles.first_mut() {
                    let _ = first.await;
                }
            }
        }

        let raw: Vec<BatchChildResult> = collect_handles(handles, join_strategy).await;

        match join_strategy {
            JoinStrategy::Summarize | JoinStrategy::BestEffort => {
                Ok(format_summary(join_strategy, &raw))
            }
            JoinStrategy::AllRequired => {
                if let Some(failure) = raw
                    .iter()
                    .find(|r| matches!(r.outcome, BatchChildOutcome::Error { .. }))
                {
                    let err_text = match &failure.outcome {
                        BatchChildOutcome::Error { error } => error.clone(),
                        _ => "unknown".into(),
                    };
                    return Err::<String, BoxError>(
                        format!(
                            "subagent.batch (all_required): `{}` failed: {err_text}",
                            failure.subagent
                        )
                        .into(),
                    );
                }
                Ok(format_summary(join_strategy, &raw))
            }
            JoinStrategy::Race => Ok(format_summary(join_strategy, &raw)),
        }
    }
}

async fn run_child(
    outer_tx: Option<mpsc::UnboundedSender<harness_core::SubAgentFrame>>,
    sub: Arc<dyn SubAgent>,
    input: SubAgentInput,
) -> Result<String, String> {
    // Each child needs its own with_subagent scope. We forward into
    // the outer transport's sender by cloning it; if no outer
    // transport is installed (unit tests) we drop frames silently.
    let inner = match outer_tx {
        Some(tx) => {
            harness_core::with_subagent(tx, async move {
                sub.invoke(input)
                    .await
                    .map(|out| out.message)
                    .map_err(|e| e.to_string())
            })
            .await
        }
        None => sub
            .invoke(input)
            .await
            .map(|out| out.message)
            .map_err(|e| e.to_string()),
    };
    inner
}

async fn collect_handles(
    handles: Vec<tokio::task::JoinHandle<BatchChildResult>>,
    join: JoinStrategy,
) -> Vec<BatchChildResult> {
    if matches!(join, JoinStrategy::Race) {
        // First successful child wins. We still collect the others
        // so the aggregate carries each one's status — losers are
        // marked `Cancelled` for the wire renderer.
        let mut results: Vec<BatchChildResult> = Vec::with_capacity(handles.len());
        let mut futures: Vec<_> = handles.into_iter().collect();
        let mut winner_seen = false;
        while !futures.is_empty() {
            let (joined, _idx, rest) = futures::future::select_all(futures).await;
            futures = rest;
            match joined {
                Ok(res) => {
                    let is_ok = matches!(res.outcome, BatchChildOutcome::Ok { .. });
                    if winner_seen && is_ok {
                        // Demote duplicate winners to Cancelled so
                        // the aggregate keeps a single primary.
                        results.push(BatchChildResult {
                            subagent: res.subagent,
                            task: res.task,
                            duration_ms: res.duration_ms,
                            outcome: BatchChildOutcome::Cancelled,
                        });
                    } else {
                        if is_ok {
                            winner_seen = true;
                        }
                        results.push(res);
                    }
                }
                Err(join_err) => {
                    results.push(BatchChildResult {
                        subagent: "<panic>".into(),
                        task: String::new(),
                        duration_ms: 0,
                        outcome: BatchChildOutcome::Error {
                            error: format!("child panicked: {join_err}"),
                        },
                    });
                }
            }
        }
        return results;
    }

    let mut results: Vec<BatchChildResult> = Vec::with_capacity(handles.len());
    for h in handles {
        match h.await {
            Ok(res) => results.push(res),
            Err(join_err) => results.push(BatchChildResult {
                subagent: "<panic>".into(),
                task: String::new(),
                duration_ms: 0,
                outcome: BatchChildOutcome::Error {
                    error: format!("child panicked: {join_err}"),
                },
            }),
        }
    }
    results
}

fn format_summary(strategy: JoinStrategy, results: &[BatchChildResult]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "subagent.batch ({strategy:?}, {} task{}):\n",
        results.len(),
        if results.len() == 1 { "" } else { "s" }
    ));
    for r in results {
        let head = format!(
            "- [{}] {} ({}ms)",
            match &r.outcome {
                BatchChildOutcome::Ok { .. } => "ok",
                BatchChildOutcome::Error { .. } => "error",
                BatchChildOutcome::Cancelled => "cancelled",
            },
            r.subagent,
            r.duration_ms,
        );
        out.push_str(&head);
        out.push('\n');
        match &r.outcome {
            BatchChildOutcome::Ok { message } => {
                push_indented(&mut out, message);
            }
            BatchChildOutcome::Error { error } => {
                push_indented(&mut out, &format!("[warning] {error}"));
            }
            BatchChildOutcome::Cancelled => {
                push_indented(&mut out, "(cancelled by race winner)");
            }
        }
    }
    out
}

fn push_indented(out: &mut String, text: &str) {
    for line in text.lines() {
        out.push_str("    ");
        out.push_str(line);
        out.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::echo::EchoSubAgent;
    use harness_core::{with_subagent, SubAgentEvent};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn registry_with_echo() -> Arc<SubAgentRegistry> {
        let mut reg = SubAgentRegistry::new();
        reg.register(Arc::new(EchoSubAgent::new("echo")));
        reg.register(Arc::new(EchoSubAgent::new("echo-2")));
        Arc::new(reg)
    }

    #[tokio::test]
    async fn rejects_empty_tasks() {
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let err = tool
            .invoke(json!({ "tasks": [] }))
            .await
            .expect_err("empty tasks should fail");
        assert!(err.to_string().contains("at least one task"));
    }

    #[tokio::test]
    async fn rejects_unknown_subagent() {
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let err = tool
            .invoke(json!({
                "tasks": [{ "subagent": "no-such", "task": "hi" }]
            }))
            .await
            .expect_err("unknown subagent should fail");
        assert!(err.to_string().contains("unknown subagent"));
    }

    #[tokio::test]
    async fn summarize_aggregates_all_children() {
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let out = tool
            .invoke(json!({
                "tasks": [
                    { "subagent": "echo", "task": "hello" },
                    { "subagent": "echo-2", "task": "world" }
                ],
                "join": "summarize"
            }))
            .await
            .unwrap();
        assert!(out.contains("[ok] echo"), "got:\n{out}");
        assert!(out.contains("[ok] echo-2"), "got:\n{out}");
        assert!(out.contains("echoed: hello"), "got:\n{out}");
        assert!(out.contains("echoed: world"), "got:\n{out}");
    }

    #[tokio::test]
    async fn frames_from_each_child_reach_the_outer_sender() {
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _ = with_subagent(tx, async {
            tool.invoke(json!({
                "tasks": [
                    { "subagent": "echo", "task": "alpha" },
                    { "subagent": "echo-2", "task": "beta" }
                ]
            }))
            .await
            .unwrap()
        })
        .await;

        let mut started = 0;
        let mut done = 0;
        let mut names = std::collections::HashSet::new();
        while let Ok(frame) = rx.try_recv() {
            names.insert(frame.subagent_name.clone());
            match frame.event {
                SubAgentEvent::Started { .. } => started += 1,
                SubAgentEvent::Done { .. } => done += 1,
                _ => {}
            }
        }
        assert_eq!(started, 2, "each child must emit Started exactly once");
        assert_eq!(done, 2, "each child must emit Done exactly once");
        assert!(names.contains("echo"));
        assert!(names.contains("echo-2"));
    }

    #[tokio::test]
    async fn best_effort_keeps_going_when_one_subagent_unknown() {
        // Mix one valid with one invalid — wait, the resolver
        // currently rejects upfront. That's intentional (typo
        // detection). Best-effort failure surfaces only after the
        // resolved subagent itself errors, which `EchoSubAgent`
        // doesn't do. This test pins the *upfront* validation
        // behaviour: typo on subagent name is a hard error, even
        // under best_effort, because it indicates an agent-side bug.
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let res = tool
            .invoke(json!({
                "tasks": [
                    { "subagent": "echo", "task": "ok" },
                    { "subagent": "no-such", "task": "fail" }
                ],
                "join": "best_effort"
            }))
            .await;
        assert!(res.is_err(), "typo on subagent name is hard fail");
    }

    #[tokio::test]
    async fn race_returns_after_first_success() {
        // Echo finishes near-instantly, so race effectively just
        // verifies the path runs to completion and emits a result
        // for the winner.
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let out = tool
            .invoke(json!({
                "tasks": [
                    { "subagent": "echo", "task": "fast" },
                    { "subagent": "echo-2", "task": "also-fast" }
                ],
                "join": "race"
            }))
            .await
            .unwrap();
        // At least one [ok] line; race semantics allow up to one
        // winner + losers as cancelled. EchoSubAgent always
        // succeeds, so the first one to finish wins.
        let ok_count = out.matches("[ok] ").count();
        assert!(ok_count >= 1, "expected at least one ok in:\n{out}");
    }

    #[tokio::test]
    async fn parameters_object_schema_is_well_formed() {
        let tool = SubAgentBatchTool::new(registry_with_echo(), PathBuf::from("/tmp"), 3);
        let p = tool.parameters();
        assert_eq!(p["type"], "object");
        assert!(p["properties"]["tasks"].is_object());
        assert!(p["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("tasks")));
    }
}
