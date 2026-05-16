//! Project-scoped tags for kanban [`Requirement`](crate::Requirement)
//! rows.
//!
//! Where `Project.tags: Vec<String>` is loose project metadata, a
//! [`Label`] is a structured, project-scoped, **shared** entity that
//! one or more requirements reference by id. Labels carry a name + a
//! colour so the kanban can render coloured chips, and a description
//! so the team can encode "what counts as a `bug` here" without
//! turning every label into a doc page.
//!
//! Storage shape mirrors the other top-level entities: a separate
//! [`LabelStore`](crate::LabelStore) trait with one impl per backend.
//! The Requirement-side reference is just `Vec<String>` (label ids)
//! held on [`Requirement::label_ids`](crate::Requirement::label_ids);
//! the Label rows themselves live in their own store. This keeps
//! label edits (rename, recolour) cheap (one row) without rewriting
//! every requirement that uses the label.
//!
//! Phase 3.8 (Multica-inspired). Companion proposal:
//! `docs/proposals/work-orchestration.zh-CN.md` §"Phase 3.8 — Labels".

use serde::{Deserialize, Serialize};

/// Maximum length for a label name. Two reasons for the cap:
///
/// 1. The kanban renders these as inline chips; >32 chars wraps badly.
/// 2. The agent system prompt embeds the active labels for a
///    requirement; runaway names eat into the token budget.
pub const MAX_LABEL_NAME_LEN: usize = 32;

/// One project-scoped tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub struct Label {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// Project this label belongs to. Labels do not cross project
    /// boundaries — two projects with a "bug" label have two
    /// independent rows.
    pub project_id: String,
    /// Display name. Trimmed and required non-empty by
    /// [`validate_label_name`]. Case-preserving, but uniqueness
    /// inside a project is enforced case-insensitively (mirrors
    /// `Project.slug` and Multica's behaviour).
    pub name: String,
    /// Hex colour in `#rrggbb` form (lowercase). Validated by
    /// [`validate_label_colour`]. The UI overlays text on top, so
    /// extreme contrast values (`#ffffff`, `#000000`) are allowed
    /// — the renderer picks a contrasting text colour.
    pub colour: String,
    /// Optional one-line guidance: "use this when X". Markdown
    /// allowed; the kanban shows it on hover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// RFC-3339 / ISO-8601. Set on insert, never mutated.
    pub created_at: String,
    /// RFC-3339 / ISO-8601. Bumped on every mutation.
    pub updated_at: String,
}

impl Label {
    /// Build a fresh label. The caller is responsible for running
    /// [`validate_label_name`] / [`validate_label_colour`] before
    /// passing values; this constructor stays infallible so it can
    /// be used in tests / fixtures freely.
    pub fn new(
        project_id: impl Into<String>,
        name: impl Into<String>,
        colour: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            name: name.into(),
            colour: colour.into(),
            description: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to now. Stores call this before persisting
    /// a mutation so the field stays consistent across backends.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Trim, length-cap, and reject empty / whitespace-only label names.
/// Returns the canonicalised form (trimmed) on success.
pub fn validate_label_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("label name must not be empty".to_string());
    }
    if trimmed.chars().count() > MAX_LABEL_NAME_LEN {
        return Err(format!(
            "label name must be ≤ {MAX_LABEL_NAME_LEN} characters"
        ));
    }
    if trimmed.chars().any(|c| c == '\n' || c == '\r' || c == '\t') {
        return Err("label name must not contain newline / tab".to_string());
    }
    Ok(trimmed.to_string())
}

/// Accept `#rrggbb` (case-insensitive). Returns the lowercased form.
/// We deliberately don't accept named colours, rgba(), or hsl(): one
/// canonical form makes UI rendering trivial and the agent system
/// prompt embedding compact.
pub fn validate_label_colour(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.len() != 7 || !trimmed.starts_with('#') {
        return Err("colour must be in `#rrggbb` form".to_string());
    }
    if !trimmed[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("colour must be `#rrggbb` with hex digits".to_string());
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// Broadcast event for [`Label`] mutations. Mirrors `CommentEvent` /
/// `ActivityEvent`. Web sockets relay these so kanban filters /
/// chip rows update without a refetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LabelEvent {
    Created(Label),
    Updated(Label),
    Deleted {
        project_id: String,
        label_id: String,
    },
}

impl LabelEvent {
    /// Project id the event targets — convenience for per-project WS
    /// filtering.
    pub fn project_id(&self) -> &str {
        match self {
            Self::Created(l) | Self::Updated(l) => &l.project_id,
            Self::Deleted { project_id, .. } => project_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_label_name_strips_whitespace() {
        assert_eq!(validate_label_name("  bug  ").unwrap(), "bug");
    }

    #[test]
    fn validate_label_name_rejects_empty() {
        assert!(validate_label_name("").is_err());
        assert!(validate_label_name("   ").is_err());
    }

    #[test]
    fn validate_label_name_rejects_too_long() {
        let s = "a".repeat(MAX_LABEL_NAME_LEN + 1);
        assert!(validate_label_name(&s).is_err());
    }

    #[test]
    fn validate_label_name_rejects_control_chars() {
        assert!(validate_label_name("bug\nfix").is_err());
        assert!(validate_label_name("bug\tfix").is_err());
    }

    #[test]
    fn validate_label_colour_accepts_hex() {
        assert_eq!(validate_label_colour("#ABcdef").unwrap(), "#abcdef");
        assert_eq!(validate_label_colour(" #112233 ").unwrap(), "#112233");
    }

    #[test]
    fn validate_label_colour_rejects_other_forms() {
        assert!(validate_label_colour("red").is_err());
        assert!(validate_label_colour("#abc").is_err()); // 3-digit form not accepted
        assert!(validate_label_colour("rgb(0,0,0)").is_err());
        assert!(validate_label_colour("#zzzzzz").is_err());
    }

    #[test]
    fn round_trip_skips_none_description() {
        let l = Label::new("proj-1", "bug", "#ff0000");
        let s = serde_json::to_string(&l).unwrap();
        assert!(!s.contains("description"));
        let back: Label = serde_json::from_str(&s).unwrap();
        assert_eq!(back, l);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut l = Label::new("proj-1", "bug", "#ff0000");
        let original = l.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        l.touch();
        assert_ne!(l.updated_at, original);
        assert_eq!(l.created_at, original, "created_at is immutable");
    }
}
