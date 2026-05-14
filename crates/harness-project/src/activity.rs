//! Per-Requirement audit timeline.
//!
//! One row per "thing that happened" against a kanban
//! [`Requirement`](crate::Requirement) — status flips, run lifecycle,
//! verification results. Append-only by design (no upsert, no delete).
//! Surfaced via [`ActivityStore`](crate::ActivityStore) and the WS
//! frame `activity_appended` so a single connected client sees the
//! same timeline regardless of which mutation drove it (REST PATCH,
//! `/runs` POST, future `requirement.*` agent tools).
//!
//! This module deliberately stays a "what happened" log, not a
//! "what's true now" projection. The current Requirement / Run row
//! is still the authoritative source — `Activity` exists so the UI
//! can render *how we got here* without reconstructing the trail
//! from agent events.
//!
//! Phase 3.7 (Multica-inspired). The companion proposal lives at
//! `docs/proposals/work-orchestration.zh-CN.md` §"借鉴 Multica" /
//! §"Phase 3.7".

use serde::{Deserialize, Serialize};

/// One audit-timeline row.
///
/// `body` is intentionally an open `serde_json::Value` rather than a
/// per-kind enum payload — different events carry different shapes
/// (`{from, to}` for status, `{run_id, status}` for run finished,
/// etc.) and routing every shape through a typed enum would force
/// every consumer to know the full set. UIs that need to read a
/// field do so on a per-kind basis; the wire format documents the
/// expected shape per kind below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// Requirement this activity belongs to.
    pub requirement_id: String,
    /// What happened.
    pub kind: ActivityKind,
    /// Who did it.
    pub actor: ActivityActor,
    /// Free-form payload, shape varies by `kind`. See variant docs
    /// for the expected fields.
    pub body: serde_json::Value,
    /// RFC-3339 / ISO-8601 timestamp.
    pub created_at: String,
}

impl Activity {
    /// Build a new activity row with a fresh UUID and current
    /// timestamp.
    pub fn new(
        requirement_id: impl Into<String>,
        kind: ActivityKind,
        actor: ActivityActor,
        body: serde_json::Value,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            requirement_id: requirement_id.into(),
            kind,
            actor,
            body,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Kind of activity. Wire form is snake_case
/// (`"status_change"` / `"run_started"` / ...).
///
/// The set is intentionally small in v0; AssigneeChange / Comment /
/// Blocked / Unblocked are reserved for Phases 3.6 / 4 when their
/// driving features land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    /// Status flipped.
    /// Body: `{"from": "<wire>", "to": "<wire>"}`.
    StatusChange,
    /// A new RequirementRun was started.
    /// Body: `{"run_id": "<uuid>", "conversation_id": "<uuid>"}`.
    RunStarted,
    /// A RequirementRun reached a terminal status.
    /// Body: `{"run_id": "<uuid>", "status": "<wire>"}`.
    RunFinished,
    /// A verification result was attached to a run.
    /// Body: `{"run_id": "<uuid>", "status": "<wire>"}`.
    VerificationFinished,
    /// Reserved for Phase 3.6 — assignee change. Currently unused.
    AssigneeChange,
    /// Reserved for a future comment / annotation feature.
    Comment,
    /// Reserved for Phase 4 — manual block on a requirement.
    Blocked,
    /// Reserved for Phase 4 — clearing a block.
    Unblocked,
}

/// Who triggered an activity.
///
/// `Human` is the v0 default for any REST-driven mutation (we don't
/// have user identity yet — every authenticated REST call counts as
/// "the human at the keyboard"). `Agent` is reserved for Phase 4
/// when `requirement.*` tools let the model drive board state.
/// `System` is the bucket for server-side auto-advances
/// (e.g. `start_run` flipping `Backlog → InProgress`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActivityActor {
    Human,
    Agent { profile_id: String },
    System,
}

/// Broadcast event for [`Activity`] mutations.
///
/// Append-only log → only one variant. Kept as an enum (rather than
/// a bare `Activity`) so future variants (truncate, replay, etc.)
/// can land without a wire break.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActivityEvent {
    /// A new activity row was appended.
    Appended(Activity),
}

impl ActivityEvent {
    /// Requirement id the event targets — convenience for
    /// per-requirement WS filtering.
    pub fn requirement_id(&self) -> &str {
        match self {
            Self::Appended(a) => &a.requirement_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_mints_uuid_and_timestamp() {
        let a = Activity::new(
            "req-1",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({"from": "backlog", "to": "in_progress"}),
        );
        assert_eq!(a.id.len(), 36);
        assert_eq!(a.requirement_id, "req-1");
        assert_eq!(a.kind, ActivityKind::StatusChange);
    }

    #[test]
    fn round_trip_status_change_event() {
        let a = Activity::new(
            "req-1",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({"from": "backlog", "to": "in_progress"}),
        );
        let ev = ActivityEvent::Appended(a.clone());
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"appended\""));
        assert!(json.contains("\"kind\":\"status_change\""));
        assert!(json.contains("\"actor\":{\"type\":\"human\"}"));
        let back: ActivityEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.requirement_id(), "req-1");
    }

    #[test]
    fn agent_actor_carries_profile_id() {
        let actor = ActivityActor::Agent {
            profile_id: "prof-7".into(),
        };
        let json = serde_json::to_string(&actor).unwrap();
        assert!(json.contains("\"type\":\"agent\""));
        assert!(json.contains("\"profile_id\":\"prof-7\""));
        let back: ActivityActor = serde_json::from_str(&json).unwrap();
        assert_eq!(back, actor);
    }

    #[test]
    fn run_finished_body_round_trips() {
        let a = Activity::new(
            "req",
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({"run_id": "abc", "status": "completed"}),
        );
        let s = serde_json::to_string(&a).unwrap();
        let back: Activity = serde_json::from_str(&s).unwrap();
        assert_eq!(back, a);
    }
}
