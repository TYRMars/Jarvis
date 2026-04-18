//! SQLite-backed [`ConversationStore`](harness_core::ConversationStore).
//!
//! Opens a pool against the given URL (`sqlite://path/to.db` or
//! `sqlite::memory:`), runs DDL idempotently, and stores each
//! [`Conversation`] as a JSON blob in a single `conversations` table.

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Conversation, ConversationRecord, ConversationStore};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

use crate::error::StoreError;

pub struct SqliteConversationStore {
    pool: SqlitePool,
}

impl SqliteConversationStore {
    /// Connect (creating the file if missing) and run schema migrations.
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::from_str(url)?.create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(options).await?;
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    /// Wrap an already-configured pool (useful in tests).
    pub async fn from_pool(pool: SqlitePool) -> Result<Self, StoreError> {
        migrate(&pool).await?;
        Ok(Self { pool })
    }
}

async fn migrate(pool: &SqlitePool) -> Result<(), StoreError> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id         TEXT PRIMARY KEY,
            messages   TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[async_trait]
impl ConversationStore for SqliteConversationStore {
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        let payload = serde_json::to_string(conversation).map_err(StoreError::from)?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (id, messages, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT(id) DO UPDATE SET
                messages   = excluded.messages,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(&payload)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT messages FROM conversations WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        match row {
            Some((json,)) => {
                let conv: Conversation = serde_json::from_str(&json).map_err(StoreError::from)?;
                Ok(Some(conv))
            }
            None => Ok(None),
        }
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            r#"
            SELECT id, messages, created_at, updated_at
            FROM conversations
            ORDER BY updated_at DESC
            LIMIT ?1
            "#,
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;

        rows.into_iter()
            .map(|(id, messages, created_at, updated_at)| {
                let conv: Conversation =
                    serde_json::from_str(&messages).map_err(StoreError::from)?;
                Ok(ConversationRecord {
                    id,
                    created_at,
                    updated_at,
                    message_count: conv.messages.len(),
                })
            })
            .collect::<Result<Vec<_>, BoxError>>()
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM conversations WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Message;

    async fn make() -> SqliteConversationStore {
        SqliteConversationStore::connect("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn save_load_delete() {
        let store = make().await;
        let mut conv = Conversation::new();
        conv.push(Message::user("hi there"));

        store.save("s1", &conv).await.unwrap();
        let loaded = store.load("s1").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);

        assert!(store.delete("s1").await.unwrap());
        assert!(store.load("s1").await.unwrap().is_none());
        assert!(!store.delete("s1").await.unwrap());
    }

    #[tokio::test]
    async fn list_orders_newest_first() {
        let store = make().await;
        store.save("a", &Conversation::new()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        store.save("b", &Conversation::new()).await.unwrap();

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b");
        assert_eq!(rows[1].id, "a");
    }

    #[tokio::test]
    async fn save_overwrites_existing() {
        let store = make().await;
        let mut a = Conversation::new();
        a.push(Message::user("one"));
        store.save("k", &a).await.unwrap();

        let mut b = Conversation::new();
        b.push(Message::user("one"));
        b.push(Message::user("two"));
        store.save("k", &b).await.unwrap();

        let loaded = store.load("k").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 2);
    }
}
