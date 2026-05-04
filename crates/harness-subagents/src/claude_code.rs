//! `subagent.claude_code` — Anthropic's official Claude Code agent
//! delegated as a subagent. The actual driving is done by the Node
//! sidecar at `sidecar/claude_code.mjs`, which uses
//! `@anthropic-ai/claude-agent-sdk` and emits a small JSON Lines
//! protocol on stdout. This module spawns the sidecar, parses each
//! line, and emits the equivalent [`SubAgentEvent`] frames so the
//! outer UI can show ClaudeCode's reasoning + tool calls in real
//! time alongside the rest of the subagent surface.
//!
//! Wire protocol (sidecar → Rust):
//!
//! ```text
//!   { "kind": "started",    "task": "..." }
//!   { "kind": "delta",      "text": "..." }
//!   { "kind": "tool_start", "name": "fs.read", "arguments": {...} }
//!   { "kind": "tool_end",   "name": "fs.read", "output": "..." }
//!   { "kind": "status",     "message": "init" }
//!   { "kind": "done",       "final_message": "..." }
//!   { "kind": "error",      "message": "..." }
//! ```
//!
//! Discovery: the composition root calls [`probe`] once at startup;
//! if Node is missing or the SDK can't be resolved, it returns
//! `Err(reason)` and the subagent is **not registered** — no panic,
//! no hard error. Mirrors how `harness-mcp` skips servers it can't
//! launch.

use crate::{
    Artifact, SubAgent, SubAgentEvent, SubAgentFrame, SubAgentInput, SubAgentOutput,
};
use async_trait::async_trait;
use harness_core::{emit_subagent, BoxError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tracing::{debug, warn};

/// Bundled at compile time. Written to a stable temp file once per
/// process so we don't spam the filesystem on every invocation.
const SIDECAR_SCRIPT: &str = include_str!("../sidecar/claude_code.mjs");

pub const DESCRIPTION: &str = "Delegate a coding task to ClaudeCode (Anthropic's `@anthropic-ai/claude-agent-sdk`). It can read, edit, and run shell commands inside the workspace; treat it like a peer coder you hand a focused task to. Will modify files; the call is approval-gated.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeConfig {
    /// Path to `node`. Default `node`. Override via
    /// `JARVIS_SUBAGENT_CLAUDE_CODE_NODE` at the composition root.
    pub node_bin: String,
    /// Optional model override forwarded to the SDK as the
    /// `model` option in `query()`. `None` lets the SDK pick its
    /// default (currently the latest Claude Sonnet).
    pub model: Option<String>,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        Self {
            node_bin: "node".into(),
            model: None,
        }
    }
}

pub struct ClaudeCodeSubAgent {
    config: ClaudeCodeConfig,
}

impl ClaudeCodeSubAgent {
    pub fn new(config: ClaudeCodeConfig) -> Self {
        Self { config }
    }
}

/// Probe the host: can we run `node`, and does the SDK import? Run
/// once at startup; if it fails, callers should skip registering
/// `subagent.claude_code` (a one-line INFO log is the right level).
///
/// The probe shells out to `node -e "import(...).then(...).catch(...)"`
/// instead of running our full sidecar — same import path, much
/// quicker, zero side effects.
pub async fn probe(node_bin: &str) -> Result<(), String> {
    let check = "import('@anthropic-ai/claude-agent-sdk').then(m => process.exit(typeof m.query === 'function' ? 0 : 4)).catch(() => process.exit(3))";
    let result = Command::new(node_bin)
        .arg("-e")
        .arg(check)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn `{node_bin}` failed: {e}"))?;
    match result.code() {
        Some(0) => Ok(()),
        Some(3) => Err("@anthropic-ai/claude-agent-sdk not installed".into()),
        Some(4) => Err("@anthropic-ai/claude-agent-sdk loaded but `query` export missing".into()),
        Some(other) => Err(format!("probe exited with code {other}")),
        None => Err("probe killed by signal".into()),
    }
}

