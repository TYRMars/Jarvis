//! In-process [`ConversationStore`](harness_core::ConversationStore).
//!
//! Useful for tests and as the zero-dep reference impl of the trait.
//! Not intended for production — data is lost when the process exits.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Conversation, ConversationRecord, ConversationStore};
use tokio::sync::RwLock;

#[derive(Clone)]
struct Entry {
    conversation: Conversation,
    created_at: String,
    updated_at: String,
}

/// Stores conversations in a `HashMap` behind an async `RwLock`.
#[derive(Default, Clone)]
pub struct MemoryConversationStore {
    inner: Arc<RwLock<HashMap<String, Entry>>>,
}

impl MemoryConversationStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ConversationStore for MemoryConversationStore {
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        let now = Utc::now().to_rfc3339();
        let mut guard = self.inner.write().await;
        guard
            .entry(id.to_string())
            .and_modify(|e| {
                e.conversation = conversation.clone();
                e.updated_at = now.clone();
            })
            .or_insert_with(|| Entry {
                conversation: conversation.clone(),
                created_at: now.clone(),
                updated_at: now,
            });
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).map(|e| e.conversation.clone()))
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<ConversationRecord> = guard
            .iter()
            .map(|(id, e)| ConversationRecord {
                id: id.clone(),
                created_at: e.created_at.clone(),
                updated_at: e.updated_at.clone(),
                message_count: e.conversation.messages.len(),
            })
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Message;

    #[tokio::test]
    async fn save_load_delete_roundtrip() {
        let store = MemoryConversationStore::new();
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));

        store.save("abc", &conv).await.unwrap();
        let loaded = store.load("abc").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);

        assert!(store.delete("abc").await.unwrap());
        assert!(store.load("abc").await.unwrap().is_none());
        assert!(!store.delete("abc").await.unwrap());
    }

    #[tokio::test]
    async fn list_orders_newest_first() {
        let store = MemoryConversationStore::new();
        store.save("a", &Conversation::new()).await.unwrap();
        // Spin until chrono's rfc3339 string advances; micro/nanoseconds are
        // included, so one `sleep(1ms)` is plenty.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        store.save("b", &Conversation::new()).await.unwrap();

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b");
        assert_eq!(rows[1].id, "a");

        let rows = store.list(1).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "b");
    }
}
