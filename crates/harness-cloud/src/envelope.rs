use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Common envelope for all cloud / edge messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(rename = "type")]
    pub ty: String,
    pub id: String,
    pub ts: String,
    pub workspace_slug: String,
    pub runtime_id: String,
    pub payload: Value,
}
