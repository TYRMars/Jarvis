//! Error type for `harness-store`.
//!
//! `StoreError` wraps the concrete failures a backend can produce (sqlx,
//! serde_json) plus a couple of local variants. It converts cleanly into
//! the `BoxError` the [`ConversationStore`](harness_core::ConversationStore)
//! trait returns, so backend impls can just use `?`.

/// Errors produced while opening a store or running a query.
///
/// Implements `std::error::Error`, so the blanket `From<E> for Box<dyn Error>`
/// lets backend methods return [`BoxError`](harness_core::BoxError) with `?`.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// [`connect`](crate::connect) was handed a URL whose scheme we don't
    /// recognise, or whose backend feature isn't enabled in this build.
    #[error("unsupported database scheme: {0}")]
    UnsupportedScheme(String),

    #[cfg(any(feature = "sqlite", feature = "postgres", feature = "mysql"))]
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}