#[async_trait]
impl SubAgent for ClaudeCodeSubAgent {
    fn name(&self) -> &str {
        "claude_code"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Natural-language coding task. ClaudeCode will plan + execute autonomously."
                }
            },
            "required": ["task"],
            "additionalProperties": false
        })
    }
    fn requires_approval(&self) -> bool {
        // External CLI that *will* mutate the workspace. The outer
        // approver MUST gate this call; per-tool approvals inside
        // ClaudeCode are governed by its own permissionMode (we set
        // `acceptEdits`, since the user already approved the
        // outer call).
        true
    }

    async fn invoke(&self, input: SubAgentInput) -> Result<SubAgentOutput, BoxError> {
        let id = uuid::Uuid::new_v4().to_string();
        let name = "claude_code".to_owned();
        let push = |event: SubAgentEvent| {
            emit_subagent(SubAgentFrame {
                subagent_id: id.clone(),
                subagent_name: name.clone(),
                event,
            });
        };

        let script = ensure_sidecar_on_disk()?;

        // Build the stdin payload the sidecar expects.
        let payload = serde_json::json!({
            "task": input.task,
            "workspace_root": input.workspace_root,
            "model": self.config.model,
        });
        let payload_bytes = serde_json::to_vec(&payload)?;

        let mut child = Command::new(&self.config.node_bin)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| -> BoxError {
                format!("spawn `{}`: {e}", self.config.node_bin).into()
            })?;

        // Hand the payload off via stdin then close — the sidecar
        // reads-to-EOF before doing anything else.
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&payload_bytes).await?;
            stdin.shutdown().await?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| -> BoxError { "sidecar stdout missing".into() })?;
        let mut reader = BufReader::new(stdout).lines();

        let mut final_message = String::new();
        let mut error_message: Option<String> = None;

        // Drain stdout line-by-line. Each line is one frame.
        while let Some(line) = reader.next_line().await? {
            match parse_frame(&line) {
                Some(SidecarFrame::Started { task, .. }) => {
                    // Sidecar's own `started` frame mirrors the input
                    // task. Re-emit so the outer UI sees the canonical
                    // SubAgentEvent::Started before any deltas.
                    push(SubAgentEvent::Started {
                        task: task.unwrap_or_else(|| input.task.clone()),
                        model: self.config.model.clone(),
                    });
                }
                Some(SidecarFrame::Delta { text }) => {
                    push(SubAgentEvent::Delta { text });
                }
                Some(SidecarFrame::ToolStart { name, arguments }) => {
                    push(SubAgentEvent::ToolStart { name, arguments });
                }
                Some(SidecarFrame::ToolEnd { name, output }) => {
                    push(SubAgentEvent::ToolEnd { name, output });
                }
                Some(SidecarFrame::Status { message }) => {
                    push(SubAgentEvent::Status { message });
                }
                Some(SidecarFrame::Done { final_message: f }) => {
                    final_message = f;
                }
                Some(SidecarFrame::Error { message }) => {
                    error_message = Some(message);
                }
                None => {
                    debug!(line = %line, "claude_code sidecar: skipping unparseable line");
                }
            }
        }

        let status = child.wait().await?;

        if let Some(msg) = error_message {
            push(SubAgentEvent::Error {
                message: msg.clone(),
            });
            warn!(error = %msg, "claude_code sidecar error");
            return Err(format!("subagent error: {msg}").into());
        }

        if !status.success() {
            // Sidecar exited non-zero without an `error` frame —
            // unusual; surface what we can.
            let msg = format!("claude_code sidecar exited {status}");
            push(SubAgentEvent::Error {
                message: msg.clone(),
            });
            return Err(msg.into());
        }

        push(SubAgentEvent::Done {
            final_message: final_message.clone(),
        });

        Ok(SubAgentOutput {
            message: final_message,
            artifacts: artifacts_for_run(),
        })
    }
}

