//! `memory.*` agent-maintained memory tools (M3.1 + P9).
//!
//! The model can write durable notes ("user prefers Rust + tokio",
//! "the auth flow rejects empty user-agent strings", etc.) into one
//! of two scopes:
//!
//! - **workspace** scope — facts that are specific to the current
//!   project. Stored under `<workspace>/.jarvis/memory/`. Checking
//!   the directory into git gives the rest of the team shared
//!   recall of the codebase's quirks.
//! - **user** scope — facts that follow the operator across
//!   projects (preferences, recurring style choices, personal
//!   shortcuts). Stored under `~/.jarvis/memory/`. Syncing the
//!   home directory via Dropbox / iCloud / a personal git repo
//!   makes the same notes available on every machine without a
//!   Jarvis-specific sync server.
//!
//! Each scope has its own `MEMORY.md` index plus one `<slug>.md`
//! per topic. The agent's system prompt injects both indices at
//! conversation start (with `=== project memory index ===` and
//! `=== user memory index ===` headers) so the model wakes up
//! knowing what's recorded on each side.
//!
//! P9 wire layout:
//!
//! ```text
//! ~/.jarvis/memory/                       # user-scope (cross-workspace)
//!   MEMORY.md
//!   <slug>.md
//!
//! <workspace>/.jarvis/memory/             # workspace-scope (project)
//!   MEMORY.md
//!   <slug>.md
//! ```
//!
//! Slug collisions across scopes are allowed — the two scopes are
//! independent file trees. `memory.read` defaults to workspace and
//! falls back to user when the slug isn't found in workspace; an
//! explicit `scope` argument disambiguates.
//!
//! Off by default — opt in via [`crate::BuiltinsConfig::enable_memory`].
//!
//! Safety caps:
//! - Slug must match `[A-Za-z0-9._-]{1,64}` — no path separators,
//!   no shell metacharacters; the index file name `MEMORY.md` is
//!   reserved so writes can't clobber it.
//! - Per-entry body capped at [`MAX_ENTRY_BYTES`].
//! - Index capped at [`MAX_INDEX_BYTES`] / [`MAX_INDEX_LINES`].
//! - Writes are atomic (temp-rename) so a crashed agent can't leave
//!   a half-written MEMORY.md.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::fs;

/// Per-entry body cap. Generous compared to a typical memory note
/// (a paragraph or two) but small enough that one bad write can't
/// blow up the system-prompt injection budget.
pub const MAX_ENTRY_BYTES: usize = 32 * 1024;
/// Index file (MEMORY.md) cap. The whole index is injected into the
/// system prompt at conversation start — 25 KiB is the same budget
/// used by `load_instructions` for CLAUDE.md / AGENTS.md.
pub const MAX_INDEX_BYTES: usize = 25 * 1024;
/// Hard cap on index lines so a runaway `memory.write` loop can't
/// fill MEMORY.md with thousands of one-line entries. 200 leaves
/// generous headroom for a real project's memory map without
/// inviting an unbounded list.
pub const MAX_INDEX_LINES: usize = 200;

/// Subdirectory under the workspace / user-home root where memory
/// lives. Same name in both scopes so a glance at `tree` reveals the
/// layout consistently.
pub const MEMORY_DIR: &str = ".jarvis/memory";
const INDEX_FILE: &str = "MEMORY.md";

/// Identifies which scope a memory operation targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    /// `<workspace>/.jarvis/memory/`. Project-specific facts.
    Workspace,
    /// `<user_home>/.jarvis/memory/`. Cross-workspace facts.
    User,
}

impl MemoryScope {
    pub fn as_wire(&self) -> &'static str {
        match self {
            MemoryScope::Workspace => "workspace",
            MemoryScope::User => "user",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "workspace" => Some(MemoryScope::Workspace),
            "user" => Some(MemoryScope::User),
            _ => None,
        }
    }
}

/// Tool-construction config: both scope roots, optional. `user_root`
/// is the parent of `.jarvis/memory/` (usually the user's home
/// directory); `None` means user scope is disabled — write attempts
/// to user scope error cleanly, the system prompt injection
/// silently omits the user index.
#[derive(Debug, Clone, Default)]
pub struct MemoryRoots {
    pub workspace_root: PathBuf,
    pub user_root: Option<PathBuf>,
}

