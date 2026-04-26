//! Sandboxed filesystem tools. Every tool is constructed with a `root`
//! directory and refuses inputs that are absolute or contain `..`
//! components, so the LLM can only read/list/write inside that root.

use std::path::PathBuf;

use async_trait::async_trait;
use harness_core::{BoxError, Tool};
use serde_json::{json, Value};
use tokio::fs;

use crate::sandbox::resolve_under;

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, BoxError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| -> BoxError { format!("missing `{key}` argument").into() })
}

/// Read a UTF-8 file under the tool root.
pub struct FsReadTool {
    root: PathBuf,
}

impl FsReadTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for FsReadTool {
    fn name(&self) -> &str {
        "fs.read"
    }

    fn description(&self) -> &str {
        "Read a UTF-8 text file located under the tool's root directory. \
         `path` is relative; `..` and absolute paths are rejected."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path under the root." }
            },
            "required": ["path"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = arg_str(&args, "path")?;
        let abs = resolve_under(&self.root, rel)?;
        let contents = fs::read_to_string(&abs).await?;
        Ok(contents)
    }
}

/// List entries in a directory under the tool root.
pub struct FsListTool {
    root: PathBuf,
}

impl FsListTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for FsListTool {
    fn name(&self) -> &str {
        "fs.list"
    }

    fn description(&self) -> &str {
        "List entries in a directory under the tool root. Returns a JSON array \
         of {name, kind: 'file'|'dir'|'other'} objects."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative directory path under the root. \
                                    Defaults to the root itself."
                }
            }
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
        let abs = resolve_under(&self.root, rel)?;
        let mut rd = fs::read_dir(&abs).await?;

        let mut entries = Vec::new();
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ft = entry.file_type().await?;
            let kind = if ft.is_file() {
                "file"
            } else if ft.is_dir() {
                "dir"
            } else {
                "other"
            };
            entries.push(json!({ "name": name, "kind": kind }));
        }
        Ok(Value::Array(entries).to_string())
    }
}

/// Write UTF-8 `content` to `path`, creating parent directories as needed.
///
/// Overwrites existing files. Intentionally not registered by default in
/// `register_builtins` — opt in via `BuiltinsConfig::enable_fs_write`.
pub struct FsWriteTool {
    root: PathBuf,
}

impl FsWriteTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for FsWriteTool {
    fn name(&self) -> &str {
        "fs.write"
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Write UTF-8 text to a file under the tool root. Creates parent \
         directories as needed and overwrites existing files."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path under the root." },
                "content": { "type": "string", "description": "File contents (UTF-8)." }
            },
            "required": ["path", "content"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = arg_str(&args, "path")?;
        let content = arg_str(&args, "content")?;
        let abs = resolve_under(&self.root, rel)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = content.len();
        fs::write(&abs, content).await?;
        Ok(format!("wrote {bytes} bytes to {}", abs.display()))
    }
}

/// Replace `old_string` with `new_string` in a UTF-8 file under the tool
/// root. By default the match must be unique so the LLM can't silently
/// rewrite many call-sites at once; pass `replace_all = true` to opt in.
///
/// Intentionally not registered by default in `register_builtins` — opt in
/// via `BuiltinsConfig::enable_fs_edit`.
pub struct FsEditTool {
    root: PathBuf,
}

