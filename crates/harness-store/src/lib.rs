//! sqlx-backed [`ConversationStore`](harness_core::ConversationStore)
//! implementations.
//!
//! Each driver is behind a cargo feature, so downstream crates only compile
//! what they actually use:
//!
//! | feature    | backend                                               |
//! |------------|-------------------------------------------------------|
//! | `sqlite`   | [`SqliteConversationStore`] (enabled by default)      |
//! | `postgres` | [`PostgresConversationStore`]                         |
//! | `mysql`    | [`MysqlConversationStore`]                            |
//!
//! [`connect`] picks a backend by URL scheme at runtime so higher layers can
//! stay generic over the concrete type:
//!
//! ```no_run
//! # use std::sync::Arc;
//! # use harness_core::ConversationStore;
//! # use harness_store::connect;
//! # async fn demo() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
//! let store: Arc<dyn ConversationStore> = connect("sqlite::memory:").await?;
//! # let _ = store; Ok(()) }
//! ```

mod error;
mod json_file;
mod memory;

pub use error::StoreError;
pub use json_file::JsonFileConversationStore;
pub use memory::MemoryConversationStore;

#[cfg(feature = "sqlite")]
mod sqlite;
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteConversationStore;

#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "postgres")]
pub use postgres::PostgresConversationStore;

#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "mysql")]
pub use mysql::MysqlConversationStore;

use std::sync::Arc;

use harness_core::ConversationStore;

/// Open a store for the given database URL. The scheme selects the backend:
///
/// - `json:...` / `json://...` — JSON files in a directory (no external
///   deps; the default for `jarvis init`).
/// - `sqlite:...` / `sqlite::memory:` — SQLite (feature `sqlite`)
/// - `postgres://...` / `postgresql://...` — Postgres (feature `postgres`)
/// - `mysql://...` / `mariadb://...` — MySQL (feature `mysql`)
///
/// The returned store is boxed behind `Arc<dyn ConversationStore>` so higher
/// layers don't need to name the backend type. Schema migrations / directory
/// creation happen on open.
pub async fn connect(url: &str) -> Result<Arc<dyn ConversationStore>, StoreError> {
    let scheme = url.split(':').next().unwrap_or("");
    match scheme {
        "json" => {
            // Accept both `json://path` and `json:path`; the literal
            // bytes after the prefix are the directory path.
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
            let store = JsonFileConversationStore::open(path)?;
            Ok(Arc::new(store))
        }
        #[cfg(feature = "sqlite")]
        "sqlite" => {
            let store = SqliteConversationStore::connect(url).await?;
            Ok(Arc::new(store))
        }
        #[cfg(feature = "postgres")]
        "postgres" | "postgresql" => {
            let store = PostgresConversationStore::connect(url).await?;
            Ok(Arc::new(store))
        }
        #[cfg(feature = "mysql")]
        "mysql" | "mariadb" => {
            let store = MysqlConversationStore::connect(url).await?;
            Ok(Arc::new(store))
        }
        other => Err(StoreError::UnsupportedScheme(other.to_string())),
    }
}
