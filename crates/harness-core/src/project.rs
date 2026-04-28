//! `Project` — a reusable, named context container that can be attached to
//! a [`Conversation`](crate::Conversation) at creation time.
//!
//! Projects are independent of "AI Coding"; they're a generic container
//! intended for any recurring workflow (research, writing, support, …) where
//! the same instructions / persona should be re-applied across many
//! conversations.
//!
//! `harness-core` defines only the value type and the [`ProjectStore`]
//! trait (in [`store`](crate::store)); persistence backends live in
//! `harness-store`, the runtime injection (so a Project's instructions
//! reach the LLM as a system message) lives in `harness-server`'s
//! `project_binder` module.
//!
//! ## Lifecycle
//!
//! - `Project::new(name, instructions)` mints a fresh UUID id, an empty
//!   slug (the caller is expected to set one — see [`Self::with_slug`])
//!   and current RFC-3339 timestamps.
//! - Mutating helpers (`set_*`, `with_*`) bump `updated_at`.
//! - `archived = true` is the soft-delete sentinel: a [`ProjectStore`]
//!   `list` call hides archived rows by default (callers can opt in via
//!   `include_archived = true`). Hard delete is a separate operation.

use serde::{Deserialize, Serialize};

/// A reusable, named bundle of instructions / context that can be bound
/// to one or more [`Conversation`](crate::Conversation)s.
///
/// Stored opaquely by [`ProjectStore`](crate::store::ProjectStore)
/// implementations; the wire shape is the JSON serialisation of this
/// struct, so all fields must round-trip through `serde`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    /// Stable internal identifier (UUID v4). Conversations reference
    /// this, never the slug.
    pub id: String,
    /// Human-readable, URL/CLI-friendly handle. Globally unique within
    /// a store. Renameable (with care: existing references break).
    pub slug: String,
    /// Display name. Free-form, not unique.
    pub name: String,
    /// Optional one-liner shown in pickers / sidebars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The body that gets injected into the system prompt for any
    /// conversation bound to this project. Markdown-friendly.
    pub instructions: String,
    /// Free-form tags; useful for UI grouping. Order is preserved.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Soft-delete flag. Archived projects are hidden from default
    /// listings but their bound conversations keep working.
    #[serde(default)]
    pub archived: bool,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp of the last mutation. Bumped by
    /// the `set_*` / `with_*` helpers so callers don't have to.
    pub updated_at: String,
}

impl Project {
    /// Create a new project with a fresh UUID v4 id and current
    /// timestamps. `slug` is left **empty** — the caller is expected
    /// to set one (see [`derive_slug`] for a default derivation from
    /// the name).
    pub fn new(name: impl Into<String>, instructions: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            slug: String::new(),
            name: name.into(),
            description: None,
            instructions: instructions.into(),
            tags: Vec::new(),
            archived: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Builder-style setter for `slug`. Bumps `updated_at`.
    pub fn with_slug(mut self, slug: impl Into<String>) -> Self {
        self.set_slug(slug);
        self
    }

    /// Builder-style setter for `description`. Bumps `updated_at`.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.set_description(Some(description.into()));
        self
    }

    /// Builder-style setter for `tags`. Bumps `updated_at`.
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.set_tags(tags);
        self
    }

    /// Replace `slug`; bumps `updated_at`.
    pub fn set_slug(&mut self, slug: impl Into<String>) {
        self.slug = slug.into();
        self.touch();
    }

    /// Replace `name`; bumps `updated_at`.
    pub fn set_name(&mut self, name: impl Into<String>) {
        self.name = name.into();
        self.touch();
    }

    /// Replace `description`; bumps `updated_at`.
    pub fn set_description(&mut self, description: Option<String>) {
        self.description = description;
        self.touch();
    }

    /// Replace `instructions`; bumps `updated_at`.
    pub fn set_instructions(&mut self, instructions: impl Into<String>) {
        self.instructions = instructions.into();
        self.touch();
    }

    /// Replace `tags`; bumps `updated_at`.
    pub fn set_tags(&mut self, tags: Vec<String>) {
        self.tags = tags;
        self.touch();
    }

    /// Mark the project as soft-deleted. Idempotent.
    pub fn archive(&mut self) {
        if !self.archived {
            self.archived = true;
            self.touch();
        }
    }

    /// Restore a soft-deleted project. Idempotent.
    pub fn unarchive(&mut self) {
        if self.archived {
            self.archived = false;
            self.touch();
        }
    }

    /// Refresh `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Convert a free-form name into a URL-safe ASCII slug.
