//! MySQL-backed [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_core::ProjectStore).
//!
//! Opens a pool against a `mysql://` or `mariadb://` URL, runs DDL
//! idempotently, and stores each [`Conversation`] as JSON in a single
//! `conversations` table. Projects live in a sibling `projects` table.
//! The primary key is a `VARCHAR(255)` (MySQL can't index full `TEXT`
//! columns without a prefix length).

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{
    BoxError, Conversation, ConversationMetadata, ConversationRecord, ConversationStore, Project,
    ProjectStore, TodoEvent, TodoItem, TodoPriority, TodoStatus, TodoStore,
};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::MySqlPool;
use tokio::sync::broadcast;

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

    pub fn pool(&self) -> MySqlPool {
        self.pool.clone()
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

    // MySQL <8.0.29 doesn't support `ADD COLUMN IF NOT EXISTS`. Sniff
    // INFORMATION_SCHEMA so the migration is idempotent on every
    // reasonable version.
    let has_project_id: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'conversations'
             AND COLUMN_NAME = 'project_id'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_project_id {
        sqlx::query("ALTER TABLE conversations ADD COLUMN project_id VARCHAR(255) NULL")
            .execute(pool)
            .await?;
    }
    // CREATE INDEX IF NOT EXISTS isn't standard in MySQL — sniff first.
    let has_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'conversations'
             AND INDEX_NAME = 'idx_conversations_project'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_index {
        sqlx::query("CREATE INDEX idx_conversations_project ON conversations(project_id)")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id           VARCHAR(255) NOT NULL PRIMARY KEY,
            slug         VARCHAR(64)  NOT NULL UNIQUE,
            name         VARCHAR(255) NOT NULL,
            description  TEXT,
            instructions LONGTEXT     NOT NULL,
            tags         TEXT         NOT NULL,
            archived     TINYINT(1)   NOT NULL DEFAULT 0,
            created_at   VARCHAR(64)  NOT NULL,
            updated_at   VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS todos (
            id         VARCHAR(255) NOT NULL PRIMARY KEY,
            workspace  VARCHAR(255) NOT NULL,
            title      TEXT         NOT NULL,
            status     VARCHAR(32)  NOT NULL,
            notes      TEXT,
            created_at VARCHAR(64)  NOT NULL,
            updated_at VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_todos_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'todos'
             AND INDEX_NAME = 'idx_todos_workspace'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_todos_index {
        sqlx::query("CREATE INDEX idx_todos_workspace ON todos(workspace)")
            .execute(pool)
            .await?;
    }
    // Forward-compat: add `priority` column to existing databases
    // that pre-date the field. MySQL <8.0.29 lacks IF NOT EXISTS,
    // so sniff INFORMATION_SCHEMA first.
    let has_priority: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'todos'
             AND COLUMN_NAME = 'priority'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_priority {
        sqlx::query("ALTER TABLE todos ADD COLUMN priority VARCHAR(32) NULL")
            .execute(pool)
            .await?;
    }

    Ok(())
}

#[async_trait]
impl ConversationStore for MysqlConversationStore {
    async fn save_envelope(
        &self,
        id: &str,
        conversation: &Conversation,
        metadata: &ConversationMetadata,
    ) -> Result<(), BoxError> {
        let payload = serde_json::to_string(conversation).map_err(StoreError::from)?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (id, messages, created_at, updated_at, project_id)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                messages   = VALUES(messages),
                updated_at = VALUES(updated_at),
                project_id = VALUES(project_id)
            "#,
        )
        .bind(id)
        .bind(&payload)
        .bind(&now)
        .bind(&now)
        .bind(&metadata.project_id)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(())
    }

    async fn load_envelope(
        &self,
        id: &str,
    ) -> Result<Option<(Conversation, ConversationMetadata)>, BoxError> {
        let row: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT messages, project_id FROM conversations WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        match row {
            Some((json, project_id)) => {
                let conv: Conversation = serde_json::from_str(&json).map_err(StoreError::from)?;
                Ok(Some((conv, ConversationMetadata { project_id })))
            }
            None => Ok(None),
        }
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
            r#"
            SELECT id, messages, created_at, updated_at, project_id
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
            .map(|(id, messages, created_at, updated_at, project_id)| {
                let conv: Conversation =
                    serde_json::from_str(&messages).map_err(StoreError::from)?;
                Ok(ConversationRecord {
                    id,
                    created_at,
                    updated_at,
                    message_count: conv.messages.len(),
                    project_id,
                })
            })
            .collect::<Result<Vec<_>, BoxError>>()
    }

    async fn list_by_project(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<ConversationRecord>, BoxError> {
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            r#"
            SELECT id, messages, created_at, updated_at
            FROM conversations
            WHERE project_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            "#,
        )
        .bind(project_id)
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
                    project_id: Some(project_id.to_string()),
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

// ---------- ProjectStore ----------------------------------------------------

pub struct MysqlProjectStore {
    pool: MySqlPool,
}

impl MysqlProjectStore {
    /// Wrap a pool that already passed [`migrate`]. In practice you'll
    /// get this from
    /// [`MysqlConversationStore::pool`](MysqlConversationStore::pool).
    pub fn from_pool(pool: MySqlPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectStore for MysqlProjectStore {
    async fn save(&self, project: &Project) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        let archived: i8 = if project.archived { 1 } else { 0 };
        sqlx::query(
            r#"
            INSERT INTO projects
                (id, slug, name, description, instructions, tags, archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                slug         = VALUES(slug),
                name         = VALUES(name),
                description  = VALUES(description),
                instructions = VALUES(instructions),
                tags         = VALUES(tags),
                archived     = VALUES(archived),
                updated_at   = VALUES(updated_at)
            "#,
        )
        .bind(&project.id)
        .bind(&project.slug)
        .bind(&project.name)
        .bind(&project.description)
        .bind(&project.instructions)
        .bind(&tags)
        .bind(archived)
        .bind(&project.created_at)
        .bind(&project.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Project>, BoxError> {
        let row: Option<ProjectRow> = sqlx::query_as(
            r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
                 FROM projects WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(ProjectRow::into_project).transpose()
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError> {
        let row: Option<ProjectRow> = sqlx::query_as(
            r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
                 FROM projects WHERE slug = ?"#,
        )
        .bind(slug)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(ProjectRow::into_project).transpose()
    }

    async fn list(&self, include_archived: bool, limit: u32) -> Result<Vec<Project>, BoxError> {
        let rows: Vec<ProjectRow> = if include_archived {
            sqlx::query_as(
                r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
                     FROM projects
                     ORDER BY updated_at DESC
                     LIMIT ?"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        } else {
            sqlx::query_as(
                r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
                     FROM projects
                     WHERE archived = 0
                     ORDER BY updated_at DESC
                     LIMIT ?"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        };
        rows.into_iter().map(ProjectRow::into_project).collect()
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    instructions: String,
    tags: String,
    archived: i8,
    created_at: String,
    updated_at: String,
}

impl ProjectRow {
    fn into_project(self) -> Result<Project, BoxError> {
        let tags: Vec<String> = serde_json::from_str(&self.tags).map_err(StoreError::from)?;
        Ok(Project {
            id: self.id,
            slug: self.slug,
            name: self.name,
            description: self.description,
            instructions: self.instructions,
            tags,
            archived: self.archived != 0,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

// ---------- TodoStore -----------------------------------------------------

pub struct MysqlTodoStore {
    pool: MySqlPool,
    tx: broadcast::Sender<TodoEvent>,
}

impl MysqlTodoStore {
    /// Wrap a pool that's already had [`migrate`] run against it.
    pub fn from_pool(pool: MySqlPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[derive(sqlx::FromRow)]
struct TodoRow {
    id: String,
    workspace: String,
    title: String,
    status: String,
    priority: Option<String>,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TodoRow {
    fn into_item(self) -> Result<TodoItem, BoxError> {
        let status = TodoStatus::from_wire(&self.status)
            .ok_or_else(|| -> BoxError { format!("unknown status `{}`", self.status).into() })?;
        let priority = self.priority.as_deref().and_then(TodoPriority::from_wire);
        Ok(TodoItem {
            id: self.id,
            workspace: self.workspace,
            title: self.title,
            status,
            priority,
            notes: self.notes,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[async_trait]
impl TodoStore for MysqlTodoStore {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
        let rows: Vec<TodoRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, status, priority, notes, created_at, updated_at
                 FROM todos
                 WHERE workspace = ?
                 ORDER BY updated_at DESC
                 LIMIT 500"#,
        )
        .bind(workspace)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!(workspace, "todo list hit 500-item soft cap");
        }
        rows.into_iter().map(TodoRow::into_item).collect()
    }

    async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError> {
        let row: Option<TodoRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, status, priority, notes, created_at, updated_at
                 FROM todos WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(TodoRow::into_item).transpose()
    }

    async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError> {
        sqlx::query(
            r#"INSERT INTO todos
                (id, workspace, title, status, priority, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    workspace  = VALUES(workspace),
                    title      = VALUES(title),
                    status     = VALUES(status),
                    priority   = VALUES(priority),
                    notes      = VALUES(notes),
                    updated_at = VALUES(updated_at)"#,
        )
        .bind(&item.id)
        .bind(&item.workspace)
        .bind(&item.title)
        .bind(item.status.as_wire())
        .bind(item.priority.map(|p| p.as_wire()))
        .bind(&item.notes)
        .bind(&item.created_at)
        .bind(&item.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(TodoEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace FROM todos WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM todos WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        if res.rows_affected() > 0 {
            let _ = self.tx.send(TodoEvent::Deleted {
                workspace,
                id: id.to_string(),
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<TodoEvent> {
        self.tx.subscribe()
    }
}
