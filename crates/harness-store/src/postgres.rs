//! Postgres-backed [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_core::ProjectStore).
//!
//! Opens a pool against a `postgres://` or `postgresql://` URL, runs DDL
//! idempotently, and stores each [`Conversation`] as JSON in a single
//! `conversations` table. Projects live in a sibling `projects` table.

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{
    BoxError, Conversation, ConversationMetadata, ConversationRecord, ConversationStore, Project,
    DocDraft, DocEvent, DocKind, DocProject, DocStore, ProjectStore, Requirement, RequirementEvent,
    RequirementStatus, RequirementStore, TodoEvent, TodoItem, TodoPriority, TodoStatus, TodoStore,
    AgentProfile, AgentProfileEvent, AgentProfileStore,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::sync::broadcast;

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

    pub fn pool(&self) -> PgPool {
        self.pool.clone()
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
    // Postgres 9.6+ supports `ADD COLUMN IF NOT EXISTS`.
    sqlx::query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id TEXT")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id           TEXT PRIMARY KEY,
            slug         TEXT NOT NULL UNIQUE,
            name         TEXT NOT NULL,
            description  TEXT,
            instructions TEXT NOT NULL,
            tags         TEXT NOT NULL,
            archived     BOOLEAN NOT NULL DEFAULT FALSE,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS todos (
            id         TEXT PRIMARY KEY,
            workspace  TEXT NOT NULL,
            title      TEXT NOT NULL,
            status     TEXT NOT NULL,
            notes      TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_todos_workspace ON todos(workspace)")
        .execute(pool)
        .await?;
    // Forward-compat: add `priority` column to existing databases
    // that pre-date the field. Postgres 9.6+ supports IF NOT EXISTS.
    sqlx::query("ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority TEXT")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS requirements (
            id               TEXT PRIMARY KEY,
            project_id       TEXT NOT NULL,
            title            TEXT NOT NULL,
            description      TEXT,
            status           TEXT NOT NULL,
            conversation_ids TEXT NOT NULL,
            assignee_id      TEXT,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id)",
    )
    .execute(pool)
    .await?;
    // Idempotent migration for pre-existing tables.
    sqlx::query("ALTER TABLE requirements ADD COLUMN IF NOT EXISTS assignee_id TEXT")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agent_profiles (
            id         TEXT PRIMARY KEY,
            payload    TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_agent_profiles_updated ON agent_profiles(updated_at DESC)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS doc_projects (
            id         TEXT PRIMARY KEY,
            workspace  TEXT NOT NULL,
            title      TEXT NOT NULL,
            kind       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            tags       TEXT    NOT NULL DEFAULT '[]',
            pinned     BOOLEAN NOT NULL DEFAULT FALSE,
            archived   BOOLEAN NOT NULL DEFAULT FALSE
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_doc_projects_workspace ON doc_projects(workspace)",
    )
    .execute(pool)
    .await?;
    // Forward-compat: add the three-pane columns to databases that
    // pre-date them. Postgres supports `ADD COLUMN IF NOT EXISTS`
    // since 9.6 — no probe needed. We mirror the existing Project
    // table's storage shape (TEXT for tags) for consistency.
    for ddl in [
        "ALTER TABLE doc_projects ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE doc_projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE doc_projects ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE",
    ] {
        sqlx::query(ddl).execute(pool).await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS doc_drafts (
            id         TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            format     TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_doc_drafts_project ON doc_drafts(project_id)")
        .execute(pool)
        .await?;

    Ok(())
}

#[async_trait]
impl ConversationStore for PostgresConversationStore {
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
            VALUES ($1, $2, $3, $3, $4)
            ON CONFLICT (id) DO UPDATE SET
                messages   = EXCLUDED.messages,
                updated_at = EXCLUDED.updated_at,
                project_id = EXCLUDED.project_id
            "#,
        )
        .bind(id)
        .bind(&payload)
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
            sqlx::query_as("SELECT messages, project_id FROM conversations WHERE id = $1")
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
            LIMIT $1
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
            WHERE project_id = $1
            ORDER BY updated_at DESC
            LIMIT $2
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
        let res = sqlx::query("DELETE FROM conversations WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }
}

// ---------- ProjectStore ----------------------------------------------------

pub struct PostgresProjectStore {
    pool: PgPool,
}

impl PostgresProjectStore {
    /// Wrap a pool that already passed [`migrate`]. In practice you'll
    /// get this from
    /// [`PostgresConversationStore::pool`](PostgresConversationStore::pool).
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectStore for PostgresProjectStore {
    async fn save(&self, project: &Project) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        sqlx::query(
            r#"
            INSERT INTO projects
                (id, slug, name, description, instructions, tags, archived, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
                slug         = EXCLUDED.slug,
                name         = EXCLUDED.name,
                description  = EXCLUDED.description,
                instructions = EXCLUDED.instructions,
                tags         = EXCLUDED.tags,
                archived     = EXCLUDED.archived,
                updated_at   = EXCLUDED.updated_at
            "#,
        )
        .bind(&project.id)
        .bind(&project.slug)
        .bind(&project.name)
        .bind(&project.description)
        .bind(&project.instructions)
        .bind(&tags)
        .bind(project.archived)
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
                 FROM projects WHERE id = $1"#,
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
                 FROM projects WHERE slug = $1"#,
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
                     LIMIT $1"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        } else {
            sqlx::query_as(
                r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
                     FROM projects
                     WHERE archived = FALSE
                     ORDER BY updated_at DESC
                     LIMIT $1"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        };
        rows.into_iter().map(ProjectRow::into_project).collect()
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query("UPDATE projects SET archived = TRUE, updated_at = $2 WHERE id = $1")
            .bind(id)
            .bind(&now)
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
    archived: bool,
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
            archived: self.archived,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

// ---------- TodoStore -----------------------------------------------------

pub struct PostgresTodoStore {
    pool: PgPool,
    tx: broadcast::Sender<TodoEvent>,
}

impl PostgresTodoStore {
    /// Wrap a pool that's already had [`migrate`] run against it.
    pub fn from_pool(pool: PgPool) -> Self {
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
impl TodoStore for PostgresTodoStore {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
        let rows: Vec<TodoRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, status, priority, notes, created_at, updated_at
                 FROM todos
                 WHERE workspace = $1
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
                 FROM todos WHERE id = $1"#,
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
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO UPDATE SET
                    workspace  = EXCLUDED.workspace,
                    title      = EXCLUDED.title,
                    status     = EXCLUDED.status,
                    priority   = EXCLUDED.priority,
                    notes      = EXCLUDED.notes,
                    updated_at = EXCLUDED.updated_at"#,
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
            sqlx::query_scalar("SELECT workspace FROM todos WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM todos WHERE id = $1")
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

// ---------- RequirementStore --------------------------------------------

pub struct PostgresRequirementStore {
    pool: PgPool,
    tx: broadcast::Sender<RequirementEvent>,
}

impl PostgresRequirementStore {
    pub fn from_pool(pool: PgPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[derive(sqlx::FromRow)]
struct RequirementRow {
    id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    status: String,
    conversation_ids: String,
    assignee_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RequirementRow {
    fn into_requirement(self) -> Result<Requirement, BoxError> {
        let status = RequirementStatus::from_wire(&self.status).ok_or_else(|| -> BoxError {
            format!("unknown requirement status `{}`", self.status).into()
        })?;
        let conversation_ids: Vec<String> =
            serde_json::from_str(&self.conversation_ids).map_err(StoreError::from)?;
        Ok(Requirement {
            id: self.id,
            project_id: self.project_id,
            title: self.title,
            description: self.description,
            status,
            conversation_ids,
            assignee_id: self.assignee_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[async_trait]
impl RequirementStore for PostgresRequirementStore {
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
        let rows: Vec<RequirementRow> = sqlx::query_as(
            r#"SELECT id, project_id, title, description, status, conversation_ids,
                       assignee_id, created_at, updated_at
                 FROM requirements
                 WHERE project_id = $1
                 ORDER BY updated_at DESC
                 LIMIT 500"#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!(project_id, "requirement list hit 500-item soft cap");
        }
        rows.into_iter()
            .map(RequirementRow::into_requirement)
            .collect()
    }

    async fn get(&self, id: &str) -> Result<Option<Requirement>, BoxError> {
        let row: Option<RequirementRow> = sqlx::query_as(
            r#"SELECT id, project_id, title, description, status, conversation_ids,
                       assignee_id, created_at, updated_at
                 FROM requirements WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(RequirementRow::into_requirement).transpose()
    }

    async fn upsert(&self, item: &Requirement) -> Result<(), BoxError> {
        let conv_ids = serde_json::to_string(&item.conversation_ids).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO requirements
                (id, project_id, title, description, status, conversation_ids,
                 assignee_id, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE SET
                    project_id       = EXCLUDED.project_id,
                    title            = EXCLUDED.title,
                    description      = EXCLUDED.description,
                    status           = EXCLUDED.status,
                    conversation_ids = EXCLUDED.conversation_ids,
                    assignee_id      = EXCLUDED.assignee_id,
                    updated_at       = EXCLUDED.updated_at"#,
        )
        .bind(&item.id)
        .bind(&item.project_id)
        .bind(&item.title)
        .bind(&item.description)
        .bind(item.status.as_wire())
        .bind(&conv_ids)
        .bind(&item.assignee_id)
        .bind(&item.created_at)
        .bind(&item.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(RequirementEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let project_id: Option<String> =
            sqlx::query_scalar("SELECT project_id FROM requirements WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(project_id) = project_id else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM requirements WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        if res.rows_affected() > 0 {
            let _ = self.tx.send(RequirementEvent::Deleted {
                project_id,
                id: id.to_string(),
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<RequirementEvent> {
        self.tx.subscribe()
    }
}

// ---------- AgentProfileStore -------------------------------------------

pub struct PostgresAgentProfileStore {
    pool: PgPool,
    tx: broadcast::Sender<AgentProfileEvent>,
}

impl PostgresAgentProfileStore {
    pub fn from_pool(pool: PgPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl AgentProfileStore for PostgresAgentProfileStore {
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload FROM agent_profiles ORDER BY updated_at DESC LIMIT 500"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!("agent profile list hit 500-item soft cap");
        }
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<AgentProfile>(&payload)
                    .map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn get(&self, id: &str) -> Result<Option<AgentProfile>, BoxError> {
        let row: Option<(String,)> =
            sqlx::query_as(r#"SELECT payload FROM agent_profiles WHERE id = $1"#)
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        match row {
            Some((payload,)) => Ok(Some(
                serde_json::from_str::<AgentProfile>(&payload).map_err(StoreError::from)?,
            )),
            None => Ok(None),
        }
    }

    async fn upsert(&self, item: &AgentProfile) -> Result<(), BoxError> {
        let payload = serde_json::to_string(item).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO agent_profiles (id, payload, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT(id) DO UPDATE SET
                   payload    = EXCLUDED.payload,
                   updated_at = EXCLUDED.updated_at"#,
        )
        .bind(&item.id)
        .bind(&payload)
        .bind(&item.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(AgentProfileEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM agent_profiles WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        if res.rows_affected() > 0 {
            let _ = self.tx.send(AgentProfileEvent::Deleted { id: id.to_string() });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<AgentProfileEvent> {
        self.tx.subscribe()
    }
}

// ---------- DocStore -----------------------------------------------------

pub struct PostgresDocStore {
    pool: PgPool,
    tx: broadcast::Sender<DocEvent>,
}

impl PostgresDocStore {
    pub fn from_pool(pool: PgPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[derive(sqlx::FromRow)]
struct DocProjectRow {
    id: String,
    workspace: String,
    title: String,
    kind: String,
    created_at: String,
    updated_at: String,
    tags: String,
    pinned: bool,
    archived: bool,
}

impl DocProjectRow {
    fn into_project(self) -> Result<DocProject, BoxError> {
        let kind = DocKind::from_wire(&self.kind)
            .ok_or_else(|| -> BoxError { format!("unknown doc kind `{}`", self.kind).into() })?;
        let tags: Vec<String> = serde_json::from_str(&self.tags).map_err(StoreError::from)?;
        Ok(DocProject {
            id: self.id,
            workspace: self.workspace,
            title: self.title,
            kind,
            created_at: self.created_at,
            updated_at: self.updated_at,
            tags,
            pinned: self.pinned,
            archived: self.archived,
        })
    }
}

#[derive(sqlx::FromRow)]
struct DocDraftRow {
    id: String,
    project_id: String,
    format: String,
    content: String,
    created_at: String,
    updated_at: String,
}

impl DocDraftRow {
    fn into_draft(self) -> DocDraft {
        DocDraft {
            id: self.id,
            project_id: self.project_id,
            format: self.format,
            content: self.content,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[async_trait]
impl DocStore for PostgresDocStore {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
        let rows: Vec<DocProjectRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, kind, created_at, updated_at,
                        tags, pinned, archived
                 FROM doc_projects
                 WHERE workspace = $1
                 ORDER BY updated_at DESC
                 LIMIT 500"#,
        )
        .bind(workspace)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!(workspace, "doc project list hit 500-item soft cap");
        }
        rows.into_iter().map(DocProjectRow::into_project).collect()
    }

    async fn get_project(&self, id: &str) -> Result<Option<DocProject>, BoxError> {
        let row: Option<DocProjectRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, kind, created_at, updated_at,
                        tags, pinned, archived
                 FROM doc_projects WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(DocProjectRow::into_project).transpose()
    }

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO doc_projects
                (id, workspace, title, kind, created_at, updated_at,
                 tags, pinned, archived)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE SET
                    workspace  = EXCLUDED.workspace,
                    title      = EXCLUDED.title,
                    kind       = EXCLUDED.kind,
                    updated_at = EXCLUDED.updated_at,
                    tags       = EXCLUDED.tags,
                    pinned     = EXCLUDED.pinned,
                    archived   = EXCLUDED.archived"#,
        )
        .bind(&project.id)
        .bind(&project.workspace)
        .bind(&project.title)
        .bind(project.kind.as_wire())
        .bind(&project.created_at)
        .bind(&project.updated_at)
        .bind(&tags)
        .bind(project.pinned)
        .bind(project.archived)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(DocEvent::ProjectUpserted(project.clone()));
        Ok(())
    }

    async fn delete_project(&self, id: &str) -> Result<bool, BoxError> {
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace FROM doc_projects WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        sqlx::query("DELETE FROM doc_drafts WHERE project_id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        let res = sqlx::query("DELETE FROM doc_projects WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        if res.rows_affected() > 0 {
            let _ = self.tx.send(DocEvent::ProjectDeleted {
                workspace,
                id: id.to_string(),
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn list_drafts(&self, project_id: &str) -> Result<Vec<DocDraft>, BoxError> {
        let rows: Vec<DocDraftRow> = sqlx::query_as(
            r#"SELECT id, project_id, format, content, created_at, updated_at
                 FROM doc_drafts
                 WHERE project_id = $1
                 ORDER BY updated_at DESC"#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(rows.into_iter().map(DocDraftRow::into_draft).collect())
    }

    async fn latest_draft(&self, project_id: &str) -> Result<Option<DocDraft>, BoxError> {
        let row: Option<DocDraftRow> = sqlx::query_as(
            r#"SELECT id, project_id, format, content, created_at, updated_at
                 FROM doc_drafts
                 WHERE project_id = $1
                 ORDER BY updated_at DESC
                 LIMIT 1"#,
        )
        .bind(project_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(row.map(DocDraftRow::into_draft))
    }

    async fn upsert_draft(&self, draft: &DocDraft) -> Result<(), BoxError> {
        sqlx::query(
            r#"INSERT INTO doc_drafts
                (id, project_id, format, content, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                    project_id = EXCLUDED.project_id,
                    format     = EXCLUDED.format,
                    content    = EXCLUDED.content,
                    updated_at = EXCLUDED.updated_at"#,
        )
        .bind(&draft.id)
        .bind(&draft.project_id)
        .bind(&draft.format)
        .bind(&draft.content)
        .bind(&draft.created_at)
        .bind(&draft.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(DocEvent::DraftUpserted(draft.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<DocEvent> {
        self.tx.subscribe()
    }
}
