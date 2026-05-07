//! Audit event model for cloud-side tool invocations.

use serde::{Deserialize, Serialize};

/// A single audited tool invocation through an Edge node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInvocationAudit {
    pub id: String,
    pub node_id: String,
    pub tool_name: String,
    pub args_json: String,
    pub result_status: AuditStatus,
    pub result_excerpt: Option<String>,
    pub requested_by: String,
    pub conversation_id: Option<String>,
    pub tenant_slug: String,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Outcome of an audited invocation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditStatus {
    Pending,
    Success,
    Denied,
    Error,
    Timeout,
}

/// Trait for persisting and querying tool invocation audits.
#[async_trait::async_trait]
pub trait ToolInvocationAuditStore: Send + Sync {
    async fn append(&self, record: &ToolInvocationAudit) -> Result<(), harness_core::BoxError>;
    async fn list_for_node(
        &self,
        node_id: &str,
        limit: u32,
    ) -> Result<Vec<ToolInvocationAudit>, harness_core::BoxError>;
    async fn list_for_conversation(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<ToolInvocationAudit>, harness_core::BoxError>;
}
