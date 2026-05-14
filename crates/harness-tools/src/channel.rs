//! `channel.send` agent tool.
//!
//! Lets the agent push a one-shot message to a channel the operator
//! configured in Settings → Channels. Approval-gated — the user
//! has to ack each call because the side effect is on a shared
//! external system (a WeCom group, a Feishu chat, etc.) and a model
//! that's wrong about which channel to use can spam every customer
//! at once.
//!
//! Wire shape:
//! ```json
//! {
//!   "instance_id": "f86b2427-106a-...",
//!   "text": "deploy succeeded ✅",
//!   "format": "text" | "markdown" (optional, default text)
//! }
//! ```
//!
//! Result:
//! - On success: `"sent ok (truncated=…, downgraded=…)"`
//! - On failure: `"send failed: <reason> (retryable=…)"`
//!
//! The model sees the failure verbatim — including the `retryable`
//! flag — so it can decide whether to retry or escalate to the user.
//!
//! Phase A only supports lookup by stable `instance_id`. A future
//! revision should add Hermes-style target strings (`"wecom:prod-
//! alerts"` resolving by display_name, `"origin"` for the message's
//! source channel) once we have channel binding hooked up.

use async_trait::async_trait;
use harness_channel::{ChannelDispatcher, ChannelMessageFormat, OutboundMessage, SendOutcome};
use harness_core::{BoxError, Tool};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct ChannelSendTool {
    dispatcher: Arc<dyn ChannelDispatcher>,
}

impl ChannelSendTool {
    pub fn new(dispatcher: Arc<dyn ChannelDispatcher>) -> Self {
        Self { dispatcher }
    }
}

#[derive(Debug, Deserialize)]
struct Args {
    instance_id: String,
    text: String,
    #[serde(default)]
    format: Option<String>,
    /// Optional list of platform-side user ids to @-mention. Empty
    /// or absent ⇒ adapter falls back to the instance's
    /// `default_mention` (if any). `["@all"]` is recognised by
    /// WeCom.
    #[serde(default)]
    mentions: Vec<String>,
}

#[async_trait]
impl Tool for ChannelSendTool {
    fn name(&self) -> &str {
        "channel.send"
    }

