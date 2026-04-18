//! Expose a harness [`ToolRegistry`] to external MCP clients.
//!
//! The server side implements `rmcp::ServerHandler` directly (rather than the
//! `#[tool_router]` macro) because tools in the registry are only known at
//! runtime, not at compile time.

use std::sync::Arc;

use harness_core::ToolRegistry;
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, Content, ErrorCode, InitializeResult, JsonObject,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool as McpTool,
    },
    service::{NotificationContext, RequestContext, RoleServer},
    transport::stdio,
    ErrorData as McpRpcError, ServerHandler, ServiceExt,
};
use serde_json::Value;
use tracing::warn;

use crate::error::McpError;

/// An MCP server backed by a [`ToolRegistry`].
#[derive(Clone)]
pub struct McpServer {
    registry: Arc<ToolRegistry>,
    info: ServerInfo,
}

impl McpServer {
    /// Build a server that advertises every tool in `registry`.
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        let info = InitializeResult::new(capabilities)
            .with_instructions("Jarvis harness exposing its local ToolRegistry over MCP.");
        Self { registry, info }
    }

    fn list_tools_sync(&self) -> ListToolsResult {
        let tools = self
            .registry
            .specs()
            .into_iter()
            .map(|spec| {
                let schema_obj = match spec.parameters {
                    Value::Object(map) => map,
                    _ => JsonObject::new(),
                };
                McpTool::new(spec.name, spec.description, Arc::new(schema_obj))
            })
            .collect();
        ListToolsResult::with_all_items(tools)
    }

    async fn call_tool_sync(
        &self,
        params: CallToolRequestParams,
    ) -> Result<CallToolResult, McpRpcError> {
        let Some(tool) = self.registry.resolve(&params.name) else {
            return Err(McpRpcError::new(
                ErrorCode::METHOD_NOT_FOUND,
                format!("unknown tool: {}", params.name),
                None,
            ));
        };
        let args = params
            .arguments
            .map(Value::Object)
            .unwrap_or(Value::Null);
        match tool.invoke(args).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        self.info.clone()
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpRpcError> {
        Ok(self.list_tools_sync())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpRpcError> {
        self.call_tool_sync(request).await
    }

    async fn on_initialized(&self, _context: NotificationContext<RoleServer>) {
        // No-op: we don't need to react to the client's initialized notification.
    }
}

/// Serve `registry` over stdio until the peer disconnects.
pub async fn serve_registry_stdio(registry: Arc<ToolRegistry>) -> Result<(), McpError> {
    let server = McpServer::new(registry);
    let service = server.serve(stdio()).await?;
    if let Err(e) = service.waiting().await {
        warn!(error = %e, "mcp server exited with error");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{BoxError, Tool};
    use serde_json::json;

    struct HelloTool;

    #[async_trait]
    impl Tool for HelloTool {
        fn name(&self) -> &str { "hello" }
        fn description(&self) -> &str { "Say hello." }
        fn parameters(&self) -> Value {
            json!({ "type": "object", "properties": { "who": { "type": "string" } } })
        }
        async fn invoke(&self, args: Value) -> Result<String, BoxError> {
            let who = args.get("who").and_then(|v| v.as_str()).unwrap_or("world");
            Ok(format!("hello, {who}"))
        }
    }

    #[tokio::test]
    async fn list_tools_returns_registered_specs() {
        let mut registry = ToolRegistry::new();
        registry.register(HelloTool);
        let server = McpServer::new(Arc::new(registry));
        let res = server.list_tools_sync();
        assert_eq!(res.tools.len(), 1);
        assert_eq!(res.tools[0].name, "hello");
    }

    #[tokio::test]
    async fn call_tool_routes_to_registry() {
        let mut registry = ToolRegistry::new();
        registry.register(HelloTool);
        let server = McpServer::new(Arc::new(registry));
        let params = CallToolRequestParams::new("hello")
            .with_arguments({
                let mut m = JsonObject::new();
                m.insert("who".into(), json!("jarvis"));
                m
            });
        let res = server.call_tool_sync(params).await.unwrap();
        assert!(res.is_error != Some(true));
        let text = match &res.content[0].raw {
            rmcp::model::RawContent::Text(t) => &t.text,
            _ => panic!("expected text"),
        };
        assert_eq!(text, "hello, jarvis");
    }

    #[tokio::test]
    async fn call_tool_unknown_returns_method_not_found() {
        let registry = ToolRegistry::new();
        let server = McpServer::new(Arc::new(registry));
        let params = CallToolRequestParams::new("missing");
        let err = server.call_tool_sync(params).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::METHOD_NOT_FOUND);
    }
}