impl MemoryRoots {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            user_root: None,
        }
    }

    pub fn with_user_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.user_root = Some(root.into());
        self
    }

    /// Resolve a scope to its absolute parent path. Returns
    /// `BoxError` (already user-facing) when the requested scope
    /// isn't configured.
    pub fn root_for(&self, scope: MemoryScope) -> Result<&Path, BoxError> {
        match scope {
            MemoryScope::Workspace => Ok(self.workspace_root.as_path()),
            MemoryScope::User => self
                .user_root
                .as_deref()
                .ok_or_else(|| -> BoxError { "user-scope memory is not configured".into() }),
        }
    }
}

/// Build the absolute index path under `root`.
pub fn index_path(root: &Path) -> PathBuf {
    root.join(MEMORY_DIR).join(INDEX_FILE)
}

/// Build the absolute body path for `slug` under `root`. Does not
/// validate the slug — callers must `validate_slug` first.
fn entry_path(root: &Path, slug: &str) -> PathBuf {
    root.join(MEMORY_DIR).join(format!("{slug}.md"))
}

/// Reject anything that isn't safe to use as a filename / index
/// anchor. The slug becomes part of the on-disk path and the
/// markdown link — disallowing path separators, dot-prefixes, and
/// the reserved `MEMORY` token keeps the layout coherent.
pub fn validate_slug(slug: &str) -> Result<(), BoxError> {
    if slug.is_empty() {
        return Err("slug must not be empty".into());
    }
    if slug.len() > 64 {
        return Err("slug must be 64 chars or fewer".into());
    }
    if slug.eq_ignore_ascii_case("memory") {
        return Err("slug `memory` is reserved (clashes with MEMORY.md)".into());
    }
    if slug.starts_with('.') {
        return Err("slug must not start with `.`".into());
    }
    for c in slug.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
            return Err(format!("slug contains invalid char `{c}` (allowed: A-Za-z0-9._-)").into());
        }
    }
    Ok(())
}

/// Read the index file (`MEMORY.md`), returning `Ok(None)` when it
/// hasn't been created yet so the empty-state path is `None` rather
/// than `Err`.
///
/// On macOS, if the memory dir lives under iCloud Drive and the
/// index is still a lazy stub (`.MEMORY.md.icloud`), this triggers
/// a `brctl download` first so the read sees the real file.
/// Cross-platform paths bypass that step entirely (no extra cost).
pub async fn read_index(root: &Path) -> Result<Option<String>, BoxError> {
    let path = index_path(root);
    let _ = crate::memory_icloud::ensure_materialised(root.join(MEMORY_DIR).as_path()).await;
    match fs::read_to_string(&path).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display()).into()),
    }
}

/// Append-or-update one entry's line in MEMORY.md. The line shape
/// is `- [<summary>](<slug>.md)` — a normal markdown list link the
/// model can read back. Duplicate slugs replace the existing line
/// in place so re-writing the same topic doesn't bloat the index.
fn merge_index_line(existing: Option<&str>, slug: &str, summary: &str) -> String {
    let new_line = format!("- [{summary}]({slug}.md)");
    let needle = format!("]({slug}.md)");
    let lines: Vec<&str> = existing.map(|s| s.lines().collect()).unwrap_or_default();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;
    for line in &lines {
        if line.contains(&needle) {
            out.push(new_line.clone());
            replaced = true;
        } else {
            out.push((*line).to_string());
        }
    }
    if !replaced {
        out.push(new_line);
    }
    // Drop empty leading/trailing lines for stable byte output.
    while out.first().map(|s| s.is_empty()).unwrap_or(false) {
        out.remove(0);
    }
    while out.last().map(|s| s.is_empty()).unwrap_or(false) {
        out.pop();
    }
    out.join("\n") + "\n"
}

/// Remove the matching index line for `slug`. Returns `true` when a
/// line was removed (i.e. the slug had an entry).
fn remove_index_line(existing: &str, slug: &str) -> (String, bool) {
    let needle = format!("]({slug}.md)");
    let kept: Vec<&str> = existing
        .lines()
        .filter(|line| !line.contains(&needle))
        .collect();
    let removed = kept.len() < existing.lines().count();
    let mut joined = kept.join("\n");
    if !joined.is_empty() && !joined.ends_with('\n') {
        joined.push('\n');
    }
    (joined, removed)
}

/// Atomic write: temp file in the same directory + rename. Avoids
/// torn writes if the agent dies mid-write.
async fn atomic_write(path: &Path, contents: &str) -> Result<(), BoxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| -> BoxError { format!("mkdir {}: {e}", parent.display()).into() })?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)
        .await
        .map_err(|e| -> BoxError { format!("write {}: {e}", tmp.display()).into() })?;
    fs::rename(&tmp, path)
        .await
        .map_err(|e| -> BoxError { format!("rename {}: {e}", path.display()).into() })?;
    Ok(())
}

