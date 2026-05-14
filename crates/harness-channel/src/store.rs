//! Persistence traits for channel rows.
//!
//! Two distinct lifecycles, two distinct stores:
//! - [`ChannelInstanceStore`] — operator-configured rows ("I set up
//!   a WeCom group robot in Settings").
//! - [`ChannelBindingStore`] — runtime per-chat mapping rows ("this
//!   WeCom group maps to conversation X"), written at message-
//!   arrival time.
//!
//! Implementations live in `harness-store` (in-memory, JSON file,
//! SQL behind opt-in features).

use async_trait::async_trait;

use crate::binding::ChannelBinding;
use crate::instance::ChannelInstance;

/// `Send + Sync`-bounded boxed error, free of any harness-core
/// coupling so this crate stays a true leaf. Callers that already
/// have a `harness_core::BoxError` can convert via `into()` — same
/// underlying type.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Persistence operations on [`ChannelBinding`] rows. The
/// `(channel, channel_chat_id)` pair is the unique key.
///
/// Channel adapter plugins (Feishu / DingTalk / WeCom / …) call this
/// on every inbound message to answer "is there already a Jarvis
/// conversation for this chat?". The pair `(channel, channel_chat_id)`
/// is the unique key — `channel` matches the plugin manifest's
/// `channel_adapters` map key (e.g. `"wecom"`), `channel_chat_id` is
/// platform-defined (group id, DM userid, …).
///
/// All implementations preserve their on-disk shape across restarts;
/// the JSON-file backend in `harness-store` is the default. Stores
/// don't touch `updated_at` — callers use
/// [`ChannelBinding::touch`] to bump it before `upsert`.
#[async_trait]
pub trait ChannelBindingStore: Send + Sync {
    /// Insert or overwrite a binding. Idempotent on the
    /// `(channel, channel_chat_id)` key.
    async fn upsert(&self, binding: &ChannelBinding) -> Result<(), BoxError>;

    /// Look up by `(channel, channel_chat_id)`. Returns `None` if
    /// no binding exists — adapters use this signal to decide
    /// "create a new conversation" vs "resume an existing one".
    async fn lookup(
        &self,
        channel: &str,
        channel_chat_id: &str,
    ) -> Result<Option<ChannelBinding>, BoxError>;

    /// All bindings owned by `channel`, ordered newest-first by
    /// `updated_at`. Drives admin / debugging UIs and the
    /// per-plugin "active chats" view.
    async fn list_for_channel(&self, channel: &str) -> Result<Vec<ChannelBinding>, BoxError>;

    /// Hard-delete a single binding. Returns `true` if a row was
    /// removed. Used when a user issues `/reset` from inside a
    /// channel chat.
    async fn delete(&self, channel: &str, channel_chat_id: &str) -> Result<bool, BoxError>;

    /// Hard-delete every binding pointing at `conversation_id`.
    /// Called when the underlying conversation is deleted so we
    /// don't leave dangling pointers across channels. Returns the
    /// number of rows removed.
    async fn delete_for_conversation(&self, conversation_id: &str) -> Result<usize, BoxError>;
}

/// Persistence operations on user-configured [`ChannelInstance`]
/// rows. Sibling to [`ChannelBindingStore`]: `ChannelInstance` is
/// the "I configured a WeCom robot in Settings" row;
/// `ChannelBinding` is the per-chat "this WeCom group maps to
/// conversation X" row written at message-arrival time. Two
/// distinct lifecycles, two distinct stores.
///
/// All implementations preserve on-disk shape across restarts; the
/// JSON-file backend in `harness-store` is the default. Stores don't
/// touch `updated_at` — callers use [`ChannelInstance::touch`] before
/// `upsert`.
///
/// `id` is a server-minted UUID (set by [`ChannelInstance::new`]);
/// the trait does not enforce uniqueness on `display_name` so the
/// same human label can appear twice (e.g. two WeCom groups both
/// called "alerts" — that's the operator's call).
#[async_trait]
pub trait ChannelInstanceStore: Send + Sync {
    /// Insert or overwrite a row keyed by `id`.
    async fn upsert(&self, instance: &ChannelInstance) -> Result<(), BoxError>;

    /// Look up by stable id. `None` when absent.
    async fn get(&self, id: &str) -> Result<Option<ChannelInstance>, BoxError>;

    /// All rows ordered newest-first by `updated_at`. The Settings
    /// page renders this directly. The instance count is bounded by
    /// human attention (operator-configured), so no `limit` argument.
    async fn list(&self) -> Result<Vec<ChannelInstance>, BoxError>;

    /// Hard-delete by id. `true` if a row was removed.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}
