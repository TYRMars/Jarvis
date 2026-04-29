//! Persistent project TODO board — value types + store-broadcast event.
//!
//! Distinct from [`crate::plan`]: `plan` is the per-turn working
//! checklist a model maintains via the [`crate::plan::with_plan`]
//! task-local channel and is replaced as a snapshot on every emit.
//! This module is the *long-lived backlog* — items survive across
//! turns, conversations, and process restarts. Mutations come from
//! either the agent (via `todo.*` tools) or the human (via REST /
//! UI), and are fanned out to all subscribers from the store, not
//! the agent loop.
//!
//! Wire model:
//!
//! - [`TodoItem`] is the row shape — flat, JSON-serialisable, and
//!   small. New fields are added with `#[serde(default,
//!   skip_serializing_if = "Option::is_none")]` so v2 extensions
//!   don't break existing clients.
//! - [`TodoEvent`] is the broadcast envelope: `Upserted(TodoItem)`
//!   or `Deleted { workspace, id }`. WS sessions filter by
//!   `workspace` to avoid cross-talk between multi-window UIs
//!   pinned to different roots.
//! - The agent stream stays uninvolved on purpose — the store's
//!   `subscribe()` is the single broadcast path. Tools call store
//!   mutators directly; REST handlers call the same mutators; both
//!   produce the same fanout. No `AgentEvent::TodoUpdate` variant.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::BoxError;

/// One persistent TODO entry, scoped to a single workspace.
///
/// The wire shape matches the JSON serialisation of this struct.
/// Renderers should treat unknown statuses as
/// [`TodoStatus::Pending`] for forward compat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    /// Stable identifier (UUID v4 string). Server-allocated on
    /// `todo.add` / `POST /v1/todos` so clients can't pick colliding
    /// ids.
    pub id: String,
    /// Canonicalised absolute path of the workspace this TODO
    /// belongs to. Use [`crate::workspace::canonicalize_workspace`]
    /// at every entry point so all callers (REST, tool, UI) agree
    /// on the key.
    pub workspace: String,
    /// Human-readable headline. One sentence; avoid markdown.
    pub title: String,
    /// State machine.
    pub status: TodoStatus,
    /// Optional priority. `None` = unprioritised — most TODOs are.
    /// Renderers should treat unknown values as `None` for forward
    /// compat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<TodoPriority>,
    /// Optional free-form note. Useful for "blocked by X" or a
    /// link to a discussion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// RFC-3339 / ISO-8601 timestamp.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp; bumped on every mutation.
    pub updated_at: String,
}

/// Lifecycle of a [`TodoItem`]. Serialised lowercase
/// (`"pending"` / `"in_progress"` / `"completed"` / `"cancelled"` /
/// `"blocked"`) to match the JSON payload the model produces and
/// the UI consumes.
///
/// `Blocked` is intentionally separate from `Cancelled`: blocked
/// items expect to be picked up later (note the unblocker in
/// `notes`), cancelled items are abandoned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    /// Not yet started.
    Pending,
    /// Currently being worked on.
    InProgress,
    /// Done.
    Completed,
    /// Abandoned without completing.
    Cancelled,
    /// Waiting on something else; the unblocker should live in the
    /// item's `notes`.
    Blocked,
}

impl TodoStatus {
    /// Parse a wire string. Returns `None` for unrecognised values
    /// — REST handlers convert to a 400 with the bad value echoed.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "blocked" => Self::Blocked,
            _ => return None,
        })
    }

    /// The lowercase wire form.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Blocked => "blocked",
        }
    }
}

/// Optional priority hint on a [`TodoItem`]. Three buckets keeps
/// the model's choice-space small (model writers ship this; it's
/// not a 1–5 numeric ladder where `3 vs 4` becomes a bikeshed).
/// Wire format: lowercase strings `"low"` / `"medium"` / `"high"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoPriority {
    Low,
    Medium,
    High,
}

impl TodoPriority {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            _ => return None,
        })
    }
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

