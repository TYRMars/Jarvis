//! sqlx-backed [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_core::ProjectStore) implementations.
//!
//! Each driver is behind a cargo feature, so downstream crates only compile
//! what they actually use:
//!
//! | feature    | conversation backend                                  | project backend                |
//! |------------|-------------------------------------------------------|--------------------------------|
//! | (always on) | [`JsonFileConversationStore`] / [`MemoryConversationStore`] | [`JsonFileProjectStore`] / [`MemoryProjectStore`] |
//! | `sqlite`   | [`SqliteConversationStore`] (enabled by default)      | [`SqliteProjectStore`]         |
//! | `postgres` | [`PostgresConversationStore`]                         | [`PostgresProjectStore`]       |
//! | `mysql`    | [`MysqlConversationStore`]                            | [`MysqlProjectStore`]          |
//!
//! [`connect`] picks a conversation backend by URL scheme at runtime so
//! higher layers can stay generic over the concrete type. [`connect_all`]
//! returns a [`StoreBundle`] containing both the conversation and the
//! project store, with the underlying connection pool / directory shared
//! between the two — important for SQLite (`:memory:` is per-connection)
//! and convenient for JSON-file (one base directory).
//!
//! ```no_run
//! # use harness_store::{connect, connect_all};
//! # async fn demo() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
//! let stores = connect_all("sqlite::memory:").await?;
//! let _ = stores.conversations;
//! let _ = stores.projects;
//!
//! // Conversation-only callers can stay on the older API:
//! let _ = connect("sqlite::memory:").await?;
//! # Ok(()) }
//! ```

mod error;
mod json_file;
mod memory;
mod permission;
mod workspace;

pub use error::StoreError;
pub use json_file::{
    JsonFileConversationStore, JsonFileDocStore, JsonFileProjectStore, JsonFileRequirementStore,
    JsonFileTodoStore,
};
pub use memory::{
    MemoryConversationStore, MemoryDocStore, MemoryProjectStore, MemoryRequirementStore,
    MemoryTodoStore,
};
pub use permission::JsonFilePermissionStore;
pub use workspace::{default_path as default_workspaces_path, WorkspaceEntry, WorkspaceStore};

#[cfg(feature = "sqlite")]
mod sqlite;
#[cfg(feature = "sqlite")]
pub use sqlite::{
    SqliteConversationStore, SqliteDocStore, SqliteProjectStore, SqliteRequirementStore,
    SqliteTodoStore,
};

#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "postgres")]
pub use postgres::{
    PostgresConversationStore, PostgresDocStore, PostgresProjectStore, PostgresRequirementStore,
    PostgresTodoStore,
};

#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "mysql")]
pub use mysql::{
    MysqlConversationStore, MysqlDocStore, MysqlProjectStore, MysqlRequirementStore, MysqlTodoStore,
};

use std::sync::Arc;

use harness_core::{ConversationStore, DocStore, ProjectStore, RequirementStore, TodoStore};

/// Bundle of stores returned by [`connect_all`]. The backends share
/// their underlying resource (DB pool or base directory) so a single
/// URL can drive every entry.
pub struct StoreBundle {
    pub conversations: Arc<dyn ConversationStore>,
    pub projects: Arc<dyn ProjectStore>,
    pub todos: Arc<dyn TodoStore>,
    /// Per-project requirement kanban (Backlog / In progress /
    /// Review / Done). Mirrors `todos` in shape but scoped by
    /// `project_id` rather than workspace.
    pub requirements: Arc<dyn RequirementStore>,
    /// Per-workspace doc workspaces (notes, designs, reports) with
    /// Markdown drafts attached.
    pub docs: Arc<dyn DocStore>,
}

