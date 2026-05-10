//! SQLite-backed [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_core::ProjectStore).
//!
//! Opens a pool against the given URL (`sqlite://path/to.db` or
//! `sqlite::memory:`), runs DDL idempotently, and stores each
//! [`Conversation`] as a JSON blob in a single `conversations` table.
//! Projects live in a sibling `projects` table.
//!
//! ## Schema migration
//!
//! The `conversations` table grew a nullable `project_id` column for
//! the Project feature. `migrate()` runs `ALTER TABLE ... ADD COLUMN`
//! after detecting the column is absent (SQLite has no `IF NOT EXISTS`
//! for `ADD COLUMN`, so we sniff `pragma_table_info`). Old databases
//! migrate forward; old binaries reading new databases keep working
//! (they ignore the extra column).

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{
    Activity, ActivityEvent, ActivityStore, AgentProfile, AgentProfileEvent, AgentProfileStore,
    BoxError, Comment, CommentEvent, CommentStore, Conversation, ConversationMetadata,
    ConversationRecord, ConversationStore, DocDraft, DocEvent, DocKind, DocProject, DocStore,
    KanbanColumn, Label, LabelEvent, LabelStore, Project, ProjectAutomation, ProjectStore,
    Requirement, RequirementEvent, RequirementRun, RequirementRunEvent, RequirementRunStore,
    RequirementStatus, RequirementStore, Tenant, TenantStore, TodoEvent, TodoItem, TodoPriority,
    TodoStatus, TodoStore,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;
use tokio::sync::broadcast;

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

    /// Wrap an already-configured pool (useful in tests, and for
    /// sharing the pool with [`SqliteProjectStore`]).
    pub async fn from_pool(pool: SqlitePool) -> Result<Self, StoreError> {
        migrate(&pool).await?;
        Ok(Self { pool })
    }

    /// Hand back a clone of the underlying pool — `SqliteProjectStore`
    /// uses this to share the connection (essential for `:memory:`,
    /// where each connection is a separate database).
    pub fn pool(&self) -> SqlitePool {
        self.pool.clone()
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

    // Add project_id column if it's missing (forward-compat with
    // databases created by older binaries).
    let has_project_id: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name = 'project_id'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_project_id {
        sqlx::query("ALTER TABLE conversations ADD COLUMN project_id TEXT")
            .execute(pool)
            .await?;
    }
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
            workspaces   TEXT NOT NULL DEFAULT '[]',
            columns      TEXT,
            automation   TEXT NOT NULL DEFAULT '{"auto_mode_enabled":true}',
            archived     INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    // Forward-compat: older databases created before multi-workspace
    // shipped are missing `workspaces`. Same pragma_table_info dance as
    // doc_projects below.
    let has_workspaces: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'workspaces'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_workspaces {
        sqlx::query("ALTER TABLE projects ADD COLUMN workspaces TEXT NOT NULL DEFAULT '[]'")
            .execute(pool)
            .await?;
    }
    let has_columns: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'columns'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_columns {
        sqlx::query("ALTER TABLE projects ADD COLUMN columns TEXT")
            .execute(pool)
            .await?;
    }
    let has_automation: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'automation'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_automation {
        sqlx::query(
            r#"ALTER TABLE projects ADD COLUMN automation TEXT NOT NULL DEFAULT '{"auto_mode_enabled":true}'"#,
        )
        .execute(pool)
        .await?;
    }

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
    // Add `priority` column if it's missing (forward-compat with
    // databases created before TodoItem.priority shipped).
    let has_priority: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('todos') WHERE name = 'priority'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_priority {
        sqlx::query("ALTER TABLE todos ADD COLUMN priority TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS requirements (
            id               TEXT PRIMARY KEY,
            project_id       TEXT NOT NULL,
            title            TEXT NOT NULL,
            description      TEXT,
            status           TEXT NOT NULL,
            conversation_ids TEXT NOT NULL,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id)")
        .execute(pool)
        .await?;
    // Phase 3.6: add `assignee_id` column to existing databases.
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; sniff via
    // `pragma_table_info` first.
    let has_assignee_id: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('requirements') WHERE name = 'assignee_id'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_assignee_id {
        sqlx::query("ALTER TABLE requirements ADD COLUMN assignee_id TEXT")
            .execute(pool)
            .await?;
    }
    // Phase 6 — verification_plan stored as a JSON-encoded
    // Option<VerificationPlan>. NULL ⇒ no plan.
    let has_verification_plan: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('requirements') WHERE name = 'verification_plan'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_verification_plan {
        sqlx::query("ALTER TABLE requirements ADD COLUMN verification_plan TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agent_profiles (
            id         TEXT PRIMARY KEY,
            payload    TEXT NOT NULL,
            name       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_profiles_name ON agent_profiles(name)")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS requirement_runs (
            id             TEXT PRIMARY KEY,
            requirement_id TEXT NOT NULL,
            payload        TEXT NOT NULL,
            status         TEXT NOT NULL,
            started_at     TEXT NOT NULL,
            finished_at    TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_requirement_runs_req \
         ON requirement_runs(requirement_id, started_at DESC)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS activities (
            id             TEXT PRIMARY KEY,
            requirement_id TEXT NOT NULL,
            payload        TEXT NOT NULL,
            created_at     TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_activities_req \
         ON activities(requirement_id, created_at DESC)",
    )
    .execute(pool)
    .await?;

    // Phase 3.8 — Comments. One row per discussion entry, scoped to
    // a `requirement_id`. `parent_id` is nullable for top-level rows
    // and references another `comments.id` for depth-1 replies; the
    // depth invariant is enforced in app code (the store rejects
    // `parent_id` whose own `parent_id` is non-null) so the DB
    // doesn't need a self-referential FK. `payload` carries the full
    // serde JSON of the row so future `Comment` fields don't require
    // a column-level migration.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS comments (
            id             TEXT PRIMARY KEY,
            requirement_id TEXT NOT NULL,
            parent_id      TEXT,
            payload        TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_comments_req \
         ON comments(requirement_id, created_at ASC)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_comments_parent \
         ON comments(parent_id)",
    )
    .execute(pool)
    .await?;

    // Phase 3.8 — Labels. One row per project-scoped tag. Name
    // uniqueness within a project is enforced in app code
    // (case-insensitive); the DB only enforces id PK.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS labels (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL,
            name        TEXT NOT NULL,
            colour      TEXT NOT NULL,
            payload     TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_labels_proj \
         ON labels(project_id, name)",
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
            tags       TEXT NOT NULL DEFAULT '[]',
            pinned     INTEGER NOT NULL DEFAULT 0,
            archived   INTEGER NOT NULL DEFAULT 0
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_doc_projects_workspace ON doc_projects(workspace)")
        .execute(pool)
        .await?;
    // Forward-compat: older databases created before three-pane shipped
    // are missing tags / pinned / archived. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so we sniff pragma_table_info first.
    for (col, ddl) in [
        (
            "tags",
            "ALTER TABLE doc_projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "pinned",
            "ALTER TABLE doc_projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "archived",
            "ALTER TABLE doc_projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        let present: bool = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('doc_projects') WHERE name = ?1",
        )
        .bind(col)
        .fetch_one(pool)
        .await?
            > 0;
        if !present {
            sqlx::query(ddl).execute(pool).await?;
        }
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

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tenants (
            id         TEXT PRIMARY KEY,
            slug       TEXT NOT NULL UNIQUE,
            name       TEXT NOT NULL,
            settings   TEXT NOT NULL DEFAULT '{}',
            archived   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)")
        .execute(pool)
        .await?;

    // ---------- Cloud nodes (harness-cloud integration) ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS cloud_nodes (
            id               TEXT PRIMARY KEY,
            display_name     TEXT,
            provider         TEXT NOT NULL,
            region           TEXT,
            labels_json      TEXT NOT NULL DEFAULT '[]',
            capabilities_json TEXT NOT NULL DEFAULT '{}',
            status           TEXT NOT NULL DEFAULT 'unknown',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            last_seen_at     TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_cloud_nodes_status ON cloud_nodes(status)")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS cloud_tool_invocations (
            id             TEXT PRIMARY KEY,
            node_id        TEXT NOT NULL,
            tool_name      TEXT NOT NULL,
            args_json      TEXT NOT NULL DEFAULT '{}',
            result_status   TEXT NOT NULL DEFAULT 'pending',
            result_excerpt  TEXT,
            requested_by    TEXT,
            conversation_id TEXT,
            created_at      TEXT NOT NULL,
            completed_at    TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_cloud_tool_invocations_node \
         ON cloud_tool_invocations(node_id, created_at DESC)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_cloud_tool_invocations_convo \
         ON cloud_tool_invocations(conversation_id, created_at DESC)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[async_trait]
impl ConversationStore for SqliteConversationStore {
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
            VALUES (?1, ?2, ?3, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                messages   = excluded.messages,
                updated_at = excluded.updated_at,
                project_id = excluded.project_id
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
            sqlx::query_as("SELECT messages, project_id FROM conversations WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        match row {
            Some((json, project_id)) => {
                let conv: Conversation = serde_json::from_str(&json).map_err(StoreError::from)?;
                Ok(Some((
                    conv,
                    ConversationMetadata {
                        project_id,
                        // Lifecycle column not yet present in the SQL
                        // schema — treat all rows as Active for now;
                        // a future migration can add the column +
                        // populate it from existing data.
                        lifecycle: Default::default(),
                    },
                )))
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
            LIMIT ?1
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
                    lifecycle: Default::default(),
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
            WHERE project_id = ?1
            ORDER BY updated_at DESC
            LIMIT ?2
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
                    lifecycle: Default::default(),
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

// ---------- ProjectStore ----------------------------------------------------

pub struct SqliteProjectStore {
    pool: SqlitePool,
}

impl SqliteProjectStore {
    /// Wrap a pool that's already had [`migrate`] run against it.
    /// In practice you'll get this from
    /// [`SqliteConversationStore::pool`](SqliteConversationStore::pool)
    /// so the two stores share one connection.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectStore for SqliteProjectStore {
    async fn save(&self, project: &Project) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        let workspaces = serde_json::to_string(&project.workspaces).map_err(StoreError::from)?;
        let columns = project
            .columns
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(StoreError::from)?;
        let automation = serde_json::to_string(&project.automation).map_err(StoreError::from)?;
        let archived: i64 = if project.archived { 1 } else { 0 };
        sqlx::query(
            r#"
            INSERT INTO projects
                (id, slug, name, description, instructions, tags, workspaces, columns, automation, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                slug         = excluded.slug,
                name         = excluded.name,
                description  = excluded.description,
                instructions = excluded.instructions,
                tags         = excluded.tags,
                workspaces   = excluded.workspaces,
                columns      = excluded.columns,
                automation   = excluded.automation,
                archived     = excluded.archived,
                updated_at   = excluded.updated_at
            "#,
        )
        .bind(&project.id)
        .bind(&project.slug)
        .bind(&project.name)
        .bind(&project.description)
        .bind(&project.instructions)
        .bind(&tags)
        .bind(&workspaces)
        .bind(&columns)
        .bind(&automation)
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
            r#"SELECT id, slug, name, description, instructions, tags, workspaces, columns, automation, archived, created_at, updated_at
                 FROM projects WHERE id = ?1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(ProjectRow::into_project).transpose()
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError> {
        let row: Option<ProjectRow> = sqlx::query_as(
            r#"SELECT id, slug, name, description, instructions, tags, workspaces, columns, automation, archived, created_at, updated_at
                 FROM projects WHERE slug = ?1"#,
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
                r#"SELECT id, slug, name, description, instructions, tags, workspaces, columns, automation, archived, created_at, updated_at
                     FROM projects
                     ORDER BY updated_at DESC
                     LIMIT ?1"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        } else {
            sqlx::query_as(
                r#"SELECT id, slug, name, description, instructions, tags, workspaces, columns, automation, archived, created_at, updated_at
                     FROM projects
                     WHERE archived = 0
                     ORDER BY updated_at DESC
                     LIMIT ?1"#,
            )
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(StoreError::from)?
        };
        rows.into_iter().map(ProjectRow::into_project).collect()
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM projects WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query("UPDATE projects SET archived = 1, updated_at = ?2 WHERE id = ?1")
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
    workspaces: String,
    columns: Option<String>,
    automation: String,
    archived: i64,
    created_at: String,
    updated_at: String,
}

impl ProjectRow {
    fn into_project(self) -> Result<Project, BoxError> {
        let tags: Vec<String> = serde_json::from_str(&self.tags).map_err(StoreError::from)?;
        // Tolerate empty / NULL-equivalent payloads; the migration
        // backfills `'[]'` but a hand-edited DB might not.
        let workspaces: Vec<harness_core::ProjectWorkspace> = if self.workspaces.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&self.workspaces).map_err(StoreError::from)?
        };
        let columns: Option<Vec<KanbanColumn>> = self
            .columns
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(serde_json::from_str)
            .transpose()
            .map_err(StoreError::from)?;
        let automation: ProjectAutomation = if self.automation.trim().is_empty() {
            ProjectAutomation::default()
        } else {
            serde_json::from_str(&self.automation).map_err(StoreError::from)?
        };
        Ok(Project {
            id: self.id,
            slug: self.slug,
            name: self.name,
            description: self.description,
            instructions: self.instructions,
            tags,
            workspaces,
            archived: self.archived != 0,
            columns,
            automation,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

// ---------- TodoStore -----------------------------------------------------

pub struct SqliteTodoStore {
    pool: SqlitePool,
    tx: broadcast::Sender<TodoEvent>,
}

impl SqliteTodoStore {
    /// Wrap a pool that's already had [`migrate`] run against it. In
    /// practice the binary gets the pool from
    /// [`SqliteConversationStore::pool`] so the three stores share one
    /// connection (essential for `:memory:`, where each connection is
    /// a separate database).
    pub fn from_pool(pool: SqlitePool) -> Self {
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
        // Unknown priority values silently downgrade to `None` —
        // forward-compat with future enum widening.
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
impl TodoStore for SqliteTodoStore {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
        let rows: Vec<TodoRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, status, priority, notes, created_at, updated_at
                 FROM todos
                 WHERE workspace = ?1
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
                 FROM todos WHERE id = ?1"#,
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
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(id) DO UPDATE SET
                    workspace  = excluded.workspace,
                    title      = excluded.title,
                    status     = excluded.status,
                    priority   = excluded.priority,
                    notes      = excluded.notes,
                    updated_at = excluded.updated_at"#,
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
        // Fetch the workspace before deleting so we can broadcast it.
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace FROM todos WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM todos WHERE id = ?1")
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

// ---------- RequirementStore ---------------------------------------------

pub struct SqliteRequirementStore {
    pool: SqlitePool,
    tx: broadcast::Sender<RequirementEvent>,
}

impl SqliteRequirementStore {
    /// Wrap a pool that's already had [`migrate`] run against it. In
    /// practice the binary gets the pool from
    /// [`SqliteConversationStore::pool`] so the four stores share one
    /// connection (essential for `:memory:`, where each connection is
    /// a separate database).
    pub fn from_pool(pool: SqlitePool) -> Self {
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
    verification_plan: Option<String>,
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
        let verification_plan = match self.verification_plan {
            Some(s) => Some(serde_json::from_str(&s).map_err(StoreError::from)?),
            None => None,
        };
        // Phase 3.6 / v1.0 / Phase 3.8 fields aren't yet stored in
        // dedicated columns by the SQL backends — they default to the
        // same values `Requirement::new` would produce. The JSON
        // backend already preserves them via the row blob; bringing
        // SQL parity is a separate migration.
        Ok(Requirement {
            id: self.id,
            project_id: self.project_id,
            title: self.title,
            description: self.description,
            status,
            conversation_ids,
            assignee_id: self.assignee_id,
            verification_plan,
            todos: Vec::new(),
            triage_state: harness_core::TriageState::Approved,
            depends_on: Vec::new(),
            label_ids: Vec::new(),
            acceptance_policy: harness_core::AcceptancePolicy::Subagent,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[async_trait]
impl RequirementStore for SqliteRequirementStore {
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
        let rows: Vec<RequirementRow> = sqlx::query_as(
            r#"SELECT id, project_id, title, description, status, conversation_ids,
                       assignee_id, verification_plan, created_at, updated_at
                 FROM requirements
                 WHERE project_id = ?1
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
                       assignee_id, verification_plan, created_at, updated_at
                 FROM requirements WHERE id = ?1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(RequirementRow::into_requirement).transpose()
    }

    async fn upsert(&self, item: &Requirement) -> Result<(), BoxError> {
        let conv_ids = serde_json::to_string(&item.conversation_ids).map_err(StoreError::from)?;
        let plan_json = match item.verification_plan.as_ref() {
            Some(p) => Some(serde_json::to_string(p).map_err(StoreError::from)?),
            None => None,
        };
        sqlx::query(
            r#"INSERT INTO requirements
                (id, project_id, title, description, status, conversation_ids,
                 assignee_id, verification_plan, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(id) DO UPDATE SET
                    project_id        = excluded.project_id,
                    title             = excluded.title,
                    description       = excluded.description,
                    status            = excluded.status,
                    conversation_ids  = excluded.conversation_ids,
                    assignee_id       = excluded.assignee_id,
                    verification_plan = excluded.verification_plan,
                    updated_at        = excluded.updated_at"#,
        )
        .bind(&item.id)
        .bind(&item.project_id)
        .bind(&item.title)
        .bind(&item.description)
        .bind(item.status.as_wire())
        .bind(&conv_ids)
        .bind(item.assignee_id.as_deref())
        .bind(plan_json.as_deref())
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
            sqlx::query_scalar("SELECT project_id FROM requirements WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(project_id) = project_id else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM requirements WHERE id = ?1")
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

pub struct SqliteRequirementRunStore {
    pool: SqlitePool,
    tx: broadcast::Sender<RequirementRunEvent>,
}

impl SqliteRequirementRunStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl RequirementRunStore for SqliteRequirementRunStore {
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM requirement_runs
                 WHERE requirement_id = ?1
                 ORDER BY started_at DESC
                 LIMIT 200"#,
        )
        .bind(requirement_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 200 {
            tracing::warn!(requirement_id, "requirement run list hit 200-item soft cap");
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
            sqlx::query_as("SELECT payload FROM requirement_runs WHERE id = ?1")
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
                 LIMIT ?1"#,
        )
        .bind(limit)
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
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(id) DO UPDATE SET
                    requirement_id = excluded.requirement_id,
                    payload        = excluded.payload,
                    status         = excluded.status,
                    started_at     = excluded.started_at,
                    finished_at    = excluded.finished_at"#,
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

pub struct SqliteAgentProfileStore {
    pool: SqlitePool,
    tx: broadcast::Sender<AgentProfileEvent>,
}

impl SqliteAgentProfileStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl AgentProfileStore for SqliteAgentProfileStore {
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError> {
        let rows: Vec<(String,)> =
            sqlx::query_as(r#"SELECT payload FROM agent_profiles ORDER BY name ASC LIMIT 200"#)
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
            sqlx::query_as("SELECT payload FROM agent_profiles WHERE id = ?1")
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
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(id) DO UPDATE SET
                    payload    = excluded.payload,
                    name       = excluded.name,
                    updated_at = excluded.updated_at"#,
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
        let res = sqlx::query("DELETE FROM agent_profiles WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        if res.rows_affected() > 0 {
            let _ = self
                .tx
                .send(AgentProfileEvent::Deleted { id: id.to_string() });
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

pub struct SqliteActivityStore {
    pool: SqlitePool,
    tx: broadcast::Sender<ActivityEvent>,
}

impl SqliteActivityStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl ActivityStore for SqliteActivityStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Activity>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM activities
                 WHERE requirement_id = ?1
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
                serde_json::from_str::<Activity>(&payload).map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn append(&self, activity: &Activity) -> Result<(), BoxError> {
        let payload = serde_json::to_string(activity).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO activities (id, requirement_id, payload, created_at)
                VALUES (?1, ?2, ?3, ?4)"#,
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

// ---------- CommentStore -------------------------------------------------

pub struct SqliteCommentStore {
    pool: SqlitePool,
    tx: broadcast::Sender<CommentEvent>,
}

impl SqliteCommentStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }
}

#[async_trait]
impl CommentStore for SqliteCommentStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM comments
                 WHERE requirement_id = ?1
                 ORDER BY created_at ASC
                 LIMIT 500"#,
        )
        .bind(requirement_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        if rows.len() == 500 {
            tracing::warn!(requirement_id, "comment list hit 500-item soft cap");
        }
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<Comment>(&payload).map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn create(&self, comment: &Comment) -> Result<(), BoxError> {
        // Enforce the depth-1 invariant: when `parent_id` is set, it
        // must reference an existing comment in the same requirement
        // whose own `parent_id` is null.
        if let Some(parent_id) = comment.parent_id.as_deref() {
            let parent: Option<(Option<String>, String)> =
                sqlx::query_as(r#"SELECT parent_id, requirement_id FROM comments WHERE id = ?1"#)
                    .bind(parent_id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(StoreError::from)?;
            match parent {
                None => {
                    return Err(
                        format!("parent comment `{parent_id}` not found in requirement").into(),
                    )
                }
                Some((_, parent_req)) if parent_req != comment.requirement_id => {
                    return Err(
                        format!("parent comment `{parent_id}` not found in requirement").into(),
                    )
                }
                Some((Some(_), _)) => {
                    return Err(
                        "comment threading is limited to depth 1 (cannot reply to a reply)".into(),
                    )
                }
                _ => {}
            }
        }
        let payload = serde_json::to_string(comment).map_err(StoreError::from)?;
        // INSERT (no upsert) — the trait wants `create` to fail on
        // duplicate id, mirroring the JSON / Memory backends.
        sqlx::query(
            r#"INSERT INTO comments
                (id, requirement_id, parent_id, payload, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
        )
        .bind(&comment.id)
        .bind(&comment.requirement_id)
        .bind(comment.parent_id.as_deref())
        .bind(&payload)
        .bind(&comment.created_at)
        .bind(&comment.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| -> BoxError {
            // SQLite's "UNIQUE constraint failed" matches the
            // free-form check the JSON backend does. Surface the
            // same wording so REST callers see consistent errors.
            let msg = e.to_string();
            if msg.contains("UNIQUE") {
                format!("comment id `{}` already exists", comment.id).into()
            } else {
                Box::new(StoreError::from(e))
            }
        })?;
        let _ = self.tx.send(CommentEvent::Posted(comment.clone()));
        Ok(())
    }

    async fn update(&self, comment: &Comment) -> Result<bool, BoxError> {
        // Only `body` + `updated_at` mutate; the other fields stay
        // pinned to whatever the existing row holds. Matches the JSON
        // backend's contract.
        let existing: Option<(String,)> =
            sqlx::query_as(r#"SELECT payload FROM comments WHERE id = ?1 AND requirement_id = ?2"#)
                .bind(&comment.id)
                .bind(&comment.requirement_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some((existing_payload,)) = existing else {
            return Ok(false);
        };
        let mut existing: Comment =
            serde_json::from_str(&existing_payload).map_err(StoreError::from)?;
        existing.body = comment.body.clone();
        existing.updated_at = comment.updated_at.clone();
        let payload = serde_json::to_string(&existing).map_err(StoreError::from)?;
        sqlx::query(
            r#"UPDATE comments
                 SET payload = ?1, updated_at = ?2
                 WHERE id = ?3"#,
        )
        .bind(&payload)
        .bind(&existing.updated_at)
        .bind(&existing.id)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(CommentEvent::Edited(existing));
        Ok(true)
    }

    async fn delete(&self, requirement_id: &str, comment_id: &str) -> Result<bool, BoxError> {
        // Resolve target + replies in one round-trip so the cascade
        // is visible to broadcast subscribers as one event per row.
        let target: Option<(Option<String>,)> = sqlx::query_as(
            r#"SELECT parent_id FROM comments WHERE id = ?1 AND requirement_id = ?2"#,
        )
        .bind(comment_id)
        .bind(requirement_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let Some((target_parent_id,)) = target else {
            return Ok(false);
        };
        let mut to_remove: Vec<String> = vec![comment_id.to_string()];
        if target_parent_id.is_none() {
            // Top-level — collect direct replies to fan-out before
            // deleting them.
            let reply_rows: Vec<(String,)> =
                sqlx::query_as(r#"SELECT id FROM comments WHERE parent_id = ?1"#)
                    .bind(comment_id)
                    .fetch_all(&self.pool)
                    .await
                    .map_err(StoreError::from)?;
            for (id,) in reply_rows {
                to_remove.push(id);
            }
        }
        // One DELETE covers both the target and the replies.
        sqlx::query(
            r#"DELETE FROM comments
                WHERE id = ?1
                   OR parent_id = ?1"#,
        )
        .bind(comment_id)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        for id in to_remove {
            let _ = self.tx.send(CommentEvent::Deleted {
                requirement_id: requirement_id.to_string(),
                comment_id: id,
            });
        }
        Ok(true)
    }

    fn subscribe(&self) -> broadcast::Receiver<CommentEvent> {
        self.tx.subscribe()
    }
}

// ---------- LabelStore ---------------------------------------------------

pub struct SqliteLabelStore {
    pool: SqlitePool,
    tx: broadcast::Sender<LabelEvent>,
}

impl SqliteLabelStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { pool, tx }
    }

    async fn name_clash(
        &self,
        project_id: &str,
        name: &str,
        skip_id: Option<&str>,
    ) -> Result<bool, BoxError> {
        // SQLite collates ASCII case-insensitively with the `NOCASE`
        // collation, but we keep the check explicit (LOWER(...)) to
        // mirror the wire-level uniqueness rule. Walking the bucket
        // is cheap — projects rarely have >100 labels.
        let rows: Vec<(String, String)> =
            sqlx::query_as(r#"SELECT id, name FROM labels WHERE project_id = ?1"#)
                .bind(project_id)
                .fetch_all(&self.pool)
                .await
                .map_err(StoreError::from)?;
        Ok(rows.iter().any(|(id, n)| {
            skip_id.map(|s| s != id).unwrap_or(true) && n.eq_ignore_ascii_case(name)
        }))
    }
}

#[async_trait]
impl LabelStore for SqliteLabelStore {
    async fn list_for_project(&self, project_id: &str) -> Result<Vec<Label>, BoxError> {
        // Order by LOWER(name) so backends keep the same sort the
        // JSON / Memory impls produce. Without LOWER() SQLite would
        // sort uppercase before lowercase, surprising the UI.
        let rows: Vec<(String,)> = sqlx::query_as(
            r#"SELECT payload
                 FROM labels
                 WHERE project_id = ?1
                 ORDER BY LOWER(name) ASC"#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        rows.into_iter()
            .map(|(payload,)| {
                serde_json::from_str::<Label>(&payload).map_err(|e| -> BoxError { Box::new(e) })
            })
            .collect()
    }

    async fn get(&self, id: &str) -> Result<Option<Label>, BoxError> {
        let row: Option<(String,)> = sqlx::query_as(r#"SELECT payload FROM labels WHERE id = ?1"#)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(StoreError::from)?;
        row.map(|(payload,)| serde_json::from_str::<Label>(&payload).map_err(StoreError::from))
            .transpose()
            .map_err(|e| -> BoxError { Box::new(e) })
    }

    async fn create(&self, label: &Label) -> Result<(), BoxError> {
        if self
            .name_clash(&label.project_id, &label.name, None)
            .await?
        {
            return Err(format!("label name `{}` already exists in project", label.name).into());
        }
        let payload = serde_json::to_string(label).map_err(StoreError::from)?;
        sqlx::query(
            r#"INSERT INTO labels
                (id, project_id, name, colour, payload, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        )
        .bind(&label.id)
        .bind(&label.project_id)
        .bind(&label.name)
        .bind(&label.colour)
        .bind(&payload)
        .bind(&label.created_at)
        .bind(&label.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| -> BoxError {
            let msg = e.to_string();
            if msg.contains("UNIQUE") {
                format!("label id `{}` already exists", label.id).into()
            } else {
                Box::new(StoreError::from(e))
            }
        })?;
        let _ = self.tx.send(LabelEvent::Created(label.clone()));
        Ok(())
    }

    async fn update(&self, label: &Label) -> Result<bool, BoxError> {
        let existing: Option<(String,)> =
            sqlx::query_as(r#"SELECT payload FROM labels WHERE id = ?1 AND project_id = ?2"#)
                .bind(&label.id)
                .bind(&label.project_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some((existing_payload,)) = existing else {
            return Ok(false);
        };
        let existing: Label = serde_json::from_str(&existing_payload).map_err(StoreError::from)?;
        if self
            .name_clash(&label.project_id, &label.name, Some(&label.id))
            .await?
        {
            return Err(format!("label name `{}` already exists in project", label.name).into());
        }
        // Pin id / project_id / created_at to existing; everything
        // else from the patch.
        let merged = Label {
            id: existing.id,
            project_id: existing.project_id,
            created_at: existing.created_at,
            name: label.name.clone(),
            colour: label.colour.clone(),
            description: label.description.clone(),
            updated_at: label.updated_at.clone(),
        };
        let payload = serde_json::to_string(&merged).map_err(StoreError::from)?;
        sqlx::query(
            r#"UPDATE labels
                 SET name = ?1, colour = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?5"#,
        )
        .bind(&merged.name)
        .bind(&merged.colour)
        .bind(&payload)
        .bind(&merged.updated_at)
        .bind(&merged.id)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        let _ = self.tx.send(LabelEvent::Updated(merged));
        Ok(true)
    }

    async fn delete(&self, project_id: &str, label_id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query(r#"DELETE FROM labels WHERE id = ?1 AND project_id = ?2"#)
            .bind(label_id)
            .bind(project_id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        let removed = res.rows_affected() > 0;
        if removed {
            let _ = self.tx.send(LabelEvent::Deleted {
                project_id: project_id.to_string(),
                label_id: label_id.to_string(),
            });
        }
        Ok(removed)
    }

    fn subscribe(&self) -> broadcast::Receiver<LabelEvent> {
        self.tx.subscribe()
    }
}

// ---------- DocStore -----------------------------------------------------

pub struct SqliteDocStore {
    pool: SqlitePool,
    tx: broadcast::Sender<DocEvent>,
}

impl SqliteDocStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
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
    pinned: i64,
    archived: i64,
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
impl DocStore for SqliteDocStore {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
        let rows: Vec<DocProjectRow> = sqlx::query_as(
            r#"SELECT id, workspace, title, kind, created_at, updated_at,
                        tags, pinned, archived
                 FROM doc_projects
                 WHERE workspace = ?1
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
                 FROM doc_projects WHERE id = ?1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StoreError::from)?;
        row.map(DocProjectRow::into_project).transpose()
    }

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
        let tags = serde_json::to_string(&project.tags).map_err(StoreError::from)?;
        let pinned: i64 = if project.pinned { 1 } else { 0 };
        let archived: i64 = if project.archived { 1 } else { 0 };
        sqlx::query(
            r#"INSERT INTO doc_projects
                (id, workspace, title, kind, created_at, updated_at,
                 tags, pinned, archived)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    workspace  = excluded.workspace,
                    title      = excluded.title,
                    kind       = excluded.kind,
                    updated_at = excluded.updated_at,
                    tags       = excluded.tags,
                    pinned     = excluded.pinned,
                    archived   = excluded.archived"#,
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
        // Fetch workspace + existence in one shot, then cascade.
        let workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace FROM doc_projects WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        let Some(workspace) = workspace else {
            return Ok(false);
        };
        sqlx::query("DELETE FROM doc_drafts WHERE project_id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        let res = sqlx::query("DELETE FROM doc_projects WHERE id = ?1")
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
                 WHERE project_id = ?1
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
                 WHERE project_id = ?1
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
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    format     = excluded.format,
                    content    = excluded.content,
                    updated_at = excluded.updated_at"#,
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

// ---------- TenantStore -------------------------------------------------

pub struct SqliteTenantStore {
    pool: SqlitePool,
}

impl SqliteTenantStore {
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[derive(sqlx::FromRow)]
struct TenantRow {
    id: String,
    slug: String,
    name: String,
    settings: String,
    archived: i64,
    created_at: String,
    updated_at: String,
}

impl TenantRow {
    fn into_tenant(self) -> Result<Tenant, BoxError> {
        let settings = if self.settings.trim().is_empty() {
            harness_core::TenantSettings::default()
        } else {
            serde_json::from_str(&self.settings).map_err(StoreError::from)?
        };
        Ok(Tenant {
            id: self.id,
            slug: self.slug,
            name: self.name,
            settings,
            archived: self.archived != 0,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[async_trait]
impl TenantStore for SqliteTenantStore {
    async fn save(&self, tenant: &Tenant) -> Result<(), BoxError> {
        let settings = serde_json::to_string(&tenant.settings).map_err(StoreError::from)?;
        let archived: i64 = if tenant.archived { 1 } else { 0 };
        sqlx::query(
            r#"
            INSERT INTO tenants (id, slug, name, settings, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                slug       = excluded.slug,
                name       = excluded.name,
                settings   = excluded.settings,
                archived   = excluded.archived,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&tenant.id)
        .bind(&tenant.slug)
        .bind(&tenant.name)
        .bind(&settings)
        .bind(archived)
        .bind(&tenant.created_at)
        .bind(&tenant.updated_at)
        .execute(&self.pool)
        .await
        .map_err(StoreError::from)?;
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Tenant>, BoxError> {
        let row: Option<TenantRow> =
            sqlx::query_as("SELECT id, slug, name, settings, archived, created_at, updated_at FROM tenants WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        row.map(TenantRow::into_tenant).transpose()
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Tenant>, BoxError> {
        let row: Option<TenantRow> =
            sqlx::query_as("SELECT id, slug, name, settings, archived, created_at, updated_at FROM tenants WHERE slug = ?1")
                .bind(slug)
                .fetch_optional(&self.pool)
                .await
                .map_err(StoreError::from)?;
        row.map(TenantRow::into_tenant).transpose()
    }

    async fn list(&self) -> Result<Vec<Tenant>, BoxError> {
        let rows: Vec<TenantRow> = sqlx::query_as(
            "SELECT id, slug, name, settings, archived, created_at, updated_at FROM tenants WHERE archived = 0 ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(StoreError::from)?;
        rows.into_iter().map(TenantRow::into_tenant).collect()
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let now = Utc::now().to_rfc3339();
        let res = sqlx::query("UPDATE tenants SET archived = 1, updated_at = ?2 WHERE id = ?1")
            .bind(id)
            .bind(&now)
            .execute(&self.pool)
            .await
            .map_err(StoreError::from)?;
        Ok(res.rows_affected() > 0)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let res = sqlx::query("DELETE FROM tenants WHERE id = ?1")
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
        SqliteConversationStore::connect("sqlite::memory:")
            .await
            .unwrap()
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
    async fn envelope_round_trips_metadata() {
        let store = make().await;
        let conv = Conversation::new();
        let meta = ConversationMetadata::with_project("p-1");
        store.save_envelope("c1", &conv, &meta).await.unwrap();
        let (_, loaded_meta) = store.load_envelope("c1").await.unwrap().unwrap();
        assert_eq!(loaded_meta.project_id.as_deref(), Some("p-1"));

        // Saving without metadata clears the project_id (last write wins).
        store
            .save_envelope("c1", &conv, &ConversationMetadata::default())
            .await
            .unwrap();
        let (_, loaded_meta) = store.load_envelope("c1").await.unwrap().unwrap();
        assert!(loaded_meta.project_id.is_none());
    }

    #[tokio::test]
    async fn list_by_project_filters_in_sql() {
        let store = make().await;
        store
            .save_envelope(
                "a",
                &Conversation::new(),
                &ConversationMetadata::with_project("p1"),
            )
            .await
            .unwrap();
        store
            .save_envelope("b", &Conversation::new(), &ConversationMetadata::default())
            .await
            .unwrap();
        store
            .save_envelope(
                "c",
                &Conversation::new(),
                &ConversationMetadata::with_project("p1"),
            )
            .await
            .unwrap();

        let rows = store.list_by_project("p1", 10).await.unwrap();
        assert_eq!(rows.len(), 2);
        for r in &rows {
            assert_eq!(r.project_id.as_deref(), Some("p1"));
        }
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

    #[tokio::test]
    async fn migration_is_idempotent_on_legacy_schema() {
        // Simulate an old DB that has the conversations table without
        // project_id. Build it by hand, then run migrate() twice.
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1) // :memory: needs a single shared conn
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL,
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Insert a row in old shape.
        sqlx::query("INSERT INTO conversations VALUES ('old', '{\"messages\":[]}', 'now', 'now')")
            .execute(&pool)
            .await
            .unwrap();

        migrate(&pool).await.unwrap();
        migrate(&pool).await.unwrap(); // second run is a no-op

        let store = SqliteConversationStore::from_pool(pool).await.unwrap();
        let (_, meta) = store.load_envelope("old").await.unwrap().unwrap();
        assert!(meta.project_id.is_none());
    }

    // ---- ProjectStore --------------------------------------------------

    async fn make_pair() -> (SqliteConversationStore, SqliteProjectStore) {
        let conv = make().await;
        let proj = SqliteProjectStore::from_pool(conv.pool());
        (conv, proj)
    }

    #[tokio::test]
    async fn project_save_load_round_trip() {
        let (_, store) = make_pair().await;
        let p = Project::new("Q", "instructions").with_slug("q");
        store.save(&p).await.unwrap();
        let loaded = store.load(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);
        assert_eq!(store.find_by_slug("q").await.unwrap().unwrap(), p);
    }

    #[tokio::test]
    async fn project_unique_slug_violation() {
        let (_, store) = make_pair().await;
        let a = Project::new("A", "x").with_slug("dup");
        let b = Project::new("B", "y").with_slug("dup");
        store.save(&a).await.unwrap();
        assert!(store.save(&b).await.is_err());
    }

    #[tokio::test]
    async fn project_archive_excludes_from_default_list() {
        let (_, store) = make_pair().await;
        let p = Project::new("Z", "x").with_slug("z");
        store.save(&p).await.unwrap();
        store.archive(&p.id).await.unwrap();

        assert!(store.list(false, 10).await.unwrap().is_empty());
        assert_eq!(store.list(true, 10).await.unwrap().len(), 1);
        assert!(store.load(&p.id).await.unwrap().unwrap().archived);
    }

    #[tokio::test]
    async fn project_delete_returns_existence() {
        let (_, store) = make_pair().await;
        let p = Project::new("D", "x").with_slug("d");
        store.save(&p).await.unwrap();
        assert!(store.delete(&p.id).await.unwrap());
        assert!(!store.delete(&p.id).await.unwrap());
    }

    // ---- TodoStore -----------------------------------------------------

    async fn make_todo_store() -> (SqliteConversationStore, SqliteTodoStore) {
        let conv = make().await;
        let todos = SqliteTodoStore::from_pool(conv.pool());
        (conv, todos)
    }

    #[tokio::test]
    async fn todo_round_trip() {
        let (_, store) = make_todo_store().await;
        let mut t = TodoItem::new("/repo", "fix parser");
        t.notes = Some("blocked by ticket #5".into());
        t.status = TodoStatus::Blocked;
        store.upsert(&t).await.unwrap();

        let loaded = store.get(&t.id).await.unwrap().unwrap();
        assert_eq!(loaded, t);

        let listed = store.list("/repo").await.unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[tokio::test]
    async fn todo_list_filters_by_workspace_newest_first() {
        let (_, store) = make_todo_store().await;
        let a = TodoItem::new("/r1", "first");
        store.upsert(&a).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let b = TodoItem::new("/r1", "second");
        store.upsert(&b).await.unwrap();
        let c = TodoItem::new("/r2", "other repo");
        store.upsert(&c).await.unwrap();

        let r1 = store.list("/r1").await.unwrap();
        assert_eq!(r1.len(), 2);
        assert_eq!(r1[0].id, b.id, "newest first");
        let r2 = store.list("/r2").await.unwrap();
        assert_eq!(r2.len(), 1);
    }

    #[tokio::test]
    async fn todo_delete_idempotent_and_emits_once() {
        let (_, store) = make_todo_store().await;
        let mut rx = store.subscribe();
        let t = TodoItem::new("/r", "x");
        store.upsert(&t).await.unwrap();
        // Drain the upsert event.
        let _ = rx.recv().await.unwrap();

        assert!(store.delete(&t.id).await.unwrap());
        match rx.recv().await.unwrap() {
            TodoEvent::Deleted { workspace, id } => {
                assert_eq!(workspace, "/r");
                assert_eq!(id, t.id);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }

        // Second delete is a no-op + no event.
        assert!(!store.delete(&t.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- RequirementStore -----------------------------------------------

    async fn make_requirement_store() -> (SqliteConversationStore, SqliteRequirementStore) {
        let conv = make().await;
        let reqs = SqliteRequirementStore::from_pool(conv.pool());
        (conv, reqs)
    }

    #[tokio::test]
    async fn requirement_round_trip() {
        let (_, store) = make_requirement_store().await;
        let mut r = Requirement::new("p-a", "ship the kanban");
        r.description = Some("Build the board".into());
        r.status = RequirementStatus::Review;
        r.conversation_ids = vec!["c1".into(), "c2".into()];
        store.upsert(&r).await.unwrap();

        let loaded = store.get(&r.id).await.unwrap().unwrap();
        assert_eq!(loaded, r);

        let listed = store.list("p-a").await.unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[tokio::test]
    async fn requirement_list_filters_by_project_newest_first() {
        let (_, store) = make_requirement_store().await;
        let a = Requirement::new("p1", "first");
        store.upsert(&a).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let b = Requirement::new("p1", "second");
        store.upsert(&b).await.unwrap();
        let c = Requirement::new("p2", "other project");
        store.upsert(&c).await.unwrap();

        let p1 = store.list("p1").await.unwrap();
        assert_eq!(p1.len(), 2);
        assert_eq!(p1[0].id, b.id, "newest first");
        let p2 = store.list("p2").await.unwrap();
        assert_eq!(p2.len(), 1);
    }

    #[tokio::test]
    async fn requirement_delete_idempotent_and_emits_once() {
        let (_, store) = make_requirement_store().await;
        let mut rx = store.subscribe();
        let r = Requirement::new("p", "x");
        store.upsert(&r).await.unwrap();
        let _ = rx.recv().await.unwrap();

        assert!(store.delete(&r.id).await.unwrap());
        match rx.recv().await.unwrap() {
            RequirementEvent::Deleted { project_id, id } => {
                assert_eq!(project_id, "p");
                assert_eq!(id, r.id);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }

        assert!(!store.delete(&r.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- RequirementRunStore --------------------------------------------

    use harness_core::RequirementRunStatus;

    async fn make_run_store() -> (SqliteConversationStore, SqliteRequirementRunStore) {
        let conv = make().await;
        let runs = SqliteRequirementRunStore::from_pool(conv.pool());
        (conv, runs)
    }

    #[tokio::test]
    async fn requirement_run_round_trip_through_sqlite() {
        let (_, store) = make_run_store().await;
        let mut r = RequirementRun::new("req-1", "conv-1");
        r.summary = Some("done".into());
        r.status = RequirementRunStatus::Completed;
        r.finished_at = Some("2026-04-30T01:23:45+00:00".into());
        store.upsert(&r).await.unwrap();

        let loaded = store.get(&r.id).await.unwrap().unwrap();
        assert_eq!(loaded, r);

        let listed = store.list_for_requirement("req-1").await.unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[tokio::test]
    async fn requirement_run_list_filters_and_orders_via_sql() {
        let (_, store) = make_run_store().await;
        let a = RequirementRun::new("req-a", "c1");
        store.upsert(&a).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let b = RequirementRun::new("req-a", "c2");
        store.upsert(&b).await.unwrap();
        let c = RequirementRun::new("req-b", "c3");
        store.upsert(&c).await.unwrap();

        let req_a = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(req_a.len(), 2);
        assert_eq!(req_a[0].id, b.id, "newest first");
        let req_b = store.list_for_requirement("req-b").await.unwrap();
        assert_eq!(req_b.len(), 1);
    }

    #[tokio::test]
    async fn requirement_run_emits_started_then_finished_via_sqlite() {
        let (_, store) = make_run_store().await;
        let mut rx = store.subscribe();
        let mut r = RequirementRun::new("req", "conv");
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Started(run) => assert_eq!(run.id, r.id),
            other => panic!("expected Started, got {other:?}"),
        }
        r.finish(RequirementRunStatus::Completed);
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Finished(run) => {
                assert_eq!(run.status, RequirementRunStatus::Completed)
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    // ---- AgentProfileStore ----------------------------------------------

    async fn make_profile_store() -> (SqliteConversationStore, SqliteAgentProfileStore) {
        let conv = make().await;
        let profs = SqliteAgentProfileStore::from_pool(conv.pool());
        (conv, profs)
    }

    #[tokio::test]
    async fn agent_profile_round_trip_through_sqlite() {
        let (_, store) = make_profile_store().await;
        let mut p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        p.system_prompt = Some("You are Alice. Be concise.".into());
        p.allowed_tools = vec!["fs.read".into(), "fs.list".into()];
        store.upsert(&p).await.unwrap();
        let loaded = store.get(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);
    }

    #[tokio::test]
    async fn agent_profile_list_orders_by_name_via_sql() {
        let (_, store) = make_profile_store().await;
        store
            .upsert(&AgentProfile::new("Charlie", "openai", "gpt-4o-mini"))
            .await
            .unwrap();
        store
            .upsert(&AgentProfile::new("Alice", "openai", "gpt-4o-mini"))
            .await
            .unwrap();
        store
            .upsert(&AgentProfile::new("Bob", "openai", "gpt-4o-mini"))
            .await
            .unwrap();
        let listed = store.list().await.unwrap();
        let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Alice", "Bob", "Charlie"]);
    }

    #[tokio::test]
    async fn agent_profile_delete_idempotent_and_emits_once_via_sqlite() {
        let (_, store) = make_profile_store().await;
        let mut rx = store.subscribe();
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        store.upsert(&p).await.unwrap();
        let _ = rx.recv().await.unwrap();
        assert!(store.delete(&p.id).await.unwrap());
        let _ = rx.recv().await.unwrap();
        assert!(!store.delete(&p.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn requirement_persists_assignee_id_via_sqlite() {
        let (_, store) = make_requirement_store().await;
        let mut r = Requirement::new("p", "x");
        r.assignee_id = Some("prof-123".into());
        store.upsert(&r).await.unwrap();
        let loaded = store.get(&r.id).await.unwrap().unwrap();
        assert_eq!(loaded.assignee_id.as_deref(), Some("prof-123"));
    }

    // ---- ActivityStore --------------------------------------------------

    use harness_core::{ActivityActor, ActivityKind};
    use serde_json::json;

    async fn make_activity_store() -> (SqliteConversationStore, SqliteActivityStore) {
        let conv = make().await;
        let acts = SqliteActivityStore::from_pool(conv.pool());
        (conv, acts)
    }

    #[tokio::test]
    async fn activity_round_trip_through_sqlite() {
        let (_, store) = make_activity_store().await;
        let a = Activity::new(
            "req-1",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({"from": "backlog", "to": "in_progress"}),
        );
        store.append(&a).await.unwrap();

        let listed = store.list_for_requirement("req-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], a);
    }

    #[tokio::test]
    async fn activity_list_filters_and_orders_via_sql() {
        let (_, store) = make_activity_store().await;
        store
            .append(&Activity::new(
                "req-a",
                ActivityKind::RunStarted,
                ActivityActor::System,
                json!({}),
            ))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let later = Activity::new(
            "req-a",
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({}),
        );
        store.append(&later).await.unwrap();
        store
            .append(&Activity::new(
                "req-b",
                ActivityKind::StatusChange,
                ActivityActor::Human,
                json!({}),
            ))
            .await
            .unwrap();

        let req_a = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(req_a.len(), 2);
        assert_eq!(req_a[0].id, later.id, "newest first");
        let req_b = store.list_for_requirement("req-b").await.unwrap();
        assert_eq!(req_b.len(), 1);
    }

    #[tokio::test]
    async fn activity_subscribe_emits_appended_via_sqlite() {
        let (_, store) = make_activity_store().await;
        let mut rx = store.subscribe();
        let a = Activity::new(
            "req",
            ActivityKind::VerificationFinished,
            ActivityActor::System,
            json!({"run_id": "r1", "status": "passed"}),
        );
        store.append(&a).await.unwrap();
        match rx.recv().await.unwrap() {
            ActivityEvent::Appended(got) => assert_eq!(got.id, a.id),
        }
    }

    // ---- DocStore -------------------------------------------------------

    async fn make_doc_store() -> (SqliteConversationStore, SqliteDocStore) {
        let conv = make().await;
        let docs = SqliteDocStore::from_pool(conv.pool());
        (conv, docs)
    }

    #[tokio::test]
    async fn doc_project_round_trip() {
        let (_, store) = make_doc_store().await;
        let mut p = DocProject::new("/r", "design");
        p.kind = DocKind::Design;
        store.upsert_project(&p).await.unwrap();

        let loaded = store.get_project(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);

        let listed = store.list_projects("/r").await.unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[tokio::test]
    async fn doc_project_persists_tags_pinned_archived() {
        let (_, store) = make_doc_store().await;
        let mut p = DocProject::new("/r", "weekly");
        p.tags = vec!["q3".into(), "ship".into()];
        p.pinned = true;
        p.archived = true;
        store.upsert_project(&p).await.unwrap();

        let loaded = store.get_project(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded.tags, vec!["q3", "ship"]);
        assert!(loaded.pinned);
        assert!(loaded.archived);

        // Toggle off and re-save — confirms the upsert UPDATE branch
        // keeps the new columns in sync.
        let mut p2 = loaded;
        p2.pinned = false;
        p2.archived = false;
        p2.tags.clear();
        store.upsert_project(&p2).await.unwrap();
        let again = store.get_project(&p2.id).await.unwrap().unwrap();
        assert!(!again.pinned);
        assert!(!again.archived);
        assert!(again.tags.is_empty());
    }

    #[tokio::test]
    async fn doc_delete_cascades_to_drafts_in_sql() {
        let (_, store) = make_doc_store().await;
        let p = DocProject::new("/r", "x");
        store.upsert_project(&p).await.unwrap();
        let d = DocDraft::new(&p.id, "# hi");
        store.upsert_draft(&d).await.unwrap();
        assert_eq!(store.list_drafts(&p.id).await.unwrap().len(), 1);

        assert!(store.delete_project(&p.id).await.unwrap());
        assert!(store.list_drafts(&p.id).await.unwrap().is_empty());
        assert!(store.get_project(&p.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn doc_latest_draft_uses_sql_order_by() {
        let (_, store) = make_doc_store().await;
        let p = DocProject::new("/r", "x");
        store.upsert_project(&p).await.unwrap();
        store
            .upsert_draft(&DocDraft::new(&p.id, "first"))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let d2 = DocDraft::new(&p.id, "second");
        store.upsert_draft(&d2).await.unwrap();
        let latest = store.latest_draft(&p.id).await.unwrap().unwrap();
        assert_eq!(latest.id, d2.id);
    }

    // ---- TenantStore ---------------------------------------------------

    async fn make_tenant_store() -> (SqliteConversationStore, SqliteTenantStore) {
        let conv = make().await;
        let tenants = SqliteTenantStore::from_pool(conv.pool());
        (conv, tenants)
    }

    #[tokio::test]
    async fn first_start_creates_default_tenant() {
        let (conv, store) = make_tenant_store().await;
        crate::ensure_default_tenant(Arc::new(store)).await.unwrap();
        let store = SqliteTenantStore::from_pool(conv.pool());
        let t = store.find_by_slug("default").await.unwrap().unwrap();
        assert_eq!(t.slug, "default");
        assert_eq!(t.name, "Default");

        // Idempotent — second call must not create a duplicate.
        crate::ensure_default_tenant(Arc::new(store)).await.unwrap();
        let store = SqliteTenantStore::from_pool(conv.pool());
        let list = store.list().await.unwrap();
        assert_eq!(list.len(), 1);
    }

    #[tokio::test]
    async fn tenant_save_rejects_duplicate_slug() {
        let (_, store) = make_tenant_store().await;
        let a = Tenant::new("A").with_slug("dup");
        let b = Tenant::new("B").with_slug("dup");
        store.save(&a).await.unwrap();
        assert!(store.save(&b).await.is_err());
    }
}
