//! `plan.update` — push a structured plan snapshot into the agent
//! event stream.
//!
//! The model calls this tool whenever it wants the UI to refresh
//! the visible checklist of work-in-progress. The full plan is sent
//! every time (replace, not patch); transports surface it as
//! [`harness_core::AgentEvent::PlanUpdate`].
//!
//! Always-on, read-only with respect to the workspace: it touches
//! no files, runs no processes, calls no network. The "side
//! effect" is purely an event emission, which the harness loop
//! relays through the per-invocation plan channel
//! ([`harness_core::plan::with_plan`]). Outside an agent loop the
//! channel is absent and the call is a no-op — so unit tests can
//! invoke directly without standing up the whole harness.

use async_trait::async_trait;
use harness_core::{plan as plan_chan, BoxError, PlanItem, PlanStatus, Tool, ToolCategory};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct PlanUpdateTool;

#[async_trait]
impl Tool for PlanUpdateTool {
    fn name(&self) -> &str {
        "plan.update"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Publish the agent's current plan as a structured checklist. \
         Each call REPLACES the previous plan snapshot — send every \
         step you want the user to see, not just the changed ones. \
         Use `id` (short kebab-case) to identify steps, `title` for \
         the headline, and `status` ∈ {pending, in_progress, \
         completed, cancelled}. Optional `note` is a one-line \
         annotation (e.g. \"blocked: missing fixture\")."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed", "cancelled"]
                            },
                            "note": { "type": "string" }
                        },
                        "required": ["id", "title", "status"]
                    }
                }
            },
            "required": ["items"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        // Use a private DTO instead of `serde_json::from_value::<Vec<PlanItem>>`
        // directly so we can produce a friendlier error message when
        // the model fumbles the schema (e.g. omits `id`).
        #[derive(Deserialize)]
        struct Args {
            items: Vec<RawItem>,
        }
        #[derive(Deserialize)]
        struct RawItem {
            id: String,
            title: String,
            status: PlanStatus,
            #[serde(default)]
            note: Option<String>,
        }

        let parsed: Args = serde_json::from_value(args).map_err(|e| -> BoxError {
            format!("plan.update: invalid `items` array: {e}").into()
        })?;

        if parsed.items.is_empty() {
            return Err(
                "plan.update: `items` must not be empty (use status=cancelled \
                       on every item to clear the plan)"
                    .into(),
            );
        }

        // Stable round-trip through the canonical PlanItem type so
        // the agent loop only ever sees one shape.
        let items: Vec<PlanItem> = parsed
            .items
            .into_iter()
            .map(|r| PlanItem {
                id: r.id,
                title: r.title,
                status: r.status,
                note: r.note,
            })
            .collect();

        let n = items.len();
        plan_chan::emit(items);
        // The model gets a tiny ack so the tool-call loop has a
        // textual `tool_result` to feed back. Keep it short — the
        // useful payload is the typed event the transport relays.
        Ok(format!("ok ({n} item(s))"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn emits_through_active_channel() {
        let tool = PlanUpdateTool;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let result = harness_core::with_plan(tx, async {
            tool.invoke(json!({
                "items": [
                    {"id": "a", "title": "Inspect", "status": "in_progress"},
                    {"id": "b", "title": "Patch", "status": "pending"}
                ]
            }))
            .await
        })
        .await
        .unwrap();
        assert!(result.contains("2 item"));
        let items = rx.try_recv().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].status, PlanStatus::InProgress);
        assert_eq!(items[1].status, PlanStatus::Pending);
    }

    #[tokio::test]
    async fn empty_items_errors() {
        let tool = PlanUpdateTool;
        let err = tool.invoke(json!({ "items": [] })).await.unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[tokio::test]
    async fn unknown_status_errors() {
        let tool = PlanUpdateTool;
        let err = tool
            .invoke(json!({ "items": [{"id": "a", "title": "A", "status": "wat"}] }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("invalid"), "got: {err}");
    }

    #[tokio::test]
    async fn outside_scope_is_noop_not_error() {
        // No `with_plan` wrapping — emit becomes a no-op but the
        // tool still returns ok (so test paths and direct invocations
        // don't blow up).
        let tool = PlanUpdateTool;
        let result = tool
            .invoke(json!({ "items": [{"id": "x", "title": "X", "status": "pending"}] }))
            .await
            .unwrap();
        assert!(result.contains("1 item"));
    }
}
