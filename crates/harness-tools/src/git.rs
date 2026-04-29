//! Git tools — read-only by default, write toolset opt-in.
//!
//! Each tool spawns the host's `git` binary with a fixed first
//! argument (the subcommand) and a small set of carefully-chosen
//! flags, then returns the captured stdout. They are deliberately
//! split per-subcommand so the JSON schema can describe exactly the
//! arguments each one understands — much easier for the model than a
//! single `git` tool with a free-form `args` array.
//!
//! Two groups:
//!
//! - **Read-only** ([`GitStatusTool`], [`GitDiffTool`], [`GitLogTool`],
//!   [`GitShowTool`]) — never call anything that mutates the working
//!   tree, the index, refs, or remotes. Always-on, no approval gate.
//! - **Write** ([`GitAddTool`], [`GitCommitTool`], [`GitMergeTool`]) —
//!   stage / commit / merge inside the workspace. Off by default
//!   (gated by [`crate::BuiltinsConfig::enable_git_write`] /
//!   `JARVIS_ENABLE_GIT_WRITE`). All three are approval-gated; each
//!   call surfaces an `ApprovalRequest` event before the side effect
//!   lands. None of them ever push, fetch, or touch remotes — those
//!   stay out of the toolset by design.
//!
//! The cwd is always the configured tool root, so `git` resolves to
//! that repo. If the root isn't a git working tree the tool returns a
//! plain "(not a git repository)" string instead of an error so the
//! model can adapt.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::process::Command;

const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

async fn run_git(
    root: &std::path::Path,
    args: &[&str],
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<String, BoxError> {
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
        .map_err(|e| -> BoxError { format!("failed to spawn git: {e}").into() })?;

    let output =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("git process error: {e}").into()),
            Err(_) => return Err(format!("git timed out after {timeout_ms} ms").into()),
        };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Treat "not a git repository" as a soft failure — the model
        // can decide whether that matters. Anything else is a real
        // error that should surface as a tool error.
        if stderr.contains("not a git repository") || stderr.contains("Not a git repository") {
            return Ok("(not a git repository)".to_string());
        }
        return Err(format!(
            "git exited {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into()),
            stderr.trim()
        )
        .into());
    }

    let mut s = String::from_utf8_lossy(&output.stdout).into_owned();
    if s.len() > max_bytes {
        let cut = s
            .char_indices()
            .take_while(|(i, _)| *i < max_bytes)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        s.truncate(cut);
        s.push_str(&format!("\n[... truncated at {max_bytes} bytes ...]\n"));
    }
    Ok(s)
}

/// `git status` (porcelain v1) — short, machine-friendly.
pub struct GitStatusTool {
    root: PathBuf,
    max_bytes: usize,
    timeout_ms: u64,
}

impl GitStatusTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitStatusTool {
    fn name(&self) -> &str {
        "git.status"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Show working-tree status of the repository at the tool root. \
         Uses `git status --porcelain=v1 --branch` so output is stable and \
         compact: each changed file appears on its own line prefixed with \
         a two-letter index/worktree status code."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        run_git(
            &root,
            &["status", "--porcelain=v1", "--branch"],
            self.max_bytes,
            self.timeout_ms,
        )
        .await
    }
}

/// `git diff` — unstaged, staged, or between revisions.
pub struct GitDiffTool {
    root: PathBuf,
    max_bytes: usize,
    timeout_ms: u64,
}

impl GitDiffTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn arg_opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// Reject any argument that could be interpreted as an option (starts with
/// `-`) or that contains shell metacharacters / null bytes. Refs / paths
/// in real-world use never need any of these.
fn check_safe_arg(name: &str, value: &str) -> Result<(), BoxError> {
    if value.is_empty() {
        return Err(format!("`{name}` must not be empty").into());
    }
    if value.starts_with('-') {
        return Err(format!("`{name}` must not start with `-`").into());
    }
    if value.contains('\0') || value.contains('\n') {
        return Err(format!("`{name}` contains forbidden characters").into());
    }
    Ok(())
}