/// Future enhancement: parse `git status` / `git diff` after the run
/// to populate `Artifact::FilesChanged`. v1.0 returns nothing; the
/// final-message text already names the changed files.
fn artifacts_for_run() -> Vec<Artifact> {
    Vec::new()
}

/// Internal cache: write the bundled sidecar to a stable temp path
/// once per process and reuse on every invocation. The path
/// includes the binary's PID so concurrent test processes don't
/// trample each other.
static SIDECAR_PATH: OnceLock<PathBuf> = OnceLock::new();

fn ensure_sidecar_on_disk() -> Result<PathBuf, BoxError> {
    if let Some(p) = SIDECAR_PATH.get() {
        return Ok(p.clone());
    }
    let dir = std::env::temp_dir().join("jarvis-subagents");
    std::fs::create_dir_all(&dir).map_err(|e| -> BoxError {
        format!("create sidecar dir {}: {e}", dir.display()).into()
    })?;
    let path = dir.join(format!("claude_code-{}.mjs", std::process::id()));
    std::fs::write(&path, SIDECAR_SCRIPT).map_err(|e| -> BoxError {
        format!("write sidecar {}: {e}", path.display()).into()
    })?;
    let _ = SIDECAR_PATH.set(path.clone());
    Ok(path)
}

/// Sidecar JSON Lines protocol. Internal — the public-facing event
/// surface is [`SubAgentEvent`].
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SidecarFrame {
    Started {
        #[serde(default)]
        task: Option<String>,
    },
    Delta {
        text: String,
    },
    ToolStart {
        name: String,
        #[serde(default)]
        arguments: Value,
    },
    ToolEnd {
        name: String,
        #[serde(default)]
        output: String,
    },
    Status {
        message: String,
    },
    Done {
        #[serde(default)]
        final_message: String,
    },
    Error {
        message: String,
    },
}

fn parse_frame(line: &str) -> Option<SidecarFrame> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_started_frame() {
        let f = parse_frame(r#"{"kind":"started","task":"refactor"}"#).unwrap();
        match f {
            SidecarFrame::Started { task } => assert_eq!(task.as_deref(), Some("refactor")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_tool_start_with_object_args() {
        let f = parse_frame(
            r#"{"kind":"tool_start","name":"fs.read","arguments":{"path":"a.rs"}}"#,
        )
        .unwrap();
        match f {
            SidecarFrame::ToolStart { name, arguments } => {
                assert_eq!(name, "fs.read");
                assert_eq!(arguments["path"], "a.rs");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_done_with_message() {
        let f = parse_frame(r#"{"kind":"done","final_message":"Refactored"}"#).unwrap();
        match f {
            SidecarFrame::Done { final_message } => assert_eq!(final_message, "Refactored"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_error_frame() {
        let f = parse_frame(r#"{"kind":"error","message":"sdk missing"}"#).unwrap();
        match f {
            SidecarFrame::Error { message } => assert_eq!(message, "sdk missing"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn skips_blank_lines_and_garbage() {
        assert!(parse_frame("").is_none());
        assert!(parse_frame("   ").is_none());
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame(r#"{"kind":"unknown"}"#).is_none());
    }

    #[test]
    fn done_frame_without_message_defaults_to_empty() {
        let f = parse_frame(r#"{"kind":"done"}"#).unwrap();
        match f {
            SidecarFrame::Done { final_message } => assert_eq!(final_message, ""),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn sidecar_script_is_bundled() {
        // Sanity check the include_str! path resolves and the file
        // looks like our protocol implementation.
        assert!(SIDECAR_SCRIPT.contains("@anthropic-ai/claude-agent-sdk"));
        assert!(SIDECAR_SCRIPT.contains("\"started\""));
        assert!(SIDECAR_SCRIPT.contains("\"done\""));
    }

    #[tokio::test]
    async fn probe_returns_err_when_node_missing() {
        // Use a path that definitely doesn't exist.
        let err = probe("/no/such/binary-jarvis-test").await.unwrap_err();
        assert!(err.contains("spawn"), "unexpected: {err}");
    }
}
