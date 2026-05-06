//! Claude Code CLI sub-agent tool — L2 of the Claude Code SubAgent
//! integration.
//!
//! Spawns the official Anthropic Claude Code CLI (`claude -p`) as a child
//! process, pointed at the current session workspace, and returns the
//! agent's final answer to the calling Jarvis agent. Treated as a single
//! black-box invocation: no streaming, no nested approval, no multi-turn
//! protocol — for those, see L3
//! ([`docs/proposals/claude-code-subagent.zh-CN.md`](../../../docs/proposals/claude-code-subagent.zh-CN.md)).
//!
//! Approval, timeout, kill-on-drop, and workspace-path safety mirror
//! [`crate::codex::CodexRunTool`] one-for-one — see that module for the
//! shared rationale. The two tools are deliberately separate files so
//! their respective protocol / flag quirks can evolve independently.
//!
//! Intentionally **not** registered by default — opt in via
//! [`crate::BuiltinsConfig::enable_claude_code_run`].

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::process::Command;
use tracing::warn;

use crate::sandbox::resolve_under;

/// Default cap on captured stdout per invocation.
const DEFAULT_MAX_STDOUT_BYTES: usize = 64 * 1024;
/// Default cap on captured stderr surfaced in error reports.
const DEFAULT_MAX_STDERR_BYTES: usize = 4 * 1024;
/// Default per-invocation wall-clock timeout (30 minutes).
const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000;

/// Delegate a single self-contained task to the Claude Code CLI.
pub struct ClaudeCodeRunTool {
    root: PathBuf,
    binary: PathBuf,
    default_timeout_ms: u64,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    permission_mode: PermissionMode,
    model: Option<String>,
    allowed_tools: Vec<String>,
}

/// Claude Code's `--permission-mode` value passed through verbatim. We
/// keep the upstream naming (`acceptEdits` etc.) rather than re-mapping
/// to Jarvis's own permission-mode taxonomy because we want behaviour to
/// match the Claude Code docs the operator is reading.
///
/// See `docs/proposals/claude-code-subagent.zh-CN.md` §6 Q3 for why L2
/// defaults to `AcceptEdits` rather than reaching for
/// `BypassPermissions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// Claude Code prompts on every risky operation. Inappropriate for
    /// L2 because there's no stdin pipe to answer the prompts on, but
    /// included for completeness.
    Default,
    /// Auto-accept file edits; still prompts for shell. The L2 default —
    /// matches the design intent of "delegate a focused code change".
    AcceptEdits,
    /// Plan mode — read-only, produces a plan instead of editing.
    Plan,
    /// Bypass all Claude Code permission checks. Should be paired with
    /// strong host-side sandboxing (Jarvis Approver gate is still
    /// active) — never enable casually.
    BypassPermissions,
}

impl PermissionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

impl ClaudeCodeRunTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            binary: PathBuf::from("claude"),
            default_timeout_ms: DEFAULT_TIMEOUT_MS,
            max_stdout_bytes: DEFAULT_MAX_STDOUT_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            permission_mode: PermissionMode::AcceptEdits,
            model: None,
            allowed_tools: Vec::new(),
        }
    }

    pub fn with_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.binary = binary.into();
        self
    }

    pub fn with_default_timeout_ms(mut self, ms: u64) -> Self {
        self.default_timeout_ms = ms;
        self
    }

    pub fn with_max_stdout_bytes(mut self, n: usize) -> Self {
        self.max_stdout_bytes = n;
        self
    }

    pub fn with_max_stderr_bytes(mut self, n: usize) -> Self {
        self.max_stderr_bytes = n;
        self
    }

    pub fn with_permission_mode(mut self, mode: PermissionMode) -> Self {
        self.permission_mode = mode;
        self
    }

    /// Override the model passed to Claude Code via `--model`. `None`
    /// (the default) lets Claude Code pick from its own configuration.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Restrict Claude Code to the given tool whitelist via
    /// `--allowed-tools`. Empty (the default) means no restriction
    /// from Jarvis's side — Claude Code's own settings still apply.
    pub fn with_allowed_tools(mut self, tools: Vec<String>) -> Self {
        self.allowed_tools = tools;
        self
    }
}

#[async_trait]
impl Tool for ClaudeCodeRunTool {
    fn name(&self) -> &str {
        "claude_code.run"
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Exec
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("task")
            .and_then(Value::as_str)
            .map(|s| s.lines().next().unwrap_or(s).to_string())
    }

