//! `jarvis mcp ...` subcommands.
//!
//! Talks to a running `jarvis serve` over HTTP; assumes the server's
//! address is reachable at `--server`, `JARVIS_SERVER_URL`, or
//! `http://127.0.0.1:<JARVIS_ADDR-port>` derived from the config.
//!
//! These commands are operator-facing — they print human-readable
//! summaries on stdout and a non-zero exit on error. JSON output
//! is opt-in via `--json` for scripting.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use harness_mcp::{McpClientConfig, McpTransport};
use serde_json::{json, Value};

use crate::config::Config;

#[derive(Subcommand, Debug)]
pub enum McpAction {
    /// List configured MCP servers (running and stopped).
    List(ListArgs),
    /// Add a new MCP server. Today only stdio transport is wired;
    /// `--url` produces an entry the server will reject at connect
    /// time until the streamable-http feature is enabled.
    Add(AddArgs),
    /// Remove a server by prefix.
    Remove(RemoveArgs),
    /// Probe a server with `tools/list` and report latency.
    Test(TestArgs),
}

#[derive(Args, Debug)]
pub struct ServerArg {
    /// Base URL of the running jarvis server. Defaults to
    /// `JARVIS_SERVER_URL`, then to `http://<addr>` derived from
    /// config / `JARVIS_ADDR`, then to `http://127.0.0.1:7001`.
    #[arg(long, value_name = "URL", global = true)]
    pub server: Option<String>,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    #[command(flatten)]
    pub server: ServerArg,
    /// Print the raw JSON body returned by the server.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct AddArgs {
    #[command(flatten)]
    pub server: ServerArg,
    /// Local prefix for this server (e.g. `github`). Tool names
    /// register as `<prefix>.<remote-name>`.
    pub prefix: String,
    /// Stdio command. Mutually exclusive with `--url`.
    #[arg(long, value_name = "BIN")]
    pub command: Option<String>,
    /// Stdio command args (repeat the flag).
    #[arg(long = "arg", value_name = "VALUE")]
    pub args: Vec<String>,
    /// `KEY=VALUE` env var for the spawned child (repeat).
    #[arg(long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// HTTP transport URL. Mutually exclusive with `--command`.
    #[arg(long, value_name = "URL")]
    pub url: Option<String>,
    /// Use the streamable-http variant when `--url` is set. Defaults
    /// to plain HTTP otherwise.
    #[arg(long)]
    pub streamable_http: bool,
    /// Restrict to these remote tool names (repeat).
    #[arg(long = "allow-tool", value_name = "NAME")]
    pub allow_tools: Vec<String>,
    /// Skip these remote tool names (repeat).
    #[arg(long = "deny-tool", value_name = "NAME")]
    pub deny_tools: Vec<String>,
    /// Per-tool rename: `--alias remote=local` (repeat).
    #[arg(long = "alias", value_name = "FROM=TO")]
    pub alias: Vec<String>,
}

#[derive(Args, Debug)]
pub struct RemoveArgs {
    #[command(flatten)]
    pub server: ServerArg,
    pub prefix: String,
}

#[derive(Args, Debug)]
pub struct TestArgs {
    #[command(flatten)]
    pub server: ServerArg,
    pub prefix: String,
}

pub async fn run(action: McpAction, cfg: Option<&Config>) -> Result<()> {
    match action {
        McpAction::List(a) => list(a, cfg).await,
        McpAction::Add(a) => add(a, cfg).await,
        McpAction::Remove(a) => remove(a, cfg).await,
        McpAction::Test(a) => test(a, cfg).await,
    }
}

fn server_url(arg: &ServerArg, cfg: Option<&Config>) -> String {
    if let Some(url) = &arg.server {
        return url.trim_end_matches('/').to_string();
    }
    if let Ok(url) = std::env::var("JARVIS_SERVER_URL") {
        return url.trim_end_matches('/').to_string();
    }
    let addr = std::env::var("JARVIS_ADDR")
        .ok()
        .or_else(|| cfg.and_then(|c| c.server.addr.clone()))
        .unwrap_or_else(|| "0.0.0.0:7001".to_string());
    // Treat 0.0.0.0 as localhost when the user didn't pin a host.
    let addr = addr.replace("0.0.0.0", "127.0.0.1");
    format!("http://{}", addr.trim_end_matches('/'))
}

