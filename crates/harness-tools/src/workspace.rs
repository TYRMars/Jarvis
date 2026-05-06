//! `workspace.context` — compact workspace overview.
//!
//! Returns a small JSON blob the model can use as its "first look" at
//! the repository it's working inside. Designed to keep token cost
//! tiny: no source-file contents, no recursive listing — only what
//! makes the difference between "I'm in repo X on branch Y, with
//! these manifests / instruction files" and "I have no idea where I
//! am".
//!
//! Output shape (stable):
//!
//! ```json
//! {
//!   "root": "/abs/path/to/workspace",
//!   "vcs": "git" | "none",
//!   "branch": "main",                 // omitted when vcs == "none"
//!   "dirty": true,                    // omitted when vcs == "none"
//!   "head": "34cd366",                // omitted when no commits / vcs == "none"
//!   "instructions": ["AGENTS.md", "CLAUDE.md", "README.md"],
//!   "manifest": ["Cargo.toml", "apps/jarvis-web/package.json"],
//!   "tools_root_top_level": ["apps", "crates", "docs", "Cargo.toml"]
//! }
//! ```
//!
//! Always-on, read-only — no approval gate. Discovery is bounded:
//! instructions and manifests are looked up via a small allowlist;
//! the top-level listing is one shallow `read_dir` capped at 64
//! entries. Path scoping reuses [`crate::sandbox::resolve_under`].

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Map, Value};
use tokio::process::Command;

const GIT_TIMEOUT_MS: u64 = 5_000;
const MAX_TOP_LEVEL_ENTRIES: usize = 64;

/// Filenames recognised as "instruction" docs the model should
/// probably read before doing anything serious. Order is the order
/// returned in the JSON output, so put the most agent-specific first.
const INSTRUCTION_FILES: &[&str] = &[
    "AGENTS.md",
    "JARVIS.md",
    "CLAUDE.md",
    "AGENT.md",
    ".jarvis/JARVIS.md",
    ".jarvis/AGENTS.md",
    "CONTRIBUTING.md",
    "README.md",
    "README",
];

/// Filenames recognised as project manifests. Looked up at the
/// root and inside one level of [`CONTAINER_DIRS`] (so monorepos
/// like `apps/jarvis-web/package.json` show up).
const MANIFEST_FILES: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "deno.json",
    "deno.jsonc",
    "mix.exs",
    "Package.swift",
    "pubspec.yaml",
];

/// Top-level directories that conventionally hold per-package
/// children (monorepo layout). Only these get a one-level deeper
/// scan for manifests; anything else is skipped to keep the walk
/// bounded.
const CONTAINER_DIRS: &[&str] = &["apps", "crates", "packages", "services", "modules", "libs"];

/// Directories we never enter regardless of the layout — they
/// either don't contain real source (`target/`, `dist/`,
/// `node_modules/`) or are noisy enough that listing them costs
/// more than the model gains (`.git/`, `.venv/`).
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".venv"];

/// Cap on total manifest entries returned. Prevents pathological
/// monorepos with hundreds of packages from blowing the response.
const MAX_MANIFESTS: usize = 24;

/// Claude Code-style project memory defaults. `MEMORY.md` is treated
/// as a compact index; durable facts live in sibling topic files.
pub const PROJECT_MEMORY_DIR: &str = ".jarvis/memory";
pub const PROJECT_MEMORY_ENTRYPOINT: &str = "MEMORY.md";
pub const PROJECT_MEMORY_MAX_ENTRYPOINT_LINES: usize = 200;
pub const PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES: usize = 25_000;

pub struct WorkspaceContextTool {
    root: PathBuf,
}

impl WorkspaceContextTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[async_trait]
impl Tool for WorkspaceContextTool {
    fn name(&self) -> &str {
        "workspace.context"
    }