    fn description(&self) -> &str {
        "Delegate a self-contained task to the Claude Code CLI. Spawns \
         `claude -p` in the session workspace (or `workspace_subpath` \
         under it), waits for completion, and returns Claude Code's \
         final answer. Use for: focused code changes, well-specified \
         refactors, exploratory analysis. Do not use for: planning, \
         conversation, ambiguous tasks. Killed after `timeout_ms` \
         (default 30 minutes)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Self-contained task description with \
                                    acceptance criteria. The full prompt to \
                                    Claude Code."
                },
                "workspace_subpath": {
                    "type": "string",
                    "description": "Optional subdirectory under the tool root \
                                    to run Claude Code in. Relative; absolute \
                                    paths and `..` are rejected."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Wall-clock timeout in milliseconds. \
                                    Defaults to 1800000 (30 minutes)."
                }
            },
            "required": ["task"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let task = args
            .get("task")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `task` argument".into() })?;
        if task.trim().is_empty() {
            return Err("`task` must be non-empty".into());
        }

        let root = harness_core::active_workspace_or(&self.root);
        let cwd = match args.get("workspace_subpath").and_then(Value::as_str) {
            Some(rel) => resolve_under(&root, rel)?,
            None => root.clone(),
        };

        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(self.default_timeout_ms);

        let mut cmd = Command::new(&self.binary);
        cmd.arg("--permission-mode")
            .arg(self.permission_mode.as_str());
        if let Some(model) = &self.model {
            cmd.arg("--model").arg(model);
        }
        if !self.allowed_tools.is_empty() {
            // Claude Code accepts repeated `--allowed-tools` flags or a
            // single comma-separated value. The repeated form survives
            // tool names that themselves contain commas (MCP names) so
            // we use it.
            for tool in &self.allowed_tools {
                cmd.arg("--allowed-tools").arg(tool);
            }
        }
        // `-p` puts Claude Code in print/headless mode; the prompt is
        // the value. `--` guards against tasks starting with `-`.
        cmd.arg("-p").arg("--").arg(task);
        cmd.current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        let child = cmd.spawn().map_err(|e| -> BoxError {
            format!("failed to spawn `{}`: {e}", self.binary.display()).into()
        })?;

        let output =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
                .await
            {
                Ok(Ok(out)) => out,
                Ok(Err(e)) => return Err(format!("claude process error: {e}").into()),
                Err(_) => {
                    return Err(format!("claude timed out after {timeout_ms} ms").into());
                }
            };

        if !output.status.success() {
            let exit = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            let stderr_tail = truncate_utf8(&output.stderr, self.max_stderr_bytes);
            return Err(format!("claude exit={exit}: {stderr_tail}").into());
        }

        let stdout = truncate_utf8(&output.stdout, self.max_stdout_bytes);

        // Defensive: if the operator turned on `--output-format
        // stream-json` somewhere upstream of us, the stdout will be
        // line-delimited JSON events instead of the assistant's text.
        // We don't try to parse it (that's L3 territory) — just warn
        // so the operator knows why the model is seeing structured
        // noise.
        if stdout.trim_start().starts_with("{\"type\":") {
            warn!("claude_code.run stdout looks like stream-json; passing through raw");
        }

        Ok(stdout)
    }
}

