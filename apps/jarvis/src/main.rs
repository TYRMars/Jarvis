use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use harness_core::{Agent, AgentConfig, ToolRegistry};
use harness_llm::{OpenAiConfig, OpenAiProvider};
use harness_mcp::{connect_all_mcp, serve_registry_stdio, McpClientConfig};
use harness_server::{serve, AppState};
use harness_tools::{register_builtins, BuiltinsConfig};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();

    let mut tools = ToolRegistry::new();
    register_builtins(
        &mut tools,
        BuiltinsConfig {
            fs_root: PathBuf::from(
                std::env::var("JARVIS_FS_ROOT").unwrap_or_else(|_| ".".into()),
            ),
            enable_fs_write: std::env::var("JARVIS_ENABLE_FS_WRITE").is_ok(),
            ..BuiltinsConfig::default()
        },
    );

    // If invoked with --mcp-serve, expose the local ToolRegistry over MCP stdio
    // instead of starting the HTTP server. No LLM provider is needed for this
    // mode, so we skip OpenAI setup and any MCP *client* connections.
    if std::env::args().any(|a| a == "--mcp-serve") {
        info!(registered = tools.len(), "serving tools over mcp stdio");
        serve_registry_stdio(Arc::new(tools)).await?;
        return Ok(());
    }

    let api_key = std::env::var("OPENAI_API_KEY").context("OPENAI_API_KEY must be set")?;
    let model = std::env::var("JARVIS_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
    let base_url = std::env::var("OPENAI_BASE_URL").ok();

    let mut cfg = OpenAiConfig::new(api_key);
    if let Some(base) = base_url {
        cfg = cfg.with_base_url(base);
    }
    let llm: Arc<dyn harness_core::LlmProvider> = Arc::new(OpenAiProvider::new(cfg));

    // Optional: connect to external MCP servers listed in JARVIS_MCP_SERVERS.
    // Format: comma-separated `prefix=command arg1 arg2` entries.
    let mcp_clients = if let Ok(spec) = std::env::var("JARVIS_MCP_SERVERS") {
        let configs = parse_mcp_servers(&spec)?;
        connect_all_mcp(&configs, &mut tools).await?
    } else {
        Vec::new()
    };
    info!(
        registered = tools.len(),
        mcp_servers = mcp_clients.len(),
        "tools registered"
    );

    let agent_cfg = AgentConfig::new(model)
        .with_system_prompt("You are Jarvis, a concise and capable assistant.")
        .with_tools(tools)
        .with_max_iterations(8);
    let agent = Arc::new(Agent::new(llm, agent_cfg));

    // Optional persistence. `JARVIS_DB_URL` picks the backend by scheme
    // (`sqlite:...`, `postgres://...`, `mysql://...`); omit it to run fully
    // in memory.
    let mut state = AppState::new(agent);
    if let Ok(db_url) = std::env::var("JARVIS_DB_URL") {
        let store = harness_store::connect(&db_url)
            .await
            .with_context(|| format!("opening JARVIS_DB_URL `{db_url}`"))?;
        info!(url = %db_url, "conversation store connected");
        state = state.with_store(store);
    }

    let addr: SocketAddr = std::env::var("JARVIS_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:7001".to_string())
        .parse()
        .context("invalid JARVIS_ADDR")?;
    info!(%addr, "jarvis listening");
    serve(addr, state).await?;

    // Keep clients alive until here; drop explicitly so the Drop order is clear.
    drop(mcp_clients);
    Ok(())
}

fn parse_mcp_servers(spec: &str) -> anyhow::Result<Vec<McpClientConfig>> {
    let mut out = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (prefix, cmdline) = entry
            .split_once('=')
            .with_context(|| format!("expected `prefix=command ...`, got `{entry}`"))?;
        let mut parts = cmdline.split_whitespace();
        let command = parts
            .next()
            .with_context(|| format!("mcp server `{prefix}` has no command"))?
            .to_string();
        let args = parts.map(str::to_string).collect();
        out.push(McpClientConfig::new(prefix, command, args));
    }
    Ok(out)
}
