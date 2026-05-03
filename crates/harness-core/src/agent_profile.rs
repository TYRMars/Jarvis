//! Named agent profiles — "agents as teammates".
//!
//! Each profile bundles the choices that make a particular agent
//! identity (name, avatar, provider, model, optional system prompt
//! / default workspace / allowed tools) so a [`Requirement`](crate::Requirement)
//! can be assigned to one and the runtime can dispatch the work
//! against the right combination without the user re-entering it
//! per turn.
//!
//! Phase 3.6 (Multica-inspired). Goal in v0:
//!
//! - The web UI surfaces named agents in the Settings page and on
//!   each kanban card as an assignee picker.
//! - `Requirement.assignee_id` records the chosen profile id (or
//!   `None` for "use the server-default").
//! - `POST /v1/requirements/:id/runs` uses the assignee's
//!   `system_prompt` when minting the manifest seed so the model
//!   sees the assignee's instructions before the user's first turn.
//!
//! Provider routing on the WS turn itself stays a Phase 4 concern —
//! the metadata is recorded but per-turn routing through the
//! profile (so "Alice on Codex / GPT-5" actually dispatches there)
//! is wired separately. v0 keeps the wire surface stable so future
//! routing has a place to plug in.
//!
//! See `docs/proposals/work-orchestration.zh-CN.md` §"Phase 3.6" /
//! §"AgentProfile" for the full motivation.

use serde::{Deserialize, Serialize};

/// One named agent identity.
///
/// All fields are wire-stable (snake_case JSON). Optional ones use
/// `skip_serializing_if = "Option::is_none"` / `Vec::is_empty` so
/// older clients deserialise newer rows cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// Display name. Required, non-blank. Two profiles can have the
    /// same name (uniqueness is by id); the UI surfaces both.
    pub name: String,
    /// Optional avatar — emoji glyph, hex colour, or a URL. The web
    /// UI renders whatever the string is verbatim, so any encoding
    /// the operator likes works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Provider key (e.g. `"codex"`, `"anthropic"`, `"openai"`).
    /// Validated at startup to match a configured provider; `None`
    /// fields cause start_run to fall back to the server default.
    pub provider: String,
    /// Model id. Required so a profile is always actionable
    /// (`"Alice"` without a model is too vague).
    pub model: String,
    /// Optional override of the system prompt. When set,
    /// `start_run` prepends this to the manifest summary so the
    /// model sees the assignee's instructions before the user's
    /// first turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Optional default workspace path. UIs that switch context
    /// when picking an assignee read this. Empty = "no preference".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<String>,
    /// Tool allowlist. Empty = "use the server's default
    /// catalogue"; non-empty = restrict to these tool names.
    /// Validation against the live `ToolRegistry` is the runtime's
    /// responsibility — bad names are surfaced at dispatch time,
    /// not at profile save time, so a temporarily-missing tool
    /// doesn't block creating a profile that mentions it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// RFC-3339 / ISO-8601 timestamp.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp. Updated by the REST handlers
    /// (and only there — direct store writes still bump it because
    /// the helper here lives on the type).
    pub updated_at: String,
}

impl AgentProfile {
    /// Mint a new profile with a fresh UUID and current
    /// timestamps. Trims `name` for safety; callers should still
    /// reject blank names at the REST layer.
    pub fn new(name: impl Into<String>, provider: impl Into<String>, model: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into().trim().to_string(),
            avatar: None,
            provider: provider.into(),
            model: model.into(),
            system_prompt: None,
            default_workspace: None,
            allowed_tools: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to now. Call this after every mutation
    /// to a profile field except the timestamp itself.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Broadcast event for [`AgentProfile`] mutations.
///
/// Mirrors `RequirementEvent` / `TodoEvent`: one variant per
/// mutating op so transport bridges can render frame-per-frame.
///
/// `Upserted` carries a full `AgentProfile` (~200 bytes of strings)
/// while `Deleted` is just an id; clippy flags this as
/// `large_enum_variant`. The pattern is the same as our other
/// `*Event` enums and the broadcast channel sees handful-per-day
/// volume in practice, so we accept the size asymmetry rather
/// than boxing every payload.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentProfileEvent {
    /// Profile inserted or replaced.
    Upserted(AgentProfile),
    /// Profile deleted.
    Deleted { id: String },
}

impl AgentProfileEvent {
    /// Profile id the event targets.
    pub fn id(&self) -> &str {
        match self {
            Self::Upserted(p) => &p.id,
            Self::Deleted { id } => id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        assert_eq!(p.id.len(), 36);
        assert_eq!(p.name, "Alice");
        assert_eq!(p.provider, "openai");
        assert_eq!(p.model, "gpt-4o-mini");
        assert!(p.avatar.is_none());
        assert!(p.allowed_tools.is_empty());
        assert_eq!(p.created_at, p.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at_only() {
        let mut p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        let created = p.created_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(2));
        p.touch();
        assert_eq!(p.created_at, created);
        assert_ne!(p.updated_at, created);
    }

    #[test]
    fn round_trip_skips_default_optional_fields() {
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        let json = serde_json::to_string(&p).unwrap();
        // None / empty optional fields are skipped on the wire.
        assert!(!json.contains("avatar"));
        assert!(!json.contains("system_prompt"));
        assert!(!json.contains("default_workspace"));
        assert!(!json.contains("allowed_tools"));
        let back: AgentProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn upserted_event_round_trips() {
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        let ev = AgentProfileEvent::Upserted(p.clone());
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"upserted\""));
        let back: AgentProfileEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id(), p.id);
    }

    #[test]
    fn deleted_event_round_trips() {
        let ev = AgentProfileEvent::Deleted { id: "p-7".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"deleted\""));
        let back: AgentProfileEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id(), "p-7");
    }
}
