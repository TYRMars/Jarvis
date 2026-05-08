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
    JsonFileActivityStore, JsonFileAgentProfileStore, JsonFileCommentStore,
    JsonFileConversationStore, JsonFileDocStore, JsonFileEvalStore, JsonFileLabelStore,
    JsonFileObservabilityStore, JsonFileProjectStore, JsonFileRequirementRunStore,
    JsonFileRequirementStore, JsonFileTenantStore, JsonFileTodoStore,
};
pub use memory::{
    MemoryActivityStore, MemoryAgentProfileStore, MemoryCommentStore, MemoryConversationStore,
    MemoryDocStore, MemoryLabelStore, MemoryProjectMemoryStore, MemoryProjectStore,
    MemoryRequirementRunStore, MemoryRequirementStore, MemoryTenantStore, MemoryTodoStore,
};
pub use permission::JsonFilePermissionStore;
pub use workspace::{default_path as default_workspaces_path, WorkspaceEntry, WorkspaceStore};

#[cfg(feature = "sqlite")]
mod sqlite;
#[cfg(feature = "sqlite")]
pub use sqlite::{
    SqliteActivityStore, SqliteAgentProfileStore, SqliteCommentStore, SqliteConversationStore,
    SqliteDocStore, SqliteLabelStore, SqliteProjectStore, SqliteRequirementRunStore,
    SqliteRequirementStore, SqliteTenantStore, SqliteTodoStore,
};

#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "postgres")]
pub use postgres::{
    PostgresActivityStore, PostgresAgentProfileStore, PostgresCommentStore,
    PostgresConversationStore, PostgresDocStore, PostgresLabelStore, PostgresProjectStore,
    PostgresRequirementRunStore, PostgresRequirementStore, PostgresTodoStore,
};

#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "mysql")]
pub use mysql::{
    MysqlActivityStore, MysqlAgentProfileStore, MysqlCommentStore, MysqlConversationStore,
    MysqlDocStore, MysqlLabelStore, MysqlProjectStore, MysqlRequirementRunStore,
    MysqlRequirementStore, MysqlTodoStore,
};

use std::sync::Arc;

