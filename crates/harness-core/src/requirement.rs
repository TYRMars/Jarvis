//! Persistent product requirements — the **executable backlog** that
//! lives under each [`Project`](crate::Project).
//!
//! `Requirement` is the server-side counterpart of the Web UI's
//! `/projects` kanban (Backlog / In progress / Review / Done). It is
//! distinct from [`TodoItem`](crate::TodoItem) and
//! [`PlanItem`](crate::PlanItem):
//!
//! - [`PlanItem`] is **per-turn** working steps the model emits via
//!   `plan.update`.
//! - [`TodoItem`] is **workspace-scoped** lightweight backlog
//!   (anything-goes notes, follow-ups).
//! - [`Requirement`] is **project-scoped** structured work — the
//!   long-lived "what we're building", with status transitions that
//!   drive the kanban view and (later) `RequirementRun` execution.
//!
//! The wire shape mirrors the existing frontend type at
//! `apps/jarvis-web/src/types/frames.ts` so the migration off
//! `localStorage["jarvis.productRequirements.v1"]` is a verbatim
//! field-name match: `id / project_id / title / description / status /
//! conversation_ids / created_at / updated_at`. New fields are added
//! with `#[serde(default, skip_serializing_if = ...)]` so v2
//! extensions (priority, manifest, run metadata) don't break clients.
//!
//! Mutations broadcast a [`RequirementEvent`] — the store's
//! `subscribe()` is the single fanout path, mirroring [`TodoStore`].
//! The WS bridge in `harness-server` filters by `project_id` so a
//! multi-window UI focused on different projects only sees its own
//! kanban move.

use serde::{Deserialize, Serialize};

/// One persistent requirement scoped to a single [`Project`](crate::Project).
///
/// The wire shape matches the JSON serialisation of this struct.
/// Renderers should treat unknown statuses as
/// [`RequirementStatus::Backlog`] for forward compat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    /// Stable identifier (UUID v4 string). Server-allocated on
    /// `POST /v1/projects/:id/requirements` so clients can't pick
    /// colliding ids.
    pub id: String,
    /// Foreign key into [`Project::id`](crate::Project). Not enforced
    /// at the storage layer (no DB FK) so a project delete doesn't
    /// cascade-orphan requirements; higher layers should check.
    pub project_id: String,
    /// Headline. One sentence; markdown is allowed but most UIs
    /// render it as plain text.
    pub title: String,
    /// Optional longer body. `None` means no body — UI shows just the
    /// title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Kanban column.
    pub status: RequirementStatus,
    /// Conversations (by id) that have been used to work on this
    /// requirement — i.e. the "runs". Each id refers to a row in
    /// [`ConversationStore`](crate::ConversationStore). Empty by
    /// default; appended when the user opens a fresh chat from the
    /// requirement card.
    #[serde(default)]
    pub conversation_ids: Vec<String>,
    /// Optional [`AgentProfile`](crate::AgentProfile) id this
    /// requirement is assigned to. `None` means "no specific
    /// assignee" — runs spawned from the card use the binary's
    /// global default provider/model. When set, `POST
    /// /v1/requirements/:id/runs` reads the profile to override
    /// provider / model / system_prompt for the new conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp; bumped on every mutation via
    /// [`Self::touch`].
    pub updated_at: String,
}

/// Kanban column / lifecycle state of a [`Requirement`]. Serialised
/// snake_case (`"backlog"` / `"in_progress"` / `"review"` / `"done"`)
/// to match the wire shape the Web UI already produces and consumes
/// (see `apps/jarvis-web/src/types/frames.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    /// Not yet picked up.
    Backlog,
    /// Actively being worked on.
    InProgress,
    /// Implementation finished, waiting for review / verification.
    Review,
    /// Accepted; nothing more to do.
    Done,
}

impl RequirementStatus {
    /// Parse a wire string. Returns `None` for unrecognised values;
    /// REST handlers convert that to a 400.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "backlog" => Self::Backlog,
            "in_progress" => Self::InProgress,
            "review" => Self::Review,
            "done" => Self::Done,
            _ => return None,
        })
    }

    /// Wire form (lowercase, snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::InProgress => "in_progress",
            Self::Review => "review",
            Self::Done => "done",
        }
    }
}

