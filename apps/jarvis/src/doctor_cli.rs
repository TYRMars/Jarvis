//! `jarvis doctor` — pretty-print orphan worktrees, stuck runs, and
//! recent failed runs from a running `jarvis serve`. Hits the same
//! `/v1/diagnostics/*` REST surface the Web UI Diagnostics page
//! consumes; useful for SSH / cron / CI contexts where the browser
//! isn't available.
//!
//! Default output is human-readable (lines + tables); `--json` emits
//! the raw server payload for scripting. `--cleanup` adds an explicit
//! call to `POST /v1/diagnostics/worktrees/orphans/cleanup` after the
//! listing — guarded by a `y/N` prompt unless `--yes` is also passed.

use anyhow::Result;
use clap::Args;
use serde_json::Value;

use crate::config::Config;

#[derive(Args, Debug)]
pub struct DoctorArgs {
    /// Base URL of the running jarvis server. Defaults to
    /// `JARVIS_SERVER_URL`, then to `http://<addr>` derived from
    /// config / `JARVIS_ADDR`, then to `http://127.0.0.1:7001`.
    #[arg(long, value_name = "URL")]
    pub server: Option<String>,

    /// Emit raw JSON instead of the human-readable summary.
    #[arg(long)]
    pub json: bool,

    /// After listing, call the orphan-cleanup endpoint. Prompts for
    /// confirmation unless `--yes` is also passed.
    #[arg(long)]
    pub cleanup: bool,

    /// Skip the cleanup confirmation prompt.
    #[arg(long)]
    pub yes: bool,

    /// Override the "stuck" age threshold (default 3600s).
    #[arg(long, value_name = "SECONDS", default_value_t = 3600)]
    pub stuck_threshold_seconds: u64,

    /// Cap on recent-failure entries (default 20).
    #[arg(long, value_name = "N", default_value_t = 20)]
    pub failed_limit: u32,
}

pub async fn run(args: DoctorArgs, cfg: Option<&Config>) -> Result<()> {
    let base = server_url(&args.server, cfg);
    let client = reqwest::Client::new();

    let orphans = fetch(&client, &format!("{base}/v1/diagnostics/worktrees/orphans")).await?;
    let stuck = fetch(
        &client,
        &format!(
            "{base}/v1/diagnostics/runs/stuck?threshold_seconds={}&limit=500",
            args.stuck_threshold_seconds
        ),
    )
    .await?;
    let failed = fetch(
        &client,
        &format!(
            "{base}/v1/diagnostics/runs/failed?limit={}",
            args.failed_limit
        ),
    )
    .await?;

    if args.json {
        let bundle = serde_json::json!({
            "orphans": orphans,
            "stuck": stuck,
            "failed": failed,
        });
        println!("{}", serde_json::to_string_pretty(&bundle)?);
    } else {
        print_orphans(&orphans);
        print_stuck(&stuck, args.stuck_threshold_seconds);
        print_failed(&failed);
    }

    if args.cleanup {
        let count = orphans
            .as_ref()
            .and_then(|v| v.get("items"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if count == 0 {
            eprintln!("\n(no orphan worktrees to clean up)");
            return Ok(());
        }
        if !args.yes && !confirm(&format!("Remove {count} orphan worktree(s)? [y/N] "))? {
            eprintln!("aborted");
            return Ok(());
        }
        let report = cleanup(&client, &base).await?;
        eprintln!(
            "cleanup attempted={} removed={}",
            report
                .get("attempted")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            report.get("removed").and_then(Value::as_u64).unwrap_or(0)
        );
        if let Some(errs) = report.get("errors").and_then(Value::as_array) {
            for e in errs {
                eprintln!(
                    "  ! {} — {}",
                    e.get("path").and_then(Value::as_str).unwrap_or("?"),
                    e.get("reason").and_then(Value::as_str).unwrap_or("?"),
                );
            }
        }
    }
    Ok(())
}

/// 200 → JSON, 503 → `Ok(None)` (feature unavailable; matches the
/// service-layer behaviour and keeps the human-readable output
/// consistent with the Web UI).
async fn fetch(client: &reqwest::Client, url: &str) -> Result<Option<Value>> {
    let resp = client.get(url).send().await?;
    if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Ok(None);
    }
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("GET {url} → {status}: {body}");
    }
    Ok(Some(resp.json().await?))
}

