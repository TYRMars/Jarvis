//! Sandboxed filesystem tools. Every tool is constructed with a `root`
//! directory and refuses inputs that are absolute or contain `..`
//! components, so the LLM can only read/list/write inside that root.

use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use harness_core::{BoxError, Tool};
use serde_json::{json, Value};
use tokio::fs;

fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, BoxError> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("path must be relative to the tool root".into());
    }
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                return Err("`..` components are not allowed".into());
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("absolute path components are not allowed".into());
            }
            _ => {}
        }
    }
    Ok(root.join(p))
}

fn arg_path<'a>(args: &'a Value, key: &str) -> Result<&'a str, BoxError> {
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

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = arg_path(&args, "path")?;
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

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let rel = arg_path(&args, "path")?;
        let content = arg_path(&args, "content")?;
        let abs = resolve_under(&self.root, rel)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = content.len();
        fs::write(&abs, content).await?;
        Ok(format!("wrote {bytes} bytes to {}", abs.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_parent_dir() {
        let root = Path::new("/tmp/doesnt-matter");
        assert!(resolve_under(root, "../etc/passwd").is_err());
        assert!(resolve_under(root, "a/../../b").is_err());
    }

    #[test]
    fn rejects_absolute() {
        let root = Path::new("/tmp/doesnt-matter");
        assert!(resolve_under(root, "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative() {
        let root = Path::new("/tmp/root");
        let p = resolve_under(root, "a/b.txt").unwrap();
        assert_eq!(p, Path::new("/tmp/root/a/b.txt"));
    }

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
}
