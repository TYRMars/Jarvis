use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Boxed error wrapper so `Tool::invoke` can return any error type without
/// pulling `anyhow` into the public surface of harness-core.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("tool not found: {0}")]
    ToolNotFound(String),

    #[error("tool `{name}` failed: {source}")]
    ToolFailed {
        name: String,
        #[source]
        source: BoxError,
    },

    #[error("llm provider error: {0}")]
    Provider(String),

    #[error("agent reached max iterations ({0}) without terminating")]
    MaxIterations(usize),

    #[error("invalid tool arguments for `{name}`: {message}")]
    InvalidArguments { name: String, message: String },

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}