#[async_trait]
impl Tool for GitDiffTool {
    fn name(&self) -> &str {
        "git.diff"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Show diffs in the repository at the tool root. By default returns \
         the unstaged worktree diff. Set `staged: true` for the index diff. \
         Provide `from` (and optionally `to`) to diff between revisions \
         (`from..to`, or `from` alone meaning `from..HEAD`). Optional \
         `path` narrows the diff to a single file or directory."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "staged": {
                    "type": "boolean",
                    "description": "If true, show the staged (index) diff. Mutually exclusive with `from`/`to`."
                },
                "from": {
                    "type": "string",
                    "description": "Base revision (sha, branch, or tag). When set, diffs `from..to` (or `from..HEAD` if `to` omitted)."
                },
                "to": {
                    "type": "string",
                    "description": "Target revision. Only used when `from` is set."
                },
                "path": {
                    "type": "string",
                    "description": "Optional path to scope the diff to (relative to the repo root)."
                },
                "stat_only": {
                    "type": "boolean",
                    "description": "If true, return `--stat` summary instead of the full patch."
                }
            }
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let staged = arg_bool(&args, "staged");
        let stat_only = arg_bool(&args, "stat_only");
        let from = arg_opt_str(&args, "from");
        let to = arg_opt_str(&args, "to");
        let path = arg_opt_str(&args, "path");

        if staged && from.is_some() {
            return Err("`staged` and `from` are mutually exclusive".into());
        }
        if to.is_some() && from.is_none() {
            return Err("`to` requires `from`".into());
        }

        let mut argv: Vec<String> = vec!["diff".into()];
        if stat_only {
            argv.push("--stat".into());
        }
        if staged {
            argv.push("--cached".into());
        }
        let range_storage;
        if let Some(f) = from {
            check_safe_arg("from", f)?;
            range_storage = match to {
                Some(t) => {
                    check_safe_arg("to", t)?;
                    format!("{f}..{t}")
                }
                None => format!("{f}..HEAD"),
            };
            argv.push(range_storage);
        }
        if let Some(p) = path {
            check_safe_arg("path", p)?;
            argv.push("--".into());
            argv.push(p.into());
        }

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let out = run_git(&root, &argv_refs, self.max_bytes, self.timeout_ms).await?;
        if out.is_empty() {
            return Ok("(no changes)".to_string());
        }
        Ok(out)
    }
}

/// `git log` — recent commit list.
pub struct GitLogTool {
    root: PathBuf,
    max_bytes: usize,
    timeout_ms: u64,
}

impl GitLogTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitLogTool {
    fn name(&self) -> &str {
        "git.log"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Recent commit history of the repo at the tool root. Returns one \
         commit per line in `<short-sha> <subject>` form by default. Set \
         `format: \"full\"` for author + date + body. Optional `limit` \
         (default 20, hard cap 200), `revision` (branch / sha / range), \
         and `path` (file or directory) narrow the result."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200,
                    "description": "Number of commits to return. Default 20."
                },
                "revision": {
                    "type": "string",
                    "description": "Branch, sha, or range to walk (e.g. `main`, `abc123..HEAD`)."
                },
                "path": {
                    "type": "string",
                    "description": "Optional path to filter commits by (file or directory)."
                },
                "format": {
                    "type": "string",
                    "enum": ["short", "full"],
                    "description": "`short` (default): one-line per commit. `full`: include author/date/body."
                }
            }
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .min(200);
        let revision = arg_opt_str(&args, "revision");
        let path = arg_opt_str(&args, "path");
        let format = arg_opt_str(&args, "format").unwrap_or("short");

        let mut argv: Vec<String> = vec!["log".into()];
        let limit_arg = format!("-n{limit}");
        argv.push(limit_arg);
        match format {
            "short" => {
                argv.push("--pretty=format:%h %s".into());
            }
            "full" => {
                argv.push("--pretty=format:%h %an <%ae> %ad%n  %s%n%b%n".into());
                argv.push("--date=iso-strict".into());
            }
            other => {
                return Err(format!("unknown `format`: {other}").into());
            }
        }
        if let Some(r) = revision {
            check_safe_arg("revision", r)?;
            argv.push(r.into());
        }
        if let Some(p) = path {
            check_safe_arg("path", p)?;
            argv.push("--".into());
            argv.push(p.into());
        }

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        run_git(&root, &argv_refs, self.max_bytes, self.timeout_ms).await
    }
}

