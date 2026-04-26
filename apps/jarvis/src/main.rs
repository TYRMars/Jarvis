//! `jarvis` binary — clap dispatcher.
//!
//! Subcommands:
//!
//! - (none) / `serve` — start the HTTP server. Default behaviour, no
//!   change for env-var-driven setups.
//! - `mcp-serve` — expose the local tool registry over MCP stdio.
//!   The legacy `--mcp-serve` flag is still accepted as an alias.
//! - `init` / `login` / `logout` / `status` — onboarding stubs;
//!   landing in the next PR (see `docs/proposals/onboarding.md`).
//!
//! Resolution layers, highest priority first:
//!
//! 1. command-line flags (e.g. `--addr`, `--model`)
//! 2. environment variables (the existing `JARVIS_*` surface)
//! 3. config file (TOML — see [`config`])
//! 4. compiled-in defaults

use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use tracing::info;
use tracing_subscriber::EnvFilter;

mod auth_store;
mod config;
mod init;
mod login;
mod serve;
mod status;

#[cfg(test)]
mod test_env;

use config::Config;

#[derive(Parser, Debug)]
#[command(
    name = "jarvis",
    version,
    about = "Local agent runtime: pluggable LLM providers, tools, memory.",
    long_about = None,
)]
struct Cli {
    /// Path to a TOML config file. If unset, jarvis searches
    /// `$JARVIS_CONFIG`, `$XDG_CONFIG_HOME/jarvis/config.toml`,
    /// `~/.config/jarvis/config.toml`, and (on Windows)
    /// `%APPDATA%\jarvis\config.toml` in that order.
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,

    /// (deprecated) Use `jarvis mcp-serve` instead.
    #[arg(long, global = true, hide = true)]
    mcp_serve: bool,

    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Start the HTTP server (default if no subcommand is given).
    Serve(ServeArgs),
    /// Expose the local tool registry as an MCP server over stdio.
    /// No LLM credentials required.
    #[command(name = "mcp-serve")]
    McpServe,
    /// Interactive setup wizard — writes config + auth files.
    Init {
        /// Overwrite an existing config file.
        #[arg(long)]
        force: bool,
    },
    /// Authenticate against a provider. For `codex` this runs the
    /// PKCE OAuth flow against `auth.openai.com`; for API-key
    /// providers (`openai`, `anthropic`, `google`, `kimi`) it
    /// stores the key on disk — pass it via `--key`, pipe it on
    /// stdin, or fall back to the interactive (hidden) prompt.
    Login {
        /// Defaults to `codex` (the only provider that needs OAuth).
        #[arg(long)]
        provider: Option<String>,
        /// API key for non-OAuth providers. Skips the interactive
        /// prompt. Avoid in shell history — prefer stdin (pipe) or
        /// the prompt if the key is sensitive.
        #[arg(long, value_name = "KEY")]
        key: Option<String>,
        /// Use the OAuth device-code flow instead of opening a
        /// browser. Useful over SSH or in containers without a
        /// browser. Only meaningful for `--provider codex`.
        #[arg(long)]
        device_code: bool,
        /// Don't update `[provider].name` in `config.toml` after a
        /// successful login. By default, `jarvis login --provider X`
        /// makes `X` the active provider so the next `jarvis serve`
        /// uses it without further setup.
        #[arg(long)]
        no_set_default: bool,
    },
    /// Drop stored credentials for a provider.
    Logout {
        #[arg(long)]
        provider: Option<String>,
    },
    /// Print current config and auth status.
    Status,
}

#[derive(Args, Debug, Default)]
pub(crate) struct ServeArgs {
    /// Listen address. Overrides config and `JARVIS_ADDR`.
    #[arg(long, value_name = "HOST:PORT")]
    pub addr: Option<String>,

    /// LLM provider. Overrides config and `JARVIS_PROVIDER`.
    #[arg(long)]
    pub provider: Option<String>,

    /// Default model. Overrides config and `JARVIS_MODEL`.
    #[arg(long)]
    pub model: Option<String>,

    /// Additional provider to construct at startup. Repeat the flag
    /// to enable several. Each enabled provider must have its own
    /// auth on disk (`jarvis login --provider <name>`) — startup
    /// fails fast otherwise. Merges with `[provider].enabled` from
    /// the config file; the primary `--provider` is always enabled.
    #[arg(long = "enable", value_name = "NAME")]
    pub enable: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    let loaded = Config::discover(cli.config.as_deref())?;
    if let Some((path, _)) = &loaded {
        info!(config_path = %path.display(), "loaded config file");
    }
    let cfg = loaded.map(|(_, c)| c);

    // Backwards-compat: the historic `--mcp-serve` flag still routes
    // to the new subcommand.
    if cli.mcp_serve {
        return serve::run_mcp(cfg).await;
    }

    match cli.command.unwrap_or(Cmd::Serve(ServeArgs::default())) {
        Cmd::Serve(args) => serve::run(cfg, args).await,
        Cmd::McpServe => serve::run_mcp(cfg).await,
        Cmd::Init { force } => init::run(force),
        Cmd::Login {
            provider,
            key,
            device_code,
            no_set_default,
        } => login::run(provider, key, device_code, no_set_default).await,
        Cmd::Logout { provider } => logout(provider),
        Cmd::Status => status::run(cli.config.as_deref()),
    }
}

fn logout(provider: Option<String>) -> Result<()> {
    let p = provider.unwrap_or_else(|| "codex".to_string());
    // Provider aliases that share an auth file by convention:
    //   `openai-responses` shares with `openai`
    //   `moonshot` shares with `kimi`
    let canonical = match p.as_str() {
        "openai-responses" => "openai",
        "moonshot" => "kimi",
        other => other,
    };
    let removed = auth_store::delete(canonical)?;
    if removed {
        eprintln!("✓ removed credentials for `{canonical}`");
    } else {
        eprintln!("(no credentials on file for `{canonical}`)");
    }
    Ok(())
}