// ----- tools -----

pub struct MemoryListTool {
    roots: MemoryRoots,
}
impl MemoryListTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryListTool {
    fn name(&self) -> &str {
        "memory.list"
    }
    fn description(&self) -> &str {
        "List the agent's memory indices. With no arguments, returns \
         a combined view of both scopes (workspace + user, each \
         under its own heading). Pass `scope: \"workspace\"` or \
         `scope: \"user\"` to get just one. Use `memory.read(slug, \
         scope?)` to fetch a specific entry's body. Empty scopes \
         show a placeholder so callers can distinguish 'not yet \
         written' from 'not configured'."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Optional — restrict to one scope. Omit to see both."
                }
            }
        })
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let scope = match args.get("scope").and_then(Value::as_str) {
            Some(s) => Some(parse_scope_arg(s)?),
            None => None,
        };
        Ok(render_combined_list(&roots, scope).await)
    }
}

/// Render the combined list output for `memory.list`. Pure render
/// helper so the system-prompt injection path (which doesn't go
/// through tool dispatch) can call it directly.
pub async fn render_combined_list(
    roots: &MemoryRoots,
    only: Option<MemoryScope>,
) -> String {
    let mut out = String::new();
    let scopes: &[MemoryScope] = match only {
        Some(MemoryScope::Workspace) => &[MemoryScope::Workspace],
        Some(MemoryScope::User) => &[MemoryScope::User],
        None => &[MemoryScope::Workspace, MemoryScope::User],
    };
    for &scope in scopes {
        let root = match roots.root_for(scope) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let header = match scope {
            MemoryScope::Workspace => "## project memory (workspace scope)",
            MemoryScope::User => "## user memory (cross-workspace)",
        };
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(header);
        out.push('\n');
        match read_index(root).await {
            Ok(Some(body)) if !body.trim().is_empty() => out.push_str(body.trim_end()),
            _ => out.push_str("(no entries yet)"),
        }
    }
    if out.is_empty() {
        "(no memory entries yet)".to_string()
    } else {
        out
    }
}

fn parse_scope_arg(s: &str) -> Result<MemoryScope, BoxError> {
    MemoryScope::from_wire(s)
        .ok_or_else(|| -> BoxError { format!("unknown scope `{s}` — use `workspace` or `user`").into() })
}

pub struct MemoryReadTool {
    roots: MemoryRoots,
}
impl MemoryReadTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryReadTool {
    fn name(&self) -> &str {
        "memory.read"
    }
    fn description(&self) -> &str {
        "Read a single memory entry by its slug. By default searches \
         workspace scope first then falls back to user scope. Pass \
         `scope` to pin a specific tree (useful when both scopes \
         have the same slug)."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["slug"],
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Topic slug — must match `[A-Za-z0-9._-]{1,64}`."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Optional — pin to a scope. Omit for workspace-then-user fallback."
                }
            }
        })
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let slug = args
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `slug` argument".into() })?;
        validate_slug(slug)?;
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?;
        let order: Vec<MemoryScope> = match scope {
            Some(s) => vec![s],
            None => vec![MemoryScope::Workspace, MemoryScope::User],
        };
        for s in &order {
            let Ok(root) = roots.root_for(*s) else {
                continue;
            };
            let path = entry_path(root, slug);
            // P15 — pull iCloud lazy stubs down before reading.
            // Off macOS / outside iCloud Drive this is a no-op
            // and adds only one stat call.
            let _ = crate::memory_icloud::ensure_materialised(
                root.join(MEMORY_DIR).as_path(),
            )
            .await;
            match fs::read_to_string(&path).await {
                Ok(body) => return Ok(body),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("read {}: {e}", path.display()).into()),
            }
        }
        Err(format!("no memory entry for slug `{slug}` in {} scope(s)", order.len()).into())
    }
}

