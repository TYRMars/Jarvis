//! `subagent.claude_code` — delegate a coding task to the local
//! `claude` CLI (Anthropic's Claude Code distribution). Spawns
//! `claude --print --output-format stream-json --verbose` with the
//! task as a positional argument, parses each `SDKMessage` line on
//! stdout, and emits the equivalent [`SubAgentEvent`] frames so the
//! outer UI can show Claude Code's reasoning + tool calls in real
//! time alongside the rest of the subagent surface.
//!
//! Why CLI and not the Node SDK? Most operators who care about
//! `subagent.claude_code` already have the `claude` binary
//! installed (it's the canonical distribution); requiring an extra
//! `npm i -g @anthropic-ai/claude-agent-sdk` step on top doubles
//! the install friction. The CLI's `stream-json` format is also
//! the SDK's wire format on stdout, so we re-use the same
//! `SDKMessage` shape either way — switching to the binary just
//! drops the Node sidecar and its bundled script.
//!
//! Wire protocol (`claude --print --output-format stream-json --verbose`):
//!
//! ```text
//!   { "type": "system",    "subtype": "init", ... }
//!   { "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] }, ... }
//!   { "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "...", "name": "Read", "input": { ... } }] }, ... }
//!   { "type": "user",      "message": { "content": [{ "type": "tool_result", "tool_use_id": "...", "content": "..." }] }, ... }
//!   { "type": "result",    "subtype": "success", "result": "...", "is_error": false, ... }
//! ```
//!
//! Discovery: the composition root calls [`probe`] once at startup;
//! if `claude` isn't on PATH (or `--version` fails), it returns
//! `Err(reason)` and the subagent is **not registered** — no panic,
//! no hard error. Mirrors how `harness-mcp` skips servers it can't
//! launch.
//!
//! Authentication: the spawned `claude` inherits the parent
//! process's env, so a user who has logged in interactively
//! (`claude /login`) gets seamless auth — the credentials live in
//! the OS keychain (or `~/.claude/.credentials.json`). If keychain
//! access is unavailable, set `ANTHROPIC_API_KEY` for the
//! `jarvis` process and add `--bare` via
//! [`ClaudeCodeConfig::extra_args`] (TODO).

