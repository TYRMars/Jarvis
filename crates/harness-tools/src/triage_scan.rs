//! `triage.scan_candidates` — surface follow-up Requirement candidates
//! from passive workspace signals so the agent can propose work
//! beyond what the user explicitly asked for.
//!
//! v1.0 sources:
//!
//! - `todo_comments`: walk the workspace via the [`ignore`] crate
//!   (same `.gitignore`-aware traversal as [`crate::CodeGrepTool`])
//!   and surface each `TODO|FIXME|XXX|HACK` line as a candidate
//!   `{title, description, source: "todo_comment", path, line}`. The
//!   leading marker plus a short comment forms a usable
//!   Requirement title without further LLM massaging.
//!
//! Future sources (deferred to v1.1):
//!
//! - `failed_runs`: read `RequirementRunStore` for recent failed
//!   runs and propose a "fix `<title>` retry path" candidate. Needs
//!   the run store wired through `BuiltinsConfig`.
//! - `orphan_worktrees`: query `harness_server::diagnostics` for
//!   stale `.jarvis/worktrees/*` and propose cleanup. Crosses the
//!   `harness-server` dep boundary, so postponed.
//!
//! Read-only: registered alongside `code.grep` (always on). The tool
//! deliberately does NOT call `requirement.create` itself — surfacing
//! candidates and committing them are separate steps. The agent
//! decides which (if any) to write into the triage queue, where they
//! land as `triage_state=ProposedByScan`.

use std::path::PathBuf;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use ignore::WalkBuilder;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sandbox::resolve_under;

const DEFAULT_MAX_CANDIDATES: usize = 50;
const MAX_CANDIDATE_LIMIT: usize = 200;
const COMMENT_TRIM: usize = 200;

pub struct TriageScanTool {
    root: PathBuf,
}

impl TriageScanTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for TriageScanTool {
    fn name(&self) -> &str {
        "triage.scan_candidates"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Surface candidate follow-up requirements from passive \
         workspace signals. v1.0 source: `todo_comments` (TODO / \
         FIXME / XXX / HACK markers in source files). Returns a list \
         of `{title, description, source, path, line}` rows; the agent \
         then decides which to commit into the Triage queue via \
         `requirement.create(triage_state=\"proposed_by_scan\")`. \
         Read-only — does NOT itself write requirements. Optional \
         `path` narrows the scan to a subdirectory; `limit` caps the \
         result count (default 50, max 200)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "sources": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["todo_comments"] },
                    "description": "Which signal sources to include. Defaults to all known sources. Unknown source names are silently ignored so a future build adding a source doesn't break older callers."
                },
                "path": {
                    "type": "string",
                    "description": "Optional subdirectory under the workspace to scan. Sandboxed — absolute paths and `..` rejected."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_CANDIDATE_LIMIT,
                    "description": "Cap on candidates returned (default 50, max 200)."
                }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize, Default)]
        struct Args {
            #[serde(default)]
            sources: Option<Vec<String>>,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            limit: Option<u64>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("triage.scan_candidates: bad args: {e}").into() })?;

        let want_todo = parsed
            .sources
            .as_ref()
            .map(|ss| ss.iter().any(|s| s == "todo_comments"))
            .unwrap_or(true);

        let limit = parsed
            .limit
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_MAX_CANDIDATES)
            .min(MAX_CANDIDATE_LIMIT);

        let root = harness_core::active_workspace_or(&self.root);
        let scope_root = match parsed.path.as_deref() {
            Some(rel) => resolve_under(&root, rel)?,
            None => root.clone(),
        };

        let mut candidates: Vec<Value> = Vec::new();
        if want_todo {
            let display_root = root.clone();
            let mut found = scan_todo_comments(&scope_root, &display_root, limit)?;
            candidates.append(&mut found);
        }

        candidates.truncate(limit);
        Ok(serde_json::to_string(&json!({
            "candidates": candidates,
            "count": candidates.len(),
            "sources": ["todo_comments"],
        }))?)
    }
}

