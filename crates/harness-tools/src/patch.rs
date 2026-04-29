//! `fs.patch` — apply a unified diff inside the workspace sandbox.
//!
//! The model's primary mutation primitive when changing more than
//! one place at a time. Strictly more powerful than `fs.edit`
//! (multi-hunk, cross-file) but with the same safety posture:
//!
//! - **Sandboxed** — every target path resolves through
//!   [`crate::sandbox::resolve_under`]; `..` and absolute paths
//!   are rejected before any file is touched.
//! - **Atomic per-call** — all hunks for all files are applied to
//!   in-memory copies first; if any single hunk fails to apply
//!   cleanly (no fuzz, no whitespace-tolerant matching), nothing is
//!   written to disk.
//! - **Text only** — refuses git binary patches and the
//!   `Binary files differ` sentinel.
//! - **No renames / mode-only changes** — the v0 surface is just
//!   "edit text"; renames need a `mv` semantics that's worth
//!   designing on its own.
//! - **Approval-gated** — `requires_approval()` is `true`. The
//!   approval card sees the full diff, so the operator can review
//!   before any byte changes on disk.
//! - **Doesn't auto-stage** — even in a git repo, the working tree
//!   is updated but the index isn't touched. Staging is the
//!   operator's call.
//!
//! Returns a structured per-file summary so the model can confirm
//! what landed:
//!
//! ```text
//! applied 2 file(s):
//!   M src/foo.rs   (+3 -1)
//!   A src/bar.rs   (+12 -0)
//! ```

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use diffy::Patch;
use harness_core::{BoxError, Tool};
use serde_json::{json, Value};
use tokio::fs;

use crate::sandbox::resolve_under;

pub struct FsPatchTool {
    root: PathBuf,
}

impl FsPatchTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for FsPatchTool {
    fn name(&self) -> &str {
        "fs.patch"
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Apply a unified diff to one or more files inside the workspace \
         sandbox. Accepts standard `--- a/<path>` / `+++ b/<path>` \
         headers (with or without `diff --git` prefix). All hunks must \
         apply cleanly — no fuzz, no whitespace tolerance — or the \
         whole patch is rejected. Supports multi-file diffs, file \
         creation (`--- /dev/null`), and file deletion \
         (`+++ /dev/null`). Refuses binary patches, renames, and \
         paths outside the sandbox root. Does not stage changes."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "diff": {
                    "type": "string",
                    "description": "Unified diff. Multi-file diffs are split \
                                    on `diff --git` markers (or on `--- ` headers \
                                    when those are absent)."
                }
            },
            "required": ["diff"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let diff = args
            .get("diff")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `diff` argument".into() })?;

        if diff.contains("GIT binary patch") || diff.contains("Binary files") {
            return Err("binary patches are not supported".into());
        }
        if diff.contains("\nrename from ") || diff.contains("\nrename to ") {
            return Err("rename patches are not supported (v0)".into());
        }

        let blocks = split_multi_file(diff);
        if blocks.is_empty() {
            return Err("no patch blocks found in `diff`".into());
        }

        // Phase 1: parse + apply against in-memory copies. Nothing
        // touches disk until every block succeeds.
        let mut planned: Vec<PlannedWrite> = Vec::with_capacity(blocks.len());
        for block in &blocks {
            let patch = Patch::from_str(block)
                .map_err(|e| -> BoxError { format!("parse patch: {e}").into() })?;

            let original_path = patch.original();
            let modified_path = patch.modified();

            let action = classify(original_path, modified_path)?;
            match action {
                PatchAction::Create { path } => {
                    let abs = resolve_target(&root, path)?;
                    if abs.exists() {
                        return Err(format!("create patch targets existing file `{path}`").into());
                    }
                    let new_text = diffy::apply("", &patch).map_err(|e| -> BoxError {
                        format!("apply create patch on `{path}`: {e}").into()
                    })?;
                    let (added, removed) = count_lines(block);
                    planned.push(PlannedWrite {
                        rel: path.to_string(),
                        abs,
                        kind: ChangeKind::Created,
                        new_text: Some(new_text),
                        added,
                        removed,
                    });
                }
                PatchAction::Delete { path } => {
                    let abs = resolve_target(&root, path)?;
                    if !abs.is_file() {
                        return Err(format!("delete patch targets missing file `{path}`").into());
                    }
                    let original = fs::read_to_string(&abs).await.map_err(|e| -> BoxError {
                        format!("read `{path}` to delete: {e}").into()
                    })?;
                    // Sanity-check: the patch's "after" should be empty.
                    let result = diffy::apply(&original, &patch).map_err(|e| -> BoxError {
                        format!("apply delete patch on `{path}`: {e}").into()
                    })?;
                    if !result.is_empty() {
                        return Err(
                            format!("delete patch on `{path}` left non-empty content").into()
                        );
                    }
                    let (added, removed) = count_lines(block);
                    planned.push(PlannedWrite {
                        rel: path.to_string(),
                        abs,
                        kind: ChangeKind::Deleted,
                        new_text: None,
                        added,
                        removed,
                    });
                }
                PatchAction::Modify { path } => {
                    let abs = resolve_target(&root, path)?;
                    if !abs.is_file() {
                        return Err(format!("modify patch targets missing file `{path}`").into());
                    }
                    let original = fs::read_to_string(&abs).await.map_err(|e| -> BoxError {
                        format!("read `{path}` to modify: {e}").into()
                    })?;
                    let new_text = diffy::apply(&original, &patch).map_err(|e| -> BoxError {
                        format!("apply patch on `{path}`: {e}").into()
                    })?;
                    let (added, removed) = count_lines(block);
                    planned.push(PlannedWrite {
                        rel: path.to_string(),
                        abs,
                        kind: ChangeKind::Modified,
                        new_text: Some(new_text),
                        added,
                        removed,
                    });
                }
            }
        }

        // Phase 2: commit to disk. Order doesn't matter functionally
        // — each path is independent — but we keep input order for
        // a predictable summary.
        for w in &planned {
            match w.kind {
                ChangeKind::Created | ChangeKind::Modified => {
                    if let Some(parent) = w.abs.parent() {
                        fs::create_dir_all(parent).await.map_err(|e| -> BoxError {
                            format!("mkdir for `{}`: {e}", w.rel).into()
                        })?;
                    }
                    fs::write(&w.abs, w.new_text.as_deref().unwrap_or(""))
                        .await
                        .map_err(|e| -> BoxError { format!("write `{}`: {e}", w.rel).into() })?;
                }
                ChangeKind::Deleted => {
                    fs::remove_file(&w.abs)
                        .await
                        .map_err(|e| -> BoxError { format!("delete `{}`: {e}", w.rel).into() })?;
                }
            }
        }

        // Build the human-readable summary.
        let mut summary = format!("applied {} file(s):\n", planned.len());
        for w in &planned {
            let marker = match w.kind {
                ChangeKind::Created => "A",
                ChangeKind::Modified => "M",
                ChangeKind::Deleted => "D",
            };
            summary.push_str(&format!(
                "  {marker} {}   (+{} -{})\n",
                w.rel, w.added, w.removed
            ));
        }
        Ok(summary)
    }
}