pub struct MemoryWriteTool {
    roots: MemoryRoots,
}
impl MemoryWriteTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "memory.write"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Persist a memory entry. Writes \
         `<scope_root>/.jarvis/memory/<slug>.md` with `content` and \
         upserts a `- [<summary>](<slug>.md)` line in MEMORY.md so \
         the system prompt picks it up on the next conversation. \
         Re-writing an existing slug in the same scope replaces \
         both the body and the index line. \
         \
         Scope guidance: \
         - `scope: \"workspace\"` (default) — project-specific facts \
         (architecture decisions, recurring gotchas, conventions this \
         codebase enforces). Goes into `<workspace>/.jarvis/memory/` \
         and is shared with anyone who has access to the repo. \
         - `scope: \"user\"` — operator-personal facts (preferences, \
         language/style choices, cross-project habits). Goes into \
         `~/.jarvis/memory/` and follows the user across workspaces. \
         \
         Use sparingly — write the kind of fact you'd want to \
         remember across sessions, not transient working state."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["slug", "summary", "content"],
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Stable topic slug — must match `[A-Za-z0-9._-]{1,64}`."
                },
                "summary": {
                    "type": "string",
                    "description": "One-line index summary (under ~120 chars)."
                },
                "content": {
                    "type": "string",
                    "description": "Full body in markdown. Up to 32 KiB."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Where to persist. Defaults to `workspace`."
                }
            }
        })
    }
    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let slug = args.get("slug").and_then(Value::as_str)?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("workspace");
        Some(format!("{scope}/{slug}"))
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let slug = args
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `slug` argument".into() })?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `summary` argument".into() })?
            .trim();
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `content` argument".into() })?;
        validate_slug(slug)?;
        if summary.is_empty() {
            return Err("`summary` must not be empty".into());
        }
        if summary.contains('\n') {
            return Err("`summary` must be a single line".into());
        }
        if content.len() > MAX_ENTRY_BYTES {
            return Err(format!(
                "content too large: {} bytes > {} (MAX_ENTRY_BYTES)",
                content.len(),
                MAX_ENTRY_BYTES
            )
            .into());
        }
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
        let entry = entry_path(root, slug);
        atomic_write(&entry, content).await?;
        // Only workspace-scope writes get noted into the working
        // context — touching `~/.jarvis/memory/` isn't a useful
        // "recent file" for the agent's next turn.
        if matches!(scope, MemoryScope::Workspace) {
            harness_core::note_working_file_relative_to(&entry, Some(root));
        }

        let existing_index = read_index(root).await?;
        let new_index = merge_index_line(existing_index.as_deref(), slug, summary);
        if new_index.lines().count() > MAX_INDEX_LINES {
            return Err(format!(
                "memory index would exceed {MAX_INDEX_LINES} lines — delete some entries first"
            )
            .into());
        }
        if new_index.len() > MAX_INDEX_BYTES {
            return Err(format!(
                "memory index would exceed {MAX_INDEX_BYTES} bytes — delete some entries first"
            )
            .into());
        }
        let index = index_path(root);
        atomic_write(&index, &new_index).await?;
        if matches!(scope, MemoryScope::Workspace) {
            harness_core::note_working_file_relative_to(&index, Some(root));
        }

        Ok(format!(
            "wrote {} memory `{slug}` ({bytes} bytes); index now has {n} entries",
            scope.as_wire(),
            bytes = content.len(),
            n = new_index.lines().count(),
        ))
    }
}

