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
    BoxError, Conversation, ConversationMetadata, ConversationRecord, ConversationStore, Project,
    ProjectStore,
};
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
            archived     INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        "#,
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
        let archived: i64 = if project.archived { 1 } else { 0 };
        sqlx::query(
            r#"
            INSERT INTO projects
                (id, slug, name, description, instructions, tags, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                slug         = excluded.slug,
                name         = excluded.name,
                description  = excluded.description,
                instructions = excluded.instructions,
                tags         = excluded.tags,
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
            r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
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
                r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
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
                r#"SELECT id, slug, name, description, instructions, tags, archived, created_at, updated_at
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
    archived: i64,
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
}