    fn description(&self) -> &str {
        "Compact JSON snapshot of the current workspace: root path, \
         VCS state (branch / dirty / HEAD when git), agent instruction \
         files (AGENTS.md / CLAUDE.md / README.md), package manifests \
         (Cargo.toml / package.json / pyproject.toml / go.mod / …), and \
         a shallow top-level directory listing. Read-only, no source \
         file contents — call `fs.read` for those."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        // Keep the synchronous filesystem walk on a blocking thread.
        // Git work happens after, async via `tokio::process`.
        let local = tokio::task::spawn_blocking({
            let root = root.clone();
            move || gather_local(&root)
        })
        .await
        .map_err(|e| -> BoxError { format!("workspace task panicked: {e}").into() })??;

        let git = gather_git(&root).await;

        let mut out = Map::new();
        out.insert("root".into(), Value::String(local.root_display));
        match git {
            Some(g) => {
                out.insert("vcs".into(), Value::String("git".into()));
                if let Some(branch) = g.branch {
                    out.insert("branch".into(), Value::String(branch));
                }
                if let Some(head) = g.head {
                    out.insert("head".into(), Value::String(head));
                }
                out.insert("dirty".into(), Value::Bool(g.dirty));
            }
            None => {
                out.insert("vcs".into(), Value::String("none".into()));
            }
        }
        out.insert(
            "instructions".into(),
            Value::Array(local.instructions.into_iter().map(Value::String).collect()),
        );
        out.insert(
            "manifest".into(),
            Value::Array(local.manifests.into_iter().map(Value::String).collect()),
        );
        out.insert(
            "tools_root_top_level".into(),
            Value::Array(local.top_level.into_iter().map(Value::String).collect()),
        );

        serde_json::to_string_pretty(&Value::Object(out))
            .map_err(|e| -> BoxError { format!("serialize workspace.context: {e}").into() })
    }
}

struct Local {
    root_display: String,
    instructions: Vec<String>,
    manifests: Vec<String>,
    top_level: Vec<String>,
}

fn gather_local(root: &Path) -> Result<Local, BoxError> {
    // Canonicalise so the model sees a stable absolute path even if
    // we were started with `--workspace .`. If canonicalisation fails
    // (unlikely outside of broken symlinks), fall back to the raw
    // path so the tool still produces *some* answer.
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let root_display = canonical.display().to_string();

    // Instructions: simple existence check at the root.
    let mut instructions = Vec::new();
    for name in INSTRUCTION_FILES {
        if canonical.join(name).is_file() {
            instructions.push((*name).to_string());
        }
    }

    // Manifests: root + one level inside CONTAINER_DIRS. Always
    // walk both — monorepos commonly have a workspace manifest at
    // root AND per-package manifests in `apps/<x>/`, `crates/<x>/`
    // etc., and the model gains from seeing both.
    let mut manifests = Vec::new();
    for name in MANIFEST_FILES {
        if canonical.join(name).is_file() {
            manifests.push((*name).to_string());
        }
    }
    'outer: for container in CONTAINER_DIRS {
        let cdir = canonical.join(container);
        if !cdir.is_dir() {
            continue;
        }
        let inner = match std::fs::read_dir(&cdir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in inner.flatten().take(MAX_TOP_LEVEL_ENTRIES) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if SKIP_DIRS.contains(&name) || name.starts_with('.') {
                    continue;
                }
            }
            for m in MANIFEST_FILES {
                let candidate = path.join(m);
                if !candidate.is_file() {
                    continue;
                }
                if let Ok(rel) = candidate.strip_prefix(&canonical) {
                    manifests.push(rel.display().to_string());
                    if manifests.len() >= MAX_MANIFESTS {
                        break 'outer;
                    }
                    break;
                }
            }
        }
    }

    // Top-level entries (sorted, capped). Useful for the model to
    // know "there's an `apps/` and a `crates/` here" before picking
    // where to grep.
    let mut top_level: Vec<String> = match std::fs::read_dir(&canonical) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    return None;
                }
                Some(name)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    top_level.sort();
    top_level.truncate(MAX_TOP_LEVEL_ENTRIES);

    Ok(Local {
        root_display,
        instructions,
        manifests,
        top_level,
    })
}

struct GitInfo {
    branch: Option<String>,
    head: Option<String>,
    dirty: bool,
}

