//! P16 — agent-facing tools for the `MEMORY.md` include
//! directives.
//!
//! Tools:
//! - `memory.include_add(target, scope?)` — adds a directive line
//!   at the top of the scope's MEMORY.md. For git URLs the initial
//!   clone happens immediately so the agent gets fast feedback on
//!   bad URLs / auth instead of discovering them on next restart.
//! - `memory.include_list(scope?)` — returns the parsed
//!   directives + resolution status per entry.
//! - `memory.include_remove(target, scope?)` — strips a directive
//!   line.
//! - `memory.include_refresh(target, scope?)` — git includes only:
//!   nuke and re-clone the cache.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::fs;

use crate::memory::{index_path, MemoryRoots, MemoryScope};
#[cfg(test)]
use crate::memory::MEMORY_DIR;
use crate::memory_include::{
    add_include_line, parse_include_directives, refresh_git_cache, remove_include_line,
    resolve_include, IncludeDirective,
};

fn parse_scope_arg(s: &str) -> Result<MemoryScope, BoxError> {
    MemoryScope::from_wire(s)
        .ok_or_else(|| -> BoxError { format!("unknown scope `{s}` — use `workspace` or `user`").into() })
}

/// Best-effort `home/.jarvis/include-cache` resolution. Used by
/// tools that aren't `serve.rs` (which has its own resolver) —
/// falls back to a tempdir so `memory.include_refresh` etc. still
/// have somewhere to put files when HOME is unset.
fn include_cache_root() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        return home.join(".jarvis/include-cache");
    }
    std::env::temp_dir().join("jarvis-include-cache")
}

async fn write_atomic(path: &Path, body: &str) -> Result<(), BoxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| -> BoxError { format!("mkdir {}: {e}", parent.display()).into() })?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body)
        .await
        .map_err(|e| -> BoxError { format!("write {}: {e}", tmp.display()).into() })?;
    fs::rename(&tmp, path)
        .await
        .map_err(|e| -> BoxError { format!("rename {}: {e}", path.display()).into() })?;
    Ok(())
}

async fn read_or_empty(path: &Path) -> String {
    fs::read_to_string(path).await.unwrap_or_default()
}

// -------- memory.include_add --------

pub struct MemoryIncludeAddTool {
    roots: MemoryRoots,
}
impl MemoryIncludeAddTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryIncludeAddTool {
    fn name(&self) -> &str {
        "memory.include_add"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Add an include directive to the scope's MEMORY.md so the \
         system prompt also pulls in another memory tree at \
         conversation start. `target` is either a filesystem path \
         (absolute or `~/...`) or a `git+<url>[#branch]` URL. Git \
         URLs trigger an immediate clone into the local cache so \
         the agent learns about auth / URL typos here rather than \
         on next restart."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["target"],
            "properties": {
                "target": {
                    "type": "string",
                    "description": "`/abs/path/memory` or `~/path/memory` or `git+https://...[#branch]`"
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Which scope's MEMORY.md to modify. Defaults to `workspace`."
                }
            }
        })
    }
    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("target").and_then(Value::as_str).map(str::to_string)
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `target` argument".into() })?;
        let directive = IncludeDirective::parse_target(target)
            .ok_or_else(|| -> BoxError { format!("invalid include target `{target}`").into() })?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::Workspace);
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let root = roots.root_for(scope)?;
        let index = index_path(root);
        let existing = read_or_empty(&index).await;
        // Eager validate the directive: for git URLs this triggers
        // the clone; for local paths it confirms the dir + memory
        // layout. We fail BEFORE writing the directive so a broken
        // target doesn't end up baked into MEMORY.md.
        let cache = include_cache_root();
        let _ = resolve_include(&directive, &cache).await?;
        let next = add_include_line(&existing, &directive);
        write_atomic(&index, &next).await?;
        harness_core::note_working_file_relative_to(&index, Some(root));
        Ok(json!({
            "ok": true,
            "added": directive.as_wire(),
            "scope": scope.as_wire(),
            "memory_md": index.display().to_string(),
        })
        .to_string())
    }
}

// -------- memory.include_list --------

pub struct MemoryIncludeListTool {
    roots: MemoryRoots,
}
impl MemoryIncludeListTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryIncludeListTool {
    fn name(&self) -> &str {
        "memory.include_list"
    }
    fn description(&self) -> &str {
        "Return the include directives declared at the top of the \
         scope's MEMORY.md plus their resolution status. Each \
         entry reports `target`, `kind` (`local_path` | \
         `git_url`), and `resolves` (bool with `error` when false). \
         No mutations."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Defaults to `workspace`."
                }
            }
        })
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::Workspace);
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let root = roots.root_for(scope)?;
        let index = index_path(root);
        let body = read_or_empty(&index).await;
        let cache = include_cache_root();
        let directives = parse_include_directives(&body);
        let mut items = Vec::new();
        for d in directives {
            let kind = match d {
                IncludeDirective::LocalPath(_) => "local_path",
                IncludeDirective::GitUrl { .. } => "git_url",
            };
            let entry = match resolve_include(&d, &cache).await {
                Ok(p) => json!({
                    "target": d.as_wire(),
                    "kind": kind,
                    "resolves": true,
                    "path": p.display().to_string(),
                }),
                Err(e) => json!({
                    "target": d.as_wire(),
                    "kind": kind,
                    "resolves": false,
                    "error": e.to_string(),
                }),
            };
            items.push(entry);
        }
        Ok(json!({
            "scope": scope.as_wire(),
            "memory_md": index.display().to_string(),
            "items": items,
        })
        .to_string())
    }
}

