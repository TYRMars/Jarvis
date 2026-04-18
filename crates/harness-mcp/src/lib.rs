//! MCP bridge for the agent harness.
//!
//! Two directions:
//!
//! - [`client`] — spawn an external MCP server over stdio, list its tools, and
//!   adapt each one into a [`harness_core::Tool`] so the agent can invoke it
//!   like any built-in tool.
//! - [`server`] — wrap a local [`ToolRegistry`](harness_core::ToolRegistry) in
//!   an MCP server that can be driven over stdio, letting external MCP-aware
//!   clients discover and call our tools.
//!
//! Both sides use the `rmcp` SDK and speak JSON-RPC over whichever transport
//! rmcp supports. The helpers here only wire stdio + child-process transports;
//! callers wanting HTTP/WebSocket variants can drop down to rmcp directly.

pub mod client;
pub mod error;
pub mod server;

pub use client::{connect_all as connect_all_mcp, McpClient, McpClientConfig};
pub use error::McpError;
pub use server::{serve_registry_stdio, McpServer};
