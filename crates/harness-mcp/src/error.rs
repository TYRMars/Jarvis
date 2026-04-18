use thiserror::Error;

/// Errors surfaced by the MCP bridge.
#[derive(Debug, Error)]
pub enum McpError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("mcp service: {0}")]
    Service(String),
    #[error("mcp call: {0}")]
    Call(String),
    #[error("mcp: {0}")]
    Other(String),
}

impl From<rmcp::ServiceError> for McpError {
    fn from(value: rmcp::ServiceError) -> Self {
        Self::Service(value.to_string())
    }
}

impl From<rmcp::service::ClientInitializeError> for McpError {
    fn from(value: rmcp::service::ClientInitializeError) -> Self {
        Self::Service(value.to_string())
    }
}

impl From<rmcp::service::ServerInitializeError> for McpError {
    fn from(value: rmcp::service::ServerInitializeError) -> Self {
        Self::Service(value.to_string())
    }
}