impl TodoItem {
    /// Mint a new TODO with a fresh UUID and current RFC-3339
    /// timestamps. Status defaults to [`TodoStatus::Pending`].
    pub fn new(workspace: impl Into<String>, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace: workspace.into(),
            title: title.into(),
            status: TodoStatus::Pending,
            priority: None,
            notes: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Broadcast envelope sent on every successful mutation. WS
/// transports filter by `workspace` and forward to subscribed
/// clients as `todo_upserted` / `todo_deleted` frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TodoEvent {
    /// A TODO was created or updated. The full row is included so
    /// listeners don't need to re-fetch.
    Upserted(TodoItem),
    /// A TODO was deleted. Carries the workspace key so listeners
    /// pinned to a different workspace can ignore it cheaply.
    Deleted { workspace: String, id: String },
}

impl TodoEvent {
    /// Workspace key the event targets — used by WS handlers to
    /// filter against the socket's pinned workspace.
    pub fn workspace(&self) -> &str {
        match self {
            Self::Upserted(item) => &item.workspace,
            Self::Deleted { workspace, .. } => workspace,
        }
    }
}

// ---------- per-turn mutation budget --------------------------------------
//
// The `todo.add` / `todo.update` / `todo.delete` tools each affect one
// (or, for delete, up to 50) row, but a model can call them many times
// in a single turn. We don't want a runaway loop to fan out hundreds
// of mutations and fill the backlog with junk. The agent loop scopes
// a [`with_turn_budget`] frame around each turn; mutation tools call
// [`count_mutation`] before they touch the store, and the call errors
// out cleanly once the cap is hit. The model sees the error and can
// recover (apologise, ask the user, stop spamming).
//
// Outside an agent loop scope (tests, REST handlers, code paths that
// drive tools directly) the call is a free pass — we don't want to
// punish out-of-band callers, and REST handlers already gate by HTTP
// shape.

/// Hard cap on `todo.*` mutations within a single agent turn. Picked
/// to be generous enough for real refactors (mark a dozen items
/// completed, add a half-dozen follow-ups) but small enough to stop
/// a runaway loop early.
pub const MAX_MUTATIONS_PER_TURN: usize = 50;

tokio::task_local! {
    /// Per-turn mutation counter. Scoped via [`with_turn_budget`] from
    /// the agent loop's run / run_stream entry points.
    static TURN_BUDGET: Arc<AtomicUsize>;
}

/// Run `fut` with a fresh mutation counter installed. Each call
/// allocates its own counter so siblings don't bleed across turns.
pub async fn with_turn_budget<F, R>(fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    let counter = Arc::new(AtomicUsize::new(0));
    TURN_BUDGET.scope(counter, fut).await
}

/// Increment the in-flight turn's mutation counter and return an
/// error if the cap is exceeded. Returns `Ok(())` when no budget is
/// installed (out-of-band callers — REST handlers, tests). The
/// returned error message is intentionally model-readable so the
/// agent's recovery prose stays useful.
pub fn count_mutation() -> Result<(), BoxError> {
    TURN_BUDGET
        .try_with(|counter| {
            let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
            if n > MAX_MUTATIONS_PER_TURN {
                Err(format!(
                    "todo: per-turn mutation cap ({MAX_MUTATIONS_PER_TURN}) reached; \
                     stop calling todo.add / todo.update / todo.delete this turn"
                )
                .into())
            } else {
                Ok(())
            }
        })
        .unwrap_or(Ok(()))
}

/// Whether a budget scope is installed for the current task. Useful
/// for tests; production callers shouldn't gate behaviour on this.
pub fn budget_active() -> bool {
    TURN_BUDGET.try_with(|_| ()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_via_wire() {
        for s in [
            TodoStatus::Pending,
            TodoStatus::InProgress,
            TodoStatus::Completed,
            TodoStatus::Cancelled,
            TodoStatus::Blocked,
        ] {
            assert_eq!(TodoStatus::from_wire(s.as_wire()), Some(s));
        }
        assert_eq!(TodoStatus::from_wire("nonsense"), None);
    }

    #[test]
    fn status_serialises_snake_case() {
        let json = serde_json::to_string(&TodoStatus::InProgress).unwrap();
        assert_eq!(json, "\"in_progress\"");
        let json = serde_json::to_string(&TodoStatus::Blocked).unwrap();
        assert_eq!(json, "\"blocked\"");
    }

    #[test]
    fn item_new_mints_uuid_and_timestamps() {
        let t = TodoItem::new("/repo", "fix parser");
        assert_eq!(t.id.len(), 36);
        assert_eq!(t.workspace, "/repo");
        assert_eq!(t.title, "fix parser");
        assert_eq!(t.status, TodoStatus::Pending);
        assert!(t.notes.is_none());
        assert_eq!(t.created_at, t.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut t = TodoItem::new("/repo", "x");
        let before = t.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        t.touch();
        assert!(t.updated_at > before, "{} > {}", t.updated_at, before);
    }

    #[test]
    fn notes_field_is_skipped_when_none() {
        let t = TodoItem::new("/r", "x");
        let json = serde_json::to_string(&t).unwrap();
        assert!(!json.contains("notes"), "got: {json}");
    }

    #[test]
    fn round_trip_through_json() {
        let mut t = TodoItem::new("/r", "x");
        t.notes = Some("blocked by ticket #5".into());
        t.status = TodoStatus::Blocked;
        let json = serde_json::to_string(&t).unwrap();
        let back: TodoItem = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
    }

    #[test]
    fn event_workspace_helper() {
        let item = TodoItem::new("/repo", "x");
        let upserted = TodoEvent::Upserted(item.clone());
        assert_eq!(upserted.workspace(), "/repo");
        let deleted = TodoEvent::Deleted {
            workspace: "/other".into(),
            id: item.id.clone(),
        };
        assert_eq!(deleted.workspace(), "/other");
    }

    #[tokio::test]
    async fn budget_inactive_outside_scope_returns_ok() {
        assert!(!budget_active());
        for _ in 0..(MAX_MUTATIONS_PER_TURN + 5) {
            assert!(count_mutation().is_ok());
        }
    }

    #[tokio::test]
    async fn budget_counts_mutations_inside_scope() {
        with_turn_budget(async {
            assert!(budget_active());
            for _ in 0..MAX_MUTATIONS_PER_TURN {
                assert!(count_mutation().is_ok());
            }
            // The (cap+1)-th call must error.
            let err = count_mutation().unwrap_err();
            assert!(err.to_string().contains("per-turn mutation cap"));
        })
        .await;
    }

    #[tokio::test]
    async fn budget_resets_per_scope() {
        // First scope hits the cap.
        with_turn_budget(async {
            for _ in 0..(MAX_MUTATIONS_PER_TURN + 1) {
                let _ = count_mutation();
            }
        })
        .await;
        // Second scope is independent — the first call is fine again.
        with_turn_budget(async {
            assert!(count_mutation().is_ok());
        })
        .await;
    }
}
