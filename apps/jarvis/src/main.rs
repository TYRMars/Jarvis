use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use harness_core::{Agent, AgentConfig, BoxError, Tool, ToolRegistry};
use harness_llm::{OpenAiConfig, OpenAiProvider};
use harness_server::{serve, AppState};
use serde_json::{json, Value};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let api_key = std::env::var("OPENAI_API_KEY")
        .context("OPENAI_API_KEY must be set")?;
    let model = std::env::var("JARVIS_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
    let base_url = std::env::var("OPENAI_BASE_URL").ok();

    let mut cfg = OpenAiConfig::new(api_key);
    if let Some(base) = base_url {
        cfg = cfg.with_base_url(base);
    }
    let llm: Arc<dyn harness_core::LlmProvider> = Arc::new(OpenAiProvider::new(cfg));

    let mut tools = ToolRegistry::new();
    tools.register(EchoTool);

    let agent_cfg = AgentConfig::new(model)
        .with_system_prompt("You are Jarvis, a concise and capable assistant.")
        .with_tools(tools)
        .with_max_iterations(8);
    let agent = Arc::new(Agent::new(llm, agent_cfg));

    let addr: SocketAddr = std::env::var("JARVIS_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:7001".to_string())
        .parse()
        .context("invalid JARVIS_ADDR")?;
    info!(%addr, "jarvis listening");
    serve(addr, AppState::new(agent)).await?;
    Ok(())
}

/// Trivial built-in tool used to prove the wiring end-to-end.
struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }

    fn description(&self) -> &str {
        "Echo the `text` argument back verbatim. Useful for testing the tool loop."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "Text to echo." }
            },
            "required": ["text"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `text` argument".into() })?;
        Ok(text.to_string())
    }
}
