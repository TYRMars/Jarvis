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
    Activity, ActivityEvent, ActivityStore, AgentProfile, AgentProfileEvent, AgentProfileStore,
    DocDraft, DocEvent, DocKind, DocProject, DocStore, ProjectStore, Requirement, RequirementEvent,
    RequirementRun, RequirementRunEvent, RequirementRunStore, RequirementStatus, RequirementStore,
    TodoEvent, TodoItem, TodoPriority, TodoStatus, TodoStore,
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

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS requirements (
            id               VARCHAR(255) NOT NULL PRIMARY KEY,
            project_id       VARCHAR(255) NOT NULL,
            title            TEXT         NOT NULL,
            description      TEXT,
            status           VARCHAR(32)  NOT NULL,
            conversation_ids TEXT         NOT NULL,
            created_at       VARCHAR(64)  NOT NULL,
            updated_at       VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_req_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'requirements'
             AND INDEX_NAME = 'idx_requirements_project'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_req_index {
        sqlx::query("CREATE INDEX idx_requirements_project ON requirements(project_id)")
            .execute(pool)
            .await?;
    }
    // Phase 3.6: add `assignee_id` column to existing tables.
    // MySQL pre-8.0.29 has no `IF NOT EXISTS` on ADD COLUMN; sniff
    // INFORMATION_SCHEMA first.
    let has_assignee_id: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'requirements'
             AND COLUMN_NAME = 'assignee_id'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_assignee_id {
        sqlx::query("ALTER TABLE requirements ADD COLUMN assignee_id VARCHAR(255)")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agent_profiles (
            id         VARCHAR(255) NOT NULL PRIMARY KEY,
            payload    TEXT         NOT NULL,
            name       VARCHAR(255) NOT NULL,
            created_at VARCHAR(64)  NOT NULL,
            updated_at VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_prof_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'agent_profiles'
             AND INDEX_NAME = 'idx_agent_profiles_name'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_prof_index {
        sqlx::query("CREATE INDEX idx_agent_profiles_name ON agent_profiles(name)")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS requirement_runs (
            id             VARCHAR(255) NOT NULL PRIMARY KEY,
            requirement_id VARCHAR(255) NOT NULL,
            payload        TEXT         NOT NULL,
            status         VARCHAR(32)  NOT NULL,
            started_at     VARCHAR(64)  NOT NULL,
            finished_at    VARCHAR(64)
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_run_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'requirement_runs'
             AND INDEX_NAME = 'idx_requirement_runs_req'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_run_index {
        sqlx::query(
            "CREATE INDEX idx_requirement_runs_req \
             ON requirement_runs(requirement_id, started_at)",
        )
        .execute(pool)
        .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS activities (
            id             VARCHAR(255) NOT NULL PRIMARY KEY,
            requirement_id VARCHAR(255) NOT NULL,
            payload        TEXT         NOT NULL,
            created_at     VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_act_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'activities'
             AND INDEX_NAME = 'idx_activities_req'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_act_index {
        sqlx::query(
            "CREATE INDEX idx_activities_req \
             ON activities(requirement_id, created_at)",
        )
        .execute(pool)
        .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS doc_projects (
            id         VARCHAR(255) NOT NULL PRIMARY KEY,
            workspace  VARCHAR(255) NOT NULL,
            title      TEXT         NOT NULL,
            kind       VARCHAR(32)  NOT NULL,
            created_at VARCHAR(64)  NOT NULL,
            updated_at VARCHAR(64)  NOT NULL,
            tags       TEXT         NOT NULL,
            pinned     TINYINT(1)   NOT NULL DEFAULT 0,
            archived   TINYINT(1)   NOT NULL DEFAULT 0
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_doc_proj_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'doc_projects'
             AND INDEX_NAME = 'idx_doc_projects_workspace'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_doc_proj_index {
        sqlx::query("CREATE INDEX idx_doc_projects_workspace ON doc_projects(workspace)")
            .execute(pool)
            .await?;
    }
    // Forward-compat for databases created before three-pane shipped:
    // add tags / pinned / archived if they're missing. MySQL <8.0.29 has
    // no `ADD COLUMN IF NOT EXISTS`, so sniff INFORMATION_SCHEMA.
    for (col, ddl) in [
        (
            "tags",
            "ALTER TABLE doc_projects ADD COLUMN tags TEXT NOT NULL",
        ),
        (
            "pinned",
            "ALTER TABLE doc_projects ADD COLUMN pinned TINYINT(1) NOT NULL DEFAULT 0",
        ),
        (
            "archived",
            "ALTER TABLE doc_projects ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0",
        ),
    ] {
        let present: bool = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'doc_projects'
                 AND COLUMN_NAME = ?",
        )
        .bind(col)
        .fetch_one(pool)
        .await?
            > 0;
        if !present {
            sqlx::query(ddl).execute(pool).await?;
            // tags is NOT NULL with no default — backfill on rows that
            // existed before the column was added.
            if col == "tags" {
                sqlx::query("UPDATE doc_projects SET tags = '[]' WHERE tags IS NULL OR tags = ''")
                    .execute(pool)
                    .await?;
            }
        }
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS doc_drafts (
            id         VARCHAR(255) NOT NULL PRIMARY KEY,
            project_id VARCHAR(255) NOT NULL,
            format     VARCHAR(32)  NOT NULL,
            content    LONGTEXT     NOT NULL,
            created_at VARCHAR(64)  NOT NULL,
            updated_at VARCHAR(64)  NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    let has_doc_draft_index: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'doc_drafts'
             AND INDEX_NAME = 'idx_doc_drafts_project'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_doc_draft_index {
        sqlx::query("CREATE INDEX idx_doc_drafts_project ON doc_drafts(project_id)")
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

// ---------- RequirementStore --------------------------------------------

pub struct MysqlRequirementStore {
    pool: MySqlPool,
    tx: broadcast::Sender<RequirementEvent>,
}

impl MysqlRequirementStore {
    pub fn from_pool(pool: MySqlPool) -> Self {
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
impl RequirementStore for MysqlRequirementStore {
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
        let rows: Vec<RequirementRow> = sqlx::query_as(
            r#"SELECT id, project_id, title, description, status, conversation_ids,
                       assignee_id, created_at, updated_at
                 FROM requirements
                 WHERE project_id = ?
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
                 FROM requirements WHERE id = ?"#,
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
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    project_id       = VALUES(project_id),
                    title            = VALUES(title),
                    description      = VALUES(description),
                    status           = VALUES(status),
                    conversation_ids = VALUES(conversation_ids),
                    assignee_id      = VALUES(assignee_id),
                    updated_at       = VALUES(updated_at)"#,
        )
        .bind(&item.id)
        .bind(&item.project_id)
        .bind(&item.title)
        .bind(&item.description)
        .bind(item.status.as_wire())
        .bind(&conv_ids)
        .bind(item.assignee_id.as_deref())
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
            sqlx::query_scalar("SELECT project_id FROM requirements WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(project_id) = project_id else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM requirements WHERE id = ?")
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

// ---------- RequirementRunStore ------------------------------------------

pub struct MysqlRequirementRunStore {
    pool: MySqlPool,
    tx: broadcast::Sender<RequirementRunEvent>,
}

impl MysqlRequirementRunStore {
    pub fn from_pool(pool: MySqlPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl RequirementRunStore for MysqlRequirementRunStore {
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM requirement_runs
                 WHERE requirement_id = ?
                 ORDER BY started_at DESC
                 LIMIT 200"#,
        )
        .bind(requirement_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 200 {
            tracing::warn!(
                requirement_id,
                "requirement run list hit 200-item soft cap"
            );
        }
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<RequirementRun>(&payload)
                    .map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn get(&self, id: &str) -> Result<Option<RequirementRun>, BoxError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT payload FROM requirement_runs WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        match row {
            Some((payload,)) => Ok(Some(
                serde_json::from_str::<RequirementRun>(&payload).map_err(StoreError::from)?,
            )),
            None => Ok(None),
        }
    }

    async fn list_all(&self, limit: u32) -> Result<Vec<RequirementRun>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM requirement_runs
                 ORDER BY started_at DESC
                 LIMIT ?"#,
        )
        .bind(limit as u64)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<RequirementRun>(&payload)
                    .map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn upsert(&self, run: &RequirementRun) -> Result<(), BoxError> {
        let prior = self.get(&run.id).await?;
        let payload = serde_json::to_string(run).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO requirement_runs
                (id, requirement_id, payload, status, started_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    requirement_id = VALUES(requirement_id),
                    payload        = VALUES(payload),
                    status         = VALUES(status),
                    started_at     = VALUES(started_at),
                    finished_at    = VALUES(finished_at)"#,
        )
        .bind(&run.id)
        .bind(&run.requirement_id)
        .bind(&payload)
        .bind(run.status.as_wire())
        .bind(&run.started_at)
        .bind(run.finished_at.as_deref())
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if let Some(ev) = crate::memory::classify_run_event(prior.as_ref(), run) {
            let _ = self.tx.send(ev);
        }
        Ok(())
    }

    fn broadcast(&self, ev: RequirementRunEvent) {
        let _ = self.tx.send(ev);
    }

    fn subscribe(&self) -> broadcast::Receiver<RequirementRunEvent> {
        self.tx.subscribe()
    }
}

// ---------- AgentProfileStore --------------------------------------------

pub struct MysqlAgentProfileStore {
    pool: MySqlPool,
    tx: broadcast::Sender<AgentProfileEvent>,
}

impl MysqlAgentProfileStore {
    pub fn from_pool(pool: MySqlPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl AgentProfileStore for MysqlAgentProfileStore {
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT payload FROM agent_profiles ORDER BY name ASC LIMIT 200")
                .fetch_all(&self.pool)
                .await
                .map_err(StoreError::from)?;
        if rows.len() == 200 {
            tracing::warn!("agent profile list hit 200-item soft cap");
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
            sqlx::query_as("SELECT payload FROM agent_profiles WHERE id = ?")
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

    async fn upsert(&self, profile: &AgentProfile) -> Result<(), BoxError> {
        let payload = serde_json::to_string(profile).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO agent_profiles (id, payload, name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    payload    = VALUES(payload),
                    name       = VALUES(name),
                    updated_at = VALUES(updated_at)"#,
        )
        .bind(&profile.id)
        .bind(&payload)
        .bind(&profile.name)
        .bind(&profile.created_at)
        .bind(&profile.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(AgentProfileEvent::Upserted(profile.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM agent_profiles WHERE id = ?")
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

// ---------- ActivityStore ------------------------------------------------

pub struct MysqlActivityStore {
    pool: MySqlPool,
    tx: broadcast::Sender<ActivityEvent>,
}

impl MysqlActivityStore {
    pub fn from_pool(pool: MySqlPool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl ActivityStore for MysqlActivityStore {
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<Activity>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM activities
                 WHERE requirement_id = ?
                 ORDER BY created_at DESC
                 LIMIT 500"#,
        )
        .bind(requirement_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!(requirement_id, "activity list hit 500-item soft cap");
        }
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<Activity>(&payload)
                    .map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn append(&self, activity: &Activity) -> Result<(), BoxError> {
        let payload = serde_json::to_string(activity).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO activities (id, requirement_id, payload, created_at)
                VALUES (?, ?, ?, ?)"#,
        )
        .bind(&activity.id)
        .bind(&activity.requirement_id)
        .bind(&payload)
        .bind(&activity.created_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(ActivityEvent::Appended(activity.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<ActivityEvent> {
        self.tx.subscribe()
    }
}

// ---------- DocStore -----------------------------------------------------

pub struct MysqlDocStore {
    pool: MySqlPool,
    tx: broadcast::Sender<DocEvent>,
}

impl MysqlDocStore {
    pub fn from_pool(pool: MySqlPool) -> Self {
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
    pinned: i8,
    archived: i8,
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
            pinned: self.pinned != 0,
            archived: self.archived != 0,
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
impl DocStore for MysqlDocStore {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
        let rows: Vec<DocProjectRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, kind, created_at, updated_at,
                        tags, pinned, archived
                 FROM doc_projects
                 WHERE workspace = ?
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
                 FROM doc_projects WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(DocProjectRow::into_project).transpose()
    }

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        let pinned: i8 = if project.pinned { 1 } else { 0 };
        let archived: i8 = if project.archived { 1 } else { 0 };
        sqlx::query(
            r#"INSERT INTO doc_projects
                (id, workspace, title, kind, created_at, updated_at,
                 tags, pinned, archived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    workspace  = VALUES(workspace),
                    title      = VALUES(title),
                    kind       = VALUES(kind),
                    updated_at = VALUES(updated_at),
                    tags       = VALUES(tags),
                    pinned     = VALUES(pinned),
                    archived   = VALUES(archived)"#,
        )
        .bind(&project.id)
        .bind(&project.workspace)
        .bind(&project.title)
        .bind(project.kind.as_wire())
        .bind(&project.created_at)
        .bind(&project.updated_at)
        .bind(&tags)
        .bind(pinned)
        .bind(archived)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(DocEvent::ProjectUpserted(project.clone()));
        Ok(())
    }

    async fn delete_project(&self, id: &str) -> Result<bool, BoxError> {
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace FROM doc_projects WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        sqlx::query("DELETE FROM doc_drafts WHERE project_id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        let res = sqlx::query("DELETE FROM doc_projects WHERE id = ?")
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
                 WHERE project_id = ?
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
                 WHERE project_id = ?
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
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    project_id = VALUES(project_id),
                    format     = VALUES(format),
                    content    = VALUES(content),
                    updated_at = VALUES(updated_at)"#,
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