async fn cleanup(client: &reqwest::Client, base: &str) -> Result<Value> {
    let url = format!("{base}/v1/diagnostics/worktrees/orphans/cleanup");
    let resp = client.post(&url).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("POST {url} → {status}: {body}");
    }
    Ok(resp.json().await?)
}

fn print_orphans(orphans: &Option<Value>) {
    println!("== Orphan worktrees ==");
    let Some(v) = orphans else {
        println!("  (worktree feature off — set JARVIS_WORKTREE_MODE=per_run to enable)");
        return;
    };
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        println!("  (none)");
        return;
    }
    for it in items {
        println!(
            "  {} ({}, modified {}, run {})",
            it.get("path").and_then(Value::as_str).unwrap_or("?"),
            fmt_bytes(it.get("size_bytes").and_then(Value::as_u64).unwrap_or(0)),
            it.get("modified_at").and_then(Value::as_str).unwrap_or("?"),
            it.get("run_id")
                .and_then(Value::as_str)
                .map(|s| s.split('-').next().unwrap_or(s))
                .unwrap_or("?")
        );
    }
}

fn print_stuck(stuck: &Option<Value>, threshold: u64) {
    println!("\n== Stuck runs (>= {threshold}s pending/running) ==");
    let Some(v) = stuck else {
        println!("  (run store not configured — set JARVIS_DB_URL)");
        return;
    };
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        println!("  (none)");
        return;
    }
    for it in items {
        let id = it
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.split('-').next().unwrap_or(s))
            .unwrap_or("?");
        let status = it.get("status").and_then(Value::as_str).unwrap_or("?");
        let age = it.get("age_seconds").and_then(Value::as_u64).unwrap_or(0);
        let started = it.get("started_at").and_then(Value::as_str).unwrap_or("?");
        println!("  {id}  {status} for {}  started {started}", fmt_age(age));
    }
}

fn print_failed(failed: &Option<Value>) {
    println!("\n== Recent failed runs ==");
    let Some(v) = failed else {
        println!("  (run store not configured — set JARVIS_DB_URL)");
        return;
    };
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        println!("  (none)");
        return;
    }
    for it in items {
        let id = it
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.split('-').next().unwrap_or(s))
            .unwrap_or("?");
        let req = it
            .get("requirement_id")
            .and_then(Value::as_str)
            .map(|s| s.split('-').next().unwrap_or(s))
            .unwrap_or("?");
        let finished = it
            .get("finished_at")
            .and_then(Value::as_str)
            .unwrap_or("?");
        println!("  {id}  req {req}  finished {finished}");
        if let Some(err) = it.get("error").and_then(Value::as_str) {
            // First line of the error keeps the table compact.
            let first = err.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                println!("    ! {first}");
            }
        }
    }
}

fn fmt_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", (n as f64) / 1024.0)
    } else {
        format!("{:.1} MB", (n as f64) / 1024.0 / 1024.0)
    }
}

fn fmt_age(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{:.1}h", (seconds as f64) / 3600.0)
    }
}

fn confirm(prompt: &str) -> Result<bool> {
    use std::io::Write;
    eprint!("{prompt}");
    std::io::stderr().flush().ok();
    let mut buf = String::new();
    std::io::stdin().read_line(&mut buf)?;
    Ok(matches!(buf.trim().to_lowercase().as_str(), "y" | "yes"))
}

fn server_url(arg: &Option<String>, cfg: Option<&Config>) -> String {
    if let Some(url) = arg {
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