/// Truncate a UTF-8 byte buffer to at most `max_bytes`, preserving valid
/// codepoint boundaries. Appends a `[truncated]` marker when clipped.
fn truncate_utf8(bytes: &[u8], max_bytes: usize) -> String {
    if bytes.len() <= max_bytes {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut cut = max_bytes;
    while cut > 0 && (bytes[cut] & 0b1100_0000) == 0b1000_0000 {
        cut -= 1;
    }
    let mut s = String::from_utf8_lossy(&bytes[..cut]).into_owned();
    s.push_str(&format!(
        "\n[... truncated, {} bytes total ...]",
        bytes.len()
    ));
    s
}

#[cfg(test)]
#[cfg(not(windows))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn write_fake_binary(dir: &std::path::Path, name: &str, script_body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script_body}\n")).unwrap();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        path
    }

    #[tokio::test]
    async fn returns_fake_claude_stdout_on_success() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-claude", "echo 'final answer'");
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary(&fake);

        let out = tool
            .invoke(json!({ "task": "do the thing" }))
            .await
            .unwrap();
        assert!(out.contains("final answer"), "got: {out}");
    }

    #[tokio::test]
    async fn surfaces_nonzero_exit_with_stderr_tail() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-claude", "echo 'oops' 1>&2; exit 7");
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary(&fake);

        let err = tool.invoke(json!({ "task": "x" })).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("exit=7"), "got: {msg}");
        assert!(msg.contains("oops"), "got: {msg}");
    }

    #[tokio::test]
    async fn enforces_timeout() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-claude", "sleep 5");
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary(&fake);

        let err = tool
            .invoke(json!({ "task": "x", "timeout_ms": 100 }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_workspace_subpath_escape() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-claude", "echo ok");
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary(&fake);

        let err = tool
            .invoke(json!({ "task": "x", "workspace_subpath": "../etc" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(".."), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_empty_task() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-claude", "echo ok");
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary(&fake);

        let err = tool.invoke(json!({ "task": "  " })).await.unwrap_err();
        assert!(err.to_string().contains("non-empty"), "got: {err}");
    }

    #[tokio::test]
    async fn missing_binary_surfaces_spawn_error() {
        let dir = tempdir().unwrap();
        let tool = ClaudeCodeRunTool::new(dir.path()).with_binary("definitely-not-on-path-xyz");
        let err = tool.invoke(json!({ "task": "x" })).await.unwrap_err();
        assert!(err.to_string().contains("failed to spawn"), "got: {err}");
    }

    #[tokio::test]
    async fn truncates_oversized_stdout() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(
            dir.path(),
            "fake-claude",
            "head -c 4096 /dev/zero | tr '\\0' a",
        );
        let tool = ClaudeCodeRunTool::new(dir.path())
            .with_binary(&fake)
            .with_max_stdout_bytes(16);

        let out = tool.invoke(json!({ "task": "x" })).await.unwrap();
        assert!(out.contains("truncated"), "got: {out}");
        assert!(out.contains("4096 bytes total"), "got: {out}");
    }

    #[tokio::test]
    async fn passes_permission_mode_and_task_correctly() {
        // Fake binary records its own argv to a file we can inspect.
        // We use a single-arg `permission-mode acceptEdits -p -- <task>`
        // ordering and check that the task arrives intact.
        let dir = tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let log_str = log.display().to_string();
        let fake = write_fake_binary(
            dir.path(),
            "fake-claude",
            // Print every arg on its own line.
            &format!("for a in \"$@\"; do echo \"$a\" >> '{log_str}'; done"),
        );

        let tool = ClaudeCodeRunTool::new(dir.path())
            .with_binary(&fake)
            .with_permission_mode(PermissionMode::AcceptEdits);
        tool.invoke(json!({ "task": "fix `bug`; rm -rf $HOME" }))
            .await
            .unwrap();

        let argv = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = argv.lines().collect();
        // Expected argv: --permission-mode acceptEdits -p -- <task>
        assert_eq!(lines[0], "--permission-mode");
        assert_eq!(lines[1], "acceptEdits");
        assert_eq!(lines[2], "-p");
        assert_eq!(lines[3], "--");
        assert_eq!(lines[4], "fix `bug`; rm -rf $HOME");
        assert_eq!(lines.len(), 5, "unexpected argv: {argv}");
    }

    #[tokio::test]
    async fn allowed_tools_become_repeated_flags() {
        let dir = tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let log_str = log.display().to_string();
        let fake = write_fake_binary(
            dir.path(),
            "fake-claude",
            &format!("for a in \"$@\"; do echo \"$a\" >> '{log_str}'; done"),
        );

        let tool = ClaudeCodeRunTool::new(dir.path())
            .with_binary(&fake)
            .with_allowed_tools(vec!["Read".into(), "Bash(git:*)".into()]);
        tool.invoke(json!({ "task": "x" })).await.unwrap();

        let argv = std::fs::read_to_string(&log).unwrap();
        // Two repeated --allowed-tools flags, each with its value.
        let count = argv.lines().filter(|l| *l == "--allowed-tools").count();
        assert_eq!(count, 2, "argv: {argv}");
        assert!(argv.contains("Bash(git:*)"), "argv: {argv}");
    }
}