pub struct MemoryDeleteTool {
    roots: MemoryRoots,
}
impl MemoryDeleteTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryDeleteTool {
    fn name(&self) -> &str {
        "memory.delete"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Remove a memory entry. Deletes `<slug>.md` and strips its \
         line from MEMORY.md inside the chosen scope (default \
         `workspace`). Returns the number of remaining entries in \
         that scope."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["slug"],
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Slug to forget — must match `[A-Za-z0-9._-]{1,64}`."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Scope to delete from. Defaults to `workspace`."
                }
            }
        })
    }
    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let slug = args.get("slug").and_then(Value::as_str)?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("workspace");
        Some(format!("{scope}/{slug}"))
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let slug = args
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `slug` argument".into() })?;
        validate_slug(slug)?;
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
        let entry = entry_path(root, slug);
        match fs::remove_file(&entry).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(
                    format!("no memory entry for slug `{slug}` in {} scope", scope.as_wire()).into(),
                );
            }
            Err(e) => return Err(format!("delete {}: {e}", entry.display()).into()),
        }

        let existing_index = read_index(root).await?.unwrap_or_default();
        let (new_index, _removed) = remove_index_line(&existing_index, slug);
        let index = index_path(root);
        if new_index.trim().is_empty() {
            // Drop the index file entirely so an empty memory looks
            // empty rather than `MEMORY.md` of zero bytes.
            let _ = fs::remove_file(&index).await;
        } else {
            atomic_write(&index, &new_index).await?;
        }
        let remaining = new_index.lines().filter(|l| !l.trim().is_empty()).count();
        Ok(format!(
            "deleted {} memory `{slug}`; {remaining} entries remain in scope",
            scope.as_wire()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn slug_validation_rejects_path_traversal() {
        assert!(validate_slug("../etc").is_err());
        assert!(validate_slug("a/b").is_err());
        assert!(validate_slug("..").is_err());
        assert!(validate_slug("").is_err());
        assert!(validate_slug("memory").is_err());
        assert!(validate_slug("MEMORY").is_err());
        assert!(validate_slug(".hidden").is_err());
        assert!(validate_slug(&"x".repeat(65)).is_err());
        // Allowed.
        assert!(validate_slug("user-prefs").is_ok());
        assert!(validate_slug("auth_flow").is_ok());
        assert!(validate_slug("api.v2").is_ok());
        assert!(validate_slug("abc").is_ok());
    }

    fn ws_roots(root: &std::path::Path) -> MemoryRoots {
        MemoryRoots::new(root.to_path_buf())
    }

    fn dual_roots(ws: &std::path::Path, user: &std::path::Path) -> MemoryRoots {
        MemoryRoots::new(ws.to_path_buf()).with_user_root(user.to_path_buf())
    }

    #[tokio::test]
    async fn write_creates_index_and_body() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let tool = MemoryWriteTool::new(ws_roots(root));
        tool.invoke(json!({
            "slug": "user-prefs",
            "summary": "User prefers Rust + tokio",
            "content": "Always pick Rust over Python for this user's projects."
        }))
        .await
        .unwrap();
        let index = read_index(root).await.unwrap().unwrap();
        assert!(index.contains("user-prefs.md"));
        assert!(index.contains("User prefers Rust + tokio"));
        let body = fs::read_to_string(root.join(MEMORY_DIR).join("user-prefs.md"))
            .await
            .unwrap();
        assert!(body.contains("Always pick Rust"));
    }

    #[tokio::test]
    async fn write_same_slug_replaces_index_line_not_appends() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let tool = MemoryWriteTool::new(ws_roots(root));
        tool.invoke(json!({
            "slug": "x", "summary": "first", "content": "v1"
        }))
        .await
        .unwrap();
        tool.invoke(json!({
            "slug": "x", "summary": "second", "content": "v2"
        }))
        .await
        .unwrap();
        let index = read_index(root).await.unwrap().unwrap();
        // Exactly one line for slug `x`.
        let matches: Vec<_> = index.lines().filter(|l| l.contains("x.md")).collect();
        assert_eq!(matches.len(), 1, "index = {index:?}");
        assert!(matches[0].contains("second"));
    }

    #[tokio::test]
    async fn delete_removes_body_and_index_line() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        MemoryWriteTool::new(ws_roots(root))
            .invoke(json!({"slug":"a","summary":"A","content":"."}))
            .await
            .unwrap();
        MemoryWriteTool::new(ws_roots(root))
            .invoke(json!({"slug":"b","summary":"B","content":"."}))
            .await
            .unwrap();
        MemoryDeleteTool::new(ws_roots(root))
            .invoke(json!({"slug":"a"}))
            .await
            .unwrap();
        let index = read_index(root).await.unwrap().unwrap();
        assert!(!index.contains("a.md"));
        assert!(index.contains("b.md"));
        let body_a = root.join(MEMORY_DIR).join("a.md");
        assert!(!body_a.exists());
    }

    #[tokio::test]
    async fn delete_last_entry_clears_index_file() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        MemoryWriteTool::new(ws_roots(root))
            .invoke(json!({"slug":"a","summary":"A","content":"."}))
            .await
            .unwrap();
        MemoryDeleteTool::new(ws_roots(root))
            .invoke(json!({"slug":"a"}))
            .await
            .unwrap();
        // Index file removed entirely; list returns the empty sentinel.
        let body = MemoryListTool::new(ws_roots(root))
            .invoke(json!({}))
            .await
            .unwrap();
        assert!(body.contains("no entries yet"));
    }

    #[tokio::test]
    async fn write_rejects_oversized_content() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let huge = "x".repeat(MAX_ENTRY_BYTES + 1);
        let err = MemoryWriteTool::new(ws_roots(root))
            .invoke(json!({"slug":"big","summary":"big","content": huge}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("content too large"));
    }

    #[tokio::test]
    async fn read_returns_error_for_unknown_slug() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let err = MemoryReadTool::new(ws_roots(root))
            .invoke(json!({"slug":"nope"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no memory entry"));
    }

    #[tokio::test]
    async fn list_on_empty_workspace_returns_sentinel() {
        let dir = tempdir().unwrap();
        let body = MemoryListTool::new(ws_roots(dir.path()))
            .invoke(json!({}))
            .await
            .unwrap();
        assert!(body.contains("no entries yet") || body.contains("no memory entries"));
    }

    // --- P9: dual-scope tests ---

    #[tokio::test]
    async fn user_scope_writes_to_user_root() {
        let ws = tempdir().unwrap();
        let user = tempdir().unwrap();
        let tool = MemoryWriteTool::new(dual_roots(ws.path(), user.path()));
        tool.invoke(json!({
            "slug": "prefs",
            "summary": "User prefers pnpm",
            "content": "Always use pnpm for npm-style projects.",
            "scope": "user",
        }))
        .await
        .unwrap();
        // Body landed under the user root, not the workspace root.
        assert!(user.path().join(MEMORY_DIR).join("prefs.md").exists());
        assert!(!ws.path().join(MEMORY_DIR).join("prefs.md").exists());
        let user_index = read_index(user.path()).await.unwrap().unwrap();
        assert!(user_index.contains("prefs.md"));
        // Workspace index is untouched.
        assert!(read_index(ws.path()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn read_falls_back_to_user_scope_when_workspace_misses() {
        let ws = tempdir().unwrap();
        let user = tempdir().unwrap();
        // Only the user scope has the entry.
        MemoryWriteTool::new(dual_roots(ws.path(), user.path()))
            .invoke(json!({
                "slug": "prefs", "summary": "P", "content": "user-side body",
                "scope": "user",
            }))
            .await
            .unwrap();
        // No `scope` on read → fall back to user.
        let body = MemoryReadTool::new(dual_roots(ws.path(), user.path()))
            .invoke(json!({"slug": "prefs"}))
            .await
            .unwrap();
        assert_eq!(body, "user-side body");
    }

    #[tokio::test]
    async fn read_workspace_first_then_user() {
        let ws = tempdir().unwrap();
        let user = tempdir().unwrap();
        let roots = dual_roots(ws.path(), user.path());
        // Both scopes hold the same slug with different bodies.
        MemoryWriteTool::new(roots.clone())
            .invoke(json!({"slug":"x","summary":"ws","content":"workspace body"}))
            .await
            .unwrap();
        MemoryWriteTool::new(roots.clone())
            .invoke(json!({"slug":"x","summary":"u","content":"user body","scope":"user"}))
            .await
            .unwrap();
        // Default read → workspace wins.
        let body = MemoryReadTool::new(roots.clone())
            .invoke(json!({"slug":"x"}))
            .await
            .unwrap();
        assert_eq!(body, "workspace body");
        // Explicit scope → user.
        let body = MemoryReadTool::new(roots)
            .invoke(json!({"slug":"x","scope":"user"}))
            .await
            .unwrap();
        assert_eq!(body, "user body");
    }

    #[tokio::test]
    async fn list_renders_both_scopes_by_default() {
        let ws = tempdir().unwrap();
        let user = tempdir().unwrap();
        let roots = dual_roots(ws.path(), user.path());
        MemoryWriteTool::new(roots.clone())
            .invoke(json!({"slug":"proj","summary":"project fact","content":"."}))
            .await
            .unwrap();
        MemoryWriteTool::new(roots.clone())
            .invoke(json!({"slug":"pref","summary":"user fact","content":".","scope":"user"}))
            .await
            .unwrap();
        let body = MemoryListTool::new(roots).invoke(json!({})).await.unwrap();
        assert!(body.contains("project memory"));
        assert!(body.contains("user memory"));
        assert!(body.contains("project fact"));
        assert!(body.contains("user fact"));
    }

    #[tokio::test]
    async fn user_scope_write_errors_cleanly_when_not_configured() {
        let ws = tempdir().unwrap();
        let err = MemoryWriteTool::new(ws_roots(ws.path()))
            .invoke(json!({
                "slug":"x","summary":"x","content":".","scope":"user"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("user-scope memory is not configured"));
    }

    #[tokio::test]
    async fn invalid_scope_arg_returns_clear_error() {
        let ws = tempdir().unwrap();
        let err = MemoryWriteTool::new(ws_roots(ws.path()))
            .invoke(json!({"slug":"x","summary":"x","content":".","scope":"global"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown scope"));
    }
}