impl FsEditTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for FsEditTool {
    fn name(&self) -> &str {
        "fs.edit"
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Replace `old_string` with `new_string` in a file under the tool root. \
         By default `old_string` must occur exactly once; pass \
         `replace_all = true` to replace every occurrence."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative path under the root." },
                "old_string": { "type": "string", "description": "Exact text to replace." },
                "new_string": { "type": "string", "description": "Replacement text." },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring uniqueness. Defaults to false."
                }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = arg_str(&args, "path")?;
        let old = arg_str(&args, "old_string")?;
        let new = arg_str(&args, "new_string")?;
        let replace_all = args
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if old.is_empty() {
            return Err("`old_string` must not be empty".into());
        }
        if old == new {
            return Err("`old_string` and `new_string` are identical".into());
        }

        let abs = resolve_under(&self.root, rel)?;
        let original = fs::read_to_string(&abs).await?;
        let count = original.matches(old).count();

        let updated = match (count, replace_all) {
            (0, _) => return Err("`old_string` not found in file".into()),
            (_, true) => original.replace(old, new),
            (1, false) => original.replacen(old, new, 1),
            (n, false) => {
                return Err(format!(
                    "`old_string` matches {n} times — pass `replace_all = true` or extend the snippet for uniqueness"
                )
                .into());
            }
        };

        fs::write(&abs, &updated).await?;
        let replaced = if replace_all { count } else { 1 };
        Ok(format!(
            "edited {}: replaced {replaced} occurrence(s)",
            abs.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn read_write_roundtrip() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let read = FsReadTool::new(dir.path());

        write
            .invoke(json!({ "path": "sub/hello.txt", "content": "world" }))
            .await
            .unwrap();
        let got = read.invoke(json!({ "path": "sub/hello.txt" })).await.unwrap();
        assert_eq!(got, "world");
    }

    #[tokio::test]
    async fn list_contains_written_file() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let list = FsListTool::new(dir.path());
        write
            .invoke(json!({ "path": "a.txt", "content": "x" }))
            .await
            .unwrap();
        let out = list.invoke(json!({})).await.unwrap();
        assert!(out.contains("a.txt"), "list output was {out}");
    }

    #[tokio::test]
    async fn edit_replaces_unique_match() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let edit = FsEditTool::new(dir.path());
        let read = FsReadTool::new(dir.path());

        write
            .invoke(json!({ "path": "f.txt", "content": "hello world" }))
            .await
            .unwrap();
        edit.invoke(json!({
            "path": "f.txt",
            "old_string": "world",
            "new_string": "rust"
        }))
        .await
        .unwrap();
        let got = read.invoke(json!({ "path": "f.txt" })).await.unwrap();
        assert_eq!(got, "hello rust");
    }

    #[tokio::test]
    async fn edit_rejects_ambiguous_match() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let edit = FsEditTool::new(dir.path());

        write
            .invoke(json!({ "path": "f.txt", "content": "ab ab ab" }))
            .await
            .unwrap();
        let err = edit
            .invoke(json!({
                "path": "f.txt",
                "old_string": "ab",
                "new_string": "x"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("matches 3"), "got: {err}");
    }

    #[tokio::test]
    async fn edit_replace_all() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let edit = FsEditTool::new(dir.path());
        let read = FsReadTool::new(dir.path());

        write
            .invoke(json!({ "path": "f.txt", "content": "ab ab ab" }))
            .await
            .unwrap();
        edit.invoke(json!({
            "path": "f.txt",
            "old_string": "ab",
            "new_string": "x",
            "replace_all": true
        }))
        .await
        .unwrap();
        let got = read.invoke(json!({ "path": "f.txt" })).await.unwrap();
        assert_eq!(got, "x x x");
    }

    #[tokio::test]
    async fn edit_missing_string_errors() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let edit = FsEditTool::new(dir.path());

        write
            .invoke(json!({ "path": "f.txt", "content": "abc" }))
            .await
            .unwrap();
        let err = edit
            .invoke(json!({
                "path": "f.txt",
                "old_string": "xyz",
                "new_string": "q"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn edit_rejects_empty_old() {
        let dir = tempdir().unwrap();
        let write = FsWriteTool::new(dir.path());
        let edit = FsEditTool::new(dir.path());

        write
            .invoke(json!({ "path": "f.txt", "content": "abc" }))
            .await
            .unwrap();
        let err = edit
            .invoke(json!({
                "path": "f.txt",
                "old_string": "",
                "new_string": "q"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must not be empty"), "got: {err}");
    }
}