async fn list(args: ListArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_get(&format!("{base}/v1/mcp/servers")).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let empty = Vec::new();
    let servers = body.get("servers").and_then(Value::as_array).unwrap_or(&empty);
    if servers.is_empty() {
        println!("(no mcp servers registered)");
        return Ok(());
    }
    println!("{:<16} {:<10} {:<6} TOOLS", "PREFIX", "STATUS", "TRANSP");
    for s in servers {
        let prefix = s.get("prefix").and_then(Value::as_str).unwrap_or("");
        let status = s.get("status").and_then(Value::as_str).unwrap_or("unknown");
        let transport = s
            .pointer("/config/transport/type")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let tools_empty = Vec::new();
        let tools = s
            .get("tools")
            .and_then(Value::as_array)
            .unwrap_or(&tools_empty);
        println!(
            "{:<16} {:<10} {:<6} {}",
            prefix,
            status,
            transport,
            tools.len()
        );
    }
    Ok(())
}

async fn add(args: AddArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let cfg_body = build_client_config(&args)?;
    let body: Value = http_json("POST", &format!("{base}/v1/mcp/servers"), Some(&cfg_body)).await?;
    let prefix = body.get("prefix").and_then(Value::as_str).unwrap_or(&args.prefix);
    let tools_empty = Vec::new();
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .unwrap_or(&tools_empty);
    println!("✓ added `{prefix}` ({} tools)", tools.len());
    for t in tools {
        if let Some(name) = t.as_str() {
            println!("  · {name}");
        }
    }
    Ok(())
}

async fn remove(args: RemoveArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let _: Value = http_json::<()>(
        "DELETE",
        &format!("{base}/v1/mcp/servers/{}", args.prefix),
        None,
    )
    .await?;
    println!("✓ removed `{}`", args.prefix);
    Ok(())
}

async fn test(args: TestArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_json::<()>(
        "POST",
        &format!("{base}/v1/mcp/servers/{}/health", args.prefix),
        None,
    )
    .await?;
    let ok = body.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let latency = body.get("latency_ms").and_then(Value::as_u64).unwrap_or(0);
    if ok {
        let tools = body.get("tools").and_then(Value::as_u64).unwrap_or(0);
        println!("✓ `{}` healthy ({tools} tools, {latency}ms)", args.prefix);
        Ok(())
    } else {
        let err = body.get("error").and_then(Value::as_str).unwrap_or("unknown error");
        anyhow::bail!("`{}` unhealthy ({latency}ms): {err}", args.prefix)
    }
}

fn build_client_config(args: &AddArgs) -> Result<McpClientConfig> {
    if args.command.is_none() && args.url.is_none() {
        anyhow::bail!("either --command or --url is required");
    }
    if args.command.is_some() && args.url.is_some() {
        anyhow::bail!("--command and --url are mutually exclusive");
    }
    let transport = if let Some(cmd) = &args.command {
        let env = args
            .env
            .iter()
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect();
        McpTransport::Stdio {
            command: cmd.clone(),
            args: args.args.clone(),
            env,
        }
    } else if args.streamable_http {
        McpTransport::StreamableHttp {
            url: args.url.clone().unwrap(),
            headers: BTreeMap::new(),
        }
    } else {
        McpTransport::Http {
            url: args.url.clone().unwrap(),
            headers: BTreeMap::new(),
        }
    };
    let mut alias = BTreeMap::new();
    for kv in &args.alias {
        let Some((from, to)) = kv.split_once('=') else {
            anyhow::bail!("--alias expects FROM=TO, got `{kv}`");
        };
        alias.insert(from.to_string(), to.to_string());
    }
    Ok(McpClientConfig {
        prefix: args.prefix.clone(),
        transport,
        allow_tools: if args.allow_tools.is_empty() {
            None
        } else {
            Some(args.allow_tools.clone())
        },
        deny_tools: args.deny_tools.clone(),
        alias,
        enabled: true,
    })
}

async fn http_get(url: &str) -> Result<Value> {
    let res = reqwest::get(url)
        .await
        .with_context(|| format!("GET {url}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("server returned {}: {}", status, text);
    }
    serde_json::from_str(&text).with_context(|| format!("parse JSON from {url}"))
}

async fn http_json<B: serde::Serialize>(method: &str, url: &str, body: Option<&B>) -> Result<Value> {
    let client = reqwest::Client::new();
    let mut req = match method {
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => unreachable!("unknown http method `{method}`"),
    };
    if let Some(b) = body {
        req = req.json(b);
    } else {
        // Some endpoints expect an empty JSON body for POST/DELETE.
        req = req.json(&json!({}));
    }
    let res = req.send().await.with_context(|| format!("{method} {url}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("server returned {}: {}", status, text);
    }
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).with_context(|| format!("parse JSON from {url}"))
}
