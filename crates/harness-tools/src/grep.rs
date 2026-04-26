//! Regex-based code search.
//!
//! Walks the sandbox root with the [`ignore`] crate (so `.gitignore`,
//! `.ignore`, hidden files and the standard "VCS / build artifact"
//! filters are respected automatically), reads each candidate file as
//! UTF-8, and reports lines matching the supplied regex. Binary or
//! non-UTF-8 files are skipped silently — they would otherwise return
//! garbage to the model.
//!
//! Read-only: registered by default in `register_builtins`.

use std::path::PathBuf;

use async_trait::async_trait;
use harness_core::{BoxError, Tool};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::{json, Value};

use crate::sandbox::resolve_under;

const DEFAULT_MAX_RESULTS: usize = 200;
const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const MAX_LINE_CHARS: usize = 240;

pub struct CodeGrepTool {
    root: PathBuf,
    max_results: usize,
    max_bytes: usize,
}

impl CodeGrepTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_results: DEFAULT_MAX_RESULTS,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }

    pub fn with_max_results(mut self, n: usize) -> Self {
        self.max_results = n;
        self
    }

    pub fn with_max_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n;
        self
    }
}

#[async_trait]
impl Tool for CodeGrepTool {
    fn name(&self) -> &str {
        "code.grep"
    }

    fn description(&self) -> &str {
        "Search files under the tool root for lines matching a regex. \
         Respects .gitignore / .ignore / hidden-file filters. Optional \
         `path` (relative subdir) and `glob` (e.g. `*.rs`) narrow the \
         search. Returns `path:lineno: line` triples, capped by \
         `max_results` and total bytes. Lines longer than 240 chars are \
         truncated."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Rust-flavoured regex (https://docs.rs/regex)."
                },
                "path": {
                    "type": "string",
                    "description": "Optional subdirectory under the root."
                },
                "glob": {
                    "type": "string",
                    "description": "Optional gitignore-style glob, e.g. `*.rs` or `src/**/*.ts`."
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Case-insensitive match. Defaults to false."
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Cap on number of matching lines returned."
                }
            },
            "required": ["pattern"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `pattern` argument".into() })?;

        let case_insensitive = args
            .get("case_insensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let max_results = args
            .get("max_results")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(self.max_results);

        let scope_root = match args.get("path").and_then(Value::as_str) {
            Some(rel) => resolve_under(&self.root, rel)?,
            None => self.root.clone(),
        };

        let regex = RegexBuilder::new(pattern)
            .case_insensitive(case_insensitive)
            .build()
            .map_err(|e| -> BoxError { format!("invalid regex: {e}").into() })?;

        let glob = args
            .get("glob")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let display_root = self.root.clone();
        let max_bytes = self.max_bytes;

        let result = tokio::task::spawn_blocking(move || -> Result<String, BoxError> {
            let mut wb = WalkBuilder::new(&scope_root);
            wb.standard_filters(true);
            if let Some(g) = glob {
                let mut ob = OverrideBuilder::new(&scope_root);
                ob.add(&g)
                    .map_err(|e| -> BoxError { format!("invalid glob: {e}").into() })?;
                let overrides = ob
                    .build()
                    .map_err(|e| -> BoxError { format!("invalid glob: {e}").into() })?;
                wb.overrides(overrides);
            }
            let walker = wb.build();

            let mut out = String::new();
            let mut count: usize = 0;
            let mut truncated = false;

            'outer: for entry in walker {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                    continue;
                }
                let path = entry.path();
                let contents = match std::fs::read_to_string(path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let rel = path
                    .strip_prefix(&display_root)
                    .unwrap_or(path)
                    .display()
                    .to_string();
                for (idx, line) in contents.lines().enumerate() {
                    if !regex.is_match(line) {
                        continue;
                    }
                    let snippet = if line.chars().count() > MAX_LINE_CHARS {
                        let truncated_line: String =
                            line.chars().take(MAX_LINE_CHARS).collect();
                        format!("{truncated_line} …")
                    } else {
                        line.to_string()
                    };
                    let formatted = format!("{rel}:{}: {snippet}\n", idx + 1);
                    if out.len() + formatted.len() > max_bytes {
                        truncated = true;
                        break 'outer;
                    }
                    out.push_str(&formatted);
                    count += 1;
                    if count >= max_results {
                        truncated = true;
                        break 'outer;
                    }
                }
            }

            if count == 0 {
                return Ok("(no matches)".to_string());
            }
            if truncated {
                out.push_str(&format!(
                    "\n[... truncated at {count} results / {max_bytes} bytes ...]"
                ));
            }
            Ok(out)
        })
        .await
        .map_err(|e| -> BoxError { format!("grep task panicked: {e}").into() })??;

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
    async fn finds_matches_across_files() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.rs"), "fn alpha() {}\nfn beta() {}\n");
        write(&dir.path().join("sub/b.rs"), "fn gamma() {}\n");
        let tool = CodeGrepTool::new(dir.path());

        let out = tool
            .invoke(json!({ "pattern": r"^fn \w+" }))
            .await
            .unwrap();
        assert!(out.contains("a.rs:1:"), "got: {out}");
        assert!(out.contains("a.rs:2:"), "got: {out}");
        assert!(out.contains("b.rs:1:"), "got: {out}");
    }

    #[tokio::test]
    async fn glob_filters_files() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.rs"), "needle\n");
        write(&dir.path().join("b.txt"), "needle\n");
        let tool = CodeGrepTool::new(dir.path());

        let out = tool
            .invoke(json!({ "pattern": "needle", "glob": "*.rs" }))
            .await
            .unwrap();
        assert!(out.contains("a.rs"), "got: {out}");
        assert!(!out.contains("b.txt"), "got: {out}");
    }

    #[tokio::test]
    async fn case_insensitive() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.txt"), "Hello World\n");
        let tool = CodeGrepTool::new(dir.path());

        let out = tool
            .invoke(json!({ "pattern": "hello", "case_insensitive": true }))
            .await
            .unwrap();
        assert!(out.contains("Hello World"), "got: {out}");
    }

    #[tokio::test]
    async fn no_matches_message() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.txt"), "abc\n");
        let tool = CodeGrepTool::new(dir.path());

        let out = tool.invoke(json!({ "pattern": "xyz" })).await.unwrap();
        assert!(out.contains("no matches"), "got: {out}");
    }

    #[tokio::test]
    async fn invalid_regex_errors() {
        let dir = tempdir().unwrap();
        let tool = CodeGrepTool::new(dir.path());
        let err = tool
            .invoke(json!({ "pattern": "[" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("invalid regex"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let dir = tempdir().unwrap();
        let tool = CodeGrepTool::new(dir.path());
        let err = tool
            .invoke(json!({ "pattern": "x", "path": "../etc" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(".."), "got: {err}");
    }

    #[tokio::test]
    async fn caps_results() {
        let dir = tempdir().unwrap();
        let mut content = String::new();
        for _ in 0..50 {
            content.push_str("match\n");
        }
        write(&dir.path().join("a.txt"), &content);
        let tool = CodeGrepTool::new(dir.path());

        let out = tool
            .invoke(json!({ "pattern": "match", "max_results": 5 }))
            .await
            .unwrap();
        assert!(out.contains("truncated"), "got: {out}");
        assert_eq!(out.matches("a.txt:").count(), 5, "got: {out}");
    }
}
