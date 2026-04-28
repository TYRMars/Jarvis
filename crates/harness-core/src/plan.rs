//! Plan channel — typed "what is the agent doing" stream.
//!
//! Coding workflows benefit from a visible, structured plan: the
//! model declares "I will (1) inspect the failing test, (2) patch
//! the serializer, (3) re-run cargo test", and the UI shows the
//! plan as a checklist that updates in place. Without a typed
//! channel, transports would have to parse natural-language plans
//! out of [`AgentEvent::Delta`] text, which is fragile and
//! provider-specific.
//!
//! Wire model:
//!
//! - The agent loop installs an [`mpsc::UnboundedSender<Vec<PlanItem>>`]
//!   in a `tokio::task_local` before invoking each tool, scoped via
//!   [`with_plan`]. The pattern mirrors [`crate::progress`].
//! - A tool (in practice the always-on `plan.update` tool) calls
//!   [`emit`] with the latest plan snapshot. **Each emit is a full
//!   replacement** — partial diffs would force the UI to reconstruct
//!   state from a sequence and waste bytes on the wire.
//! - The agent loop drains the receiver alongside `tool.invoke` and
//!   forwards each snapshot as `AgentEvent::PlanUpdate`.
//!
//! Outside an agent invocation the channel is absent — emits become
//! no-ops, which keeps the tool's unit tests trivial.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// One step in the agent's working plan. The shape is intentionally
/// minimal — the model writes what it needs, the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanItem {
    /// Stable identifier the model picks; lets it update individual
    /// items without sending the whole plan back. Free-form, but
    /// short kebab-case strings (`"inspect-test"`, `"patch-serde"`)
    /// keep diffs readable.
    pub id: String,
    /// Human-readable headline. One sentence; avoid markdown.
    pub title: String,
    /// State machine. Renderers should treat unknown statuses as
    /// `Pending` for forward-compat.
    pub status: PlanStatus,
    /// Optional one-line note. Useful for "blocked by X" style
    /// annotations the UI can show as secondary text.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub note: Option<String>,
}

/// Lifecycle of a [`PlanItem`]. Serialised lowercase
/// (`"pending"` / `"in_progress"` / `"completed"` / `"cancelled"`)
/// to match the JSON payload the model produces and the UI consumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    /// Not yet started.
    Pending,
    /// Currently being worked on. Conventionally at most one item
    /// is `InProgress` at any time, but the type doesn't enforce
    /// it — the model is free to parallelise if it has reason to.
    InProgress,
    /// Done.
    Completed,
    /// Abandoned without completing — used when the agent decides
    /// the step turned out unnecessary or impossible.
    Cancelled,
}

tokio::task_local! {
    /// Per-invocation plan sender, scoped via [`with_plan`].
    static PLAN_TX: mpsc::UnboundedSender<Vec<PlanItem>>;
}

/// Publish the latest plan snapshot. No-op when no listener is
/// installed (i.e. the tool was invoked outside an agent loop —
/// the test path).
pub fn emit(items: Vec<PlanItem>) {
    let _ = PLAN_TX.try_with(|tx| {
        let _ = tx.send(items);
    });
}

/// Whether a plan sender is installed for the current task.
pub fn is_active() -> bool {
    PLAN_TX.try_with(|_| ()).is_ok()
}

/// Run `fut` with `tx` installed as the active plan sender. Used by
/// the agent loop to scope a sender to a single tool invocation.
/// The sender goes out of scope when `fut` completes, so subsequent
/// invocations need their own channel.
pub async fn with_plan<F, R>(tx: mpsc::UnboundedSender<Vec<PlanItem>>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    PLAN_TX.scope(tx, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_inside_with_plan_reaches_receiver() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_plan(tx, async {
            assert!(is_active());
            emit(vec![PlanItem {
                id: "a".into(),
                title: "Step A".into(),
                status: PlanStatus::InProgress,
                note: None,
            }]);
        })
        .await;
        let items = rx.try_recv().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].status, PlanStatus::InProgress);
    }

    #[tokio::test]
    async fn emit_outside_scope_is_noop() {
        assert!(!is_active());
        emit(vec![]);
        // The point: this didn't panic.
    }

    #[test]
    fn plan_status_serialises_snake_case() {
        let items = vec![
            PlanItem {
                id: "x".into(),
                title: "X".into(),
                status: PlanStatus::InProgress,
                note: None,
            },
            PlanItem {
                id: "y".into(),
                title: "Y".into(),
                status: PlanStatus::Cancelled,
                note: Some("blocked".into()),
            },
        ];
        let json = serde_json::to_string(&items).unwrap();
        assert!(json.contains("\"in_progress\""), "got: {json}");
        assert!(json.contains("\"cancelled\""), "got: {json}");
        assert!(json.contains("\"note\":\"blocked\""), "got: {json}");
    }
}