use crate::{Artifact, SubAgent, SubAgentEvent, SubAgentFrame, SubAgentInput, SubAgentOutput};
use async_trait::async_trait;
use harness_core::{emit_subagent, BoxError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{debug, warn};

pub const DESCRIPTION: &str = "Delegate a coding task to Claude Code (Anthropic's `claude` CLI). It can read, edit, and run shell commands inside the workspace; treat it like a peer coder you hand a focused task to. Will modify files; the call is approval-gated.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeConfig {
    /// Path or name of the `claude` binary. Default `claude` (PATH
    /// lookup). Override via `JARVIS_SUBAGENT_CLAUDE_CODE_BIN` at
    /// the composition root.
    pub claude_bin: String,
    /// Optional model override forwarded to the CLI as `--model`.
    /// `None` lets the CLI use its configured default (whatever the
    /// user picked via `claude /model` or their settings).
    pub model: Option<String>,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        Self {
            claude_bin: "claude".into(),
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

/// Probe the host: is the `claude` binary on PATH and does
/// `--version` recognise it as Claude Code? Run once at startup;
/// on failure callers should skip registering the subagent (a
/// one-line INFO log is the right level).
pub async fn probe(claude_bin: &str) -> Result<(), String> {
    let output = Command::new(claude_bin)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("spawn `{claude_bin}` failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`{claude_bin} --version` exited with {}",
            output.status
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout);
    // The CLI prints e.g. `2.1.119 (Claude Code)` — the parenthesised
    // tag is what disambiguates the official binary from a someone-
    // else's `claude` on PATH.
    if !version.contains("Claude Code") {
        return Err(format!(
            "`{claude_bin} --version` output unrecognised (got: {})",
            version.trim()
        ));
    }
    Ok(())
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
                    "description": "Natural-language coding task. Claude Code will plan + execute autonomously."
                }
            },
            "required": ["task"],
            "additionalProperties": false
        })
    }
    fn requires_approval(&self) -> bool {
        // The CLI *will* mutate the workspace. The outer approver
        // MUST gate this call; per-tool approvals inside the CLI are
        // governed by `--permission-mode bypassPermissions` (the
        // user already approved the outer call, no point asking
        // again — and `--print` mode can't surface interactive
        // prompts anyway).
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

        let mut cmd = Command::new(&self.config.claude_bin);
        cmd.args([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose", // required by stream-json
            "--permission-mode",
            "bypassPermissions",
        ]);
        if let Some(m) = &self.config.model {
            cmd.args(["--model", m.as_str()]);
        }
        // Final positional: the task itself.
        cmd.arg(&input.task);
        // Run inside the sandbox root so `claude`'s default
        // workspace resolution lands in the right place.
        cmd.current_dir(&input.workspace_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        push(SubAgentEvent::Started {
            task: input.task.clone(),
            model: self.config.model.clone(),
        });

        let mut child = cmd.spawn().map_err(|e| -> BoxError {
            format!("spawn `{}`: {e}", self.config.claude_bin).into()
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| -> BoxError { "claude stdout missing".into() })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| -> BoxError { "claude stderr missing".into() })?;

        // Drain stderr in the background so a chatty `claude` doesn't
        // deadlock against a full pipe. We surface its content only
        // when something goes wrong.
        let stderr_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut buf = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                buf.push_str(&line);
                buf.push('\n');
                // Cap at 64 KiB to avoid unbounded memory if the CLI
                // logs verbose junk.
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
            buf
        });

        let mut reader = BufReader::new(stdout).lines();
        let mut final_message = String::new();
        let mut error_message: Option<String> = None;
        // Track pending tool_use_id → name so we can pair tool_result
        // blocks back to the original tool name when emitting ToolEnd.
        let mut tool_names: HashMap<String, String> = HashMap::new();

        while let Some(line) = reader.next_line().await? {
            match parse_sdk_message(&line) {
                Some(SdkMessage::System { subtype, .. }) => {
                    // The init payload carries the model + tools list;
                    // not load-bearing for the UI, but a Status frame
                    // is the closest match.
                    if let Some(s) = subtype {
                        push(SubAgentEvent::Status {
                            message: format!("system:{s}"),
                        });
                    }
                }
                Some(SdkMessage::Assistant { message }) => {
                    for block in message.content {
                        match block {
                            ContentBlock::Text { text } => {
                                if !text.is_empty() {
                                    push(SubAgentEvent::Delta { text });
                                }
                            }
                            ContentBlock::ToolUse { id, name, input } => {
                                tool_names.insert(id, name.clone());
                                push(SubAgentEvent::ToolStart {
                                    name,
                                    arguments: input,
                                });
                            }
                            ContentBlock::Thinking { .. } | ContentBlock::Unknown => {
                                // Forward-compat: silently ignore.
                            }
                            ContentBlock::ToolResult { .. } => {
                                // Should only appear on user turns; ignore.
                            }
                        }
                    }
                }
                Some(SdkMessage::User { message }) => {
                    for block in message.content {
                        if let ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                        } = block
                        {
                            let name = tool_names
                                .remove(&tool_use_id)
                                .unwrap_or_else(|| "unknown".into());
                            push(SubAgentEvent::ToolEnd {
                                name,
                                output: stringify_tool_result(content),
                            });
                        }
                    }
                }
                Some(SdkMessage::Result {
                    subtype,
                    result,
                    is_error,
                }) => {
                    if is_error || subtype.as_deref() != Some("success") {
                        error_message = Some(result.clone().unwrap_or_else(|| {
                            format!("claude returned error subtype={:?}", subtype)
                        }));
                    } else if let Some(r) = result {
                        final_message = r;
                    }
                }
                Some(SdkMessage::Unknown) | None => {
                    debug!(line = %line, "claude_code stream: skipping unparseable line");
                }
            }
        }

        let status = child.wait().await?;
        let stderr_text = stderr_handle.await.unwrap_or_default();

        if let Some(msg) = error_message {
            push(SubAgentEvent::Error {
                message: msg.clone(),
            });
            warn!(error = %msg, "claude_code error result");
            return Err(format!("subagent error: {msg}").into());
        }

        if !status.success() {
            let trimmed = stderr_text.trim();
            let msg = if trimmed.is_empty() {
                format!("`claude` exited {status}")
            } else {
                format!("`claude` exited {status}: {trimmed}")
            };
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

/// `claude --output-format stream-json` SDKMessage envelope.
/// Internal — the public-facing event surface is [`SubAgentEvent`].
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SdkMessage {
    System {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(flatten)]
        _rest: serde_json::Map<String, Value>,
    },
    Assistant {
        message: AssistantInner,
    },
    User {
        message: UserInner,
    },
    Result {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        is_error: bool,
    },
    /// Forward-compat for new SDKMessage variants. Captured so we
    /// don't crash on an upstream addition; our match arm logs +
    /// drops them.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct AssistantInner {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct UserInner {
    /// `content` is normally `Vec<ContentBlock>` for stream-json, but
    /// the CLI also emits plain-string content for some legacy paths.
    /// Default to empty if it's not an array.
    #[serde(default, deserialize_with = "deserialize_user_content")]
    content: Vec<ContentBlock>,
}

