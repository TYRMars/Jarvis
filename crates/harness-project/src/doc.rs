//! Document workspace value types — `DocProject` + `DocDraft`.
//!
//! Doc v0 cut: each `DocProject` lives under a workspace (the same
//! pinned root the rest of the harness is scoped to) and carries a
//! single Markdown body owned by a `DocDraft`. Multiple drafts per
//! project are allowed (revisions, alternative phrasings) but the v0
//! UI surfaces only the most-recent one.
//!
//! Sibling to:
//!
//! - [`Project`](crate::Project) — the *executable* project workspace
//!   that owns Requirements + Conversations. `DocProject` is its
//!   document-side cousin: same workspace, different ownership.
//! - [`TodoItem`](crate::TodoItem) — workspace-scoped backlog. Doc
//!   projects can attach action items here later.
//!
//! Wire model parity with the frontend at
//! `apps/jarvis-web/src/types/frames.ts` (added in the same PR).

use serde::{Deserialize, Serialize};

/// One document workspace — a folder for a single piece of writing
/// (note, research bundle, technical design, report, user guide).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocProject {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// Canonicalised absolute path of the parent workspace this doc
    /// belongs to. Use [`crate::workspace::canonicalize_workspace`]
    /// at every entry point so REST + tool callers agree on the key.
    pub workspace: String,
    /// Display title. Free-form Markdown-ish; UIs render as plain
    /// text by default.
    pub title: String,
    /// Genre. Influences the default outline / template a future
    /// generator might apply, but v0 stores it opaquely.
    pub kind: DocKind,
    /// RFC-3339 / ISO-8601 timestamp.
    pub created_at: String,
    /// RFC-3339; bumped on every mutation via [`Self::touch`].
    pub updated_at: String,
    /// Free-form labels for cross-kind organisation. Wire form is a
    /// JSON array of strings. Tag values are kept as-is (no
    /// case-folding / dedup at the store layer); UIs are responsible
    /// for the input UX.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Soft "favourite" flag. Pinned docs surface to the top of the
    /// rail-level "Pinned" scope and otherwise behave normally.
    #[serde(default)]
    pub pinned: bool,
    /// Soft delete / archive flag. Archived docs are hidden from the
    /// default list and only show up under the "Archive" scope; they
    /// are not removed from the store.
    #[serde(default)]
    pub archived: bool,
}

/// Document type. Wire form lowercase snake_case
/// (`note / research / report / design / guide`). Renderers should
/// treat unknown values as [`DocKind::Note`] for forward-compat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocKind {
    /// Free-form note. The default; nothing structural assumed.
    Note,
    /// Research bundle: sources, excerpts, synthesis.
    Research,
    /// Long-form report (postmortem, weekly, retro).
    Report,
    /// Technical design / RFC.
    Design,
    /// User-facing guide / how-to.
    Guide,
}

impl DocKind {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "note" => Self::Note,
            "research" => Self::Research,
            "report" => Self::Report,
            "design" => Self::Design,
            "guide" => Self::Guide,
            _ => return None,
        })
    }
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Research => "research",
            Self::Report => "report",
            Self::Design => "design",
            Self::Guide => "guide",
        }
    }
}

impl DocProject {
    /// Mint a new project with a fresh UUID, current timestamps,
    /// and kind [`DocKind::Note`] by default.
    pub fn new(workspace: impl Into<String>, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace: workspace.into(),
            title: title.into(),
            kind: DocKind::Note,
            created_at: now.clone(),
            updated_at: now,
            tags: Vec::new(),
            pinned: false,
            archived: false,
        }
    }

    /// Bump `updated_at` to "now". Call from every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// One Markdown draft. Multiple per project are allowed (versioning
/// / alternates); v0 UIs read the most-recent one by `updated_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocDraft {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// Foreign key into [`DocProject::id`].
    pub project_id: String,
    /// Always `"markdown"` in v0. Reserved for future
    /// `markdown-strict` / `mdx` / `org` / etc.
    pub format: String,
    /// The full body. v0 rewrites the row on every save (no diff
    /// storage); a draft over a few hundred KiB starts to feel
    /// expensive — pick a real DB at that point.
    pub content: String,
    /// RFC-3339 timestamp of creation.
    pub created_at: String,
    /// RFC-3339; bumped on every save.
    pub updated_at: String,
}

