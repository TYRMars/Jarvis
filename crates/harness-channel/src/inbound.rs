//! Inbound primitives (M3 — first inbound kind: WeCom 自建应用).
//!
//! Mirror of Hermes's `MessageEvent` shape from
//! `gateway/platforms/base.py`, keyed by Jarvis's
//! `ChannelInstance.id` so the dispatcher can look up bindings +
//! send replies via the same row.

use serde::{Deserialize, Serialize};

/// Coarse-grained inbound message kind, normalised across platforms.
/// Adapters that receive richer wire shapes (forms, location, cards…)
/// fold them into `Event(name)` with the original payload preserved
/// in [`ChannelInboundEvent::raw`] — keeps the trait stable while
/// new adapter modules add platform-specific kinds without churning
/// the shared crate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum ChannelInboundKind {
    Text,
    Image,
    Voice,
    /// Platform-specific events (subscribe / unsubscribe / member_join /
    /// click / etc.). The string is the platform's event-type name,
    /// lowercased.
    Event(String),
}

impl ChannelInboundKind {
    /// One-line tag suitable for log lines + activity rows.
    pub fn tag(&self) -> String {
        match self {
            Self::Text => "text".into(),
            Self::Image => "image".into(),
            Self::Voice => "voice".into(),
            Self::Event(name) => format!("event:{name}"),
        }
    }
}

/// Inbound message arriving from a configured channel. Mirrors the
/// shape Hermes uses (`MessageEvent` in `gateway/platforms/base.py`)
/// but keyed by Jarvis's `ChannelInstance.id` so the dispatcher can
/// look up bindings + send replies via the same row.
///
/// `thread_id` is reserved for platforms that have threads (Slack,
/// Feishu topics, Discord). WeCom 自建应用 doesn't, so the field
/// stays `None` in M3 — but encoding it now means the binding model
/// doesn't need a breaking change when the second inbound kind lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInboundEvent {
    /// Adapter discriminator, matches `ChannelAdapter::kind()`.
    pub channel: String,
    /// `ChannelInstance.id` this event arrived on. The dispatcher
    /// uses this to route replies back through the same configured
    /// row.
    pub instance_id: String,
    /// Platform-side chat / group / DM identifier. Forms the
    /// `(channel, channel_chat_id)` key used by `ChannelBindingStore`.
    pub external_chat_id: String,
    /// Platform-side sender id, when known. Optional because some
    /// inbound events (subscribe / unsubscribe) don't carry one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_user_id: Option<String>,
    /// Best-effort display name captured at receipt. May be stale
    /// next time we see the same user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Thread / topic id, when the platform has them. Reserve early
    /// so the binding shape doesn't have to change once Slack /
    /// Feishu inbound lands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub text: String,
    pub kind: ChannelInboundKind,
    /// Platform-decoded payload. JSON for most kinds; XML-flavoured
    /// kinds (WeCom AES callback) decode to a `Value` object first.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub raw: serde_json::Value,
    /// RFC-3339 timestamp set when the inbound handler accepted the
    /// payload. Adapters may shadow this with a platform-supplied
    /// timestamp when one is present.
    pub received_at: String,
}

/// HTTP request envelope passed to inbound handlers. Decouples the
/// handler from the axum extractor types so the trait stays in
/// `harness-server` but the request shape is platform-agnostic.
#[derive(Debug, Clone, Default)]
pub struct InboundRequest {
    pub query: std::collections::HashMap<String, String>,
    pub headers: std::collections::HashMap<String, String>,
    pub body: Vec<u8>,
}

/// What to write back to the platform after an inbound handler runs.
/// Different platforms have wildly different ack conventions — WeCom
/// expects HTTP 200 with empty body (ack-and-async), WeChat MP wants
/// a synchronous XML reply, the verification GET wants the verbatim
/// echostr — so this enum is just an opaque payload classifier the
/// route handler maps to its axum response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckPayload {
    /// Empty body, 200 OK. Used for fire-and-forget ack.
    Empty,
    /// Plain bytes, content-type `text/plain`. WeCom GET verification
    /// returns the decrypted echostr verbatim through this branch.
    Plain(Vec<u8>),
    /// XML body, content-type `application/xml`. Used by passive-reply
    /// platforms.
    Xml(String),
}

/// Result of a successful inbound POST: the normalised event +
/// the platform-specific ack payload.
#[derive(Debug, Clone)]
pub struct DecodedInbound {
    pub event: ChannelInboundEvent,
    pub ack: AckPayload,
}
