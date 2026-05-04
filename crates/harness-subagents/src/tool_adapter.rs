//! Adapter that exposes a [`SubAgent`] as a [`harness_core::Tool`]
//! named `subagent.<name>`. The main agent invokes it like any other
//! tool; the wrapper picks up the workspace root, builds a
//! [`SubAgentInput`], delegates to the subagent, and returns the
//! final message back to the main agent.
//!
//! Frames emitted by the subagent reach the outer agent loop's
//! `subagent` task-local channel directly because the wrapper runs
//! inside the outer loop's tool-invocation scope (see
//! `crates/harness-core/src/agent.rs::run_stream`'s
//! `with_subagent(...)` block).

use crate::{SubAgent, SubAgentInput};
use async_trait::async_trait;
use harness_core::{active_workspace_or, BoxError, Tool, ToolCategory};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Wraps a `SubAgent` as a `Tool`. The tool name is derived
/// `subagent.<sub.name()>` so the main agent's tool catalogue
/// clearly distinguishes built-in tools from delegated subagents.
pub struct SubAgentTool {
    sub: Arc<dyn SubAgent>,
    /// Cached `subagent.<name>` — built once at construction so
    /// `Tool::name()` can return a `&str` without requiring runtime
    /// `format!`.
    full_name: String,
    /// Default workspace root used when the agent loop didn't pin
    /// one via `with_session_workspace`. Mirrors the behaviour of
    /// `harness-tools` constructors that take a `root: PathBuf`.
    default_root: PathBuf,
}

impl SubAgentTool {
    pub fn new(sub: Arc<dyn SubAgent>, default_root: PathBuf) -> Self {
        let full_name = format!("subagent.{}", sub.name());
        Self {
            sub,
            full_name,
            default_root,
        }
    }
}

#[async_trait]
impl Tool for SubAgentTool {
    fn name(&self) -> &str {
        &self.full_name
    }

    fn description(&self) -> &str {
        self.sub.description()
    }

    fn parameters(&self) -> Value {
        self.sub.input_schema()
    }

    fn requires_approval(&self) -> bool {
        self.sub.requires_approval()
    }

    fn category(&self) -> ToolCategory {
        // SubAgents that mutate the workspace (codex, claude_code)
        // belong to the `Write` permission lane so the existing
        // accept-edits / plan-mode filters apply uniformly. Read-only
        // delegates land in `Read`.
        if self.sub.requires_approval() {
            ToolCategory::Write
        } else {
            ToolCategory::Read
        }
    }

    async fn invoke(&self, args: Value) -> std::result::Result<String, BoxError> {
        let task = args
            .get("task")
            .and_then(|v| v.as_str())
            .ok_or_else(|| -> BoxError {
                "subagent invocation missing required `task` string".into()
            })?
            .to_owned();

        let workspace_root = active_workspace_or(&self.default_root);

        let input = SubAgentInput {
            task,
            workspace_root,
            context: args.get("context").cloned(),
            // v1.0 forbids recursion. The outer agent's tool
            // registry should not contain `subagent.*` for nested
            // invocations — this field is informational + a safety
            // net for transports that might inspect it.
            caller_chain: vec![self.sub.name().to_owned()],
        };

        let out = self.sub.invoke(input).await?;
        Ok(out.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::echo::EchoSubAgent;
    use harness_core::with_subagent;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn wrapper_exposes_subagent_as_tool() {
        let sub = Arc::new(EchoSubAgent::new("echo"));
        let tool = SubAgentTool::new(sub, PathBuf::from("/tmp"));
        assert_eq!(tool.name(), "subagent.echo");
        assert!(tool.parameters().is_object());
        // EchoSubAgent doesn't require approval (`requires_approval`
        // default is false), so the wrapper inherits read category.
        assert!(!tool.requires_approval());
        assert!(matches!(tool.category(), ToolCategory::Read));
    }

    #[tokio::test]
    async fn wrapper_runs_inside_with_subagent_scope() {
        let sub = Arc::new(EchoSubAgent::new("echo"));
        let tool = SubAgentTool::new(sub, PathBuf::from("/tmp"));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = with_subagent(tx, async {
            tool.invoke(json!({ "task": "hello" })).await.unwrap()
        })
        .await;
        assert_eq!(result, "echoed: hello");
        // Frames should have flowed: Started + (≥1 Delta) + Done.
        let mut started = 0;
        let mut done = 0;
        while let Ok(f) = rx.try_recv() {
            match f.event {
                harness_core::SubAgentEvent::Started { .. } => started += 1,
                harness_core::SubAgentEvent::Done { .. } => done += 1,
                _ => {}
            }
        }
        assert_eq!(started, 1);
        assert_eq!(done, 1);
    }

    #[tokio::test]
    async fn wrapper_rejects_missing_task_arg() {
        let sub = Arc::new(EchoSubAgent::new("echo"));
        let tool = SubAgentTool::new(sub, PathBuf::from("/tmp"));
        let err = tool.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("task"), "unexpected: {err}");
    }
}
