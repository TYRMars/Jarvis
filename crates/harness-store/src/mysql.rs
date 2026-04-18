//! MySQL-backed [`ConversationStore`](harness_core::ConversationStore).
//!
//! Opens a pool against a `mysql://` or `mariadb://` URL, runs DDL
//! idempotently, and stores each [`Conversation`] as JSON in a single
//! `conversations` table. The primary key is a `VARCHAR(255)` (MySQL
//! can't index full `TEXT` columns without a prefix length).

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Conversation, ConversationRecord, ConversationStore};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::MySqlPool;

use crate::error::StoreError;

pub struct MysqlConversationStore {
    pool: MySqlPool,
}

impl MysqlConversationStore {
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let pool = MySqlPoolOptions::new().connect(url).await?;
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn from_pool(pool: MySqlPool) -> Result<Self, StoreError> {
        migrate(&pool).await?;
        Ok(Self { pool })
    }
}

async fn migrate(pool: &MySqlPool) -> Result<(), StoreError> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id         VARCHAR(255) NOT NULL PRIMARY KEY,
            messages   LONGTEXT     NOT NULL,
            created_at VARCHAR(64)  NOT NULL,
            updated_at VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[async_trait]
impl ConversationStore for MysqlConversationStore {
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        let payload = serde_json::to_string(conversation).map_err(StoreError::from)?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (id, messages, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                messages   = VALUES(messages),
                updated_at = VALUES(updated_at)
            "#,
        )
        .bind(id)
        .bind(&payload)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT messages FROM conversations WHERE id = ?")
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
            LIMIT ?
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
        let res = sqlx::query("DELETE FROM conversations WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }
}
