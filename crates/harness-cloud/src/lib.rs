//! Cloud / Edge runtime scaffold.
//!
//! Placeholder crate for node model, transport trait, and envelope schema.
//! No cloud SDKs are introduced yet.

pub mod envelope;
pub mod model;
pub mod transport;

pub use envelope::Envelope;
pub use model::{CloudVendor, EdgeCapabilities, EdgeNode, EdgeNodeStatus, EdgeToolSpec, ToolRisk};
pub use transport::EdgeTransport;
