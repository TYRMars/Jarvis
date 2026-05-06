//! Codex CLI sub-agent tool — L2 of the Codex SubAgent integration.
//!
//! Spawns the official OpenAI Codex CLI (`codex exec`) as a child process,
//! pointed at the current session workspace, and returns the agent's final
//! answer to the calling Jarvis agent. The Codex run is treated as a
//! single black-box invocation: no streaming, no nested approval, no
//! multi-turn protocol — for those, see L3
//! ([`docs/proposals/codex-subagent.zh-CN.md`](../../../docs/proposals/codex-subagent.zh-CN.md)).
//!
//! Approval, timeout, kill-on-drop, and workspace-path safety follow the
//! same conventions as `shell.exec`:
//!
//! - `requires_approval = true` — every invocation passes through the
//!   configured [`harness_core::Approver`].
//! - `cwd` is resolved with [`crate::sandbox::resolve_under`] so the
//!   model can't push the Codex run outside the tool root.
//! - `tokio::time::timeout` + `kill_on_drop(true)` keep a stuck or
//!   misbehaving Codex process from holding up the calling agent.
//!
//! Intentionally **not** registered by default — opt in via
//! [`crate::BuiltinsConfig::enable_codex_run`].

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::process::Command;
use tracing::warn;

use crate::sandbox::resolve_under;

/// Default cap on captured stdout per invocation. Codex's final answer is
/// typically a few KB; the cap protects the calling agent's context from
/// runaway diagnostic output.
const DEFAULT_MAX_STDOUT_BYTES: usize = 64 * 1024;
/// Default cap on captured stderr surfaced in error reports.
const DEFAULT_MAX_STDERR_BYTES: usize = 4 * 1024;
/// Default per-invocation wall-clock timeout. Codex tasks can run for
/// many minutes when they involve real work; 30 min is a deliberate
/// "long but not unbounded" ceiling.
const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000;

/// Delegate a single self-contained coding task to the Codex CLI.
pub struct CodexRunTool {
    root: PathBuf,
    binary: PathBuf,
    default_timeout_ms: u64,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    sandbox_mode: SandboxMode,
}

/// Codex's `--sandbox` value passed through verbatim. We don't try to
/// re-validate Codex's sandbox model here — see
/// `docs/proposals/codex-subagent.zh-CN.md` §6 Q3 for the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    /// `--sandbox read-only` — Codex can read but not modify the workspace.
    /// Useful for "explain this code" / "find the bug" tasks.
    ReadOnly,
    /// `--sandbox workspace-write` — Codex can read/write inside the
    /// workspace. Default: matches the L2 design intent of "delegate a
    /// focused code change".
    WorkspaceWrite,
    /// `--sandbox danger-full-access` — no Codex-side sandbox. Almost
    /// never the right choice from inside Jarvis; included only for
    /// completeness and explicit operator opt-in.
    DangerFullAccess,
}

impl SandboxMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

impl CodexRunTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            binary: PathBuf::from("codex"),
            default_timeout_ms: DEFAULT_TIMEOUT_MS,
            max_stdout_bytes: DEFAULT_MAX_STDOUT_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            sandbox_mode: SandboxMode::WorkspaceWrite,
        }
    }

    /// Override the binary path. Defaults to `codex` (looked up via
    /// `PATH`). Tests use a fixture script; production deployments may
    /// pin a specific install.
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

    /// Set the `--sandbox` mode passed to `codex exec`.
    pub fn with_sandbox_mode(mut self, mode: SandboxMode) -> Self {
        self.sandbox_mode = mode;
        self
    }
}

#[async_trait]
impl Tool for CodexRunTool {
    fn name(&self) -> &str {
        "codex.run"
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
        "Delegate a self-contained coding task to the OpenAI Codex CLI. \
         Spawns `codex exec` in the session workspace (or `workspace_subpath` \
         under it), waits for completion, and returns Codex's final answer. \
         Use for: focused code changes, bug fixes, well-specified refactors. \
         Do not use for: planning, conversation, ambiguous tasks. \
         Killed after `timeout_ms` (default 30 minutes)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Self-contained task description with \
                                    acceptance criteria. The full prompt to Codex."
                },
                "workspace_subpath": {
                    "type": "string",
                    "description": "Optional subdirectory under the tool root \
                                    to run Codex in. Relative; absolute paths \
                                    and `..` are rejected."
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
        // `--full-auto` = "ask-for-approval=never + sandbox=workspace-write"
        // bundle. We then explicitly override `--sandbox` so the operator's
        // SandboxMode choice wins regardless of how `--full-auto` evolves
        // upstream. The trailing `--` guards against `task` strings that
        // happen to start with `-`.
        cmd.arg("exec")
            .arg("--full-auto")
            .arg("--sandbox")
            .arg(self.sandbox_mode.as_str())
            .arg("--")
            .arg(task);
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
                Ok(Err(e)) => return Err(format!("codex process error: {e}").into()),
                Err(_) => {
                    // tokio::time::timeout drops the child future, which fires
                    // `kill_on_drop`. No further cleanup needed here.
                    return Err(format!("codex timed out after {timeout_ms} ms").into());
                }
            };

