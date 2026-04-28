//! Round-trip test: drive a [`McpServer`] through an in-memory duplex pipe
//! using a raw `rmcp` client and verify listing + calling a tool works.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolRegistry};
use harness_mcp::McpServer;
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Value};

struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn description(&self) -> &str {
        "Echo back the `text` argument."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        })
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        Ok(args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }
}

#[tokio::test]
async fn server_round_trip_over_duplex() {
    let mut registry = ToolRegistry::new();
    registry.register(EchoTool);
    let server = McpServer::new(Arc::new(registry));

    let (server_io, client_io) = tokio::io::duplex(64 * 1024);

    let server_handle = tokio::spawn(async move {
        let svc = server.serve(server_io).await.expect("server serve");
        let _ = svc.waiting().await;
    });

    let client = ().serve(client_io).await.expect("client serve");

    let tools = client.peer().list_all_tools().await.expect("list tools");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");

    let params = CallToolRequestParams::new("echo").with_arguments({
        let mut m = rmcp::model::JsonObject::new();
        m.insert("text".into(), json!("hi via mcp"));
        m
    });
    let result = client.peer().call_tool(params).await.expect("call tool");
    assert!(result.is_error != Some(true));
    let rmcp::model::RawContent::Text(text) = &result.content[0].raw else {
        panic!("expected text content");
    };
    assert_eq!(text.text, "hi via mcp");

    client.cancel().await.ok();
    server_handle.abort();
}
