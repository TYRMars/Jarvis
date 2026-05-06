//! `jarvis skill ...` subcommands.
//!
//! Talks to a running `jarvis serve` over HTTP. Same connection
//! conventions as `jarvis mcp` — `--server`, `JARVIS_SERVER_URL`,
//! or fall back to `http://<addr>` derived from config.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use serde_json::Value;

use crate::config::Config;

#[derive(Subcommand, Debug)]
pub enum SkillAction {
    /// List every skill the running server has loaded.
    List(ListArgs),
    /// Print one skill's manifest + body markdown.
    Show(ShowArgs),
    /// Trigger a re-scan of the skill roots on the running server.
    Reload(ReloadArgs),
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
pub struct ShowArgs {
    #[command(flatten)]
    pub server: ServerArg,
    pub name: String,
    /// Print the raw JSON body (skips human-readable rendering).
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct ReloadArgs {
    #[command(flatten)]
    pub server: ServerArg,
}

pub async fn run(action: SkillAction, cfg: Option<&Config>) -> Result<()> {
    match action {
        SkillAction::List(a) => list(a, cfg).await,
        SkillAction::Show(a) => show(a, cfg).await,
        SkillAction::Reload(a) => reload(a, cfg).await,
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
    let body: Value = http_get(&format!("{base}/v1/skills")).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let empty = Vec::new();
    let skills = body
        .get("skills")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    if skills.is_empty() {
        println!("(no skills loaded — drop a SKILL.md under ~/.config/jarvis/skills/<name>/)");
        return Ok(());
    }
    println!("{:<24} {:<10} {:<10} DESCRIPTION", "NAME", "SOURCE", "ACT");
    for s in skills {
        let name = s.get("name").and_then(Value::as_str).unwrap_or("");
        let source = s.get("source").and_then(Value::as_str).unwrap_or("?");
        let activation = s.get("activation").and_then(Value::as_str).unwrap_or("?");
        let desc = s
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("");
        let trimmed = if desc.len() > 60 {
            format!("{}…", &desc[..60])
        } else {
            desc.to_string()
        };
        println!("{name:<24} {source:<10} {activation:<10} {trimmed}");
    }
    Ok(())
}

async fn show(args: ShowArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_get(&format!("{base}/v1/skills/{}", urlencoding(&args.name))).await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&args.name);
    let desc = body
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let source = body.get("source").and_then(Value::as_str).unwrap_or("?");
    let path = body.get("path").and_then(Value::as_str).unwrap_or("?");
    let body_md = body.get("body").and_then(Value::as_str).unwrap_or("");
    println!("name: {name}");
    println!("source: {source}");
    println!("path: {path}");
    println!("description: {desc}");
    println!();
    println!("{body_md}");
    Ok(())
}

async fn reload(args: ReloadArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let body: Value = http_post(&format!("{base}/v1/skills/reload")).await?;
    let count = body.get("count").and_then(Value::as_u64).unwrap_or(0);
    println!("✓ catalog count: {count}");
    Ok(())
}

fn urlencoding(s: &str) -> String {
    // Skill names are kebab-case ASCII so we don't need full
    // percent-encoding; just refuse anything with '/' which would
    // change the URL shape.
    if s.contains('/') {
        // The server's catalog can't have it either, so this is a
        // type / validation issue worth surfacing rather than
        // silently encoding.
        return s.replace('/', "%2F");
    }
    s.to_string()
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

async fn http_post(url: &str) -> Result<Value> {
    let res = reqwest::Client::new()
        .post(url)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("server returned {}: {}", status, text);
    }
    if text.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&text).with_context(|| format!("parse JSON from {url}"))
}
