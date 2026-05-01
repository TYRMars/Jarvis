//! Named agent identities — the **assignee surface** for
//! [`Requirement`](crate::Requirement)s and the foundation for
//! Multica-style multi-agent collaboration.
//!
//! An `AgentProfile` is a saved bundle of provider / model /
//! system_prompt / allowed_tools that a user can name and reuse, e.g.
//! "Alice (Claude Code on rust)" or "Reviewer (gpt-5 + critique
//! prompt)". Phase 3.5 of `docs/proposals/work-orchestration.zh-CN.md`
//! introduces it as the building block for:
//!
//! - **assignee on a requirement card** — the kanban shows who's
//!   responsible, and `POST /v1/requirements/:id/runs` uses the
//!   assignee's profile to mint the new conversation
//!   (provider/model/system_prompt overrides) instead of the global
//!   default;
//! - **future restricted auto loop** (Phase 6) — when auto mode picks
//!   the next Ready unit, it dispatches to the unit's assigned
//!   profile only, so users can scope which agents the loop is allowed
//!   to drive;
//! - **@mentions in chat** — eventually a name like `@Alice` resolves
//!   to a profile id.
//!
//! The wire shape is deliberately a flat record so the JSON-blob-in-a-
//! row schema used by every SQL backend in `harness-store` round-trips
//! verbatim. New fields can be added with
//! `#[serde(default, skip_serializing_if = ...)]` for backward compat.
//!
//! Mutations broadcast an [`AgentProfileEvent`]; the WS bridge in
//! `harness-server` forwards them as `agent_profile_upserted` /
//! `agent_profile_deleted` frames so multi-window UIs stay in sync.

use serde::{Deserialize, Serialize};

/// One named agent identity. Server-side counterpart of the
/// `AgentProfile` shown in Settings → Agent profiles.
///
/// Field layout matches the wire shape; all optional fields are
/// `#[serde(default, skip_serializing_if = ...)]` so older or hand-rolled
/// payloads round-trip unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    /// Stable identifier (UUID v4 string). Server-allocated on
    /// `POST /v1/agent-profiles` so clients can't pick colliding ids.
    pub id: String,
    /// Display name. Free text; the UI uses this as the @mention
    /// handle. Not unique-enforced — duplicates are allowed at the
    /// storage layer; the UI may show a slug suffix to disambiguate.
    pub name: String,
    /// Optional avatar — emoji, single-char glyph, color hex, or URL.
    /// Renderers should detect type heuristically and fall back to a
    /// generated initial when invalid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Provider key as understood by `apps/jarvis::build_provider`:
    /// `"openai"` / `"openai-responses"` / `"anthropic"` / `"google"`
    /// / `"codex"` / `"kimi"` / `"ollama"`.
    pub provider: String,
    /// Concrete model id (e.g. `"claude-3-5-sonnet-latest"`,
    /// `"gpt-4o-mini"`). The provider is responsible for validating;
    /// an unknown model surfaces as a 4xx at run time, not on
    /// profile save.
    pub model: String,
    /// Optional override for the agent's system prompt. `None` means
    /// "use the binary's coding/general default". Empty string is
    /// **not** the same as `None` — an empty prompt is an explicit
    /// "no system prompt" instruction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Optional default workspace path for new conversations spawned
    /// from this profile. `None` means the session's pinned workspace
    /// (or the server's default root) is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<String>,
    /// Tool allowlist by name (`fs.read`, `git.diff`, etc.). Empty
    /// means "use the server's default tool set" — *not* "deny all";
    /// an explicit deny-all profile should ship a sentinel allowlist
    /// (e.g. `["echo"]`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// RFC-3339 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 timestamp; bumped on every mutation via [`Self::touch`].
    pub updated_at: String,
}

