//! User-authored discussion threads attached to a
//! [`Requirement`](crate::Requirement).
//!
//! Where [`Activity`](crate::Activity) is "what happened" (status
//! flips, runs, verifications — auto-generated audit rows),
//! [`Comment`] is "what people / agents said" — free-form prose, the
//! channel humans and agents use to discuss a piece of work without
//! having to reset and re-spin a `Conversation`.
//!
//! Two roles play together:
//!
//! * The agent loop reads recent comments at the top of each turn (so
//!   "operator told me to focus on X" becomes part of the turn's
//!   context — see the system-prompt assembly in `apps/jarvis/src/serve.rs`).
//! * The human reads comments + activity rows interleaved on a single
//!   timeline rendered by the web UI. The timeline is the union of
//!   the two streams keyed on `created_at` — there's no shared parent
//!   table.
//!
//! Storage shape mirrors [`Activity`]: a separate trait
//! ([`CommentStore`](crate::CommentStore)) so the JSON / SQL backends
//! own their own files / tables and the agent loop stays decoupled
//! from the choice. Comments are _not_ append-only — operators can
//! edit typos and delete comments they regret. The
//! [`updated_at`](Self::updated_at) timestamp lets the UI show
//! "(edited)" markers.
//!
//! Phase 3.8 (Multica-inspired). Companion proposal:
//! `docs/proposals/work-orchestration.zh-CN.md` §"Phase 3.8 — Comments".

use serde::{Deserialize, Serialize};

use crate::ActivityActor;

/// One row in the discussion thread for a Requirement.
///
/// `parent_id` enables one level of threading: a top-level comment
/// has `parent_id = None`; a reply has `parent_id = Some(top_level_id)`.
/// We deliberately keep this flat (no nesting deeper than two levels)
/// — multi-level reply trees are a feature trap; Linear / GitHub /
/// Multica all flatten beyond depth 1, and so do we.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub struct Comment {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// The Requirement this comment is attached to.
    pub requirement_id: String,
    /// Who wrote it. Reuses `ActivityActor` so a comment authored by
    /// an agent can carry its profile id and a human-authored one
    /// stays a flat `Human` variant. `System` is reserved for any
    /// future "the server posted this" case (release notes,
    /// auto-summaries) — humans should not write `System` comments
    /// directly.
    pub author: ActivityActor,
    /// Plain markdown body. No HTML sanitisation here — the trait
    /// stays format-agnostic; the web UI renders via its existing
    /// markdown component which handles sanitisation.
    pub body: String,
    /// `Some(<top_level_id>)` for a one-level reply; `None` for a
    /// top-level comment. Implementations MUST reject inserts where
    /// `parent_id` itself has a non-`None` parent — i.e. depth > 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// RFC-3339 / ISO-8601. Set on insert, never mutated.
    pub created_at: String,
    /// RFC-3339 / ISO-8601. Set on insert (= `created_at`), bumped
    /// on every edit. The UI compares the two to decide whether to
    /// render an "(edited)" marker.
    pub updated_at: String,
}

impl Comment {
    /// Build a fresh top-level comment with a new UUID and matching
    /// timestamps.
    pub fn new(
        requirement_id: impl Into<String>,
        author: ActivityActor,
        body: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            requirement_id: requirement_id.into(),
            author,
            body: body.into(),
            parent_id: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Build a reply to `parent_id`. The depth-1 invariant is the
    /// store's responsibility to enforce on insert; this constructor
    /// just records the parent.
    pub fn reply(
        requirement_id: impl Into<String>,
        author: ActivityActor,
        body: impl Into<String>,
        parent_id: impl Into<String>,
    ) -> Self {
        let mut c = Self::new(requirement_id, author, body);
        c.parent_id = Some(parent_id.into());
        c
    }

    /// Replace the body and bump `updated_at`. Returns `true` when
    /// the body actually changed; the store can use this to skip a
    /// no-op write.
    pub fn edit(&mut self, new_body: impl Into<String>) -> bool {
        let new_body = new_body.into();
        if new_body == self.body {
            return false;
        }
        self.body = new_body;
        self.updated_at = chrono::Utc::now().to_rfc3339();
        true
    }
}

/// Broadcast event for [`Comment`] mutations.
///
/// Emitted by [`CommentStore`](crate::CommentStore) implementations
/// after a successful write. Web sockets relay these to clients
/// subscribed to a Requirement's timeline so the UI updates without
/// a refetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommentEvent {
    /// A new comment was posted.
    Posted(Comment),
    /// An existing comment was edited (body / `updated_at` changed).
    Edited(Comment),
    /// A comment was deleted. Only the id is emitted — clients
    /// already know the requirement_id from their subscription
    /// scope, and the row's contents are gone.
    Deleted {
        requirement_id: String,
        comment_id: String,
    },
}

impl CommentEvent {
    /// Requirement id the event targets — convenience for
    /// per-requirement WS filtering, mirrors `ActivityEvent`.
    pub fn requirement_id(&self) -> &str {
        match self {
            Self::Posted(c) | Self::Edited(c) => &c.requirement_id,
            Self::Deleted { requirement_id, .. } => requirement_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mints_uuid_and_matching_timestamps() {
        let c = Comment::new("req-1", ActivityActor::Human, "hello");
        assert_eq!(c.id.len(), 36);
        assert_eq!(c.requirement_id, "req-1");
        assert_eq!(c.body, "hello");
        assert!(c.parent_id.is_none());
        assert_eq!(c.created_at, c.updated_at);
    }

    #[test]
    fn reply_records_parent() {
        let c = Comment::reply("req-1", ActivityActor::Human, "+1", "top-id");
        assert_eq!(c.parent_id.as_deref(), Some("top-id"));
    }

    #[test]
    fn edit_changes_body_and_bumps_updated_at() {
        let mut c = Comment::new("req-1", ActivityActor::Human, "v1");
        let original_updated = c.updated_at.clone();
        // Sleep enough that the RFC-3339 string actually differs.
        std::thread::sleep(std::time::Duration::from_millis(10));
        let changed = c.edit("v2");
        assert!(changed);
        assert_eq!(c.body, "v2");
        assert_ne!(c.updated_at, original_updated);
        assert_eq!(c.created_at, original_updated, "created_at is immutable");
    }

    #[test]
    fn edit_skips_when_body_unchanged() {
        let mut c = Comment::new("req-1", ActivityActor::Human, "same");
        let original_updated = c.updated_at.clone();
        let changed = c.edit("same");
        assert!(!changed);
        assert_eq!(c.updated_at, original_updated);
    }

    #[test]
    fn round_trips_json_with_optional_parent_id_omitted() {
        let c = Comment::new("req-1", ActivityActor::Human, "no parent");
        let s = serde_json::to_string(&c).unwrap();
        assert!(
            !s.contains("parent_id"),
            "serde(skip_serializing_if = Option::is_none) should drop the field"
        );
        let back: Comment = serde_json::from_str(&s).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn round_trips_json_with_agent_author() {
        let c = Comment::new(
            "req-1",
            ActivityActor::Agent {
                profile_id: "alice-bot".into(),
            },
            "hi from a bot",
        );
        let s = serde_json::to_string(&c).unwrap();
        let back: Comment = serde_json::from_str(&s).unwrap();
        assert_eq!(back, c);
    }
}
