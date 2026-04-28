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
    "CLAUDE.md",
    "AGENT.md",
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
        let root = self.root.clone();
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
/// describe project conventions for an LLM agent. Loaded in
/// priority order: the first match wins for the dedup, but every
/// matching file is still concatenated so a project that has both
/// `AGENTS.md` (vendor-neutral) and `CLAUDE.md` (Claude-specific)
/// gets both.
///
/// Deliberately excluded: `README.md`, `CONTRIBUTING.md`. Those are
/// human-marketing / human-PR docs and including them in the
/// system prompt dilutes signal for the LLM. The model can still
/// read them on demand via `fs.read`.
const INSTRUCTION_FILES_TO_LOAD: &[&str] = &["AGENTS.md", "CLAUDE.md", "AGENT.md"];

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
    let mut any = false;
    for name in INSTRUCTION_FILES_TO_LOAD {
        let path = canonical.join(name);
        let body = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        any = true;
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("=== project context: {name} ===\n"));
        out.push_str(body.trim_end());
        out.push('\n');
        if out.len() >= max_bytes {
            break;
        }
    }
    if !any {
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
        let out = load_instructions(dir.path(), 32 * 1024).unwrap();
        // AGENTS.md must appear before CLAUDE.md regardless of which was written first.
        let agents_idx = out.find("=== project context: AGENTS.md ===").unwrap();
        let claude_idx = out.find("=== project context: CLAUDE.md ===").unwrap();
        assert!(agents_idx < claude_idx, "got: {out}");
        assert!(out.contains("agent rules"), "got: {out}");
        assert!(out.contains("claude rules"), "got: {out}");
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