        if !output.status.success() {
            let exit = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            let stderr_tail = truncate_utf8(&output.stderr, self.max_stderr_bytes);
            return Err(format!("codex exec exit={exit}: {stderr_tail}").into());
        }

        let stdout = truncate_utf8(&output.stdout, self.max_stdout_bytes);

        // Stream-json-shaped output coming out of `codex exec` would mean
        // the model is calling us with an unexpected `codex` build
        // (legacy `--json` flag, future change, etc.). We don't try to
        // parse it — just warn so operators can investigate — and pass
        // the raw bytes through. The model still gets the bytes; the
        // log gets a breadcrumb.
        if stdout.trim_start().starts_with("{\"type\":") {
            warn!("codex.run stdout looks like stream-json; passing through raw");
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
    // Walk back to a UTF-8 boundary so `from_utf8_lossy` doesn't
    // smear a `?` over the cut. `is_char_boundary` on the prefix
    // string is equivalent to "byte starts a codepoint" because we
    // operate on a borrowed slice that we'll lossy-decode separately.
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

    /// Write `script_body` as an executable file under `dir` and return
    /// its path. The fixture stands in for a real `codex` binary so we
    /// can exercise the tool in CI without depending on the upstream
    /// CLI being installed.
    fn write_fake_binary(dir: &std::path::Path, name: &str, script_body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script_body}\n")).unwrap();
        let mut perm = std::fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&path, perm).unwrap();
        path
    }

    #[tokio::test]
    async fn returns_fake_codex_stdout_on_success() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-codex", "echo 'final answer'");
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let out = tool
            .invoke(json!({ "task": "do the thing" }))
            .await
            .unwrap();
        assert!(out.contains("final answer"), "got: {out}");
    }

    #[tokio::test]
    async fn surfaces_nonzero_exit_with_stderr_tail() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-codex", "echo 'oops' 1>&2; exit 7");
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let err = tool.invoke(json!({ "task": "x" })).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("exit=7"), "got: {msg}");
        assert!(msg.contains("oops"), "got: {msg}");
    }

    #[tokio::test]
    async fn enforces_timeout() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-codex", "sleep 5");
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let err = tool
            .invoke(json!({ "task": "x", "timeout_ms": 100 }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_workspace_subpath_escape() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-codex", "echo ok");
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let err = tool
            .invoke(json!({ "task": "x", "workspace_subpath": "../etc" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(".."), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_empty_task() {
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(dir.path(), "fake-codex", "echo ok");
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let err = tool.invoke(json!({ "task": "  " })).await.unwrap_err();
        assert!(err.to_string().contains("non-empty"), "got: {err}");
    }

    #[tokio::test]
    async fn missing_binary_surfaces_spawn_error() {
        let dir = tempdir().unwrap();
        let tool = CodexRunTool::new(dir.path()).with_binary("definitely-not-on-path-xyz");
        let err = tool.invoke(json!({ "task": "x" })).await.unwrap_err();
        assert!(err.to_string().contains("failed to spawn"), "got: {err}");
    }

    #[tokio::test]
    async fn truncates_oversized_stdout() {
        let dir = tempdir().unwrap();
        // Print 4 KiB of `a` to overrun the 16-byte cap below.
        let fake = write_fake_binary(
            dir.path(),
            "fake-codex",
            "head -c 4096 /dev/zero | tr '\\0' a",
        );
        let tool = CodexRunTool::new(dir.path())
            .with_binary(&fake)
            .with_max_stdout_bytes(16);

        let out = tool.invoke(json!({ "task": "x" })).await.unwrap();
        assert!(out.contains("truncated"), "got: {out}");
        assert!(out.contains("4096 bytes total"), "got: {out}");
    }

    #[tokio::test]
    async fn passes_task_as_argv_safely() {
        // A task containing shell metacharacters must NOT be reinterpreted
        // by `sh` — it should reach the binary as a single argv slot.
        // We assert this by having the fake binary echo $#: it should
        // see exactly the trailing `task` argument we pass after `--`.
        let dir = tempdir().unwrap();
        let fake = write_fake_binary(
            dir.path(),
            "fake-codex",
            // Skip exec / --full-auto / --sandbox / value / -- and
            // print the remaining arg count + the task itself.
            "shift 5; echo \"argc=$#\"; echo \"task=$1\"",
        );
        let tool = CodexRunTool::new(dir.path()).with_binary(&fake);

        let task = "fix `bug`; rm -rf $HOME";
        let out = tool.invoke(json!({ "task": task })).await.unwrap();
        assert!(out.contains("argc=1"), "got: {out}");
        assert!(out.contains(&format!("task={task}")), "got: {out}");
    }
}
