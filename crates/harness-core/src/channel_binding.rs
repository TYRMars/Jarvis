//! Channel-binding value type.
//!
//! A `ChannelBinding` records the persistent mapping between a chat
//! on an external messaging platform (Feishu / Lark, DingTalk, WeCom,
//! Telegram, …) and a Jarvis [`Conversation`](crate::Conversation).
//! It's the lookup that lets a channel adapter answer the question
//! *"this user just spoke in WeCom group `wm…ABCD` — which Jarvis
//! conversation should I drop their message into?"* without losing
//! memory across adapter reconnects.
//!
//! The value type lives in `harness-core`; the persistence trait
//! ([`crate::ChannelBindingStore`]) and concrete backends are in
//! `crate::store` and `harness-store` respectively. Channel
//! adapters themselves run as out-of-process plugins under
//! `harness-plugin`'s supervision and only ever see this value type
//! over the wire / SDK boundary.
//!
//! See `docs/proposals/channel-plugins.md` for the larger picture.

use serde::{Deserialize, Serialize};

/// Persistent binding from an external chat to a Jarvis conversation.
///
/// Keyed by `(channel, channel_chat_id)` — that's the unique pair
/// every adapter needs to answer "do I already have a conversation
/// for this chat?". `conversation_id` is the same id used everywhere
/// else in `harness-store` (`ConversationStore::load_envelope`, …),
/// so a binding has full read access to the underlying message log
/// the same way the WS handler does.
///
/// `channel_user_id` is informational — it's the platform-side
/// sender id at binding-creation time. Useful for DM-style bindings
/// (1:1 chats) where the chat id and user id are effectively the
/// same; for groups it just records "who first @-mentioned the bot".
/// `display_name` is best-effort and may be stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelBinding {
    /// Adapter handle, e.g. `"wecom"` / `"feishu"` / `"dingtalk"`.
    /// Matches the plugin manifest's `channel_adapters` map key.
    pub channel: String,
    /// Platform-side identifier for the chat. WeCom uses the
    /// `chatid` (group) or `userid` (DM); Feishu uses the open chat
    /// id; DingTalk uses the `conversationId`. Adapter-defined.
    pub channel_chat_id: String,
    /// Jarvis-internal conversation id. Same shape as everywhere else
    /// in `harness-store`.
    pub conversation_id: String,
    /// RFC-3339 string. Set on insert, never touched on update.
    pub created_at: String,
    /// RFC-3339 string. Bumped by [`Self::touch`] on every inbound.
    pub updated_at: String,
    /// Platform-side user id of the binding's "owner". Informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_user_id: Option<String>,
    /// Best-effort display name captured at binding creation. May
    /// drift; adapters can refresh it on each upsert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl ChannelBinding {
    /// Build a fresh binding with `created_at` == `updated_at` ==
    /// now. Adapters that don't carry a user id / display name pass
    /// `None`.
    pub fn new(
        channel: impl Into<String>,
        channel_chat_id: impl Into<String>,
        conversation_id: impl Into<String>,
        channel_user_id: Option<String>,
        display_name: Option<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            channel: channel.into(),
            channel_chat_id: channel_chat_id.into(),
            conversation_id: conversation_id.into(),
            created_at: now.clone(),
            updated_at: now,
            channel_user_id,
            display_name,
        }
    }

    /// Bump `updated_at` to "now". Stores never mutate timestamps on
    /// the caller's behalf — same convention as
    /// [`crate::ProjectMemory::touch`].
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}
