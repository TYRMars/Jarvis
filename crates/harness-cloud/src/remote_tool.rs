//! Remote edge tool adapter: exposes an Edge node's local tool to the Cloud agent loop.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use harness_core::{BoxError, Tool};

use crate::{CloudPolicy, EdgeCommand, EdgeCommandKind, NodeRegistry};

/// A [`Tool`] implementation that forwards invocations to an Edge node.
pub struct RemoteEdgeTool {
    pub node_id: String,
    pub remote_name: String,
    pub public_name: String,
    pub description: String,
    pub parameters: Value,
    pub risk: crate::ToolRisk,
    pub policy: Arc<CloudPolicy>,
    pub nodes: Arc<dyn NodeRegistry>,
}

#[async_trait]
impl Tool for RemoteEdgeTool {
    fn name(&self) -> &str {
        &self.public_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> Value {
        self.parameters.clone()
    }

    fn category(&self) -> harness_core::ToolCategory {
        match self.risk {
            crate::ToolRisk::ReadOnly => harness_core::ToolCategory::Read,
            crate::ToolRisk::Network => harness_core::ToolCategory::Network,
            crate::ToolRisk::Write | crate::ToolRisk::Exec | crate::ToolRisk::Cost => {
                harness_core::ToolCategory::Write
            }
        }
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        // 1. Policy check
        if !self.policy.is_allowed(&self.public_name, &self.node_id) {
            return Err(format!(
                "tool error: remote tool {} on node {} blocked by policy",
                self.public_name, self.node_id
            )
            .into());
        }

        // 2. Check node is online
        let node = self.nodes.get(&self.node_id).await?;
        if node.is_none() || !matches!(node.unwrap().status, crate::EdgeNodeStatus::Online) {
            return Err(format!(
                "tool error: node {} is offline or unavailable",
                self.node_id
            )
            .into());
        }

        // 3. Send command and await result (timeout handled by caller)
        let cmd = EdgeCommand {
            command_id: uuid::Uuid::new_v4().to_string(),
            kind: EdgeCommandKind::InvokeTool,
            payload: serde_json::json!({
                "tool": self.remote_name,
                "args": args,
            }),
        };

        // Placeholder: in full implementation this would route through the
        // command bus and await the matching EdgeCommandResult.
        let result = self.nodes.send_command(&self.node_id, cmd).await?;

        if result.ok {
            Ok(result.output.unwrap_or_default())
        } else {
            Err(format!(
                "tool error: remote invocation failed: {}",
                result.error.unwrap_or_default()
            )
            .into())
        }
    }
}
