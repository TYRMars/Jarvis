//! Filename-glob file search.
//!
//! Walks the sandbox root with the [`ignore`] crate (so `.gitignore`,
//! `.ignore`, hidden files and the standard "VCS / build artifact"
//! filters are respected automatically) and lists the *paths* of files
//! whose name matches a gitignore-style glob — the read-only counterpart
//! to [`crate::grep::CodeGrepTool`] that searches by name rather than by
//! content.
//!
//! Read-only: registered by default in `register_builtins`.

use std::path::PathBuf;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde_json::{json, Value};

use crate::sandbox::resolve_under;

const DEFAULT_MAX_RESULTS: usize = 500;

pub struct FsFindTool {
    root: PathBuf,
    max_results: usize,
}

impl FsFindTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_results: DEFAULT_MAX_RESULTS,
        }
    }

    pub fn with_max_results(mut self, n: usize) -> Self {
        self.max_results = n;
        self
    }
}

#[async_trait]
impl Tool for FsFindTool {
    fn name(&self) -> &str {
        "fs.find"
    }

    fn description(&self) -> &str {
        "Find files under the tool root whose path matches a gitignore-style \
         glob (e.g. `**/*.rs` or `src/**/*.ts`). Respects \
         .gitignore / .ignore / hidden-file filters. Optional `path` \
         (relative subdir) narrows the search. Returns one relative file \
         path per line, capped by `max_results`."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "glob": {
                    "type": "string",
                    "description": "Gitignore-style glob, e.g. `**/*.rs` or `src/**/*.ts`."
                },
                "path": {
                    "type": "string",
                    "description": "Optional subdirectory under the root."
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Cap on number of file paths returned."
                }
            },
            "required": ["glob"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("glob").and_then(Value::as_str).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let glob = args
            .get("glob")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `glob` argument".into() })?
            .to_string();

        let max_results = args
            .get("max_results")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(self.max_results);

        let root = harness_core::active_workspace_or(&self.root);
        let scope_root = match args.get("path").and_then(Value::as_str) {
            Some(rel) => resolve_under(&root, rel)?,
            None => root.clone(),
        };

        let display_root = root.clone();

        let result = tokio::task::spawn_blocking(move || -> Result<String, BoxError> {
            let mut wb = WalkBuilder::new(&scope_root);
            wb.standard_filters(true);
            let mut ob = OverrideBuilder::new(&scope_root);
            ob.add(&glob)
                .map_err(|e| -> BoxError { format!("invalid glob: {e}").into() })?;
            let overrides = ob
                .build()
                .map_err(|e| -> BoxError { format!("invalid glob: {e}").into() })?;
            wb.overrides(overrides);
            let walker = wb.build();

            let mut out = String::new();
            let mut count: usize = 0;
            let mut truncated = false;

            for entry in walker {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                    continue;
                }
                let path = entry.path();
                let rel = path
                    .strip_prefix(&display_root)
                    .unwrap_or(path)
                    .display()
                    .to_string();
                out.push_str(&rel);
                out.push('\n');
                count += 1;
                if count >= max_results {
                    truncated = true;
                    break;
                }
            }

            if count == 0 {
                return Ok("(no matches)".to_string());
            }
            if truncated {
                out.push_str(&format!("\n[... truncated at {count} results ...]"));
            }
            Ok(out)
        })
        .await
        .map_err(|e| -> BoxError { format!("fs.find task panicked: {e}").into() })??;

        Ok(result)
    }
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
    async fn finds_rust_files_across_subdirs() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.rs"), "fn alpha() {}\n");
        write(&dir.path().join("sub/b.rs"), "fn beta() {}\n");
        let tool = FsFindTool::new(dir.path());

        let out = tool.invoke(json!({ "glob": "**/*.rs" })).await.unwrap();
        assert!(out.contains("a.rs"), "got: {out}");
        assert!(out.contains("b.rs"), "got: {out}");
    }

    #[tokio::test]
    async fn glob_excludes_other_extensions() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.rs"), "fn alpha() {}\n");
        write(&dir.path().join("b.txt"), "plain text\n");
        let tool = FsFindTool::new(dir.path());

        let out = tool.invoke(json!({ "glob": "**/*.rs" })).await.unwrap();
        assert!(out.contains("a.rs"), "got: {out}");
        assert!(!out.contains("b.txt"), "got: {out}");
    }

    #[tokio::test]
    async fn no_matches_message() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.txt"), "plain text\n");
        let tool = FsFindTool::new(dir.path());

        let out = tool.invoke(json!({ "glob": "**/*.rs" })).await.unwrap();
        assert!(out.contains("no matches"), "got: {out}");
    }
}