/// `git show` — a single commit's metadata + diff (or just metadata).
pub struct GitShowTool {
    root: PathBuf,
    max_bytes: usize,
    timeout_ms: u64,
}

impl GitShowTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitShowTool {
    fn name(&self) -> &str {
        "git.show"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Show a single commit (metadata + patch) by sha or ref. Set \
         `metadata_only: true` to skip the diff and return only \
         author / date / subject / body. Optional `path` scopes the diff \
         to a single file."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "revision": {
                    "type": "string",
                    "description": "Commit sha, branch tip, tag, or `HEAD~N`."
                },
                "metadata_only": {
                    "type": "boolean",
                    "description": "If true, omit the patch body."
                },
                "path": {
                    "type": "string",
                    "description": "Optional path to scope the diff to."
                }
            },
            "required": ["revision"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let revision = args
            .get("revision")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `revision` argument".into() })?;
        check_safe_arg("revision", revision)?;
        let metadata_only = arg_bool(&args, "metadata_only");
        let path = arg_opt_str(&args, "path");

        let mut argv: Vec<String> = vec!["show".into()];
        if metadata_only {
            argv.push("--no-patch".into());
        }
        argv.push("--pretty=fuller".into());
        argv.push(revision.into());
        if let Some(p) = path {
            check_safe_arg("path", p)?;
            argv.push("--".into());
            argv.push(p.into());
        }

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        run_git(&root, &argv_refs, self.max_bytes, self.timeout_ms).await
    }
}

// ============================================================
// Write tools (opt-in via BuiltinsConfig::enable_git_write)
// ============================================================

/// `git add` — stage paths or `-A` for everything.
///
/// Approval-gated. Refuses to take any path starting with `-` or
/// containing null/newline bytes; the same `check_safe_arg` guard
/// the read-only tools use against option-injection.
pub struct GitAddTool {
    root: PathBuf,
    timeout_ms: u64,
}

impl GitAddTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitAddTool {
    fn name(&self) -> &str {
        "git.add"
    }

    fn description(&self) -> &str {
        "Stage changes for the next commit. Pass `paths: [...]` for \
         specific files / dirs (relative to the repo root), or `all: \
         true` to stage every tracked + untracked change (`git add -A`). \
         Approval-gated."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Files / directories to stage. Relative to the repo root."
                },
                "all": {
                    "type": "boolean",
                    "description": "Stage every change (`git add -A`). Mutually exclusive with `paths`."
                }
            }
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let all = arg_bool(&args, "all");
        let paths: Vec<String> = args
            .get("paths")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        if all && !paths.is_empty() {
            return Err("`all` and `paths` are mutually exclusive".into());
        }
        if !all && paths.is_empty() {
            return Err("must pass `paths` or `all: true`".into());
        }

        let mut argv: Vec<String> = vec!["add".into()];
        if all {
            argv.push("-A".into());
        } else {
            // `--` terminates option parsing so a path that somehow
            // starts with `-` (we already reject it) still wouldn't be
            // treated as a flag.
            argv.push("--".into());
            for p in &paths {
                check_safe_arg("paths", p)?;
                argv.push(p.clone());
            }
        }

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let _ = run_git(&root, &argv_refs, DEFAULT_MAX_BYTES, self.timeout_ms).await?;
        // `git add` is silent on success; surface a friendly status.
        let summary = run_git(
            &root,
            &["status", "--porcelain=v1"],
            DEFAULT_MAX_BYTES,
            self.timeout_ms,
        )
        .await
        .unwrap_or_default();
        if summary.trim().is_empty() {
            Ok("(staged; working tree clean)".to_string())
        } else {
            Ok(format!("staged. status:\n{summary}"))
        }
    }
}

/// `git commit -m <message>` — commit the current index.
///
/// Approval-gated. Always passes `--no-gpg-sign` (so an unset signing
/// key doesn't fail the agent's autonomous commit) and `--no-verify`
/// is **never** passed — pre-commit hooks remain in force, matching
/// the operator's local defaults. The `--allow-empty-message` /
/// `--amend` flags are not exposed; the model must compose a real
/// message and create a fresh commit.
pub struct GitCommitTool {
    root: PathBuf,
    timeout_ms: u64,
}

