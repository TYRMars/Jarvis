//! Adapt external MCP servers as [`harness_core::Tool`] implementations.
//!
//! Spawn an MCP server as a child process over stdio, discover its tools on
//! connect, and register each one with a [`ToolRegistry`](harness_core::ToolRegistry).
//! Every remote tool call becomes an `tools/call` JSON-RPC request under the
//! hood.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolRegistry};
use rmcp::{
    model::{CallToolRequestParams, RawContent},
    service::{RoleClient, RunningService},
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde_json::Value;
use tokio::process::Command;
use tracing::debug;

use crate::error::McpError;

/// Shape of a single MCP server to spawn as a subprocess.
#[derive(Debug, Clone)]
pub struct McpClientConfig {
    /// Human-readable label; prepended to each remote tool's name as
    /// `<prefix>.<tool>` so tools from multiple servers don't collide.
    pub prefix: String,
    /// Executable and arguments to run. The child must speak MCP on stdio.
    pub command: String,
    pub args: Vec<String>,
}

impl McpClientConfig {
    pub fn new(
        prefix: impl Into<String>,
        command: impl Into<String>,
        args: Vec<String>,
    ) -> Self {
        Self {
            prefix: prefix.into(),
            command: command.into(),
            args,
        }
    }
}

/// A connected MCP client holding a running child process.
///
/// The child is killed when this value is dropped; keep it alive for as long
/// as you want to use the adapted tools.
pub struct McpClient {
    prefix: String,
    service: Arc<RunningService<RoleClient, ()>>,
}

impl McpClient {
    /// Spawn the child described by `cfg` and perform the MCP handshake.
    pub async fn connect(cfg: &McpClientConfig) -> Result<Self, McpError> {
        let args = cfg.args.clone();
        let transport = TokioChildProcess::new(Command::new(&cfg.command).configure(|c| {
            c.args(&args);
        }))?;
        let service = ().serve(transport).await?;
        debug!(prefix = %cfg.prefix, "connected to mcp server");
        Ok(Self {
            prefix: cfg.prefix.clone(),
            service: Arc::new(service),
        })
    }

    /// Fetch every tool the remote server exposes and register an adapter
    /// for each one with `registry`.
    pub async fn register_into(&self, registry: &mut ToolRegistry) -> Result<usize, McpError> {
        let tools = self.service.peer().list_all_tools().await?;
        let mut count = 0;
        for tool in tools {
            let name = format!("{}.{}", self.prefix, tool.name);
            let description = tool
                .description
                .as_deref()
                .unwrap_or("")
                .to_string();
            let parameters = Value::Object((*tool.input_schema).clone());
            let remote_name = tool.name.to_string();
            registry.register_arc(Arc::new(RemoteTool {
                name,
                description,
                parameters,
                remote_name,
                service: Arc::clone(&self.service),
            }));
            count += 1;
        }
        Ok(count)
    }

    /// Gracefully cancel the MCP session and reap the child.
    pub async fn shutdown(self) {
        if let Some(service) = Arc::into_inner(self.service) {
            let _ = service.cancel().await;
        }
    }
}

struct RemoteTool {
    name: String,
    description: String,
    parameters: Value,
    remote_name: String,
    service: Arc<RunningService<RoleClient, ()>>,
}

#[async_trait]
impl Tool for RemoteTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        self.parameters.clone()
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let arguments = match args {
            Value::Object(map) => Some(map),
            Value::Null => None,
            other => {
                return Err(format!(
                    "mcp tool {} expected an object argument, got {}",
                    self.remote_name, other
                )
                .into());
            }
        };
        let mut params = CallToolRequestParams::new(self.remote_name.clone());
        if let Some(map) = arguments {
            params = params.with_arguments(map);
        }
        let result = self.service.peer().call_tool(params).await?;

        if matches!(result.is_error, Some(true)) {
            return Err(format_error(&result.content).into());
        }
        Ok(format_content(&result.content, result.structured_content.as_ref()))
    }
}

fn format_content(
    content: &[rmcp::model::Content],
    structured: Option<&Value>,
) -> String {
    let mut parts = Vec::new();
    for c in content {
        match &c.raw {
            RawContent::Text(t) => parts.push(t.text.clone()),
            RawContent::Image(i) => {
                parts.push(format!("<image mime={} size={}>", i.mime_type, i.data.len()))
            }
            RawContent::Audio(a) => {
                parts.push(format!("<audio mime={} size={}>", a.mime_type, a.data.len()))
            }
            RawContent::Resource(r) => parts.push(format!("<resource: {:?}>", r.resource)),
            RawContent::ResourceLink(l) => parts.push(format!("<resource link: {}>", l.uri)),
        }
    }
    if let Some(s) = structured {
        parts.push(s.to_string());
    }
    parts.join("\n")
}

fn format_error(content: &[rmcp::model::Content]) -> String {
    let text = format_content(content, None);
    if text.is_empty() {
        "mcp tool error (no content)".to_string()
    } else {
        text
    }
}

/// Convenience: connect to every server in `configs` and register their tools
/// into `registry`. Returns the still-connected clients so the caller can keep
/// them alive for the lifetime of the agent.
pub async fn connect_all(
    configs: &[McpClientConfig],
    registry: &mut ToolRegistry,
) -> Result<Vec<McpClient>, McpError> {
    let mut clients = Vec::with_capacity(configs.len());
    for cfg in configs {
        let client = McpClient::connect(cfg).await?;
        let n = client.register_into(registry).await?;
        debug!(prefix = %cfg.prefix, registered = n, "mcp tools registered");
        clients.push(client);
    }
    Ok(clients)
}