/// Walk `scope_root` looking for `TODO|FIXME|XXX|HACK` markers in
/// text files. Returns one JSON object per match. The `ignore` crate
/// applies the same `.gitignore` / hidden / VCS filters as
/// `code.grep`, so we never surface a marker from `node_modules/`,
/// `target/`, or vendored deps. Binary / non-UTF-8 files are
/// skipped silently.
fn scan_todo_comments(
    scope_root: &std::path::Path,
    display_root: &std::path::Path,
    limit: usize,
) -> Result<Vec<Value>, BoxError> {
    // Tolerate `// TODO: ...`, `# FIXME — ...`, `<!-- XXX foo -->`, etc.
    // Marker must be at a word boundary and followed by `:`, `-`, ` `,
    // or end of line so prose containing the word "todo" doesn't
    // count.
    let regex = Regex::new(r"(?i)\b(TODO|FIXME|XXX|HACK)\b\s*[:\-]?\s*(.{0,300})")
        .map_err(|e| -> BoxError { format!("internal regex bad: {e}").into() })?;

    let mut wb = WalkBuilder::new(scope_root);
    // Apply standard `.gitignore` / hidden-file filters even when
    // there's no `.git` directory in the tree (`require_git(false)`)
    // — useful both for tests and for sandboxes where the walked
    // root isn't a git checkout.
    wb.standard_filters(true).require_git(false);
    let walker = wb.build();
    let mut out: Vec<Value> = Vec::new();

    'outer: for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(display_root)
            .unwrap_or(path)
            .display()
            .to_string();
        for (idx, line) in contents.lines().enumerate() {
            let Some(caps) = regex.captures(line) else {
                continue;
            };
            let marker = caps
                .get(1)
                .map(|m| m.as_str().to_uppercase())
                .unwrap_or_default();
            let body = caps
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            // Skip empty markers ("// TODO" with no text) — those
            // generate noise without telling us what to do.
            if body.is_empty() {
                continue;
            }
            let trimmed_body: String = body.chars().take(COMMENT_TRIM).collect();
            // Keep titles short; the description carries the full
            // line + path/line for context.
            let title_body: String = trimmed_body.chars().take(80).collect();
            let title = format!("{marker}: {title_body}");
            out.push(json!({
                "title": title,
                "description": format!("Source: `{rel}:{}`\n\n```\n{trimmed_body}\n```", idx + 1),
                "source": "todo_comment",
                "path": rel,
                "line": idx + 1,
            }));
            if out.len() >= limit {
                break 'outer;
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(path: &std::path::Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[tokio::test]
    async fn surfaces_todo_and_fixme_with_titles_and_paths() {
        let dir = tempdir().unwrap();
        write(
            &dir.path().join("a.rs"),
            "fn main() {\n    // TODO: hook up the spec parser\n    let _ = 1;\n    // FIXME — leak under heavy load\n}\n",
        );
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let out = tool.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let cs = v["candidates"].as_array().unwrap();
        assert_eq!(cs.len(), 2);
        assert_eq!(cs[0]["source"], "todo_comment");
        assert!(cs[0]["title"].as_str().unwrap().starts_with("TODO: "));
        assert!(cs[1]["title"].as_str().unwrap().starts_with("FIXME: "));
        assert_eq!(cs[0]["path"], "a.rs");
        assert_eq!(cs[0]["line"], 2);
    }

    #[tokio::test]
    async fn ignores_empty_markers() {
        // Plain `// TODO` with no body shouldn't surface — we only
        // emit candidates that actually carry an actionable hint.
        let dir = tempdir().unwrap();
        write(
            &dir.path().join("a.rs"),
            "// TODO\n// TODO:    \n// TODO: real one\n",
        );
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let out = tool.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let cs = v["candidates"].as_array().unwrap();
        assert_eq!(cs.len(), 1);
        assert!(cs[0]["title"].as_str().unwrap().contains("real one"));
    }

    #[tokio::test]
    async fn respects_gitignore() {
        // The `ignore` crate respects .gitignore by default. Files
        // under an ignored directory must not surface candidates.
        let dir = tempdir().unwrap();
        write(&dir.path().join(".gitignore"), "ignored/\n");
        write(
            &dir.path().join("ignored/skipped.rs"),
            "// TODO: should not appear\n",
        );
        write(&dir.path().join("kept.rs"), "// TODO: should appear\n");
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let out = tool.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let cs = v["candidates"].as_array().unwrap();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0]["path"], "kept.rs");
    }

    #[tokio::test]
    async fn limit_caps_results() {
        let dir = tempdir().unwrap();
        let mut body = String::new();
        for i in 0..10 {
            body.push_str(&format!("// TODO: item {i}\n"));
        }
        write(&dir.path().join("a.rs"), &body);
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let out = tool.invoke(json!({ "limit": 3 })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["candidates"].as_array().unwrap().len(), 3);
        assert_eq!(v["count"], 3);
    }

    #[tokio::test]
    async fn unknown_source_is_silently_ignored() {
        // Forward-compat: a caller listing only an unknown source
        // gets zero candidates back, not an error. That keeps the
        // tool stable across versions.
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.rs"), "// TODO: ignored?\n");
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let out = tool
            .invoke(json!({ "sources": ["future_source_v3"] }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["candidates"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let dir = tempdir().unwrap();
        let tool = TriageScanTool::new(dir.path().to_path_buf());
        let err = tool
            .invoke(json!({ "path": "../escape" }))
            .await
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("path") || err.to_string().contains(".."));
    }

    #[test]
    fn does_not_require_approval() {
        let tool = TriageScanTool::new(std::path::PathBuf::from("."));
        assert!(!tool.requires_approval());
    }
}