/// Open both stores for a given database URL. The scheme selects the
/// backend (see [module docs](crate)).
///
/// For SQL backends the underlying connection pool is shared between
/// the conversation and project store. For the JSON-file backend they
/// share one base directory (`<dir>/<id>.json` for conversations,
/// `<dir>/projects/<id>.json` for projects).
pub async fn connect_all(url: &str) -> Result<StoreBundle, StoreError> {
    let scheme = url.split(':').next().unwrap_or("");
    match scheme {
        "json" => {
            let path = json_path(url)?;
            let conversations =
                Arc::new(JsonFileConversationStore::open(&path)?) as Arc<dyn ConversationStore>;
            let projects = Arc::new(JsonFileProjectStore::open(&path)?) as Arc<dyn ProjectStore>;
            let todos = Arc::new(JsonFileTodoStore::open(&path)?) as Arc<dyn TodoStore>;
            let requirements =
                Arc::new(JsonFileRequirementStore::open(&path)?) as Arc<dyn RequirementStore>;
            let docs = Arc::new(JsonFileDocStore::open(&path)?) as Arc<dyn DocStore>;
            Ok(StoreBundle {
                conversations,
                projects,
                todos,
                requirements,
                docs,
            })
        }
        #[cfg(feature = "sqlite")]
        "sqlite" => {
            let conv = SqliteConversationStore::connect(url).await?;
            let proj = SqliteProjectStore::from_pool(conv.pool());
            let todos = SqliteTodoStore::from_pool(conv.pool());
            let requirements = SqliteRequirementStore::from_pool(conv.pool());
            let docs = SqliteDocStore::from_pool(conv.pool());
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                docs: Arc::new(docs),
            })
        }
        #[cfg(feature = "postgres")]
        "postgres" | "postgresql" => {
            let conv = PostgresConversationStore::connect(url).await?;
            let proj = PostgresProjectStore::from_pool(conv.pool());
            let todos = PostgresTodoStore::from_pool(conv.pool());
            let requirements = PostgresRequirementStore::from_pool(conv.pool());
            let docs = PostgresDocStore::from_pool(conv.pool());
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                docs: Arc::new(docs),
            })
        }
        #[cfg(feature = "mysql")]
        "mysql" | "mariadb" => {
            let conv = MysqlConversationStore::connect(url).await?;
            let proj = MysqlProjectStore::from_pool(conv.pool());
            let todos = MysqlTodoStore::from_pool(conv.pool());
            let requirements = MysqlRequirementStore::from_pool(conv.pool());
            let docs = MysqlDocStore::from_pool(conv.pool());
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                docs: Arc::new(docs),
            })
        }
        other => Err(StoreError::UnsupportedScheme(other.to_string())),
    }
}

/// Open just the conversation store for a given URL. Equivalent to
/// `connect_all(url).await?.conversations`. Preserved for callers that
/// don't yet know about [`ProjectStore`].
pub async fn connect(url: &str) -> Result<Arc<dyn ConversationStore>, StoreError> {
    Ok(connect_all(url).await?.conversations)
}

/// Open just the project store for a given URL. Equivalent to
/// `connect_all(url).await?.projects` — convenience for the CLI's
/// `jarvis project ...` subcommands.
pub async fn connect_projects(url: &str) -> Result<Arc<dyn ProjectStore>, StoreError> {
    Ok(connect_all(url).await?.projects)
}

/// Open just the todo store for a given URL. Equivalent to
/// `connect_all(url).await?.todos`.
pub async fn connect_todos(url: &str) -> Result<Arc<dyn TodoStore>, StoreError> {
    Ok(connect_all(url).await?.todos)
}

/// Open just the requirement store for a given URL. Equivalent to
/// `connect_all(url).await?.requirements`.
pub async fn connect_requirements(url: &str) -> Result<Arc<dyn RequirementStore>, StoreError> {
    Ok(connect_all(url).await?.requirements)
}

/// Open just the doc store for a given URL. Equivalent to
/// `connect_all(url).await?.docs`.
pub async fn connect_docs(url: &str) -> Result<Arc<dyn DocStore>, StoreError> {
    Ok(connect_all(url).await?.docs)
}

fn json_path(url: &str) -> Result<String, StoreError> {
    // Accept both `json://path` and `json:path`; the literal bytes
    // after the prefix are the directory path.
    let path = url
        .strip_prefix("json://")
        .or_else(|| url.strip_prefix("json:"))
        .unwrap_or("");
    if path.is_empty() {
        return Err(StoreError::Other(
            "json: requires a directory path (e.g. \
             `json:///Users/me/.local/share/jarvis/conversations`)"
                .into(),
        ));
    }
    Ok(path.to_string())
}
