//! Pluggable persistence for [`Conversation`](crate::Conversation)s.
//!
//! `harness-core` defines only the trait and a few value types; concrete
//! backends live in `harness-store` so callers can pick SQLite, Postgres,
//! MySQL, or an in-memory store without paying for the others' deps.

use async_trait::async_trait;

use crate::conversation::Conversation;
use crate::error::BoxError;

/// Summary record returned by [`ConversationStore::list`].
#[derive(Debug, Clone)]
pub struct ConversationRecord {
    pub id: String,
    /// ISO-8601 / RFC-3339 timestamps. We keep these as strings to avoid
    /// forcing a time crate into the public surface of `harness-core`.
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

/// Persistence operations on conversations, keyed by an opaque id chosen
/// by the caller (e.g. a session UUID).
///
/// Implementations must be safe to share across tasks.
#[async_trait]
pub trait ConversationStore: Send + Sync {
    /// Insert or overwrite the conversation stored at `id`.
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError>;

    /// Load the conversation at `id`, or `None` if it doesn't exist.
    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError>;

    /// List up to `limit` conversations, newest first.
    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError>;

    /// Delete the conversation at `id`. Deleting a non-existent id is a
    /// no-op and returns `Ok(false)`; deleting an existing row returns
    /// `Ok(true)`.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}