fn deserialize_user_content<'de, D>(d: D) -> Result<Vec<ContentBlock>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = Value::deserialize(d)?;
    match v {
        Value::Array(_) => serde_json::from_value(v).map_err(D::Error::custom),
        _ => Ok(Vec::new()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        /// Can be a string OR an array of `{type:"text",text}` blocks.
        /// We keep it as a `Value` and flatten via
        /// [`stringify_tool_result`] when emitting to the UI.
        #[serde(default)]
        content: Value,
    },
    /// Claude's extended-thinking surface. We recognise the
    /// variant so it doesn't fall into `Unknown` (and pollute the
    /// debug log), but the body is intentionally ignored — the
    /// inline card already shows assistant text + tool calls and
    /// dumping reasoning verbatim adds noise without helping the
    /// reader follow the loop.
    #[allow(dead_code)]
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    #[serde(other)]
    Unknown,
}

fn parse_sdk_message(line: &str) -> Option<SdkMessage> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// Tool results land as either a plain string or an array of
/// `{type:"text",text}` blocks. Flatten to a single string so the
/// `SubAgentEvent::ToolEnd.content` field stays simple.
fn stringify_tool_result(v: Value) -> String {
    match v {
        Value::String(s) => s,
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
            out
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_text_block() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::Assistant { message } => match &message.content[0] {
                ContentBlock::Text { text } => assert_eq!(text, "hello"),
                other => panic!("unexpected block: {other:?}"),
            },
            other => panic!("unexpected msg: {other:?}"),
        }
    }

    #[test]
    fn parses_assistant_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"u1","name":"Read","input":{"path":"a.rs"}}]}}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::Assistant { message } => match &message.content[0] {
                ContentBlock::ToolUse { id, name, input } => {
                    assert_eq!(id, "u1");
                    assert_eq!(name, "Read");
                    assert_eq!(input["path"], "a.rs");
                }
                other => panic!("unexpected block: {other:?}"),
            },
            other => panic!("unexpected msg: {other:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_string_content() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":"file body"}]}}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::User { message } => match &message.content[0] {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                } => {
                    assert_eq!(tool_use_id, "u1");
                    assert_eq!(stringify_tool_result(content.clone()), "file body");
                }
                other => panic!("unexpected block: {other:?}"),
            },
            other => panic!("unexpected msg: {other:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_array_content() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":[{"type":"text","text":"line a"},{"type":"text","text":"line b"}]}]}}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::User { message } => match &message.content[0] {
                ContentBlock::ToolResult { content, .. } => {
                    assert_eq!(stringify_tool_result(content.clone()), "line a\nline b");
                }
                other => panic!("unexpected block: {other:?}"),
            },
            other => panic!("unexpected msg: {other:?}"),
        }
    }

    #[test]
    fn parses_result_success() {
        let line = r#"{"type":"result","subtype":"success","result":"all done","is_error":false}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::Result {
                subtype,
                result,
                is_error,
            } => {
                assert_eq!(subtype.as_deref(), Some("success"));
                assert_eq!(result.as_deref(), Some("all done"));
                assert!(!is_error);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_result_error() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::Result {
                subtype, is_error, ..
            } => {
                assert_eq!(subtype.as_deref(), Some("error_max_turns"));
                assert!(is_error);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unknown_message_kind_does_not_panic() {
        let line = r#"{"type":"future_kind_we_havent_seen","stuff":1}"#;
        match parse_sdk_message(line).unwrap() {
            SdkMessage::Unknown => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn skips_blank_and_garbage_lines() {
        assert!(parse_sdk_message("").is_none());
        assert!(parse_sdk_message("   ").is_none());
        assert!(parse_sdk_message("not json").is_none());
    }

    #[test]
    fn stringify_handles_null_and_unknown() {
        assert_eq!(stringify_tool_result(Value::Null), "");
        assert_eq!(stringify_tool_result(Value::Bool(true)), "true");
    }

    #[tokio::test]
    async fn probe_returns_err_when_binary_missing() {
        let err = probe("/no/such/binary-jarvis-test").await.unwrap_err();
        assert!(err.contains("spawn"), "unexpected: {err}");
    }
}
