//! Builders that turn a [`Requirement`](harness_core::Requirement) +
//! a workspace root into a [`RequirementContextManifest`].
//!
//! The default builder reads a small allowlist of instruction files
//! (`AGENTS.md` / `CLAUDE.md` / `AGENT.md` / `README.md`) and packs
//! their bodies into the manifest's `instructions` list. It also
//! produces a Markdown summary suitable for prepending to the
//! initial system prompt of a fresh-session conversation.
//!
//! Intentionally tiny: the model can pull more context via
//! `code.grep` / `fs.read` / `workspace.context` once the run starts.
//! v0 doesn't try to be clever about relevance — explicit > magic.

use std::path::Path;

use harness_core::Requirement;

use crate::model::{
    ContextKind, ContextRef, RequirementContextManifest, VerificationPlan,
};

/// Maximum bytes read per instruction file. Files larger than the
/// cap are read up to the limit and marked `truncated`. 16 KiB is
/// the same ballpark as `apps/jarvis`'s project-context-loader cap
/// for AGENTS.md / CLAUDE.md.
pub const MAX_INSTRUCTION_BYTES: usize = 16 * 1024;

/// Allowlist of well-known instruction filenames the default
/// manifest builder picks up. Order matters — the first file that
/// exists "wins" the priority slot (used for the summary's
/// "primary instruction" heading).
pub const INSTRUCTION_FILES: &[&str] = &["AGENTS.md", "CLAUDE.md", "AGENT.md", "README.md"];

/// Build a default manifest for `requirement` rooted at `workspace`.
///
/// Reads the instruction-file allowlist from `workspace`, packs
/// each one (truncated to [`MAX_INSTRUCTION_BYTES`]) into a
/// [`ContextRef`], and stamps the requirement's title / description
/// onto the manifest. No verification plan is attached by default —
/// callers add one via [`with_verification`] when policy demands it.
///
/// Returns even when no instruction files exist (the model can
/// still operate from `goal` + `description` alone).
pub async fn build_default_manifest(
    workspace: &Path,
    requirement: &Requirement,
) -> RequirementContextManifest {
    let mut instructions = Vec::with_capacity(INSTRUCTION_FILES.len());
    for name in INSTRUCTION_FILES {
        let p = workspace.join(name);
        if let Ok(meta) = tokio::fs::metadata(&p).await {
            if !meta.is_file() {
                continue;
            }
            if let Ok(bytes) = tokio::fs::read(&p).await {
                let (body, truncated) = truncate_to_utf8_lossy(&bytes, MAX_INSTRUCTION_BYTES);
                instructions.push(ContextRef {
                    path: (*name).to_string(),
                    kind: ContextKind::File,
                    body,
                    truncated,
                });
            }
        }
    }

    RequirementContextManifest {
        requirement_id: requirement.id.clone(),
        workspace: workspace.display().to_string(),
        goal: requirement.title.clone(),
        description: requirement.description.clone(),
        instructions,
        files: Vec::new(),
        verification: None,
        constraints: Vec::new(),
    }
}

/// Attach a verification plan to a manifest, returning the modified
/// manifest. Convenience builder for the common "I have a manifest
/// and I want a `cargo test` gate" call site.
pub fn with_verification(
    mut manifest: RequirementContextManifest,
    plan: VerificationPlan,
) -> RequirementContextManifest {
    manifest.verification = Some(plan);
    manifest
}

