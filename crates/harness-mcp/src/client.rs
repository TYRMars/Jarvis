//! Adapt external MCP servers as [`harness_core::Tool`] implementations.
//!
//! Spawn an MCP server as a child process over stdio, discover its tools on
//! connect, and register each one with a [`ToolRegistry`](harness_core::ToolRegistry).
//! Every remote tool call becomes an `tools/call` JSON-RPC request under the
//! hood.
//!
//! Multiple transports are modelled by [`McpTransport`]; today the
//! library only fully wires `Stdio`. `Http` / `StreamableHttp` are
//! recognised by the API surface but will return an error from
//! `McpClient::connect` until the corresponding rmcp feature is
//! enabled — the goal is for callers (config, REST API, UI) to build
//! against the final shape now and have it light up automatically
//! when transport features land.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolRegistry};
use rmcp::{
    model::{CallToolRequestParams, RawContent},
    service::{RoleClient, RunningService},
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use tracing::debug;

use crate::error::McpError;

/// Wire-level transport selection for an MCP server.
///
/// Carries the per-transport connection details directly; this is the
/// shape that round-trips through config files and the HTTP API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum McpTransport {
    /// Spawn a child process speaking MCP over stdio.
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    /// Plain HTTP+JSON-RPC. Reserved for forward-compatibility — wiring
    /// requires the `transport-streamable-http-client` feature on rmcp.
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    /// MCP streamable HTTP — the modern long-lived flavour. Same
    /// forward-compat status as `Http`.
    StreamableHttp {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
}

impl McpTransport {
    pub fn stdio<S: Into<String>>(command: S, args: Vec<String>) -> Self {
        Self::Stdio {
            command: command.into(),
            args,
            env: BTreeMap::new(),
        }
    }
}

/// Shape of a single MCP server to spawn / connect to.
///
/// Backwards-compatible shorthand: `McpClientConfig::new(prefix, command, args)`
/// still produces a stdio-transport config so older callers continue to work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpClientConfig {
    /// Human-readable label; prepended to each remote tool's name as
    /// `<prefix>.<tool>` so tools from multiple servers don't collide.
    pub prefix: String,
    /// How to reach the server.
    pub transport: McpTransport,
    /// Optional allowlist of remote tool names. When `Some`, only
    /// tools whose remote name appears here get registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_tools: Option<Vec<String>>,
    /// Tool names to skip even if otherwise allowed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny_tools: Vec<String>,
    /// Per-tool rename: `remote_name -> local_short_name`. The final
    /// registered name is still `<prefix>.<short>`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub alias: BTreeMap<String, String>,
    /// Whether this server should be auto-started by the manager.
    /// Defaults to `true`. Disabled servers stay in the catalog so
    /// they're discoverable via API but don't consume a slot.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl McpClientConfig {
    /// Backwards-compatible constructor: builds a stdio-transport
    /// entry with no filtering and no aliasing.
    pub fn new(prefix: impl Into<String>, command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            prefix: prefix.into(),
            transport: McpTransport::stdio(command, args),
            allow_tools: None,
            deny_tools: Vec::new(),
            alias: BTreeMap::new(),
            enabled: true,
        }
    }

    pub fn with_alias(mut self, from: impl Into<String>, to: impl Into<String>) -> Self {
        self.alias.insert(from.into(), to.into());
        self
    }

    pub fn with_allow_tools(mut self, allow: Vec<String>) -> Self {
        self.allow_tools = Some(allow);
        self
    }

    pub fn with_deny_tools(mut self, deny: Vec<String>) -> Self {
        self.deny_tools = deny;
        self
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
    /// Spawn / connect to the server described by `cfg` and perform the MCP handshake.
    pub async fn connect(cfg: &McpClientConfig) -> Result<Self, McpError> {
        let service = match &cfg.transport {
            McpTransport::Stdio { command, args, env } => {
                let args = args.clone();
                let env = env.clone();
                let transport = TokioChildProcess::new(Command::new(command).configure(|c| {
                    c.args(&args);
                    for (k, v) in &env {
                        c.env(k, v);
                    }
                }))?;
                ().serve(transport).await?
            }
            McpTransport::Http { .. } | McpTransport::StreamableHttp { .. } => {
                return Err(McpError::Other(
                    "http transport requires the rmcp `transport-streamable-http-client` feature \
                     (not enabled in this build)"
                        .to_string(),
                ));
            }
        };
        debug!(prefix = %cfg.prefix, "connected to mcp server");
        Ok(Self {
            prefix: cfg.prefix.clone(),
            service: Arc::new(service),
        })
    }

    /// Prefix this client registers tools under.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// Fetch every tool the remote server exposes and build an adapter
    /// per tool, applying the config's allow/deny/alias. Returns the
    /// (final-registered-name, Tool) pairs so callers can decide when /
    /// where to insert them — useful for the runtime manager which
    /// inserts under a write lock without holding it across the network
    /// round-trip.
    pub async fn collect_remote_tools(
        &self,
        cfg: &McpClientConfig,
    ) -> Result<Vec<(String, Arc<dyn Tool>)>, McpError> {
        let tools = self.service.peer().list_all_tools().await?;
        let mut out: Vec<(String, Arc<dyn Tool>)> = Vec::new();
        for tool in tools {
            let remote_name = tool.name.to_string();
            if let Some(allow) = &cfg.allow_tools {
                if !allow.iter().any(|a| a == &remote_name) {
                    continue;
                }
            }
            if cfg.deny_tools.iter().any(|d| d == &remote_name) {
                continue;
            }
            let short = cfg
                .alias
                .get(&remote_name)
                .cloned()
                .unwrap_or_else(|| remote_name.clone());
            let name = format!("{}.{}", self.prefix, short);
            let description = tool.description.as_deref().unwrap_or("").to_string();
            let parameters = Value::Object((*tool.input_schema).clone());
            let arc: Arc<dyn Tool> = Arc::new(RemoteTool {
                name: name.clone(),
                description,
                parameters,
                remote_name,
                service: Arc::clone(&self.service),
            });
            out.push((name, arc));
        }
        Ok(out)
    }

    /// Convenience: collect remote tools and register them straight
    /// into `registry`. Equivalent to
    /// `collect_remote_tools(cfg).await?` followed by `register_arc`
    /// for each result.
    pub async fn register_into(
        &self,
        registry: &mut ToolRegistry,
        cfg: &McpClientConfig,
    ) -> Result<Vec<String>, McpError> {
        let tools = self.collect_remote_tools(cfg).await?;
        let mut names = Vec::with_capacity(tools.len());
        for (name, tool) in tools {
            registry.register_arc(tool);
            names.push(name);
        }
        Ok(names)
    }

    /// Probe the server with a `tools/list` round-trip. Returns the
    /// number of tools the server advertises.
    pub async fn health(&self) -> Result<usize, McpError> {
        let tools = self.service.peer().list_all_tools().await?;
        Ok(tools.len())
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
        Ok(format_content(
            &result.content,
            result.structured_content.as_ref(),
        ))
    }
}

fn format_content(content: &[rmcp::model::Content], structured: Option<&Value>) -> String {
    let mut parts = Vec::new();
    for c in content {
        match &c.raw {
            RawContent::Text(t) => parts.push(t.text.clone()),
            RawContent::Image(i) => parts.push(format!(
                "<image mime={} size={}>",
                i.mime_type,
                i.data.len()
            )),
            RawContent::Audio(a) => parts.push(format!(
                "<audio mime={} size={}>",
                a.mime_type,
                a.data.len()
            )),
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
///
/// Disabled entries (`enabled = false`) are skipped silently.
pub async fn connect_all(
    configs: &[McpClientConfig],
    registry: &mut ToolRegistry,
) -> Result<Vec<McpClient>, McpError> {
    let mut clients = Vec::with_capacity(configs.len());
    for cfg in configs {
        if !cfg.enabled {
            continue;
        }
        let client = McpClient::connect(cfg).await?;
        let names = client.register_into(registry, cfg).await?;
        debug!(prefix = %cfg.prefix, registered = names.len(), "mcp tools registered");
        clients.push(client);
    }
    Ok(clients)
}