    fn description(&self) -> &str {
        "Send a one-shot message to a channel the user configured in Settings → Channels (e.g. a WeCom group robot). Approval-gated. Use the channel's `instance_id` (UUID) — list available channels via the Settings page or have the user share the id. The result string says whether the send succeeded and surfaces any platform error."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["instance_id", "text"],
            "properties": {
                "instance_id": {
                    "type": "string",
                    "description": "UUID of the configured channel instance (from Settings → Channels)."
                },
                "text": {
                    "type": "string",
                    "description": "Message body. Bodies over the platform's max length are truncated; the result string flags it."
                },
                "format": {
                    "type": "string",
                    "enum": ["text", "markdown"],
                    "description": "Wire format. Defaults to text. Adapters that don't support markdown (e.g. some WeCom variants) will downgrade and flag it in the result."
                },
                "mentions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional @-mention user ids. Use [\"@all\"] to mention everyone in WeCom. Falls back to the instance's default mention list when empty."
                }
            }
        })
    }

    fn requires_approval(&self) -> bool {
        // Side effect on a shared external channel — never silent.
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("invalid args: {e}").into() })?;
        let format = match parsed.format.as_deref() {
            None => ChannelMessageFormat::Text,
            Some(s) => ChannelMessageFormat::from_wire(s).ok_or_else(|| -> BoxError {
                format!("unknown format '{s}' — expected text|markdown").into()
            })?,
        };
        let msg = OutboundMessage::text(parsed.text)
            .with_format(format)
            .with_mentions(parsed.mentions);

        let outcome = self.dispatcher.send_by_id(&parsed.instance_id, &msg).await;
        match outcome {
            SendOutcome::Sent {
                message_id,
                truncated,
                downgraded_format,
            } => {
                let mut notes: Vec<String> = Vec::new();
                if truncated {
                    notes.push("truncated to platform max length".into());
                }
                if downgraded_format {
                    notes.push("format downgraded (markdown not supported)".into());
                }
                if let Some(id) = message_id {
                    notes.push(format!("platform message id: {id}"));
                }
                Ok(if notes.is_empty() {
                    "sent ok".to_string()
                } else {
                    format!("sent ok ({})", notes.join("; "))
                })
            }
            SendOutcome::Failed {
                message,
                code,
                retryable,
            } => Ok(format!(
                "send failed: {message}{} (retryable={retryable})",
                code.map(|c| format!(" [{c}]")).unwrap_or_default()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct StubDispatcher {
        outcome: SendOutcome,
        seen: Mutex<Vec<(String, OutboundMessage)>>,
    }

    impl StubDispatcher {
        fn new(outcome: SendOutcome) -> Arc<Self> {
            Arc::new(Self {
                outcome,
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl ChannelDispatcher for StubDispatcher {
        async fn send_by_id(&self, id: &str, msg: &OutboundMessage) -> SendOutcome {
            self.seen
                .lock()
                .unwrap()
                .push((id.to_string(), msg.clone()));
            self.outcome.clone()
        }
    }

    #[tokio::test]
    async fn invoke_passes_args_through_to_dispatcher() {
        let stub = StubDispatcher::new(SendOutcome::sent());
        let tool = ChannelSendTool::new(stub.clone());
        let r = tool
            .invoke(json!({
                "instance_id": "abc",
                "text": "hello",
                "format": "markdown",
                "mentions": ["@all"]
            }))
            .await
            .unwrap();
        assert_eq!(r, "sent ok");
        let calls = stub.seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "abc");
        assert_eq!(calls[0].1.text, "hello");
        assert_eq!(calls[0].1.format, ChannelMessageFormat::Markdown);
        assert_eq!(calls[0].1.mentions, vec!["@all".to_string()]);
    }

    #[tokio::test]
    async fn invoke_default_format_is_text() {
        let stub = StubDispatcher::new(SendOutcome::sent());
        let tool = ChannelSendTool::new(stub.clone());
        tool.invoke(json!({"instance_id": "x", "text": "hi"}))
            .await
            .unwrap();
        assert_eq!(
            stub.seen.lock().unwrap()[0].1.format,
            ChannelMessageFormat::Text
        );
    }

    #[tokio::test]
    async fn invoke_surfaces_truncation_in_success_string() {
        let stub = StubDispatcher::new(SendOutcome::Sent {
            message_id: None,
            truncated: true,
            downgraded_format: false,
        });
        let tool = ChannelSendTool::new(stub);
        let r = tool
            .invoke(json!({"instance_id": "x", "text": "hi"}))
            .await
            .unwrap();
        assert!(r.contains("truncated"), "got: {r}");
    }

    #[tokio::test]
    async fn invoke_surfaces_failure_with_retryable_flag() {
        let stub = StubDispatcher::new(SendOutcome::fail_retryable("boom"));
        let tool = ChannelSendTool::new(stub);
        let r = tool
            .invoke(json!({"instance_id": "x", "text": "hi"}))
            .await
            .unwrap();
        assert!(r.starts_with("send failed: boom"), "got: {r}");
        assert!(r.contains("retryable=true"), "got: {r}");
    }

    #[tokio::test]
    async fn invoke_rejects_bad_format() {
        let stub = StubDispatcher::new(SendOutcome::sent());
        let tool = ChannelSendTool::new(stub);
        let err = tool
            .invoke(json!({
                "instance_id": "x",
                "text": "hi",
                "format": "html"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown format"));
    }

    #[test]
    fn tool_is_approval_gated() {
        let stub = StubDispatcher::new(SendOutcome::sent());
        let tool = ChannelSendTool::new(stub);
        assert!(tool.requires_approval());
    }
}