///
/// Rules:
/// - lowercase
/// - keep `[a-z0-9]`, replace anything else with `-`
/// - collapse runs of `-`, trim leading/trailing
/// - cap at 64 chars
/// - if empty after that, return a short random fragment
///
/// **Uniqueness is the caller's job** — this just produces a candidate.
/// On collision the typical pattern is to append `-2`, `-3`, etc.
pub fn derive_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = true; // suppress leading '-'
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 64 {
        out.truncate(64);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        // Last resort — pick a few hex chars from a fresh UUID.
        out = uuid::Uuid::new_v4().to_string()[..8].to_string();
    }
    out
}

/// Validate that a slug is well-formed for storage.
///
/// Returns `Ok(())` for `[a-z0-9-]{1,64}` that doesn't start or end
/// with `-`. Anything else returns `Err` with a human-readable reason
/// suitable for surfacing to API clients.
pub fn validate_slug(slug: &str) -> Result<(), &'static str> {
    if slug.is_empty() {
        return Err("slug must not be empty");
    }
    if slug.len() > 64 {
        return Err("slug must be at most 64 characters");
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err("slug must not start or end with '-'");
    }
    if !slug
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("slug must contain only lowercase ascii, digits, and '-'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let p = Project::new("Customer Support", "be terse");
        assert_eq!(p.id.len(), 36); // UUID
        assert_eq!(p.name, "Customer Support");
        assert_eq!(p.instructions, "be terse");
        assert!(p.slug.is_empty());
        assert!(!p.archived);
        assert_eq!(p.created_at, p.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut p = Project::new("x", "y");
        let before = p.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.set_name("z");
        assert!(p.updated_at > before, "{} > {}", p.updated_at, before);
    }

    #[test]
    fn archive_is_idempotent() {
        let mut p = Project::new("x", "y");
        p.archive();
        let stamp = p.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.archive();
        assert_eq!(
            p.updated_at, stamp,
            "second archive must not bump updated_at"
        );
        assert!(p.archived);
    }

    #[test]
    fn derive_slug_basic() {
        assert_eq!(derive_slug("Customer Support"), "customer-support");
        assert_eq!(derive_slug("  Hello, World!  "), "hello-world");
        assert_eq!(derive_slug("MULTI___under_scores"), "multi-under-scores");
        assert_eq!(derive_slug("v1.2.3"), "v1-2-3");
    }

    #[test]
    fn derive_slug_caps_length() {
        let slug = derive_slug(&"a".repeat(200));
        assert!(slug.len() <= 64);
    }

    #[test]
    fn derive_slug_falls_back_when_empty() {
        let slug = derive_slug("中文 ::: !!!");
        // Should be a non-empty hex fragment.
        assert!(!slug.is_empty());
        assert!(slug.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    }

    #[test]
    fn validate_slug_rejects_bad_inputs() {
        assert!(validate_slug("ok-slug").is_ok());
        assert!(validate_slug("a").is_ok());
        assert!(validate_slug("").is_err());
        assert!(validate_slug("-leading").is_err());
        assert!(validate_slug("trailing-").is_err());
        assert!(validate_slug("UPPER").is_err());
        assert!(validate_slug("with space").is_err());
        assert!(validate_slug(&"a".repeat(65)).is_err());
    }

    #[test]
    fn round_trip_serialises_to_json() {
        let p = Project::new("name", "body")
            .with_slug("name")
            .with_description("d")
            .with_tags(vec!["t1".into(), "t2".into()]);
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn description_field_is_skipped_when_none() {
        let p = Project::new("n", "i");
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("description"));
    }
}
