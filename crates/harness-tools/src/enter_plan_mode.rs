//! `enter_plan_mode` — agent-initiated entry into Plan Mode.
//!
//! Companion to [`crate::exit_plan::ExitPlanTool`]. Without this
//! tool the only way to enter Plan Mode is via the WS `SetMode`
//! frame or the CLI flag — i.e. the operator has to click. When
//! the model itself realises a request is risky / large enough to
//! warrant a plan-first round, calling `enter_plan_mode` flips the
//! session into read-only investigation territory until the model
//! finishes drafting and calls `exit_plan`.
//!
//! Wire shape:
//!
//! - The tool emits [`harness_core::PermissionMode::Plan`] on the
//!   shared mode-signal channel via
//!   [`harness_core::mode_signal::emit`]. The agent loop relays
//!   that to the transport as
//!   [`harness_core::AgentEvent::ModeChanged`].
//! - The transport (today: the WS handler) reacts by updating its
//!   per-socket mode handle so the *next* user turn's
//!   `tool_filter` + approver behave like Plan Mode. The current
//!   turn finishes under the old mode — that's intentional, since
//!   mid-turn approver swaps are racy.
//!
//! Registration: off by default. The composition root opts in via
//! `BuiltinsConfig::enable_enter_plan_mode`. Most coding deployments
//! want this on; locked-down "model can never escape its mode"
//! deployments can leave it off.

use async_trait::async_trait;
use harness_core::{BoxError, PermissionMode, Tool, ToolCategory};
use serde_json::{json, Value};

pub struct EnterPlanModeTool;

#[async_trait]
impl Tool for EnterPlanModeTool {
    fn name(&self) -> &str {
        "enter_plan_mode"
    }

    fn description(&self) -> &str {
        "Switch the agent into Plan Mode: write/exec/network tools \
         are hidden, only read-only investigation tools (`fs.read`, \
         `code.grep`, `git.*`, `workspace.context`, ...) plus \
         `exit_plan` are exposed. The mode change takes effect on \
         the **next** user turn, not mid-turn. Call this when a \
         request is large or risky and you want to draft a plan \
         before touching anything. End the plan-mode cycle by \
         calling `exit_plan({plan: \"...\"})` from inside it. No \
         arguments."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        })
    }

    /// Listed as Read so the Plan-Mode tool_filter never accidentally
    /// hides this tool from a Plan-Mode session that wants to flip
    /// back into Plan Mode after a refinement (no-op, but harmless).
    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        harness_core::mode_signal::emit(PermissionMode::Plan);
        Ok("plan mode armed for next turn".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invocation_outside_agent_loop_is_noop_but_returns_ok() {
        let out = EnterPlanModeTool.invoke(json!({})).await.unwrap();
        assert!(out.contains("plan mode"));
    }

    #[tokio::test]
    async fn invocation_inside_scope_signals_plan_mode() {
        use tokio::sync::mpsc;
        let (tx, mut rx) = mpsc::unbounded_channel::<PermissionMode>();
        harness_core::mode_signal::with_mode_signal(tx, async {
            EnterPlanModeTool.invoke(json!({})).await.unwrap();
        })
        .await;
        assert_eq!(rx.try_recv().unwrap(), PermissionMode::Plan);
    }

    #[test]
    fn is_read_only_and_not_destructive() {
        assert_eq!(EnterPlanModeTool.category(), ToolCategory::Read);
        assert!(EnterPlanModeTool.is_concurrency_safe());
        assert!(!EnterPlanModeTool.is_destructive());
    }
}
