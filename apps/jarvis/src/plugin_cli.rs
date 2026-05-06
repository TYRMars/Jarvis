//! `jarvis plugin ...` subcommands.
//!
//! Same connection conventions as `jarvis mcp` / `jarvis skill` —
//! `--server`, `JARVIS_SERVER_URL`, or fall back to
//! `http://<addr>` derived from config.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::config::Config;

#[derive(Subcommand, Debug)]
pub enum PluginAction {
    /// List installed plugins.
    List(ListArgs),
    /// Install a plugin from a local directory containing
    /// `plugin.json`.
    Install(InstallArgs),
    /// Remove an installed plugin by name.
    Remove(RemoveArgs),
    /// Show one plugin's install record.
    Info(InfoArgs),
    /// Print the built-in marketplace stub list.
    Marketplace(MarketplaceArgs),
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
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct InstallArgs {
    #[command(flatten)]
    pub server: ServerArg,
    /// Local directory containing `plugin.json`.
    pub path: String,
}

#[derive(Args, Debug)]
pub struct RemoveArgs {
    #[command(flatten)]
    pub server: ServerArg,
    pub name: String,
}

#[derive(Args, Debug)]
pub struct InfoArgs {
    #[command(flatten)]
    pub server: ServerArg,
    pub name: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct MarketplaceArgs {
    #[command(flatten)]
    pub server: ServerArg,
    #[arg(long)]
    pub json: bool,
}

pub async fn run(action: PluginAction, cfg: Option<&Config>) -> Result<()> {
    match action {
        PluginAction::List(a) => list(a, cfg).await,
        PluginAction::Install(a) => install(a, cfg).await,
        PluginAction::Remove(a) => remove(a, cfg).await,
        PluginAction::Info(a) => info(a, cfg).await,
        PluginAction::Marketplace(a) => marketplace(a, cfg).await,
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
    let addr = addr.replace("0.0.0.0", "127.0.0.1");
    format!("http://{}", addr.trim_end_matches('/'))
}

async fn list(args: ListArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_get(&format!("{base}/v1/plugins")).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let empty = Vec::new();
    let plugins = body
        .get("plugins")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    if plugins.is_empty() {
        println!("(no plugins installed — try `jarvis plugin marketplace`)");
        return Ok(());
    }
    println!(
        "{:<24} {:<10} {:<7} {:<7} DESCRIPTION",
        "NAME", "VERSION", "SKILLS", "MCP"
    );
    for p in plugins {
        let name = p.get("name").and_then(Value::as_str).unwrap_or("");
        let version = p.get("version").and_then(Value::as_str).unwrap_or("");
        let skills_empty = Vec::new();
        let skills = p
            .get("skill_names")
            .and_then(Value::as_array)
            .unwrap_or(&skills_empty)
            .len();
        let mcp_empty = Vec::new();
        let mcp = p
            .get("mcp_prefixes")
            .and_then(Value::as_array)
            .unwrap_or(&mcp_empty)
            .len();
        let desc = p
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("");
        let trimmed = if desc.len() > 50 {
            format!("{}…", &desc[..50])
        } else {
            desc.to_string()
        };
        println!("{name:<24} {version:<10} {skills:<7} {mcp:<7} {trimmed}");
    }
    Ok(())
}

async fn install(args: InstallArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let abs = std::path::Path::new(&args.path);
    let canonical = std::fs::canonicalize(abs)
        .with_context(|| format!("resolve {}", args.path))?
        .display()
        .to_string();
    let req = json!({ "source": "path", "value": canonical });
    let body: Value = http_post_json(&format!("{base}/v1/plugins/install"), &req).await?;
    let plugin = body.get("plugin").cloned().unwrap_or(Value::Null);
    let name = plugin.get("name").and_then(Value::as_str).unwrap_or("?");
    let added_skills_empty = Vec::new();
    let added_skills = body
        .get("added_skills")
        .and_then(Value::as_array)
        .unwrap_or(&added_skills_empty);
    let added_mcp_empty = Vec::new();
    let added_mcp = body
        .get("added_mcp")
        .and_then(Value::as_array)
        .unwrap_or(&added_mcp_empty);
    println!(
        "✓ installed `{name}` ({} skills, {} mcp)",
        added_skills.len(),
        added_mcp.len()
    );
    Ok(())
}

async fn remove(args: RemoveArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let _: Value = http_delete(&format!("{base}/v1/plugins/{}", args.name)).await?;
    println!("✓ removed `{}`", args.name);
    Ok(())
}

async fn info(args: InfoArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_get(&format!("{base}/v1/plugins/{}", args.name)).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&args.name);
    let version = body.get("version").and_then(Value::as_str).unwrap_or("?");
    let dir = body
        .get("install_dir")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let installed_at = body
        .get("installed_at")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let skills_empty = Vec::new();
    let skills = body
        .get("skill_names")
        .and_then(Value::as_array)
        .unwrap_or(&skills_empty);
    let mcp_empty = Vec::new();
    let mcp = body
        .get("mcp_prefixes")
        .and_then(Value::as_array)
        .unwrap_or(&mcp_empty);
    println!("name:       {name}");
    println!("version:    {version}");
    println!("install:    {dir}");
    println!("installed:  {installed_at}");
    println!("skills:     {}", join_str(skills));
    println!("mcp:        {}", join_str(mcp));
    Ok(())
}

async fn marketplace(args: MarketplaceArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_get(&format!("{base}/v1/plugins/marketplace")).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let empty = Vec::new();
    let plugins = body
        .get("plugins")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    if plugins.is_empty() {
        println!("(marketplace is empty)");
        return Ok(());
    }
    for p in plugins {
        let name = p.get("name").and_then(Value::as_str).unwrap_or("");
        let desc = p.get("description").and_then(Value::as_str).unwrap_or("");
        let value = p.get("value").and_then(Value::as_str).unwrap_or("");
        println!("- {name}");
        println!("  {desc}");
        println!("  install: jarvis plugin install {value}");
    }
    Ok(())
}

fn join_str(arr: &[Value]) -> String {
    let names: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
    if names.is_empty() {
        "(none)".to_string()
    } else {
        names.join(", ")
    }
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

async fn http_post_json<B: serde::Serialize>(url: &str, body: &B) -> Result<Value> {
    let res = reqwest::Client::new()
        .post(url)
        .json(body)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
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

async fn http_delete(url: &str) -> Result<Value> {
    let res = reqwest::Client::new()
        .delete(url)
        .send()
        .await
        .with_context(|| format!("DELETE {url}"))?;
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