/// Render the manifest as a Markdown block suitable for prepending
/// to the initial system prompt of a fresh-session conversation.
///
/// The output is human-readable and stable: no random ids, no
/// timestamps, no trailing whitespace. Two manifests with identical
/// inputs render identically (so prompt caching can match).
pub fn render_manifest_summary(manifest: &RequirementContextManifest) -> String {
    let mut out = String::with_capacity(1024);
    out.push_str("=== requirement ===\n");
    out.push_str(&format!("goal: {}\n", manifest.goal));
    if let Some(d) = manifest.description.as_deref().filter(|s| !s.is_empty()) {
        out.push_str("description:\n");
        for line in d.lines() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(&format!("workspace: {}\n", manifest.workspace));

    if !manifest.instructions.is_empty() {
        out.push_str("\n=== project instructions ===\n");
        for ctx in &manifest.instructions {
            out.push_str(&format!("--- {} ---\n", ctx.path));
            out.push_str(&ctx.body);
            if !ctx.body.ends_with('\n') {
                out.push('\n');
            }
            if ctx.truncated {
                out.push_str(&format!(
                    "[... truncated at {} bytes ...]\n",
                    MAX_INSTRUCTION_BYTES
                ));
            }
        }
    }

    if !manifest.constraints.is_empty() {
        out.push_str("\n=== constraints ===\n");
        for c in &manifest.constraints {
            out.push_str("- ");
            out.push_str(c);
            out.push('\n');
        }
    }

    if let Some(plan) = manifest.verification.as_ref() {
        if !plan.commands.is_empty() {
            out.push_str("\n=== verification commands ===\n");
            for c in &plan.commands {
                out.push_str("- ");
                out.push_str(c);
                out.push('\n');
            }
        }
    }

    out
}

/// Read up to `cap` bytes from `bytes` and decode as UTF-8 (lossily
/// if needed). Returns `(body, truncated)` — `truncated` is `true`
/// when the input was larger than `cap`. Splits cleanly at a UTF-8
/// boundary so we don't ship half a multi-byte character.
fn truncate_to_utf8_lossy(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    // Walk back from `cap` until the next byte starts a fresh UTF-8
    // codepoint (high two bits != `10`).
    let mut split = cap;
    while split > 0 && (bytes[split] & 0b1100_0000) == 0b1000_0000 {
        split -= 1;
    }
    (String::from_utf8_lossy(&bytes[..split]).into_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{Requirement, RequirementStatus};
    use tempfile::tempdir;

    fn req() -> Requirement {
        let mut r = Requirement::new("proj-1", "ship the kanban");
        r.description = Some("Backlog → Done flow".into());
        r.status = RequirementStatus::Backlog;
        r
    }

    #[tokio::test]
    async fn empty_workspace_yields_empty_instructions() {
        let dir = tempdir().unwrap();
        let m = build_default_manifest(dir.path(), &req()).await;
        assert!(m.instructions.is_empty());
        assert_eq!(m.goal, "ship the kanban");
        assert_eq!(m.description.as_deref(), Some("Backlog → Done flow"));
        assert!(m.verification.is_none());
    }

    #[tokio::test]
    async fn picks_up_agents_md_and_claude_md() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "always inspect first\n").unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "be careful with edits\n").unwrap();
        let m = build_default_manifest(dir.path(), &req()).await;
        let names: Vec<_> = m.instructions.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(names, vec!["AGENTS.md", "CLAUDE.md"]);
        assert!(m.instructions[0].body.contains("always inspect"));
        assert!(!m.instructions[0].truncated);
    }

    #[tokio::test]
    async fn truncates_large_instruction_files() {
        let dir = tempdir().unwrap();
        // 32 KiB of ASCII — well over the 16 KiB cap.
        let big = "x".repeat(32 * 1024);
        std::fs::write(dir.path().join("AGENTS.md"), &big).unwrap();
        let m = build_default_manifest(dir.path(), &req()).await;
        assert_eq!(m.instructions.len(), 1);
        assert!(m.instructions[0].truncated);
        assert_eq!(m.instructions[0].body.len(), MAX_INSTRUCTION_BYTES);
    }

    #[tokio::test]
    async fn skips_directories_with_instruction_names() {
        // If someone has a directory named `README.md` (yes, allowed
        // on POSIX) we mustn't try to read it as a file.
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("README.md")).unwrap();
        let m = build_default_manifest(dir.path(), &req()).await;
        assert!(m.instructions.is_empty());
    }

    #[test]
    fn render_summary_includes_goal_and_workspace() {
        let manifest = RequirementContextManifest {
            requirement_id: "r".into(),
            workspace: "/repo".into(),
            goal: "fix parser bug".into(),
            description: Some("the message_test failed".into()),
            instructions: vec![ContextRef {
                path: "AGENTS.md".into(),
                kind: ContextKind::File,
                body: "rule one\nrule two\n".into(),
                truncated: false,
            }],
            files: vec![],
            verification: Some(VerificationPlan {
                commands: vec!["cargo test -p harness-core".into()],
                require_diff: false,
                require_tests: true,
                require_human_review: false,
            }),
            constraints: vec!["small reviewable patches".into()],
        };
        let out = render_manifest_summary(&manifest);
        assert!(out.contains("goal: fix parser bug"));
        assert!(out.contains("workspace: /repo"));
        assert!(out.contains("--- AGENTS.md ---"));
        assert!(out.contains("rule one"));
        assert!(out.contains("- small reviewable patches"));
        assert!(out.contains("- cargo test -p harness-core"));
    }

    #[test]
    fn render_summary_omits_empty_sections() {
        let manifest = RequirementContextManifest {
            requirement_id: "r".into(),
            workspace: "/repo".into(),
            goal: "x".into(),
            description: None,
            instructions: vec![],
            files: vec![],
            verification: None,
            constraints: vec![],
        };
        let out = render_manifest_summary(&manifest);
        assert!(!out.contains("=== project instructions ==="));
        assert!(!out.contains("=== constraints ==="));
        assert!(!out.contains("=== verification commands ==="));
        assert!(!out.contains("description:"));
    }

    #[test]
    fn render_summary_truncation_marker() {
        let manifest = RequirementContextManifest {
            requirement_id: "r".into(),
            workspace: "/repo".into(),
            goal: "x".into(),
            description: None,
            instructions: vec![ContextRef {
                path: "AGENTS.md".into(),
                kind: ContextKind::File,
                body: "first half".into(),
                truncated: true,
            }],
            files: vec![],
            verification: None,
            constraints: vec![],
        };
        let out = render_manifest_summary(&manifest);
        assert!(out.contains("[... truncated at"));
    }

    #[test]
    fn truncate_handles_multi_byte_boundary() {
        // Three-byte UTF-8 chars; cap mid-char must back off.
        let s = "中文测试";
        let bytes = s.as_bytes();
        // Cap that lands in the middle of `测` (one byte short).
        let cap = bytes.len() - 2;
        let (out, truncated) = truncate_to_utf8_lossy(bytes, cap);
        assert!(truncated);
        // No replacement-char garbage.
        assert!(!out.contains('\u{FFFD}'), "got: {out}");
    }

    #[test]
    fn with_verification_builder_attaches_plan() {
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
        let plan = VerificationPlan {
            commands: vec!["cargo test".into()],
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        };
        let m2 = with_verification(m, plan.clone());
        assert_eq!(m2.verification.unwrap().commands, plan.commands);
    }
}
