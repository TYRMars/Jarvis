//! `jarvis-cli` — terminal coding-agent front-end.
//!
//! Talks to `harness-core::Agent` in-process — no HTTP server.
//! Mirrors the WS handler's three-channel select pattern
//! (`stdin lines, pending approvals, agent events`) but writes to
//! stdout instead of a WebSocket. The point is to give Jarvis a
//! Claude-Code-shaped UX without spinning up the web stack.
//!
//! Two modes:
//!
//! - **Interactive (default).** REPL with tty-driven approval. The
//!   user types a prompt, watches streaming output, and answers
//!   `y` / `n` / `a` / `d` when a gated tool wants to run.
//!   `Ctrl-C` cancels the active turn cleanly.
//! - **Pipe (`--no-interactive`).** Read prompt from `--prompt` or
//!   stdin, run a single turn with `AlwaysDeny` (no human there to
//!   approve), print the final assistant text, exit.
//!
//! See `docs/proposals/cli.md` for the long-form design. This binary
//! covers steps 1-3 + 6 of that proposal; slash commands,
//! conversation persistence, and the optional TUI follow.

mod policy;
mod provider;
mod render;
mod runner;

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(
    name = "jarvis-cli",
    version,
    about = "Terminal coding-agent for Jarvis. In-process — no HTTP server.",
    long_about = None,
)]
pub struct Args {
    /// Workspace root for `fs.*` / `git.*` / `code.grep` /
    /// `shell.exec`. Defaults to the current working directory.
    #[arg(long, alias = "fs-root", value_name = "PATH")]
    pub workspace: Option<PathBuf>,

    /// LLM provider: `openai` (default) / `anthropic` / `google` /
    /// `ollama`. The matching API-key env var is required (except
    /// `ollama`, which talks to a local server).
    #[arg(long, default_value = "openai")]
    pub provider: String,

    /// Override the default model for the chosen provider.
    /// Picked-up env: `JARVIS_MODEL`.
    #[arg(long)]
    pub model: Option<String>,

    /// Enable `shell.exec` (off by default — arbitrary command
    /// execution against the host is the most dangerous primitive).
    /// Still goes through the approval gate.
    #[arg(long)]
    pub allow_shell: bool,

    /// Enable `fs.write` (off by default; `fs.edit` and `fs.patch`
    /// are always on for the CLI — coding agents need to be able
    /// to mutate). Approval-gated regardless.
    #[arg(long)]
    pub allow_fs_write: bool,

    /// Disable the read-only `git.*` toolset. Useful when `git`
    /// isn't on PATH or you want a smaller toolset.
    #[arg(long)]
    pub no_git_read: bool,

    /// Pipe mode: read the prompt from `--prompt` (or stdin if
    /// omitted), run one turn with `AlwaysDeny` so no tool that
    /// needs a human can fire, print the final assistant text,
    /// exit. Suitable for shell pipelines.
    #[arg(long)]
    pub no_interactive: bool,

    /// Prompt for `--no-interactive`. When omitted, stdin is read
    /// to EOF.
    #[arg(long)]
    pub prompt: Option<String>,

    /// Cap on agent loop iterations per turn. Defaults to 30.
    #[arg(long, default_value_t = 30)]
    pub max_iterations: usize,

    /// Don't auto-load `AGENTS.md` / `CLAUDE.md` / `AGENT.md` from
    /// the workspace root into the system prompt. Same effect as
    /// `JARVIS_NO_PROJECT_CONTEXT=1`. Default behaviour matches the
    /// HTTP server: project instructions are loaded automatically
    /// when present, capped at 32 KiB.
    #[arg(long)]
    pub no_project_context: bool,

    /// Bind this REPL to a Project (id or slug). Loads the project's
    /// `instructions` from the configured store and appends them to
    /// the system prompt — purely informational, since `jarvis-cli`
    /// doesn't persist conversations. Requires `JARVIS_DB_URL` to be
    /// set; errors at startup otherwise.
    #[arg(long, value_name = "ID_OR_SLUG")]
    pub project: Option<String>,

    /// Initial permission mode: `ask` (default), `accept-edits`,
    /// `plan`, `auto`. Switch at runtime with `/mode <name>`.
    /// `bypass` requires `--dangerously-skip-permissions`.
    #[arg(long, value_name = "MODE")]
    pub permission_mode: Option<String>,

    /// Allow `--permission-mode bypass`. The flag name is the warning;
    /// only use inside isolated sandboxes.
    #[arg(long)]
    pub dangerously_skip_permissions: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    // tracing → stderr so streamed assistant text on stdout stays
    // pipe-clean. RUST_LOG=info or higher keeps the terminal quiet
    // by default; set RUST_LOG=debug for tool-level logs.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();

    let workspace = match args.workspace.clone() {
        Some(p) => p,
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    if args.no_interactive {
        runner::run_pipe(args, workspace).await
    } else {
        runner::run_repl(args, workspace).await
    }
}