impl AgentProfile {
    /// Mint a new profile with a fresh UUID and current timestamps.
    /// `provider` and `model` are required because a profile that
    /// can't be dispatched isn't useful — saving a "draft" with
    /// missing fields is the UI's problem, not the model's.
    pub fn new(
        name: impl Into<String>,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
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

    /// Bump `updated_at` to "now". Mutators that change observable
    /// state should call this; cosmetic noops should not (so
    /// `updated_at` reflects real change for sort order).
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Broadcast envelope sent on every successful [`AgentProfileStore`]
/// mutation. WS transports forward to subscribed clients as
/// `agent_profile_upserted` / `agent_profile_deleted` frames.
///
/// Unlike [`crate::RequirementEvent`] there's no `project_id`
/// filter — agent profiles are global to the server, every connected
/// client sees every mutation.
//
// `large_enum_variant`: `Upserted` carries a full `AgentProfile`
// (~240 B) while `Deleted` carries only an id. Boxing the upserted
// variant would help RAM at the cost of an extra allocation per
// broadcast and would break wire-shape parity with `RequirementEvent`
// / `TodoEvent`. The events are short-lived (queued per-broadcast,
// dropped after fanout); the size delta isn't worth the API churn.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentProfileEvent {
    /// A profile was created or updated. Full row included so listeners
    /// don't need to refetch.
    Upserted(AgentProfile),
    /// A profile was deleted. Carries just the id.
    Deleted { id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let p = AgentProfile::new("Alice", "anthropic", "claude-3-5-sonnet-latest");
        assert_eq!(p.id.len(), 36);
        assert_eq!(p.name, "Alice");
        assert_eq!(p.provider, "anthropic");
        assert_eq!(p.model, "claude-3-5-sonnet-latest");
        assert!(p.avatar.is_none());
        assert!(p.system_prompt.is_none());
        assert!(p.default_workspace.is_none());
        assert!(p.allowed_tools.is_empty());
        assert_eq!(p.created_at, p.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut p = AgentProfile::new("a", "openai", "gpt-4o-mini");
        let before = p.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.touch();
        assert!(p.updated_at > before);
    }

    #[test]
    fn optional_fields_omitted_when_default() {
        let p = AgentProfile::new("a", "openai", "gpt-4o-mini");
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("avatar"), "got {json}");
        assert!(!json.contains("system_prompt"), "got {json}");
        assert!(!json.contains("default_workspace"), "got {json}");
        assert!(!json.contains("allowed_tools"), "got {json}");
    }

    #[test]
    fn round_trip_through_json() {
        let mut p = AgentProfile::new("Bob", "anthropic", "claude-3-5-sonnet-latest");
        p.avatar = Some("🤖".into());
        p.system_prompt = Some("You are an expert in rust.".into());
        p.default_workspace = Some("/Users/x/code/jarvis".into());
        p.allowed_tools = vec!["fs.read".into(), "code.grep".into()];
        let json = serde_json::to_string(&p).unwrap();
        let back: AgentProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn legacy_minimum_fields_decode() {
        // Hand-rolled minimal payload — only required fields. Must
        // decode without error so callers can craft profiles
        // programmatically.
        let raw = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "name": "Min",
            "provider": "openai",
            "model": "gpt-4o-mini",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        });
        let p: AgentProfile = serde_json::from_value(raw).unwrap();
        assert!(p.avatar.is_none());
        assert!(p.allowed_tools.is_empty());
    }

    #[test]
    fn event_round_trips_through_serde() {
        let p = AgentProfile::new("a", "openai", "gpt-4o-mini");
        let upserted = AgentProfileEvent::Upserted(p.clone());
        let json = serde_json::to_string(&upserted).unwrap();
        let back: AgentProfileEvent = serde_json::from_str(&json).unwrap();
        match back {
            AgentProfileEvent::Upserted(got) => assert_eq!(got.id, p.id),
            _ => panic!("expected upserted"),
        }

        let deleted = AgentProfileEvent::Deleted { id: p.id.clone() };
        let json = serde_json::to_string(&deleted).unwrap();
        let back: AgentProfileEvent = serde_json::from_str(&json).unwrap();
        match back {
            AgentProfileEvent::Deleted { id } => assert_eq!(id, p.id),
            _ => panic!("expected deleted"),
        }
    }
}