async fn gather_git(root: &Path) -> Option<GitInfo> {
    // Cheap probe: rev-parse --is-inside-work-tree. Anything other
    // than success → not a git workspace, skip the rest.
    let inside = run_git_capture(root, &["rev-parse", "--is-inside-work-tree"]).await;
    if !matches!(inside.as_deref().map(str::trim), Ok("true")) {
        return None;
    }

    let branch = run_git_capture(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");

    let head = run_git_capture(root, &["rev-parse", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let porcelain = run_git_capture(root, &["status", "--porcelain"])
        .await
        .unwrap_or_default();
    let dirty = !porcelain.trim().is_empty();

    Some(GitInfo {
        branch,
        head,
        dirty,
    })
}

async fn run_git_capture(root: &Path, args: &[&str]) -> Result<String, BoxError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| -> BoxError { format!("spawn git: {e}").into() })?;
    let out = match tokio::time::timeout(
        Duration::from_millis(GIT_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("git wait: {e}").into()),
        Err(_) => return Err("git timed out".into()),
    };
    if !out.status.success() {
        return Err(format!(
            "git exited {}: {}",
            out.status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into()),
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Files that count as "agent instructions" — short docs that
/// describe project conventions for an LLM agent.
///
/// Deliberately excluded from system-prompt loading: `README.md`,
/// `CONTRIBUTING.md`. Those are
/// human-marketing / human-PR docs and including them in the
/// system prompt dilutes signal for the LLM. The model can still
/// read them on demand via `fs.read`.
///
/// Precedence mirrors Claude Code's project/local split, but stays
/// workspace-scoped until Jarvis has a trust UI for global files:
///
/// - project root: `AGENTS.md`, `JARVIS.md`, `CLAUDE.md`, `AGENT.md`
/// - project config dir: `.jarvis/JARVIS.md` and aliases
/// - local rules: `.jarvis/rules/*.md`
const ROOT_INSTRUCTION_FILES_TO_LOAD: &[&str] =
    &["AGENTS.md", "JARVIS.md", "CLAUDE.md", "AGENT.md"];
const JARVIS_INSTRUCTION_FILES_TO_LOAD: &[&str] = &[
    ".jarvis/JARVIS.md",
    ".jarvis/AGENTS.md",
    ".jarvis/CLAUDE.md",
    ".jarvis/AGENT.md",
];
const JARVIS_RULES_DIR: &str = ".jarvis/rules";
const MAX_INSTRUCTION_INCLUDE_DEPTH: usize = 5;

/// Read the workspace's agent-instruction files and concatenate them
/// for injection into the system prompt. Returns `None` when no
/// instruction files exist (caller should leave the prompt alone).
///
/// Output shape:
///
/// ```text
/// === project context: AGENTS.md ===
/// <file body>
///
/// === project context: CLAUDE.md ===
/// <file body>
/// ```
///
/// Combined output is capped at `max_bytes`; overflow is truncated
/// with a `[... truncated at N bytes ...]` marker so the model knows
/// not to trust missing-suffix references.
pub fn load_instructions(root: &std::path::Path, max_bytes: usize) -> Option<String> {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out = String::new();
    let mut seen = std::collections::HashSet::new();
    let mut sources = instruction_sources(&canonical);
    sources.extend(jarvis_rule_sources(&canonical));
    for rel in sources {
        let path = canonical.join(&rel);
        let Some(body) = read_instruction_file(&canonical, &path, &mut seen, 0) else {
            continue;
        };
        append_instruction_section(&mut out, &rel, &body);
        if out.len() >= max_bytes {
            break;
        }
    }
    if out.is_empty() {
        return None;
    }
    if out.len() > max_bytes {
        // Trim on a UTF-8 boundary.
        let cut = out
            .char_indices()
            .take_while(|(i, _)| *i < max_bytes)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        out.truncate(cut);
        out.push_str(&format!(
            "\n\n[... project context truncated at {max_bytes} bytes ...]\n"
        ));
    }
    Some(out)
}

fn instruction_sources(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for name in ROOT_INSTRUCTION_FILES_TO_LOAD {
        if root.join(name).is_file() {
            out.push((*name).to_string());
        }
    }
    for name in JARVIS_INSTRUCTION_FILES_TO_LOAD {
        if root.join(name).is_file() {
            out.push((*name).to_string());
        }
    }
    out
}

fn jarvis_rule_sources(root: &Path) -> Vec<String> {
    let rules_dir = root.join(JARVIS_RULES_DIR);
    let Ok(rd) = std::fs::read_dir(&rules_dir) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                rows.push(format!("{JARVIS_RULES_DIR}/{name}"));
            }
        }
    }
    rows.sort();
    rows
}

fn append_instruction_section(out: &mut String, rel: &str, body: &str) {
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("=== project context: {rel} ===\n"));
    out.push_str(body.trim_end());
    out.push('\n');
}

