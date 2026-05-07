//! Cloud-side policy for Edge tool routing and permission.

use serde::{Deserialize, Serialize};

/// Top-level cloud policy configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloudPolicy {
    pub nodes: Vec<EdgeConfig>,
    pub routes: Vec<EdgeRoute>,
}

/// Per-edge-node configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeConfig {
    pub id: String,
    pub labels: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub require_approval: Vec<String>,
    pub fs_roots: Vec<String>,
}

/// Routing rule: which nodes serve which tool prefixes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRoute {
    pub tool_prefix: String,
    pub node_selector: NodeSelector,
}

/// Selector for matching nodes by labels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSelector {
    pub labels: Vec<String>,
}

/// Allow/deny rule for a specific tool pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolAllowRule {
    pub tool: String,
    pub nodes: Vec<String>,
    pub allowed: bool,
}

impl CloudPolicy {
    /// Check whether a tool is allowed on a given node.
    pub fn is_allowed(&self, tool_name: &str, node_id: &str) -> bool {
        // Find node config
        let node_cfg = self.nodes.iter().find(|n| n.id == node_id);
        if let Some(cfg) = node_cfg {
            // Explicit deny list
            if cfg.require_approval.iter().any(|t| t == tool_name) {
                return false;
            }
            // Explicit allow list
            if cfg.allowed_tools.iter().any(|t| t == tool_name) {
                return true;
            }
            // Default deny if allowed_tools is non-empty
            if !cfg.allowed_tools.is_empty() {
                return false;
            }
        }
        // Default allow when no explicit policy is set
        true
    }
}
