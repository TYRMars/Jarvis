use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An edge node registered with the cloud control plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeNode {
    pub id: String,
    pub display_name: Option<String>,
    pub provider: CloudVendor,
    pub region: Option<String>,
    pub labels: Vec<String>,
    pub status: EdgeNodeStatus,
    pub capabilities: EdgeCapabilities,
    pub last_seen_at: Option<String>,
}

/// Capabilities advertised by an edge node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeCapabilities {
    pub tools: Vec<EdgeToolSpec>,
    pub supports_approval: bool,
    pub supports_streaming: bool,
}

/// Specification for a tool exposed by an edge node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub risk: ToolRisk,
}

/// Risk level of an edge tool.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    ReadOnly,
    Network,
    Write,
    Exec,
    Cost,
}

/// Cloud vendor or deployment target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudVendor {
    Local,
    Generic,
    Aliyun,
    Aws,
    Azure,
    Tencent,
    Huawei,
    Gcp,
    Oracle,
    Baidu,
    Volcengine,
    Cloudflare,
    Other(String),
}

/// Runtime status of an edge node.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeNodeStatus {
    Online,
    Offline,
    Unknown,
}