// -------- memory.include_remove --------

pub struct MemoryIncludeRemoveTool {
    roots: MemoryRoots,
}
impl MemoryIncludeRemoveTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryIncludeRemoveTool {
    fn name(&self) -> &str {
        "memory.include_remove"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Remove an include directive from the scope's MEMORY.md. \
         `target` is the same string used when adding the include \
         (use `memory.include_list` first to read the exact form)."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["target"],
            "properties": {
                "target": { "type": "string" },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"]
                }
            }
        })
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `target` argument".into() })?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::Workspace);
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let root = roots.root_for(scope)?;
        let index = index_path(root);
        let existing = read_or_empty(&index).await;
        let next = remove_include_line(&existing, target);
        write_atomic(&index, &next).await?;
        Ok(json!({
            "ok": true,
            "removed": target,
            "scope": scope.as_wire(),
        })
        .to_string())
    }
}

// -------- memory.include_refresh --------

pub struct MemoryIncludeRefreshTool;

#[async_trait]
impl Tool for MemoryIncludeRefreshTool {
    fn name(&self) -> &str {
        "memory.include_refresh"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Wipe and re-clone the local cache for a `git+...` include. \
         No-op for local-path includes (they always read from the \
         source). Use this when a team member pushed a new memory \
         entry and you want to pick it up without restarting."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["target"],
            "properties": {
                "target": {
                    "type": "string",
                    "description": "The `git+<url>[#branch]` string to refresh."
                }
            }
        })
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let target = args
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `target` argument".into() })?;
        let directive = IncludeDirective::parse_target(target)
            .ok_or_else(|| -> BoxError { format!("invalid include target `{target}`").into() })?;
        let cache = include_cache_root();
        let resolved = refresh_git_cache(&directive, &cache).await?;
        Ok(json!({
            "ok": true,
            "target": directive.as_wire(),
            "cache_path": resolved.display().to_string(),
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ws_roots(root: &std::path::Path) -> MemoryRoots {
        MemoryRoots::new(root.to_path_buf())
    }

    #[tokio::test]
    async fn add_local_include_writes_directive() {
        let workspace = tempdir().unwrap();
        // Need a real local path that resolves cleanly so the
        // eager validation passes.
        let upstream = tempdir().unwrap();
        let upstream_mem = upstream.path().join(MEMORY_DIR);
        fs::create_dir_all(&upstream_mem).await.unwrap();
        fs::write(upstream_mem.join("MEMORY.md"), "- [foo](foo.md)\n")
            .await
            .unwrap();

        let tool = MemoryIncludeAddTool::new(ws_roots(workspace.path()));
        let out = tool
            .invoke(json!({"target": upstream.path().to_string_lossy()}))
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        let body = fs::read_to_string(workspace.path().join(MEMORY_DIR).join("MEMORY.md"))
            .await
            .unwrap();
        assert!(body.contains("<!-- jarvis-include: "));
        assert!(body.contains(&upstream.path().to_string_lossy().to_string()));
    }

    #[tokio::test]
    async fn add_rejects_unresolvable_target() {
        let workspace = tempdir().unwrap();
        let tool = MemoryIncludeAddTool::new(ws_roots(workspace.path()));
        let err = tool
            .invoke(json!({"target": "/tmp/does-not-exist-include"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
        // Crucially: MEMORY.md was NOT created with a broken directive.
        let body = fs::read_to_string(workspace.path().join(MEMORY_DIR).join("MEMORY.md"))
            .await;
        assert!(body.is_err(), "should not have written MEMORY.md");
    }

    #[tokio::test]
    async fn list_reports_resolution_per_entry() {
        let workspace = tempdir().unwrap();
        // Seed MEMORY.md with two directives: one resolvable, one not.
        let mem = workspace.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem).await.unwrap();
        let upstream = tempdir().unwrap();
        let up_mem = upstream.path().join(MEMORY_DIR);
        fs::create_dir_all(&up_mem).await.unwrap();
        fs::write(up_mem.join("MEMORY.md"), "- [x](x.md)\n").await.unwrap();
        let body = format!(
            "<!-- jarvis-include: {} -->\n<!-- jarvis-include: /tmp/none-{} -->\n",
            upstream.path().display(),
            std::process::id()
        );
        fs::write(mem.join("MEMORY.md"), body).await.unwrap();
        let tool = MemoryIncludeListTool::new(ws_roots(workspace.path()));
        let out = tool.invoke(json!({})).await.unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let items = parsed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["resolves"], true);
        assert_eq!(items[1]["resolves"], false);
        assert!(items[1]["error"].as_str().unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn remove_strips_directive() {
        let workspace = tempdir().unwrap();
        let mem = workspace.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem).await.unwrap();
        fs::write(
            mem.join("MEMORY.md"),
            "<!-- jarvis-include: /a -->\n<!-- jarvis-include: /b -->\n",
        )
        .await
        .unwrap();
        let tool = MemoryIncludeRemoveTool::new(ws_roots(workspace.path()));
        let _ = tool.invoke(json!({"target": "/a"})).await.unwrap();
        let body = fs::read_to_string(mem.join("MEMORY.md")).await.unwrap();
        assert!(!body.contains("/a"));
        assert!(body.contains("/b"));
    }

    #[tokio::test]
    async fn refresh_rejects_local_path() {
        let tool = MemoryIncludeRefreshTool;
        let err = tool
            .invoke(json!({"target": "/some/path"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("only applies"));
    }
}
