//! Long-term, project-scoped memory of lessons / gotchas / context.
//!
//! Distinct from [`crate::memory`] (the conversation-context compactor
//! that decides which messages to ship to the LLM each turn) and from
//! [`crate::Activity`] (append-only audit). A [`ProjectMemory`] is a
//! curated, durable note attached to a [`crate::Project`] that should
//! be loaded into the system prompt of every future run in that
//! project — the agent's institutional memory.
//!
//! ## Lifecycle
//!
//! * Auto-captured by `harness_server::auto_mode` when an unattended
//!   run fails. The capture is deterministic (no second LLM call):
//!   the row is built from the run's `error` plus minimal metadata
//!   so it lands reliably even when the LLM is unavailable.
//! * Manually written by the agent via a (future) `project.memory.*`
//!   tool — the agent decides which run-time observations are worth
//!   keeping for next time.
//! * Manually edited / deleted by an operator via REST.
//!
//! ## Why "kind"
//!
//! Kind drives prompt rendering, not behaviour: the system-prompt
//! injection groups by kind so the agent can tell "what failed in
//! the past" (`Gotcha`) apart from "this is how the project is
//! structured" (`Context`) and "next time, do X" (`Lesson`). Adding
//! a new kind is a wire-compatible change because the field is
//! string-tagged.

use serde::{Deserialize, Serialize};

/// A single project-scoped memory row.
///
/// Stored opaquely by [`ProjectMemoryStore`](crate::ProjectMemoryStore);
/// the wire shape is the JSON serialisation of this struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectMemory {
    /// Stable internal identifier (UUID v4).
    pub id: String,
    /// Owning project. Memories are loaded by `project_id`.
    pub project_id: String,
    /// What this row represents. Drives system-prompt grouping.
    pub kind: ProjectMemoryKind,
    /// Short headline, ≤ 200 bytes (truncated by [`Self::new`]).
    /// This is what the prompt-injector lists; the body is the
    /// "expand for detail" payload.
    pub title: String,
    /// Markdown-friendly body. Truncated to [`Self::BODY_CAP`] bytes
    /// at construction so a wild error message can't blow out the
    /// system prompt budget on its own.
    pub body: String,
    /// Free-form tags. Mirror [`crate::Requirement::tags`]; the
    /// REST/UI layer can use them to filter.
    #[serde(default)]
    pub tags: Vec<String>,
    /// `RequirementRun.id` this memory was distilled from, if any.
    /// Set by the auto-capture path; `None` for manually-authored
    /// rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_id: Option<String>,
    /// `Requirement.id` the source run was driving. Same lifecycle
    /// as `source_run_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_requirement_id: Option<String>,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp of the last edit. Bumped by
    /// the `set_*` / `touch` helpers.
    pub updated_at: String,
}

/// Why this memory exists. Kind is purely a presentation hint;
/// the store doesn't filter on it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectMemoryKind {
    /// Forward-looking: "next time, do X" — derived from a successful
    /// recovery or an operator's annotation.
    Lesson,
    /// Reactive: "X failed because Y" — the default kind for the
    /// auto-captured failure path.
    Gotcha,
    /// Stable project facts: architecture notes, conventions,
    /// owners. Typically operator-authored.
    Context,
}

impl ProjectMemoryKind {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Lesson => "lesson",
            Self::Gotcha => "gotcha",
            Self::Context => "context",
        }
    }
}

impl ProjectMemory {
    /// Hard cap on `body` at construction. 4 KiB is enough for a
    /// distilled lesson + a stack snippet without dominating the
    /// prompt; longer rows are silently truncated with a `…` marker.
    pub const BODY_CAP: usize = 4 * 1024;
    /// Hard cap on `title`. The system-prompt injector lists titles
    /// only by default, so a runaway title would crowd out other
    /// memories.
    pub const TITLE_CAP: usize = 200;

    /// Build a fresh memory row with a UUID id and current
    /// timestamps. `body` is truncated to [`Self::BODY_CAP`] bytes
    /// (UTF-8 boundary aware), title to [`Self::TITLE_CAP`].
    pub fn new(
        project_id: impl Into<String>,
        kind: ProjectMemoryKind,
        title: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            kind,
            title: truncate_chars(title.into(), Self::TITLE_CAP),
            body: truncate_chars(body.into(), Self::BODY_CAP),
            tags: Vec::new(),
            source_run_id: None,
            source_requirement_id: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Builder-style setter for `source_run_id` + the run's
    /// requirement id. Both are typically set together by the
    /// auto-capture path.
    pub fn with_source(
        mut self,
        run_id: impl Into<String>,
        requirement_id: impl Into<String>,
    ) -> Self {
        self.source_run_id = Some(run_id.into());
        self.source_requirement_id = Some(requirement_id.into());
        self
    }

    /// Builder-style setter for `tags`.
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Bump `updated_at`. Call after any mutation.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Truncate `s` to at most `cap` chars (Unicode scalar values, not
/// bytes), appending `…` if truncated. Cheap and good enough for the
/// system-prompt sizing we do here — tokenization-aware budgeting is
/// what `harness_memory` does for runtime context.
fn truncate_chars(s: String, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s;
    }
    let mut out: String = s.chars().take(cap.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_body_at_construction() {
        let body = "x".repeat(ProjectMemory::BODY_CAP + 100);
        let m = ProjectMemory::new("p1", ProjectMemoryKind::Gotcha, "t", body);
        assert!(m.body.chars().count() <= ProjectMemory::BODY_CAP);
        assert!(m.body.ends_with('…'));
    }

    #[test]
    fn kind_round_trips_as_wire() {
        for k in [
            ProjectMemoryKind::Lesson,
            ProjectMemoryKind::Gotcha,
            ProjectMemoryKind::Context,
        ] {
            let json = serde_json::to_string(&k).unwrap();
            assert!(json.contains(k.as_wire()), "wire form mismatch: {json}");
            let back: ProjectMemoryKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, k);
        }
    }

    #[test]
    fn with_source_sets_both_ids() {
        let m = ProjectMemory::new("p1", ProjectMemoryKind::Gotcha, "t", "b")
            .with_source("run-1", "req-1");
        assert_eq!(m.source_run_id.as_deref(), Some("run-1"));
        assert_eq!(m.source_requirement_id.as_deref(), Some("req-1"));
    }
}
