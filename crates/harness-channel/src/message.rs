//! Outbound message + format + send outcome.
//!
//! Used by the `channel.send` agent tool and every kind's adapter
//! `send` method. Modelled after the lessons from Hermes's
//! `gateway/platforms/base.py`:
//! - normalise the outbound message shape ([`OutboundMessage`])
//! - normalise the result so retries are explicit ([`SendOutcome`])

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Wire format of an outbound message body. Adapters that don't
/// support a particular format fall back to `Text` and tag the
/// `SendOutcome` so the caller (e.g. `channel.send` tool) can
/// surface "downgraded to text" in the agent's transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub enum ChannelMessageFormat {
    #[default]
    Text,
    /// Markdown — adapter is responsible for translating to its own
    /// dialect (WeCom uses a CommonMark subset, Feishu uses Lark
    /// rich text, etc.). Senders must reject formats they don't
    /// support rather than silently sending raw markdown source.
    Markdown,
}

impl ChannelMessageFormat {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
        }
    }
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Self::Text),
            "markdown" => Some(Self::Markdown),
            _ => None,
        }
    }
}

/// One outbound message, normalized across kinds. Adapters consume
/// this and produce platform-specific wire payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundMessage {
    /// Body text. Adapters cap at the platform's max length and
    /// surface truncation via `SendOutcome::Sent.truncated`.
    pub text: String,
    pub format: ChannelMessageFormat,
    /// Optional list of platform-side user ids to @-mention. Empty
    /// vector means "no mentions"; semantics of `"@all"` are
    /// platform-defined (WeCom group robot supports it, Feishu has
    /// a different sentinel).
    pub mentions: Vec<String>,
}

impl OutboundMessage {
    /// Convenience constructor for the most common case — a plain
    /// text message with no mentions.
    pub fn text(body: impl Into<String>) -> Self {
        Self {
            text: body.into(),
            format: ChannelMessageFormat::Text,
            mentions: Vec::new(),
        }
    }

    /// Builder-style setter for the format.
    pub fn with_format(mut self, format: ChannelMessageFormat) -> Self {
        self.format = format;
        self
    }

    /// Builder-style setter for mentions.
    pub fn with_mentions(mut self, mentions: Vec<String>) -> Self {
        self.mentions = mentions;
        self
    }
}

/// Outcome of an outbound send. Modelled after Hermes's `SendResult`
/// — the `retryable` distinction is the hard-won bit: read/write
/// timeouts on a non-idempotent send may already have delivered, so
/// blindly retrying duplicates messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SendOutcome {
    /// Adapter accepted the payload and platform returned 0/OK.
    Sent {
        /// Platform-side message id when available. Some platforms
        /// (group robots) don't return one — `None` is fine, no
        /// dedup machinery in v1 depends on it.
        message_id: Option<String>,
        /// True when the body was truncated to fit a platform max-
        /// length cap. The agent transcript surfaces this so the
        /// model knows part of its message didn't land.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        truncated: bool,
        /// True when the adapter had to downgrade (e.g. markdown →
        /// text because the sub-kind doesn't support markdown).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        downgraded_format: bool,
    },
    /// Send failed. `retryable` says whether the same payload can be
    /// retried without risking duplicate delivery. Conservative:
    /// connect-timeout = retryable (no bytes sent); read-timeout on
    /// the response = NOT retryable (the request may already have
    /// been processed by the platform).
    Failed {
        /// Single-line human-readable error suitable for surfacing
        /// to operators / agents. Adapter-specific detail goes in
        /// `code` so callers can branch.
        message: String,
        /// Optional adapter-namespaced error code, e.g.
        /// `"wecom_webhook:errcode_45009"`. Lowercase + colons.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        retryable: bool,
    },
}

impl SendOutcome {
    /// Convenience constructor for the trivial happy path.
    pub fn sent() -> Self {
        Self::Sent {
            message_id: None,
            truncated: false,
            downgraded_format: false,
        }
    }

    /// Convenience constructor for non-retryable failures (config
    /// errors, 4xx from platform, etc.). Most adapters surface
    /// these.
    pub fn fail(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
            code: None,
            retryable: false,
        }
    }

    /// Convenience constructor for transient failures the caller
    /// can retry without risking duplicate delivery.
    pub fn fail_retryable(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
            code: None,
            retryable: true,
        }
    }

    pub fn is_sent(&self) -> bool {
        matches!(self, Self::Sent { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_wire_round_trip() {
        for f in [ChannelMessageFormat::Text, ChannelMessageFormat::Markdown] {
            assert_eq!(ChannelMessageFormat::from_wire(f.as_wire()), Some(f));
        }
        assert_eq!(ChannelMessageFormat::from_wire("nope"), None);
    }

    #[test]
    fn outbound_message_builder() {
        let m = OutboundMessage::text("hi")
            .with_format(ChannelMessageFormat::Markdown)
            .with_mentions(vec!["@all".into()]);
        assert_eq!(m.text, "hi");
        assert_eq!(m.format, ChannelMessageFormat::Markdown);
        assert_eq!(m.mentions, vec!["@all".to_string()]);
    }

    #[test]
    fn send_outcome_constructors() {
        assert!(SendOutcome::sent().is_sent());
        let f = SendOutcome::fail("boom");
        match &f {
            SendOutcome::Failed { retryable, .. } => assert!(!retryable),
            _ => panic!(),
        }
        let r = SendOutcome::fail_retryable("transient");
        match &r {
            SendOutcome::Failed { retryable, .. } => assert!(retryable),
            _ => panic!(),
        }
    }

    #[test]
    fn sent_serializes_with_default_field_skipping() {
        let s = SendOutcome::sent();
        let v = serde_json::to_value(&s).unwrap();
        // Default booleans are skipped on the wire to keep the JSON
        // compact for the common happy case.
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("outcome").and_then(|x| x.as_str()), Some("sent"));
        assert!(!obj.contains_key("truncated"));
        assert!(!obj.contains_key("downgraded_format"));
    }
}
