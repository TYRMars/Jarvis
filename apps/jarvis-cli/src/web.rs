//! Spawn the bundled `jarvis serve` HTTP server alongside the REPL
//! so the user can drive the same agent via the web UI when they
//! prefer a graphical surface.
//!
//! Why a sub-process instead of an in-process axum task: the
//! production server has a much larger surface (projects /
//! requirements / skills / plugins / MCP / auto-mode / worktree)
//! than the CLI builds. Mounting that in-process from `jarvis-cli`
//! would mean copying ~1k lines of composition-root logic and risk
//! drift. A child process that runs the same binary the user
//! already has installed (via `cargo install --path apps/jarvis`)
//! gives us the full surface for free, and any future feature added
//! to `jarvis serve` flows through automatically the next time the
//! user re-installs.
//!
//! Persistence is the join point: pass the same `--db` URL (or rely
//! on the `JARVIS_DB_URL` default) so conversations created in the
//! CLI show up in the web UI's list and vice-versa.
//!
//! `tokio::process::Command::kill_on_drop(true)` guarantees the
//! child dies with the parent — no orphaned servers on Ctrl-C.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::{Child, Command};

use crate::Args;

/// Locate the `jarvis` binary the way most CLI tools do: env
/// override → sibling of `current_exe()` (so `cargo run` Just Works)
/// → PATH fall-through. Returns the path/spec to hand to
/// `Command::new`. PATH fall-through means the OS does the lookup,
/// so we get a real "command not found" error from `spawn` if
/// `jarvis` isn't installed.
fn locate_jarvis_binary() -> PathBuf {
    // 1. Explicit override — useful in dev for pointing at a
    //    `target/debug/jarvis` while running `target/release/
    //    jarvis-cli` or vice-versa.
    if let Ok(p) = std::env::var("JARVIS_BIN") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // 2. Sibling of the running CLI binary. When running from
    //    `~/.cargo/bin/jarvis-cli`, this finds `~/.cargo/bin/jarvis`.
    //    During `cargo run`, both binaries land in `target/<profile>`
    //    and this picks the matching one.
    if let Ok(self_exe) = std::env::current_exe() {
        if let Some(parent) = self_exe.parent() {
            let bin_name = if cfg!(windows) {
                "jarvis.exe"
            } else {
                "jarvis"
            };
            let candidate = parent.join(bin_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    // 3. Bare name — let the OS search PATH.
    PathBuf::from(if cfg!(windows) {
        "jarvis.exe"
    } else {
        "jarvis"
    })
}

/// Spawn `jarvis serve --workspace <ws>` as a background child
/// process. Returns the [`Child`] handle so the caller can keep it
/// alive for the duration of the REPL — when the handle drops, the
/// child is killed (via `kill_on_drop(true)`).
///
/// Stdout / stderr are silenced by default so the spawned server
/// doesn't interleave with the REPL's prompt. Set `JARVIS_WEB_LOGS=1`
/// to inherit them when debugging server-side issues.
pub async fn spawn(args: &Args, workspace: &Path) -> Result<Child> {
    let bin = locate_jarvis_binary();
    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .arg("--workspace")
        .arg(workspace.as_os_str());

    // The CLI's `--web-addr` overrides whatever JARVIS_ADDR the user
    // had in their environment for the spawned child only — we don't
    // touch the parent's env.
    cmd.env("JARVIS_ADDR", &args.web_addr);

    // If the CLI was started with `--db <url>` and the user hasn't
    // explicitly set JARVIS_DB_URL, mirror the URL into the child so
    // both surfaces share persistence. Honouring an existing env var
    // keeps the behaviour predictable in custom setups.
    if let Some(url) = &args.db {
        if std::env::var_os("JARVIS_DB_URL").is_none() {
            cmd.env("JARVIS_DB_URL", url);
        }
    }

    // Quiet by default — the REPL owns the user's terminal. Toggle
    // off for diagnostics.
    let inherit_logs = std::env::var_os("JARVIS_WEB_LOGS")
        .map(|v| v != "0" && !v.is_empty())
        .unwrap_or(false);
    if !inherit_logs {
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
    }

    // Critical: the child must die with the parent. Without this,
    // Ctrl-C / EOF / panic in the REPL would leak a server still
    // bound to the port.
    cmd.kill_on_drop(true);

    let child = cmd
        .spawn()
        .with_context(|| format!("failed to launch web server via `{}`", bin.display()))?;
    Ok(child)
}
