//! `exit_plan` — terminal tool used by Plan Mode.
//!
//! In Plan Mode the LLM tool catalogue is filtered to read-only +
//! `exit_plan`. The agent explores the workspace, drafts a plan, then
//! calls `exit_plan({plan: "..."})` to hand the plan to the user. The
//! tool's `is_terminal()` flag tells the agent loop to stop the turn
//! immediately after this call (skipping any later tool calls in the
//! same batch) and to emit `AgentEvent::PlanProposed { plan }` so the
//! transport can surface the plan card.
//!
//! The mode does **not** auto-switch on `exit_plan`. The user picks
//! the post-mode (ask / accept-edits / auto) when they accept the
//! plan via the `{type:"accept_plan", post_mode:"..."}` WS frame —
//! that pattern keeps a malicious-prompt model from hijacking the
//! mode by emitting a fake plan.

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};

pub struct ExitPlanTool;

#[async_trait]
impl Tool for ExitPlanTool {
    fn name(&self) -> &str {
        "exit_plan"
    }

    fn description(&self) -> &str {
        "End Plan Mode by submitting your proposed plan to the user. \
         Pass the full plan as `plan` (markdown is fine — bullet steps, \
         file paths, expected diffs). The agent's turn stops immediately \
         after this call; the user reviews the plan and either accepts \
         (choosing the next mode — ask / accept-edits / auto) or asks \
         you to refine. **Only available in Plan Mode.**"
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "plan": {
                    "type": "string",
                    "description": "The complete plan you want the user to review. Markdown formatting recommended."
                }
            },
            "required": ["plan"]
        })
    }

    fn category(&self) -> ToolCategory {
        // Read so it survives the Plan-Mode filter that hides Write/Exec/Network.
        ToolCategory::Read
    }

    fn is_terminal(&self) -> bool {
        true
    }

    fn cacheable(&self) -> bool {
        true
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("plan")
            .and_then(Value::as_str)
            .and_then(|p| p.lines().next())
            .map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let plan = args
            .get("plan")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `plan` argument".into() })?;
        if plan.trim().is_empty() {
            return Err("`plan` must not be empty".into());
        }
        // Return the plan body verbatim so transports that look at
        // ToolEnd before PlanProposed still see meaningful content.
        Ok(plan.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_plan_verbatim() {
        let out = ExitPlanTool
            .invoke(json!({ "plan": "1. read foo\n2. patch bar" }))
            .await
            .unwrap();
        assert!(out.contains("read foo"));
    }

    #[tokio::test]
    async fn rejects_empty_plan() {
        let err = ExitPlanTool
            .invoke(json!({ "plan": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[tokio::test]
    async fn rejects_missing_plan() {
        let err = ExitPlanTool.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn is_terminal_and_read_only() {
        assert!(ExitPlanTool.is_terminal());
        assert_eq!(ExitPlanTool.category(), ToolCategory::Read);
    }
}