impl DocDraft {
    /// Mint a new Markdown draft.
    pub fn new(project_id: impl Into<String>, content: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            format: "markdown".to_string(),
            content: content.into(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Broadcast envelope sent on every successful [`DocStore`]
/// mutation. WS sessions filter by `workspace` (for project events)
/// or by `project_id` (for draft events) before forwarding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocEvent {
    /// A doc project was created or updated.
    ProjectUpserted(DocProject),
    /// A doc project was deleted (and its drafts).
    ProjectDeleted { workspace: String, id: String },
    /// A doc draft was inserted or replaced. Carries the parent
    /// project id so listeners can route by project.
    DraftUpserted(DocDraft),
}

impl DocEvent {
    /// Workspace key the event targets. For draft events we don't
    /// have the workspace inline (drafts only carry `project_id`),
    /// so callers that need workspace-level filtering should look
    /// the project up by id; this helper returns `None` in that
    /// case so they don't accidentally treat the empty string as a
    /// match.
    pub fn workspace(&self) -> Option<&str> {
        match self {
            Self::ProjectUpserted(p) => Some(&p.workspace),
            Self::ProjectDeleted { workspace, .. } => Some(workspace),
            Self::DraftUpserted(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_kind_round_trips() {
        for k in [
            DocKind::Note,
            DocKind::Research,
            DocKind::Report,
            DocKind::Design,
            DocKind::Guide,
        ] {
            assert_eq!(DocKind::from_wire(k.as_wire()), Some(k));
        }
        assert!(DocKind::from_wire("nonsense").is_none());
    }

    #[test]
    fn doc_kind_serialises_snake_case() {
        let json = serde_json::to_string(&DocKind::Research).unwrap();
        assert_eq!(json, "\"research\"");
    }

    #[test]
    fn project_new_mints_uuid_and_now() {
        let p = DocProject::new("/repo", "weekly review");
        assert_eq!(p.id.len(), 36);
        assert_eq!(p.workspace, "/repo");
        assert_eq!(p.title, "weekly review");
        assert_eq!(p.kind, DocKind::Note);
        assert_eq!(p.created_at, p.updated_at);
    }

    #[test]
    fn project_touch_bumps_updated_at() {
        let mut p = DocProject::new("/r", "x");
        let before = p.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.touch();
        assert!(p.updated_at > before);
    }

    #[test]
    fn draft_new_defaults_to_markdown_format() {
        let d = DocDraft::new("p-1", "# hi\n");
        assert_eq!(d.format, "markdown");
        assert_eq!(d.project_id, "p-1");
        assert!(d.content.starts_with("# hi"));
    }

    #[test]
    fn project_round_trips_through_json() {
        let mut p = DocProject::new("/repo", "design doc");
        p.kind = DocKind::Design;
        p.tags = vec!["q3".into(), "ship-ready".into()];
        p.pinned = true;
        let json = serde_json::to_string(&p).unwrap();
        let back: DocProject = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn legacy_json_without_new_fields_still_deserialises() {
        // Older JSON files (pre-three-pane) won't have tags / pinned /
        // archived. They must continue to load via serde defaults so a
        // version upgrade doesn't trash existing doc projects.
        let legacy = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "workspace": "/repo",
            "title": "old doc",
            "kind": "note",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        });
        let p: DocProject = serde_json::from_value(legacy).unwrap();
        assert_eq!(p.tags, Vec::<String>::new());
        assert!(!p.pinned);
        assert!(!p.archived);
    }

    #[test]
    fn event_workspace_helper() {
        let p = DocProject::new("/r", "x");
        let up = DocEvent::ProjectUpserted(p.clone());
        assert_eq!(up.workspace(), Some("/r"));
        let del = DocEvent::ProjectDeleted {
            workspace: "/other".into(),
            id: p.id.clone(),
        };
        assert_eq!(del.workspace(), Some("/other"));
        let d = DocDraft::new(p.id.clone(), "");
        let dup = DocEvent::DraftUpserted(d);
        assert_eq!(dup.workspace(), None);
    }

    #[test]
    fn legacy_field_names_match_frontend_wire_shape() {
        // The frontend type at apps/jarvis-web/src/types/frames.ts
        // (added in the same PR) expects these exact snake_case
        // keys. Drift here breaks the migration silently.
        let p = DocProject::new("/r", "title");
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        for key in [
            "id",
            "workspace",
            "title",
            "kind",
            "created_at",
            "updated_at",
            "tags",
            "pinned",
            "archived",
        ] {
            assert!(json.get(key).is_some(), "missing wire key: {key}");
        }
        let d = DocDraft::new("p", "body");
        let json: serde_json::Value = serde_json::to_value(&d).unwrap();
        for key in [
            "id",
            "project_id",
            "format",
            "content",
            "created_at",
            "updated_at",
        ] {
            assert!(json.get(key).is_some(), "missing wire key: {key}");
        }
    }
}
