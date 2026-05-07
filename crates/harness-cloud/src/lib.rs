//! Cloud / Edge runtime scaffold.
//!
//! Defines the node model, transport trait, and envelope schema.
//! No cloud SDKs are introduced yet; all vendor-specific code lives behind
//! future feature gates or adapter crates.

pub mod audit;
pub mod envelope;
pub mod loopback;
pub mod model;
pub mod node_registry;
pub mod policy;
pub mod protocol;
pub mod remote_tool;
pub mod transport;
pub mod websocket;

pub use audit::{AuditStatus, ToolInvocationAudit, ToolInvocationAuditStore};
pub use envelope::{Envelope, Payload};
pub use loopback::{loopback_transport, LoopbackTransport};
pub use model::{CloudVendor, EdgeCapabilities, EdgeNode, EdgeNodeStatus, EdgeToolSpec, ToolRisk};
pub use node_registry::{MemoryNodeRegistry, NodeRegistry};
pub use policy::{CloudPolicy, EdgeConfig, EdgeRoute, NodeSelector};
pub use protocol::{
    EdgeCommand, EdgeCommandKind, EdgeCommandResult, RuntimeHeartbeat, RuntimeMessage,
    RuntimeRegister, TaskCancel, TaskClaim, TaskComplete, TaskDispatch, TaskFail, TaskMessage,
    TaskProgress, TaskProgressEvent,
};
pub use remote_tool::RemoteEdgeTool;
pub use transport::EdgeTransport;
pub use websocket::{connect_edge, WebSocketTransport, WsEdgeTransportConfig};
