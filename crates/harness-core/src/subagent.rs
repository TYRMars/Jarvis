//! SubAgent event channel — typed "what is the subagent doing right now" stream.
//!
//! Companion to [`crate::progress`] (per-tool stdout/stderr) and
//! [`crate::plan`] (full plan snapshots). The wire model is the
//! same: a tool installs an [`mpsc::UnboundedSender<SubAgentFrame>`]
//! in a `tokio::task_local` before invoking the subagent body via
//! [`with_subagent`], the subagent emits via [`emit`], and the agent
//! loop drains the receiver alongside `tool.invoke` and forwards
//! each frame as `AgentEvent::SubAgentEvent`.
//!
//! The point of *streaming* (versus "subagent runs and returns a
//! single string when done") is product: users want to **see** the
//! subagent's reasoning, tool calls, and intermediate output while
//! it works — both in an inline collapsible card in the main message
//! stream and on a side panel listing every running subagent. Both
//! consumers read the same event stream.
//!
//! Outside an agent invocation the channel is absent — emits become
//! no-ops, which keeps subagent unit tests trivial (no agent loop
//! required to run a subagent in isolation).

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// One frame in a subagent's execution stream. The `subagent_id` is
/// a per-invocation uuid (assigned by the harness when the
/// subagent's `Tool::invoke` starts) so the UI can correlate frames
/// from concurrent subagents on the same conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubAgentFrame {
    /// Unique id for this subagent invocation. Stable across the
    /// whole `Started…Done|Error` sequence; opaque to the renderer.
    pub subagent_id: String,
    /// Subagent registry name (e.g. `"claude_code"`, `"review"`).
    /// Stable across runs of the same subagent kind, so the UI can
    /// pick an icon / label per kind.
    pub subagent_name: String,
    /// The actual event payload.
    pub event: SubAgentEvent,
}

/// A point-in-time event in a subagent's run. Mirrors the shape of
/// the main `AgentEvent` enum but cut down to what a subagent can
/// reasonably surface; the serialiser uses `kind` as the
/// discriminator so UIs can match on it directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubAgentEvent {
    /// The subagent has begun work. Emitted exactly once per
    /// invocation, immediately after the harness installs the
    /// channel. `model` is informational (which LLM is doing the
    /// thinking, when known — empty for SDK-sidecar subagents whose
    /// model is determined by the SDK itself).
    Started {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// A chunk of assistant-visible text from the subagent's LLM.
    /// Renderers concatenate consecutive `Delta`s.
    Delta { text: String },
    /// The subagent invoked one of its own tools.
    ToolStart {
        name: String,
        arguments: serde_json::Value,
    },
    /// The subagent's tool returned. `output` mirrors what the inner
    /// tool reported — tool errors are surfaced as text here too,
    /// matching the main loop's behaviour.
    ToolEnd { name: String, output: String },
    /// SDK-style status update — a one-liner the subagent's wrapper
    /// chose to surface (e.g. "Searching files…" from
    /// `@anthropic-ai/claude-agent-sdk`'s structured events). The
    /// renderer can show these as muted lines in the inline card.
    Status { message: String },
    /// The subagent finished cleanly. `final_message` is the same
    /// string returned to the caller via `Tool::invoke`. The matching
    /// `ToolEnd` in the *outer* stream will carry the same text, so
    /// transports may dedupe if they want.
    Done { final_message: String },
    /// The subagent failed. `final_message` returned to the caller is
    /// `format!("subagent error: {message}")` so the outer model can
    /// adapt — same convention as tool errors elsewhere.
    Error { message: String },
}

tokio::task_local! {
    /// Per-invocation subagent sender, scoped via [`with_subagent`].
    static SUBAGENT_TX: mpsc::UnboundedSender<SubAgentFrame>;
}

/// Publish a frame. No-op when no listener is installed (i.e. the
/// subagent was invoked outside an agent loop — the unit-test path).
pub fn emit(frame: SubAgentFrame) {
    let _ = SUBAGENT_TX.try_with(|tx| {
        let _ = tx.send(frame);
    });
}

/// Whether a subagent sender is installed for the current task. Used
/// by subagent implementations to decide whether to bother building
/// frames (frames carry serde_json::Value args and can be costly).
pub fn is_active() -> bool {
    SUBAGENT_TX.try_with(|_| ()).is_ok()
}

/// Run `fut` with `tx` installed as the active subagent sender.
/// Used by the agent loop to scope a sender to a single subagent
/// tool invocation, mirroring [`crate::plan::with_plan`]. The sender
/// goes out of scope when `fut` completes, so subsequent invocations
/// need their own channel.
pub async fn with_subagent<F, R>(tx: mpsc::UnboundedSender<SubAgentFrame>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    SUBAGENT_TX.scope(tx, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_inside_with_subagent_reaches_receiver() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_subagent(tx, async {
            assert!(is_active());
            emit(SubAgentFrame {
                subagent_id: "sub-1".into(),
                subagent_name: "review".into(),
                event: SubAgentEvent::Started {
                    task: "verify the kanban renders".into(),
                    model: Some("claude-sonnet-4-6".into()),
                },
            });
        })
        .await;
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame.subagent_id, "sub-1");
        match frame.event {
            SubAgentEvent::Started { task, model } => {
                assert_eq!(task, "verify the kanban renders");
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn emit_outside_scope_is_noop() {
        assert!(!is_active());
        emit(SubAgentFrame {
            subagent_id: "x".into(),
            subagent_name: "x".into(),
            event: SubAgentEvent::Status { message: "x".into() },
        });
        // The point: this didn't panic.
    }

    #[test]
    fn event_serialises_with_kind_discriminator() {
        let f = SubAgentFrame {
            subagent_id: "sub-1".into(),
            subagent_name: "claude_code".into(),
            event: SubAgentEvent::ToolStart {
                name: "fs.read".into(),
                arguments: serde_json::json!({ "path": "/etc/hosts" }),
            },
        };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("\"kind\":\"tool_start\""), "got: {json}");
        assert!(json.contains("\"subagent_id\":\"sub-1\""), "got: {json}");
        assert!(json.contains("\"name\":\"fs.read\""), "got: {json}");
    }
}
