//! Postgres-backed [`ConversationStore`](harness_core::ConversationStore).
//!
//! Opens a pool against a `postgres://` or `postgresql://` URL, runs DDL
//! idempotently, and stores each [`Conversation`] as JSON in a single
//! `conversations` table.

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Conversation, ConversationRecord, ConversationStore};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::error::StoreError;

pub struct PostgresConversationStore {
    pool: PgPool,
}

impl PostgresConversationStore {
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new().connect(url).await?;
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn from_pool(pool: PgPool) -> Result<Self, StoreError> {
        migrate(&pool).await?;
        Ok(Self { pool })
    }
}

async fn migrate(pool: &PgPool) -> Result<(), StoreError> {
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
impl ConversationStore for PostgresConversationStore {
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        let payload = serde_json::to_string(conversation).map_err(StoreError::from)?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (id, messages, created_at, updated_at)
            VALUES ($1, $2, $3, $3)
            ON CONFLICT (id) DO UPDATE SET
                messages   = EXCLUDED.messages,
                updated_at = EXCLUDED.updated_at
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
            sqlx::query_as("SELECT messages FROM conversations WHERE id = $1")
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
            LIMIT $1
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
        let res = sqlx::query("DELETE FROM conversations WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }
}