#[derive(Debug)]
struct PlannedWrite {
    rel: String,
    abs: PathBuf,
    kind: ChangeKind,
    new_text: Option<String>,
    added: usize,
    removed: usize,
}

#[derive(Debug, Clone, Copy)]
enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug)]
enum PatchAction<'a> {
    Create { path: &'a str },
    Delete { path: &'a str },
    Modify { path: &'a str },
}

fn classify<'a>(
    original: Option<&'a str>,
    modified: Option<&'a str>,
) -> Result<PatchAction<'a>, BoxError> {
    let strip = |s: &'a str| -> &'a str {
        // Standard `a/` and `b/` prefixes the diff toolchain
        // injects; strip them so the path round-trips against the
        // sandbox root.
        s.strip_prefix("a/")
            .or_else(|| s.strip_prefix("b/"))
            .unwrap_or(s)
    };

    let orig_is_null = matches!(original, Some(p) if is_dev_null(p));
    let mod_is_null = matches!(modified, Some(p) if is_dev_null(p));

    match (original, modified) {
        (Some(_), Some(m)) if orig_is_null => Ok(PatchAction::Create { path: strip(m) }),
        (Some(o), Some(_)) if mod_is_null => Ok(PatchAction::Delete { path: strip(o) }),
        // Modify: trust `+++ b/<path>` (the destination), since
        // `--- a/<path>` is sometimes a build-tree path that
        // doesn't exist locally.
        (Some(_), Some(m)) => Ok(PatchAction::Modify { path: strip(m) }),
        (Some(o), None) => Ok(PatchAction::Modify { path: strip(o) }),
        _ => Err("patch missing both `---` and `+++` headers".into()),
    }
}

fn is_dev_null(p: &str) -> bool {
    let p = p.trim();
    p == "/dev/null" || p == "a/dev/null" || p == "b/dev/null"
}

fn resolve_target(root: &Path, rel: &str) -> Result<PathBuf, BoxError> {
    // diffy may include a tab-separated timestamp in the header
    // (`+++ b/foo.rs\t2024-01-01 ...`). Trim everything after a tab
    // before sandbox resolution.
    let cleaned = rel.split('\t').next().unwrap_or(rel).trim();
    if cleaned.is_empty() {
        return Err("patch path is empty".into());
    }
    resolve_under(root, cleaned)
}

/// Count `+` / `-` lines inside a single-file patch block, ignoring
/// `+++` / `---` headers. Pure cosmetic — used in the summary
/// string only.
fn count_lines(block: &str) -> (usize, usize) {
    let mut added = 0;
    let mut removed = 0;
    let mut in_hunk = false;
    for line in block.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if let Some(c) = line.chars().next() {
            match c {
                '+' => added += 1,
                '-' => removed += 1,
                _ => {}
            }
        }
    }
    (added, removed)
}