fn read_instruction_file(
    root: &Path,
    path: &Path,
    seen: &mut std::collections::HashSet<PathBuf>,
    depth: usize,
) -> Option<String> {
    if depth >= MAX_INSTRUCTION_INCLUDE_DEPTH {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    if !is_under(&canonical, root) {
        return None;
    }
    if !seen.insert(canonical.clone()) {
        return None;
    }
    let body = std::fs::read_to_string(&canonical).ok()?;
    Some(expand_instruction_includes(
        root, &canonical, &body, seen, depth,
    ))
}

fn expand_instruction_includes(
    root: &Path,
    current: &Path,
    body: &str,
    seen: &mut std::collections::HashSet<PathBuf>,
    depth: usize,
) -> String {
    let parent = current.parent().unwrap_or(root);
    let mut out = String::new();
    for line in body.lines() {
        if let Some(include) = parse_include_line(line) {
            let target = parent.join(include);
            if let Some(included) = read_instruction_file(root, &target, seen, depth + 1) {
                out.push_str(&format!(
                    "\n\n--- begin include: {include} ---\n{included}\n--- end include: {include} ---\n\n"
                ));
            } else {
                out.push_str(line);
                out.push('\n');
            }
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn parse_include_line(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("@include ")?;
    let rest = rest.trim().trim_matches('"').trim_matches('\'');
    if rest.is_empty() || rest.starts_with('/') || rest.split('/').any(|part| part == "..") {
        return None;
    }
    Some(rest)
}

fn is_under(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// Build the file-based project memory prompt, modelled after Claude
/// Code's `MEMORY.md` entrypoint design:
///
/// - `<memory_dir>/MEMORY.md` is a small always-loaded index;
/// - each durable memory gets its own markdown topic file;
/// - the prompt tells the model what *not* to save so memory doesn't
///   become a stale copy of the repo.
///
/// The directory is created when `ensure_dir` is true. Callers can use
/// `ensure_dir=false` to load an existing memory dir without mutating the
/// workspace.
pub fn load_project_memory(
    root: &std::path::Path,
    memory_dir: &std::path::Path,
    max_bytes: usize,
    ensure_dir: bool,
) -> Option<String> {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let dir = if memory_dir.is_absolute() {
        memory_dir.to_path_buf()
    } else {
        root.join(memory_dir)
    };

    if ensure_dir && ensure_private_dir(&dir).is_err() {
        return None;
    }
    if !ensure_dir && !dir.is_dir() {
        return None;
    }

    let entrypoint = dir.join(PROJECT_MEMORY_ENTRYPOINT);
    let entrypoint_content = std::fs::read_to_string(&entrypoint).unwrap_or_default();
    let truncated = truncate_memory_entrypoint(&entrypoint_content, max_bytes);
    let dir_display = dir.display();
    let mut out = String::new();
    out.push_str("=== project memory ===\n");
    out.push_str(&format!(
        "You have persistent, file-based project memory at `{dir_display}`.\n"
    ));
    out.push_str("Use it for durable user/project facts that are not obvious from the current repository state.\n");
    out.push_str("Do not save facts that can be recovered by reading code, git history, package manifests, or current docs.\n\n");
    out.push_str("How to save memories:\n");
    out.push_str(
        "- Store each memory in its own markdown file, named by topic rather than date.\n",
    );
    out.push_str("- Add frontmatter with `description` and `type` (`user`, `project`, `feedback`, or `reference`).\n");
    out.push_str(
        "- Keep `MEMORY.md` as a concise index only: `- [Title](topic.md) — one-line hook`.\n",
    );
    out.push_str("- Before writing, read `MEMORY.md` and update existing topic files instead of creating duplicates.\n");
    out.push_str("- Remove or correct memories that become stale.\n");
    out.push_str(
        "- The directory already exists when this prompt is loaded; write to it directly.\n\n",
    );
    out.push_str(&format!("## {PROJECT_MEMORY_ENTRYPOINT}\n\n"));
    if truncated.content.trim().is_empty() {
        out.push_str(&format!(
            "Your {PROJECT_MEMORY_ENTRYPOINT} is currently empty. When useful durable memories appear, create topic files and add index entries here.\n"
        ));
    } else {
        out.push_str(&truncated.content);
        out.push('\n');
    }
    Some(out)
}

struct MemoryEntrypoint {
    content: String,
}

fn truncate_memory_entrypoint(raw: &str, max_bytes: usize) -> MemoryEntrypoint {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return MemoryEntrypoint {
            content: String::new(),
        };
    }

    let lines: Vec<&str> = trimmed.lines().collect();
    let line_truncated = lines.len() > PROJECT_MEMORY_MAX_ENTRYPOINT_LINES;
    let byte_limit = max_bytes.min(PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES);
    let byte_truncated = trimmed.len() > byte_limit;

    if !line_truncated && !byte_truncated {
        return MemoryEntrypoint {
            content: trimmed.to_string(),
        };
    }

    let mut out = if line_truncated {
        lines[..PROJECT_MEMORY_MAX_ENTRYPOINT_LINES].join("\n")
    } else {
        trimmed.to_string()
    };

    if out.len() > byte_limit {
        let cut = out
            .char_indices()
            .take_while(|(i, _)| *i < byte_limit)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        out.truncate(cut);
    }
    out.push_str(&format!(
        "\n\n> WARNING: {PROJECT_MEMORY_ENTRYPOINT} was truncated while loading. Keep index entries concise and move details into topic files."
    ));
    MemoryEntrypoint { content: out }
}

fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    fn git_available() -> bool {
        StdCommand::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@e.com"]);
        run(&["config", "user.name", "T"]);
        run(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("README.md"), "hi\n").unwrap();
        run(&["add", "README.md"]);
        run(&["commit", "-q", "-m", "initial"]);
    }

    #[tokio::test]
    async fn non_git_returns_vcs_none() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        let tool = WorkspaceContextTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        assert_eq!(out["vcs"], "none");
        assert!(out["manifest"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "Cargo.toml"));
    }

    #[tokio::test]
    async fn git_repo_reports_branch_head_dirty() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        // Add an untracked file so dirty == true.
        std::fs::write(dir.path().join("scratch.txt"), "hi\n").unwrap();
        let tool = WorkspaceContextTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        assert_eq!(out["vcs"], "git");
        assert_eq!(out["branch"], "main");
        assert_eq!(out["dirty"], true);
        assert!(out["head"].is_string());
        assert!(out["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "README.md"));
    }

    #[tokio::test]
    async fn finds_manifest_one_level_deep() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("crates/foo")).unwrap();
        std::fs::write(dir.path().join("crates/foo/Cargo.toml"), "[package]\n").unwrap();
        let tool = WorkspaceContextTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        let manifests: Vec<&str> = out["manifest"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(
            manifests.iter().any(|m| m.contains("Cargo.toml")),
            "got: {manifests:?}"
        );
    }

    #[test]
    fn load_instructions_returns_none_when_no_files() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "marketing\n").unwrap();
        // README is deliberately not on the load list.
        assert!(load_instructions(dir.path(), 32 * 1024).is_none());
    }

    #[test]
    fn load_instructions_concatenates_in_priority_order() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "claude rules\n").unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "agent rules\n").unwrap();
        std::fs::create_dir_all(dir.path().join(".jarvis")).unwrap();
        std::fs::write(dir.path().join(".jarvis/JARVIS.md"), "jarvis rules\n").unwrap();
        let out = load_instructions(dir.path(), 32 * 1024).unwrap();
        // AGENTS.md must appear before CLAUDE.md regardless of which was written first.
        let agents_idx = out.find("=== project context: AGENTS.md ===").unwrap();
        let claude_idx = out.find("=== project context: CLAUDE.md ===").unwrap();
        let jarvis_idx = out
            .find("=== project context: .jarvis/JARVIS.md ===")
            .unwrap();
        assert!(agents_idx < claude_idx, "got: {out}");
        assert!(claude_idx < jarvis_idx, "got: {out}");
        assert!(out.contains("agent rules"), "got: {out}");
        assert!(out.contains("claude rules"), "got: {out}");
        assert!(out.contains("jarvis rules"), "got: {out}");
    }

    #[test]
    fn load_instructions_truncates_oversized_input() {
        let dir = tempdir().unwrap();
        let huge = "x".repeat(200_000);
        std::fs::write(dir.path().join("AGENTS.md"), huge).unwrap();
        let out = load_instructions(dir.path(), 1024).unwrap();
        assert!(out.len() <= 1024 + 100, "got len {}", out.len());
        assert!(
            out.contains("truncated"),
            "got: {}",
            &out[out.len().saturating_sub(120)..]
        );
    }

    #[test]
    fn load_instructions_reads_jarvis_rules_sorted() {
        let dir = tempdir().unwrap();
        let rules = dir.path().join(".jarvis/rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::write(rules.join("z-last.md"), "last\n").unwrap();
        std::fs::write(rules.join("a-first.md"), "first\n").unwrap();
        let out = load_instructions(dir.path(), 32 * 1024).unwrap();
        let first_idx = out
            .find("=== project context: .jarvis/rules/a-first.md ===")
            .unwrap();
        let last_idx = out
            .find("=== project context: .jarvis/rules/z-last.md ===")
            .unwrap();
        assert!(first_idx < last_idx, "got: {out}");
        assert!(out.contains("first"));
        assert!(out.contains("last"));
    }

    #[test]
    fn load_instructions_expands_relative_includes_once() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".jarvis")).unwrap();
        std::fs::write(
            dir.path().join(".jarvis/JARVIS.md"),
            "before\n@include snippets/style.md\nafter\n@include snippets/style.md\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join(".jarvis/snippets")).unwrap();
        std::fs::write(
            dir.path().join(".jarvis/snippets/style.md"),
            "style rules\n",
        )
        .unwrap();
        let out = load_instructions(dir.path(), 32 * 1024).unwrap();
        assert!(out.contains("--- begin include: snippets/style.md ---"));
        assert_eq!(out.matches("style rules").count(), 1, "got: {out}");
        assert!(out.contains("after"));
    }

    #[test]
    fn load_instructions_rejects_parent_directory_include() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".jarvis")).unwrap();
        std::fs::write(
            dir.path().join(".jarvis/JARVIS.md"),
            "@include ../secret.md\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("secret.md"), "do not inject\n").unwrap();
        let out = load_instructions(dir.path(), 32 * 1024).unwrap();
        assert!(!out.contains("do not inject"), "got: {out}");
        assert!(out.contains("@include ../secret.md"), "got: {out}");
    }

    #[test]
    fn project_memory_prompt_uses_empty_index_when_enabled() {
        let dir = tempdir().unwrap();
        let out = load_project_memory(
            dir.path(),
            Path::new(PROJECT_MEMORY_DIR),
            PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES,
            true,
        )
        .unwrap();
        assert!(dir.path().join(PROJECT_MEMORY_DIR).is_dir());
        assert!(out.contains("=== project memory ==="));
        assert!(out.contains("MEMORY.md is currently empty"));
        assert!(out.contains("Store each memory in its own markdown file"));
    }

    #[test]
    fn project_memory_auto_mode_requires_existing_dir() {
        let dir = tempdir().unwrap();
        let out = load_project_memory(
            dir.path(),
            Path::new(PROJECT_MEMORY_DIR),
            PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES,
            false,
        );
        assert!(out.is_none());
        assert!(!dir.path().join(PROJECT_MEMORY_DIR).exists());
    }

    #[test]
    fn project_memory_loads_and_truncates_index() {
        let dir = tempdir().unwrap();
        let mem = dir.path().join(PROJECT_MEMORY_DIR);
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(
            mem.join(PROJECT_MEMORY_ENTRYPOINT),
            format!("- [Useful](useful.md) — {}\n", "x".repeat(2000)),
        )
        .unwrap();
        let out =
            load_project_memory(dir.path(), Path::new(PROJECT_MEMORY_DIR), 512, false).unwrap();
        assert!(out.contains("[Useful](useful.md)"));
        assert!(out.contains("was truncated"));
        assert!(out.len() < 4_000, "got len {}", out.len());
    }

    #[tokio::test]
    async fn top_level_listing_skips_dotfiles_and_caps() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("apps")).unwrap();
        std::fs::create_dir(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        let tool = WorkspaceContextTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        let top: Vec<&str> = out["tools_root_top_level"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(top.contains(&"apps"));
        assert!(top.contains(&"Cargo.toml"));
        assert!(!top.iter().any(|s| s.starts_with('.')));
    }
}
