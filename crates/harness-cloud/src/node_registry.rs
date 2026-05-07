//! Node registry: tracks Edge nodes known to the Cloud control plane.

use std::collections::HashMap;
use std::sync::RwLock;

use harness_core::BoxError;

use crate::{EdgeCommand, EdgeCommandResult, EdgeNode};

/// Async trait for storing and querying edge nodes.
#[async_trait::async_trait]
pub trait NodeRegistry: Send + Sync {
    async fn register(&self, node: EdgeNode) -> Result<(), BoxError>;
    async fn update_status(&self, node_id: &str, status: crate::EdgeNodeStatus) -> Result<(), BoxError>;
    async fn get(&self, node_id: &str) -> Result<Option<EdgeNode>, BoxError>;
    async fn list(&self) -> Result<Vec<EdgeNode>, BoxError>;
    async fn delete(&self, node_id: &str) -> Result<bool, BoxError>;
    async fn send_command(&self, node_id: &str, command: EdgeCommand) -> Result<EdgeCommandResult, BoxError>;
}

/// In-memory node registry for tests and single-process deployments.
#[derive(Default)]
pub struct MemoryNodeRegistry {
    nodes: RwLock<HashMap<String, EdgeNode>>,
}

impl MemoryNodeRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl NodeRegistry for MemoryNodeRegistry {
    async fn register(&self, node: EdgeNode) -> Result<(), BoxError> {
        let mut guard = self.nodes.write().map_err(|e| format!("lock poison: {e}"))?;
        guard.insert(node.id.clone(), node);
        Ok(())
    }

    async fn update_status(&self, node_id: &str, status: crate::EdgeNodeStatus) -> Result<(), BoxError> {
        let mut guard = self.nodes.write().map_err(|e| format!("lock poison: {e}"))?;
        if let Some(n) = guard.get_mut(node_id) {
            n.status = status;
        }
        Ok(())
    }

    async fn get(&self, node_id: &str) -> Result<Option<EdgeNode>, BoxError> {
        let guard = self.nodes.read().map_err(|e| format!("lock poison: {e}"))?;
        Ok(guard.get(node_id).cloned())
    }

    async fn list(&self) -> Result<Vec<EdgeNode>, BoxError> {
        let guard = self.nodes.read().map_err(|e| format!("lock poison: {e}"))?;
        Ok(guard.values().cloned().collect())
    }

    async fn delete(&self, node_id: &str) -> Result<bool, BoxError> {
        let mut guard = self.nodes.write().map_err(|e| format!("lock poison: {e}"))?;
        Ok(guard.remove(node_id).is_some())
    }

    async fn send_command(&self, _node_id: &str, _command: EdgeCommand) -> Result<EdgeCommandResult, BoxError> {
        // In-memory registry can't forward to a real transport;
        // callers should use the transport directly for now.
        Ok(EdgeCommandResult {
            command_id: _command.command_id,
            ok: false,
            output: None,
            error: Some("in-memory registry cannot forward commands".into()),
        })
    }
}
