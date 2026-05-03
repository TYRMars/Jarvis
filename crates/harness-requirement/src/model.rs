//! Typed value types for Requirement execution context.
//!
//! Run records (`RequirementRun`, `RequirementRunStatus`) and
//! verification value types (`VerificationPlan` / `VerificationResult`
//! / `VerificationStatus` / `CommandResult`) live in
//! [`harness_core::requirement_run`] so the
//! [`harness_core::RequirementRunStore`] trait can name them without
//! pulling `harness-requirement` into `harness-core`. They are
//! re-exported from `crate::lib` for callers that historically
//! imported `harness_requirement::RequirementRun` etc.
//!
//! What stays in this module: [`RequirementContextManifest`] and its
//! helpers — pure orchestration concerns (which workspace files seed
//! the run, what constraints apply) that have no business in
//! `harness-core`.

use serde::{Deserialize, Serialize};

pub use harness_core::requirement_run::VerificationPlan;

// ---------- RequirementContextManifest ------------------------------------

/// The typed bundle a fresh-session run starts from. Built by
/// [`crate::manifest::build_default_manifest`] before kicking off the
/// agent loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementContextManifest {
    /// The Requirement this manifest targets.
    pub requirement_id: String,
    /// Workspace root the run executes against. Absolute path.
    pub workspace: String,
    /// One-line goal taken from `Requirement.title`.
    pub goal: String,
    /// Optional longer description from `Requirement.description`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Workspace instruction files included verbatim. Path is
    /// relative to `workspace`; `body` is the file content
    /// (may be truncated for length).
    #[serde(default)]
    pub instructions: Vec<ContextRef>,
    /// Source files explicitly attached to this manifest. Empty
    /// in the v0 manifest builder (model can pull more via
    /// `code.grep` / `fs.read`); pre-staged context goes here when
    /// callers want to seed the run.
    #[serde(default)]
    pub files: Vec<ContextRef>,
    /// Optional verification plan. When `None`, runs finish on
    /// model-claim alone; when `Some`, the configured commands
    /// must succeed before the run transitions to `Completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationPlan>,
    /// Free-form constraints displayed to the model
    /// (e.g. "no commits", "small reviewable patches"). Each entry
    /// is one line.
    #[serde(default)]
    pub constraints: Vec<String>,
}

/// A single piece of context: where it came from and what it
/// contains. Both filesystem files and synthetic blobs use this
/// shape — the source kind disambiguates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextRef {
    /// Path or symbolic name. For `kind = "file"`, this is the
    /// path relative to the manifest's `workspace`.
    pub path: String,
    /// Provenance.
    pub kind: ContextKind,
    /// File content / text body. May be truncated; the truncation
    /// marker lives inside `body` so renderers don't need to know.
    pub body: String,
    /// `true` if [`Self::body`] was truncated to fit a byte cap.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

/// Provenance of a [`ContextRef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    /// File on the workspace filesystem (e.g. AGENTS.md).
    File,
    /// Synthetic blob produced by the manifest builder
    /// (e.g. "git status output", "list of recent failures").
    Synthetic,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_optional_fields_skip_when_none() {
        let m = RequirementContextManifest {
            requirement_id: "r".into(),
            workspace: "/repo".into(),
            goal: "x".into(),
            description: None,
            instructions: vec![],
            files: vec![],
            verification: None,
            constraints: vec![],
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("description"), "got: {json}");
        assert!(!json.contains("verification"), "got: {json}");
    }
}