impl GitCommitTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitCommitTool {
    fn name(&self) -> &str {
        "git.commit"
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        // First line of the commit message — what the audit log /
        // approval card will surface as "what is the agent committing".
        args.get("message")
            .and_then(Value::as_str)
            .and_then(|m| m.lines().next())
            .map(str::to_string)
    }

    fn description(&self) -> &str {
        "Commit the staged index with `message`. Set `all: true` to \
         also stage every modified-tracked file first (`git commit -a`); \
         untracked files still need an explicit `git.add` call. \
         Approval-gated. Pre-commit hooks run as configured by the \
         operator (we never pass `--no-verify`)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "Commit message body. May contain newlines."
                },
                "all": {
                    "type": "boolean",
                    "description": "Stage every modified tracked file before committing (`git commit -a`)."
                }
            },
            "required": ["message"]
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let message = args
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `message` argument".into() })?;
        if message.trim().is_empty() {
            return Err("`message` must not be empty".into());
        }
        if message.contains('\0') {
            return Err("`message` contains null bytes".into());
        }

        let all = arg_bool(&args, "all");

        let mut argv: Vec<String> = vec!["commit".into(), "--no-gpg-sign".into()];
        if all {
            argv.push("-a".into());
        }
        argv.push("-m".into());
        argv.push(message.to_string());

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let _ = run_git(&root, &argv_refs, DEFAULT_MAX_BYTES, self.timeout_ms).await?;
        // Surface the new HEAD so the model can tell the user.
        let head = run_git(
            &root,
            &["log", "-n1", "--pretty=format:%h %s"],
            DEFAULT_MAX_BYTES,
            self.timeout_ms,
        )
        .await
        .unwrap_or_default();
        if head.is_empty() {
            Ok("committed.".to_string())
        } else {
            Ok(format!("committed: {head}"))
        }
    }
}

/// `git merge <branch>` — merge a branch into the current HEAD,
/// or `git merge --abort` to back out an in-progress merge.
///
/// Approval-gated. Conflicts are reported back to the model (with the
/// list of conflicting paths) rather than left silently in the working
/// tree — the model can then decide whether to call `git.merge` with
/// `abort: true` or hand off to the user.
pub struct GitMergeTool {
    root: PathBuf,
    timeout_ms: u64,
}

impl GitMergeTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

#[async_trait]
impl Tool for GitMergeTool {
    fn name(&self) -> &str {
        "git.merge"
    }

    fn description(&self) -> &str {
        "Merge `branch` into the current HEAD. Set `no_ff: true` to \
         force a merge commit even when fast-forward is possible. Pass \
         `abort: true` (no other args) to back out an in-progress merge \
         (`git merge --abort`). Conflicting paths come back in the \
         result so the model can decide between aborting and asking the \
         user. Approval-gated. Never pushes."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "branch": {
                    "type": "string",
                    "description": "Branch / sha / tag to merge into HEAD."
                },
                "no_ff": {
                    "type": "boolean",
                    "description": "Force a merge commit even when fast-forward is possible."
                },
                "message": {
                    "type": "string",
                    "description": "Override the merge commit message."
                },
                "abort": {
                    "type": "boolean",
                    "description": "Run `git merge --abort` instead. Mutually exclusive with `branch`."
                }
            }
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let root = harness_core::active_workspace_or(&self.root);
        let abort = arg_bool(&args, "abort");
        let branch = arg_opt_str(&args, "branch");
        let no_ff = arg_bool(&args, "no_ff");
        let message = arg_opt_str(&args, "message");

        if abort {
            if branch.is_some() || no_ff || message.is_some() {
                return Err(
                    "`abort` is mutually exclusive with branch / no_ff / message".into(),
                );
            }
            return run_git(
                &root,
                &["merge", "--abort"],
                DEFAULT_MAX_BYTES,
                self.timeout_ms,
            )
            .await
            .map(|s| if s.is_empty() { "merge aborted.".to_string() } else { s });
        }