use harness_core::{
    ActivityStore, AgentProfileStore, CommentStore, ConversationStore, DocStore, EvalStore,
    LabelStore, ObservabilityStore, ProjectStore, RequirementRunStore, RequirementStore,
    TenantStore, TodoStore,
};

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
    /// Per-requirement execution run history — one row per
    /// `/runs` invocation. Backs the kanban-card "Runs" drawer
    /// and Phase 4 verification gate.
    pub requirement_runs: Arc<dyn RequirementRunStore>,
    /// Per-requirement audit timeline — one row per status flip /
    /// run lifecycle event / verification result. Append-only;
    /// drives the kanban-card "Activity" drawer.
    pub activities: Arc<dyn ActivityStore>,
    /// Process-wide named agent profiles ("Alice on Codex / GPT-5",
    /// etc.). Backs the Settings page's Agents tab and the kanban
    /// card assignee picker.
    pub agent_profiles: Arc<dyn AgentProfileStore>,
    /// Per-workspace doc workspaces (notes, designs, reports) with
    /// Markdown drafts attached.
    pub docs: Arc<dyn DocStore>,
    /// Per-requirement discussion threads (Phase 3.8 / 3.8b).
    /// Persisted across every backend — JSON files, SQLite,
    /// Postgres, MySQL.
    pub comments: Arc<dyn CommentStore>,
    /// Per-project structured tags (Phase 3.8 / 3.8b). Persisted
    /// across every backend.
    pub labels: Arc<dyn LabelStore>,
    /// Multi-tenant isolation boundary store.
    pub tenants: Arc<dyn TenantStore>,
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
            let requirement_runs =
                Arc::new(JsonFileRequirementRunStore::open(&path)?) as Arc<dyn RequirementRunStore>;
            let activities =
                Arc::new(JsonFileActivityStore::open(&path)?) as Arc<dyn ActivityStore>;
            let agent_profiles =
                Arc::new(JsonFileAgentProfileStore::open(&path)?) as Arc<dyn AgentProfileStore>;
            let docs = Arc::new(JsonFileDocStore::open(&path)?) as Arc<dyn DocStore>;
            let comments = Arc::new(JsonFileCommentStore::open(&path)?) as Arc<dyn CommentStore>;
            let labels = Arc::new(JsonFileLabelStore::open(&path)?) as Arc<dyn LabelStore>;
            let tenants = Arc::new(JsonFileTenantStore::open(&path)?) as Arc<dyn TenantStore>;
            Ok(StoreBundle {
                conversations,
                projects,
                todos,
                requirements,
                requirement_runs,
                activities,
                agent_profiles,
                docs,
                comments,
                labels,
                tenants,
            })
        }
        #[cfg(feature = "sqlite")]
        "sqlite" => {
            let conv = SqliteConversationStore::connect(url).await?;
            let proj = SqliteProjectStore::from_pool(conv.pool());
            let todos = SqliteTodoStore::from_pool(conv.pool());
            let requirements = SqliteRequirementStore::from_pool(conv.pool());
            let requirement_runs = SqliteRequirementRunStore::from_pool(conv.pool());
            let activities = SqliteActivityStore::from_pool(conv.pool());
            let agent_profiles = SqliteAgentProfileStore::from_pool(conv.pool());
            let docs = SqliteDocStore::from_pool(conv.pool());
            // Phase 3.8b — Comment + Label SQL impls landed; persisted
            // alongside everything else.
            let comments = SqliteCommentStore::from_pool(conv.pool());
            let labels = SqliteLabelStore::from_pool(conv.pool());
            let tenants = SqliteTenantStore::from_pool(conv.pool());
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                requirement_runs: Arc::new(requirement_runs),
                activities: Arc::new(activities),
                agent_profiles: Arc::new(agent_profiles),
                docs: Arc::new(docs),
                comments: Arc::new(comments),
                labels: Arc::new(labels),
                tenants: Arc::new(tenants),
            })
        }
        #[cfg(feature = "postgres")]
        "postgres" | "postgresql" => {
            let conv = PostgresConversationStore::connect(url).await?;
            let proj = PostgresProjectStore::from_pool(conv.pool());
            let todos = PostgresTodoStore::from_pool(conv.pool());
            let requirements = PostgresRequirementStore::from_pool(conv.pool());
            let requirement_runs = PostgresRequirementRunStore::from_pool(conv.pool());
            let activities = PostgresActivityStore::from_pool(conv.pool());
            let agent_profiles = PostgresAgentProfileStore::from_pool(conv.pool());
            let docs = PostgresDocStore::from_pool(conv.pool());
            let comments = PostgresCommentStore::from_pool(conv.pool());
            let labels = PostgresLabelStore::from_pool(conv.pool());
            let tenants = ephemeral_tenants("postgres");
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                requirement_runs: Arc::new(requirement_runs),
                activities: Arc::new(activities),
                agent_profiles: Arc::new(agent_profiles),
                docs: Arc::new(docs),
                comments: Arc::new(comments),
                labels: Arc::new(labels),
                tenants,
            })
        }
        #[cfg(feature = "mysql")]
        "mysql" | "mariadb" => {
            let conv = MysqlConversationStore::connect(url).await?;
            let proj = MysqlProjectStore::from_pool(conv.pool());
            let todos = MysqlTodoStore::from_pool(conv.pool());
            let requirements = MysqlRequirementStore::from_pool(conv.pool());
            let requirement_runs = MysqlRequirementRunStore::from_pool(conv.pool());
            let activities = MysqlActivityStore::from_pool(conv.pool());
            let agent_profiles = MysqlAgentProfileStore::from_pool(conv.pool());
            let docs = MysqlDocStore::from_pool(conv.pool());
            let comments = MysqlCommentStore::from_pool(conv.pool());
            let labels = MysqlLabelStore::from_pool(conv.pool());
            let tenants = ephemeral_tenants("mysql");
            Ok(StoreBundle {
                conversations: Arc::new(conv),
                projects: Arc::new(proj),
                todos: Arc::new(todos),
                requirements: Arc::new(requirements),
                requirement_runs: Arc::new(requirement_runs),
                activities: Arc::new(activities),
                agent_profiles: Arc::new(agent_profiles),
                docs: Arc::new(docs),
                comments: Arc::new(comments),
                labels: Arc::new(labels),
                tenants,
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

/// Open just the requirement-run store for a given URL. Equivalent
/// to `connect_all(url).await?.requirement_runs`.
pub async fn connect_requirement_runs(
    url: &str,
) -> Result<Arc<dyn RequirementRunStore>, StoreError> {
    Ok(connect_all(url).await?.requirement_runs)
}

/// Open just the activity store for a given URL. Equivalent to
/// `connect_all(url).await?.activities`.
pub async fn connect_activities(url: &str) -> Result<Arc<dyn ActivityStore>, StoreError> {
    Ok(connect_all(url).await?.activities)
}

/// Open just the agent-profile store for a given URL. Equivalent
/// to `connect_all(url).await?.agent_profiles`.
pub async fn connect_agent_profiles(url: &str) -> Result<Arc<dyn AgentProfileStore>, StoreError> {
    Ok(connect_all(url).await?.agent_profiles)
}

/// Open just the doc store for a given URL. Equivalent to
/// `connect_all(url).await?.docs`.
pub async fn connect_docs(url: &str) -> Result<Arc<dyn DocStore>, StoreError> {
    Ok(connect_all(url).await?.docs)
}

/// Open just the tenant store for a given URL. Equivalent to
/// `connect_all(url).await?.tenants`.
pub async fn connect_tenants(url: &str) -> Result<Arc<dyn TenantStore>, StoreError> {
    Ok(connect_all(url).await?.tenants)
}

/// Open the local observability summary store for a given URL. Phase 1
/// implements the JSON-file backend; SQL backends will follow the same
/// scheme selection pattern once their migrations land.
pub async fn connect_observability(url: &str) -> Result<Arc<dyn ObservabilityStore>, StoreError> {
    let scheme = url.split(':').next().unwrap_or("");
    match scheme {
        "json" => {
            let path = json_path(url)?;
            Ok(Arc::new(JsonFileObservabilityStore::open(path)?) as Arc<dyn ObservabilityStore>)
        }
        other => Err(StoreError::UnsupportedScheme(other.to_string())),
    }
}

/// Open the eval result / baseline store for a given URL. Phase 1
/// implements the JSON-file backend; SQL backends intentionally remain
/// unsupported until their schema is added.
pub async fn connect_evals(url: &str) -> Result<Arc<dyn EvalStore>, StoreError> {
    let scheme = url.split(':').next().unwrap_or("");
    match scheme {
        "json" => {
            let path = json_path(url)?;
            Ok(Arc::new(JsonFileEvalStore::open(path)?) as Arc<dyn EvalStore>)
        }
        other => Err(StoreError::UnsupportedScheme(other.to_string())),
    }
}

/// Idempotently ensure a tenant with slug `default` exists.
/// Called once at process startup by the composition root.
pub async fn ensure_default_tenant(store: Arc<dyn TenantStore>) -> Result<(), StoreError> {
    if store.find_by_slug("default").await?.is_none() {
        let t = harness_core::Tenant::new("Default").with_slug("default");
        store.save(&t).await.map_err(StoreError::Other)?;
    }
    Ok(())
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