impl Requirement {
    /// Mint a new requirement with a fresh UUID and current RFC-3339
    /// timestamps. Status defaults to [`RequirementStatus::Backlog`].
    pub fn new(project_id: impl Into<String>, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            title: title.into(),
            description: None,
            status: RequirementStatus::Backlog,
            conversation_ids: Vec::new(),
            assignee_id: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Append `conversation_id` to [`Self::conversation_ids`] if it
    /// isn't already present, then [`Self::touch`]. Idempotent —
    /// a no-op when the id is already linked, in which case
    /// `updated_at` is **not** bumped (no actual mutation).
    pub fn link_conversation(&mut self, conversation_id: impl Into<String>) -> bool {
        let id = conversation_id.into();
        if self.conversation_ids.iter().any(|c| c == &id) {
            return false;
        }
        self.conversation_ids.push(id);
        self.touch();
        true
    }
}

/// Broadcast envelope sent on every successful [`RequirementStore`]
/// mutation. WS transports filter by `project_id` and forward to
/// subscribed clients as `requirement_upserted` / `requirement_deleted`
/// frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequirementEvent {
    /// A requirement was created or updated. The full row is
    /// included so listeners don't need to re-fetch.
    Upserted(Requirement),
    /// A requirement was deleted. Carries the project_id so listeners
    /// pinned to a different project can ignore it cheaply.
    Deleted { project_id: String, id: String },
}

impl RequirementEvent {
    /// Project key the event targets — used by WS handlers to filter
    /// against the socket's pinned project (when one is set).
    pub fn project_id(&self) -> &str {
        match self {
            Self::Upserted(item) => &item.project_id,
            Self::Deleted { project_id, .. } => project_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_via_wire() {
        for s in [
            RequirementStatus::Backlog,
            RequirementStatus::InProgress,
            RequirementStatus::Review,
            RequirementStatus::Done,
        ] {
            assert_eq!(RequirementStatus::from_wire(s.as_wire()), Some(s));
        }
        assert_eq!(RequirementStatus::from_wire("nonsense"), None);
    }

    #[test]
    fn status_serialises_snake_case() {
        let json = serde_json::to_string(&RequirementStatus::InProgress).unwrap();
        assert_eq!(json, "\"in_progress\"");
        let json = serde_json::to_string(&RequirementStatus::Backlog).unwrap();
        assert_eq!(json, "\"backlog\"");
    }

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let r = Requirement::new("proj-1", "ship the kanban");
        assert_eq!(r.id.len(), 36);
        assert_eq!(r.project_id, "proj-1");
        assert_eq!(r.title, "ship the kanban");
        assert_eq!(r.status, RequirementStatus::Backlog);
        assert!(r.description.is_none());
        assert!(r.conversation_ids.is_empty());
        assert_eq!(r.created_at, r.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut r = Requirement::new("p", "x");
        let before = r.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        r.touch();
        assert!(r.updated_at > before);
    }

    #[test]
    fn description_field_is_skipped_when_none() {
        let r = Requirement::new("p", "x");
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("description"), "got: {json}");
    }

    #[test]
    fn round_trip_through_json() {
        let mut r = Requirement::new("p", "x");
        r.description = Some("Build the kanban view".into());
        r.status = RequirementStatus::Review;
        r.conversation_ids = vec!["c1".into(), "c2".into()];
        let json = serde_json::to_string(&r).unwrap();
        let back: Requirement = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn link_conversation_appends_uniquely_and_touches() {
        let mut r = Requirement::new("p", "x");
        let before = r.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));

        assert!(r.link_conversation("c1"));
        assert_eq!(r.conversation_ids, vec!["c1"]);
        assert!(r.updated_at > before);

        // Idempotent: second link of the same id is a no-op.
        let second_pass = r.updated_at.clone();
        assert!(!r.link_conversation("c1"));
        assert_eq!(r.conversation_ids, vec!["c1"]);
        assert_eq!(r.updated_at, second_pass, "no-op should not touch");

        assert!(r.link_conversation("c2"));
        assert_eq!(r.conversation_ids, vec!["c1", "c2"]);
    }

    #[test]
    fn event_project_id_helper() {
        let r = Requirement::new("p1", "x");
        let upserted = RequirementEvent::Upserted(r.clone());
        assert_eq!(upserted.project_id(), "p1");
        let deleted = RequirementEvent::Deleted {
            project_id: "p2".into(),
            id: r.id.clone(),
        };
        assert_eq!(deleted.project_id(), "p2");
    }

    #[test]
    fn legacy_field_names_match_frontend_wire_shape() {
        // Sanity test: the JSON serialisation must use exactly the
        // field names the existing apps/jarvis-web/src/types/frames.ts
        // already produces. If any of these snake_case names drift,
        // the migration off localStorage breaks silently.
        let mut r = Requirement::new("p1", "title");
        r.description = Some("body".into());
        r.conversation_ids.push("c1".into());
        let json: serde_json::Value = serde_json::to_value(&r).unwrap();
        for key in [
            "id",
            "project_id",
            "title",
            "description",
            "status",
            "conversation_ids",
            "created_at",
            "updated_at",
        ] {
            assert!(json.get(key).is_some(), "missing wire key: {key}");
        }
    }
}