/// Split a multi-file unified diff into per-file blocks. Each
/// returned block is a complete, single-file patch suitable for
/// `Patch::from_str`. The split is conservative:
///
/// 1. If any `diff --git ` line is present, split on those (the
///    canonical git multi-file form).
/// 2. Otherwise, split on `--- ` lines that are immediately
///    followed by a `+++ ` line (the bare-diff multi-file form).
///
/// Lines before the first split marker are dropped (typical
/// preamble: PR description, hunk-zero metadata).
fn split_multi_file(diff: &str) -> Vec<String> {
    let lines: Vec<&str> = diff.lines().collect();
    let split_indices: Vec<usize> = if lines.iter().any(|l| l.starts_with("diff --git ")) {
        lines
            .iter()
            .enumerate()
            .filter_map(|(i, l)| l.starts_with("diff --git ").then_some(i))
            .collect()
    } else {
        lines
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                if !l.starts_with("--- ") {
                    return None;
                }
                let next = lines.get(i + 1)?;
                if next.starts_with("+++ ") {
                    Some(i)
                } else {
                    None
                }
            })
            .collect()
    };

    if split_indices.is_empty() {
        // No headers at all — caller will get a parse error with a
        // useful diagnostic from diffy.
        return Vec::new();
    }

    let mut blocks = Vec::with_capacity(split_indices.len());
    for (n, &start) in split_indices.iter().enumerate() {
        let end = split_indices.get(n + 1).copied().unwrap_or(lines.len());
        let block = lines[start..end].join("\n");
        // Patch::from_str expects a trailing newline for predictable
        // hunk parsing.
        blocks.push(format!("{block}\n"));
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn modifies_existing_file() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let tool = FsPatchTool::new(dir.path());

        let diff = "\
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
";
        let out = tool.invoke(json!({ "diff": diff })).await.unwrap();
        assert!(out.contains("M a.txt"), "got: {out}");
        let after = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(after, "one\nTWO\nthree\n");
    }

    #[tokio::test]
    async fn creates_new_file() {
        let dir = tempdir().unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
";
        let out = tool.invoke(json!({ "diff": diff })).await.unwrap();
        assert!(out.contains("A new.txt"), "got: {out}");
        let after = std::fs::read_to_string(dir.path().join("new.txt")).unwrap();
        assert_eq!(after, "hello\nworld\n");
    }

    #[tokio::test]
    async fn deletes_file() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
";
        let out = tool.invoke(json!({ "diff": diff })).await.unwrap();
        assert!(out.contains("D gone.txt"), "got: {out}");
        assert!(!dir.path().join("gone.txt").exists());
    }

    #[tokio::test]
    async fn multi_file_diff_with_git_headers() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "beta\n").unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-beta
+BETA
";
        let out = tool.invoke(json!({ "diff": diff })).await.unwrap();
        assert!(out.contains("M a.txt"), "got: {out}");
        assert!(out.contains("M b.txt"), "got: {out}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "ALPHA\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.txt")).unwrap(),
            "BETA\n"
        );
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let dir = tempdir().unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
--- a/../etc/passwd
+++ b/../etc/passwd
@@ -1 +1 @@
-x
+y
";
        let err = tool.invoke(json!({ "diff": diff })).await.unwrap_err();
        assert!(err.to_string().contains(".."), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_binary_patch() {
        let dir = tempdir().unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
diff --git a/img.bin b/img.bin
GIT binary patch
delta 1
abcd
";
        let err = tool.invoke(json!({ "diff": diff })).await.unwrap_err();
        assert!(err.to_string().contains("binary"), "got: {err}");
    }

    #[tokio::test]
    async fn stale_hunk_rolls_back_all_files() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "beta\n").unwrap();
        let tool = FsPatchTool::new(dir.path());
        // First hunk applies, second hunk's context doesn't match.
        let diff = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-NOT_BETA
+gamma
";
        let err = tool.invoke(json!({ "diff": diff })).await.unwrap_err();
        assert!(err.to_string().contains("apply patch"), "got: {err}");
        // a.txt must NOT have been modified — atomic rollback.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "alpha\n",
            "atomicity violated"
        );
    }

    #[tokio::test]
    async fn rejects_create_over_existing_file() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "exists\n").unwrap();
        let tool = FsPatchTool::new(dir.path());
        let diff = "\
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+new
";
        let err = tool.invoke(json!({ "diff": diff })).await.unwrap_err();
        assert!(err.to_string().contains("existing"), "got: {err}");
    }

    #[tokio::test]
    async fn requires_approval_is_true() {
        let tool = FsPatchTool::new("/tmp");
        assert!(tool.requires_approval());
    }
}