        let branch = branch.ok_or_else(|| -> BoxError { "missing `branch` argument".into() })?;
        check_safe_arg("branch", branch)?;
        if let Some(m) = message {
            if m.contains('\0') {
                return Err("`message` contains null bytes".into());
            }
        }

        let mut argv: Vec<String> = vec!["merge".into(), "--no-gpg-sign".into()];
        if no_ff {
            argv.push("--no-ff".into());
        }
        if let Some(m) = message {
            argv.push("-m".into());
            argv.push(m.to_string());
        }
        argv.push(branch.to_string());

        let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let result = run_git(&root, &argv_refs, DEFAULT_MAX_BYTES, self.timeout_ms).await;
        // `git merge` writes the "CONFLICT" lines to STDOUT, not
        // stderr — so a successful invocation that detected conflicts
        // surfaces here either as `Ok(stdout-with-CONFLICT-text)` or
        // (more commonly) as `Err("git exited 1: ")` when stderr is
        // empty. Either way the truth is in the working tree, so
        // probe it directly for any unmerged paths.
        let conflicts = run_git(
            &root,
            &["diff", "--name-only", "--diff-filter=U"],
            DEFAULT_MAX_BYTES,
            self.timeout_ms,
        )
        .await
        .unwrap_or_default();
        let conflicts = conflicts.trim();
        if !conflicts.is_empty() {
            return Ok(format!(
                "merge conflict — call `git.merge` with `abort: true` to back out, \
                 or have the user resolve. Conflicting paths:\n{conflicts}"
            ));
        }
        match result {
            Ok(out) => {
                if out.trim().is_empty() {
                    Ok(format!("merged `{branch}` (fast-forward)."))
                } else {
                    Ok(out)
                }
            }
            Err(e) => Err(e),
        }
    }
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

    fn init_repo(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run(&["add", "README.md"]);
        run(&["commit", "-q", "-m", "initial"]);
    }

    #[tokio::test]
    async fn status_shows_clean_then_dirty() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let tool = GitStatusTool::new(dir.path());
        let clean = tool.invoke(json!({})).await.unwrap();
        assert!(clean.contains("## main"), "got: {clean}");

        std::fs::write(dir.path().join("new.txt"), "hi\n").unwrap();
        let dirty = tool.invoke(json!({})).await.unwrap();
        assert!(dirty.contains("new.txt"), "got: {dirty}");
    }

    #[tokio::test]
    async fn diff_default_returns_no_changes_for_clean_tree() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let tool = GitDiffTool::new(dir.path());
        let out = tool.invoke(json!({})).await.unwrap();
        assert!(out.contains("no changes"), "got: {out}");
    }

    #[tokio::test]
    async fn diff_unstaged_shows_worktree_changes() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("README.md"), "hello world\n").unwrap();
        let tool = GitDiffTool::new(dir.path());
        let out = tool.invoke(json!({})).await.unwrap();
        assert!(out.contains("hello world"), "got: {out}");
        assert!(out.contains("README.md"), "got: {out}");
    }

    #[tokio::test]
    async fn diff_rejects_dash_arg() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let tool = GitDiffTool::new(dir.path());
        let err = tool
            .invoke(json!({ "from": "--exec=evil" }))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("must not start with `-`"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn log_short_format_returns_one_line() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let tool = GitLogTool::new(dir.path());
        let out = tool.invoke(json!({ "limit": 5 })).await.unwrap();
        assert!(out.contains("initial"), "got: {out}");
        assert_eq!(out.lines().count(), 1, "got: {out}");
    }

    #[tokio::test]
    async fn show_metadata_only_omits_patch() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let tool = GitShowTool::new(dir.path());
        let out = tool
            .invoke(json!({ "revision": "HEAD", "metadata_only": true }))
            .await
            .unwrap();
        assert!(out.contains("initial"), "got: {out}");
        assert!(!out.contains("+hello"), "metadata_only leaked patch: {out}");
    }

    #[tokio::test]
    async fn not_a_repo_returns_soft_message() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        let tool = GitStatusTool::new(dir.path());
        let out = tool.invoke(json!({})).await.unwrap();
        assert!(out.contains("not a git repository"), "got: {out}");
    }

    // -- write tools ----------------------------------------------------

    #[tokio::test]
    async fn add_then_commit_round_trip() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("note.txt"), "hi\n").unwrap();

        let add = GitAddTool::new(dir.path());
        let added = add
            .invoke(json!({ "paths": ["note.txt"] }))
            .await
            .unwrap();
        assert!(added.contains("note.txt"), "got: {added}");

        let commit = GitCommitTool::new(dir.path());
        let res = commit
            .invoke(json!({ "message": "add note" }))
            .await
            .unwrap();
        assert!(res.starts_with("committed:"), "got: {res}");
        assert!(res.contains("add note"), "got: {res}");
    }

    #[tokio::test]
    async fn add_all_stages_everything() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();

        let add = GitAddTool::new(dir.path());
        let added = add.invoke(json!({ "all": true })).await.unwrap();
        assert!(added.contains("a.txt"), "got: {added}");
        assert!(added.contains("b.txt"), "got: {added}");
    }

    #[tokio::test]
    async fn add_rejects_dash_path() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let add = GitAddTool::new(dir.path());
        let err = add
            .invoke(json!({ "paths": ["--exec=evil"] }))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("must not start with `-`"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn commit_requires_message() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let commit = GitCommitTool::new(dir.path());
        let err = commit.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("missing `message`"), "got: {err}");

        let err = commit
            .invoke(json!({ "message": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must not be empty"), "got: {err}");
    }

    #[tokio::test]
    async fn commit_all_stages_and_commits_modified() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("README.md"), "second line\n").unwrap();

        let commit = GitCommitTool::new(dir.path());
        let res = commit
            .invoke(json!({ "message": "tweak readme", "all": true }))
            .await
            .unwrap();
        assert!(res.contains("tweak readme"), "got: {res}");
    }

    #[tokio::test]
    async fn merge_fast_forward_into_main() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        // Make a branch with one extra commit, then merge it back.
        let g = |args: &[&str]| {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        g(&["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("feat.txt"), "feat\n").unwrap();
        g(&["add", "feat.txt"]);
        g(&["commit", "-q", "-m", "feat: add feat.txt"]);
        g(&["checkout", "-q", "main"]);

        let merge = GitMergeTool::new(dir.path());
        let res = merge.invoke(json!({ "branch": "feat" })).await.unwrap();
        assert!(
            res.contains("Updating") || res.contains("fast-forward"),
            "got: {res}"
        );
    }

    #[tokio::test]
    async fn merge_conflict_returns_paths() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let g = |args: &[&str]| {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        // Two divergent edits to README.md.
        g(&["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("README.md"), "feat-side\n").unwrap();
        g(&["commit", "-q", "-am", "feat-side"]);
        g(&["checkout", "-q", "main"]);
        std::fs::write(dir.path().join("README.md"), "main-side\n").unwrap();
        g(&["commit", "-q", "-am", "main-side"]);

        let merge = GitMergeTool::new(dir.path());
        let res = merge.invoke(json!({ "branch": "feat" })).await.unwrap();
        assert!(res.contains("conflict"), "got: {res}");
        assert!(res.contains("README.md"), "got: {res}");

        // And `abort: true` should clean up.
        let aborted = merge.invoke(json!({ "abort": true })).await.unwrap();
        assert!(
            aborted.contains("aborted") || aborted.is_empty() || aborted.starts_with("merge"),
            "got: {aborted}"
        );
    }

    #[tokio::test]
    async fn merge_rejects_bad_branch() {
        if !git_available() {
            return;
        }
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let merge = GitMergeTool::new(dir.path());
        let err = merge
            .invoke(json!({ "branch": "--exec=evil" }))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("must not start with `-`"),
            "got: {err}"
        );
    }

    #[test]
    fn write_tools_are_approval_gated() {
        let dir = std::path::Path::new("/tmp/__no_repo");
        assert!(GitAddTool::new(dir).requires_approval());
        assert!(GitCommitTool::new(dir).requires_approval());
        assert!(GitMergeTool::new(dir).requires_approval());
    }
}
