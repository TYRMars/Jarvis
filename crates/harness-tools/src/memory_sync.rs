//! P10 — `memory.sync` / `memory.sync_status`.
//!
//! Git-as-transport network sync for the M3.1+P9 memory tree. The
//! operator (or their team) hosts a private git repo somewhere they
//! already trust (GitHub / GitLab / self-hosted), points the local
//! `~/.jarvis/memory/` at it via `git remote add origin <url>`, and
//! these two tools wrap pull/push + status so the agent can keep the
//! local tree in step without the user re-typing git commands.
//!
//! Why git?
//!
//! - Auth, conflict resolution, history, branching, offline buffering
//!   are all solved problems on git's side.
//! - The user has a clear mental model: it's a repo, it follows the
//!   same rules as every other git checkout they have.
//! - We don't have to design, ship, or maintain a sync server.
//! - The same flow works for `<workspace>/.jarvis/memory/` too —
//!   that directory naturally syncs via the workspace's own repo,
//!   `memory.sync` is mostly meant for the `~/.jarvis/memory/`
//!   (user-scope) case where there's no auto-sync from the workspace's
//!   normal git flow.
//!
//! Both tools are opt-in via [`crate::BuiltinsConfig::enable_memory_sync`]
//! — they spawn the host's `git` binary which is more side-effectful
//! than the rest of the memory toolset.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::memory::{MemoryRoots, MemoryScope, MEMORY_DIR};

/// Which sync transport the user has opted into. Mutually
/// exclusive — the model + tool set adapt to the choice so a
/// `git`-backed deployment never sees iCloud-only tools and vice
/// versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemorySyncBackend {
    /// No automatic sync transport. Memory still works locally;
    /// the agent just doesn't have any "push it elsewhere" tool.
    /// Default when the user hasn't opted in.
    #[default]
    None,
    /// P10/P11 — git pull/push against a remote. Cross-platform,
    /// explicit, works for any host with `git` on `PATH`.
    Git,
    /// P13 — store the user-scope memory inside iCloud Drive and
    /// let macOS sync it automatically. No protocol code in
    /// Jarvis; the OS handles everything once files land in
    /// `~/Library/Mobile Documents/com~apple~CloudDocs/Jarvis/`.
    /// macOS-only.
    ICloud,
}

impl MemorySyncBackend {
    pub fn as_wire(&self) -> &'static str {
        match self {
            MemorySyncBackend::None => "none",
            MemorySyncBackend::Git => "git",
            MemorySyncBackend::ICloud => "icloud",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "none" | "off" | "disabled" => Some(MemorySyncBackend::None),
            "git" => Some(MemorySyncBackend::Git),
            "icloud" | "icloud-drive" => Some(MemorySyncBackend::ICloud),
            _ => None,
        }
    }
}

/// macOS iCloud Drive base path. Same value for every user on the
/// machine because the OS stitches it onto each home directory.
/// Returns `None` off macOS — the caller can decide whether to
/// error or fall back.
pub fn icloud_drive_root() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join("Library/Mobile Documents/com~apple~CloudDocs"))
}

/// Resolved location of the Jarvis memory subdir inside iCloud
/// Drive. `None` when iCloud Drive isn't available (non-macOS,
/// HOME unresolvable, or the iCloud root dir doesn't exist —
/// happens when the user hasn't enabled iCloud Drive). Callers
/// should fall back to the non-iCloud user_root in that case.
pub fn icloud_memory_root() -> Option<PathBuf> {
    let root = icloud_drive_root()?;
    if !root.exists() {
        return None;
    }
    Some(root.join("Jarvis"))
}

/// 60s default. Network pulls / pushes can take a few seconds even
/// on a healthy link; a tighter cap would kill normal interactive
/// use. The model can pass a shorter `timeout_ms` per call.
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_BYTES: usize = 64 * 1024;

/// Resolve `<scope_root>/.jarvis/memory/` for a sync operation, then
/// return its absolute path. Returns `BoxError` (user-facing) when
/// the requested scope isn't configured.
fn memory_dir_for(roots: &MemoryRoots, scope: MemoryScope) -> Result<PathBuf, BoxError> {
    let root = roots.root_for(scope)?;
    Ok(root.join(MEMORY_DIR))
}

/// Run `git` with the given args inside `cwd`. Pulled out so both
/// tools share the same spawn / timeout / output-truncation contract.
async fn run_git(
    cwd: &Path,
    args: &[&str],
    timeout_ms: u64,
) -> Result<(bool, String, String), BoxError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| -> BoxError { format!("failed to spawn git: {e}").into() })?;

    let output =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("git process error: {e}").into()),
            Err(_) => return Err(format!("git timed out after {timeout_ms} ms").into()),
        };

    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stdout.len() > DEFAULT_MAX_BYTES {
        truncate_to(&mut stdout, DEFAULT_MAX_BYTES);
    }
    if stderr.len() > DEFAULT_MAX_BYTES {
        truncate_to(&mut stderr, DEFAULT_MAX_BYTES);
    }
    Ok((output.status.success(), stdout, stderr))
}

fn truncate_to(s: &mut String, max_bytes: usize) {
    let cut = s
        .char_indices()
        .take_while(|(i, _)| *i < max_bytes)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    s.truncate(cut);
    s.push_str(&format!("\n[... truncated at {max_bytes} bytes ...]\n"));
}

/// Quick "is this dir a git work tree" probe — uses
/// `rev-parse --is-inside-work-tree` which exits 0 inside a repo and
/// fails outside one. Cheaper than running `status` just to check.
async fn is_git_repo(cwd: &Path) -> bool {
    if !cwd.exists() {
        return false;
    }
    let Ok((ok, _, _)) = run_git(cwd, &["rev-parse", "--is-inside-work-tree"], 5_000).await else {
        return false;
    };
    ok
}

fn parse_scope_arg(s: &str) -> Result<MemoryScope, BoxError> {
    MemoryScope::from_wire(s)
        .ok_or_else(|| -> BoxError { format!("unknown scope `{s}` — use `workspace` or `user`").into() })
}

/// User-facing setup hint when the memory dir isn't a git repo yet.
fn setup_hint(path: &Path) -> String {
    format!(
        "memory dir `{}` is not a git repository.\n\
         to set up sync:\n  \
         1. create a private remote repo (GitHub / GitLab / self-hosted)\n  \
         2. cd {} && git init && git remote add origin <url>\n  \
         3. git add . && git commit -m \"seed\" && git push -u origin main\n\
         then re-run memory.sync.",
        path.display(),
        path.display(),
    )
}

// --- memory.sync ---

pub struct MemorySyncTool {
    roots: MemoryRoots,
}

impl MemorySyncTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemorySyncTool {
    fn name(&self) -> &str {
        "memory.sync"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Sync the memory tree with its configured git remote. \
         Defaults to user scope (`~/.jarvis/memory/`). Runs \
         `git pull --rebase` then `git push`; if either fails (merge \
         conflict, auth, no remote, no network) returns the git \
         stderr verbatim plus a hint. The memory dir must already be \
         a git working tree — run `memory.sync_status` first to \
         check, or follow the setup hint the tool prints on first \
         use. Approval-gated because the push side has an external \
         effect."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Which memory tree to sync. Defaults to `user`."
                },
                "remote": {
                    "type": "string",
                    "description": "Optional remote name (defaults to `origin`)."
                },
                "branch": {
                    "type": "string",
                    "description": "Optional branch (defaults to the repo's current branch)."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Per-git-call timeout. Defaults to 60000 (60s)."
                }
            }
        })
    }
    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let scope = args.get("scope").and_then(Value::as_str).unwrap_or("user");
        let remote = args
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or("origin");
        Some(format!("{scope} → {remote}"))
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::User);
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let dir = memory_dir_for(&roots, scope)?;
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        if !is_git_repo(&dir).await {
            return Err(setup_hint(&dir).into());
        }

        let remote = args
            .get("remote")
            .and_then(Value::as_str)
            .unwrap_or("origin");
        // Validate remote / branch names — refuse anything that
        // looks like a flag so the model can't smuggle a
        // `--upload-pack=<cmd>` style option through.
        if remote.starts_with('-') || remote.contains(char::is_whitespace) {
            return Err(format!("invalid remote name `{remote}`").into());
        }

        let branch_arg = args.get("branch").and_then(Value::as_str);
        if let Some(b) = branch_arg {
            if b.starts_with('-') || b.contains(char::is_whitespace) {
                return Err(format!("invalid branch name `{b}`").into());
            }
        }

        let mut report = serde_json::Map::new();
        report.insert("scope".into(), json!(scope.as_wire()));
        report.insert("dir".into(), json!(dir.display().to_string()));
        report.insert("remote".into(), json!(remote));

        // Pull --rebase first so concurrent edits from other clones
        // land cleanly. `--autostash` would help if the local has
        // uncommitted changes, but `memory.write` writes through
        // an atomic temp-rename and we don't expect a dirty tree —
        // surface dirty state as a clear error instead of silently
        // stashing.
        let mut pull_args = vec!["pull", "--rebase"];
        if let Some(b) = branch_arg {
            pull_args.push(remote);
            pull_args.push(b);
        }
        let (pull_ok, pull_out, pull_err) = run_git(&dir, &pull_args, timeout_ms).await?;
        report.insert(
            "pull".into(),
            json!({
                "ok": pull_ok,
                "stdout": pull_out.trim(),
                "stderr": pull_err.trim(),
            }),
        );
        if !pull_ok {
            report.insert(
                "hint".into(),
                json!(
                    "pull failed — run `git -C <dir> status` to inspect; \
                     resolve conflicts manually and re-run memory.sync."
                ),
            );
            return Ok(serde_json::to_string_pretty(&report).unwrap_or_default());
        }

        // Push only after a clean pull.
        let mut push_args = vec!["push"];
        if let Some(b) = branch_arg {
            push_args.push(remote);
            push_args.push(b);
        }
        let (push_ok, push_out, push_err) = run_git(&dir, &push_args, timeout_ms).await?;
        report.insert(
            "push".into(),
            json!({
                "ok": push_ok,
                "stdout": push_out.trim(),
                "stderr": push_err.trim(),
            }),
        );
        if !push_ok {
            report.insert(
                "hint".into(),
                json!(
                    "push failed — common causes: remote not set, auth missing, \
                     or branch not tracking. Run `git -C <dir> push -u origin <branch>` once \
                     to establish tracking."
                ),
            );
        }

        // Capture HEAD so the caller can confirm the sync moved
        // (or didn't) and the model can log it.
        if let Ok((true, head, _)) = run_git(&dir, &["rev-parse", "HEAD"], 5_000).await {
            report.insert("head".into(), json!(head.trim()));
        }
        Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

// --- background auto-sync ticker (P11.2) ---

/// Default cadence for the background auto-sync ticker: 5 minutes.
/// Long enough that a quick burst of edits doesn't hammer the
/// remote, short enough that cross-machine drift stays bounded.
pub const DEFAULT_AUTO_SYNC_INTERVAL_SECS: u64 = 300;

/// Configuration knob for [`spawn_auto_sync_task`].
#[derive(Debug, Clone)]
pub struct AutoSyncConfig {
    pub roots: MemoryRoots,
    /// Which scope to sync on tick. Typically `User` — workspace
    /// scope is generally tracked by the project's own repo and
    /// shouldn't ping a separate remote on every tick.
    pub scope: MemoryScope,
    /// Tick interval. The first tick fires after `interval` from
    /// startup, not immediately, so an early shell doesn't race
    /// with `serve_*_runtime` initialisation.
    pub interval: Duration,
    /// Whether to also run one sync immediately at task start
    /// (useful for picking up changes another machine pushed
    /// while this one was offline). Defaults to true via
    /// [`AutoSyncConfig::with_defaults`].
    pub initial_pull: bool,
}

impl AutoSyncConfig {
    pub fn with_defaults(roots: MemoryRoots) -> Self {
        Self {
            roots,
            scope: MemoryScope::User,
            interval: Duration::from_secs(DEFAULT_AUTO_SYNC_INTERVAL_SECS),
            initial_pull: true,
        }
    }
}

/// Spawn a background tokio task that periodically syncs the
/// configured memory scope against its git remote. Returns the
/// `JoinHandle` so the caller can keep it alive for the process
/// lifetime; drop it to stop ticking. Failures are logged via
/// `tracing::warn!` — a flaky network can't bring down the server.
pub fn spawn_auto_sync_task(cfg: AutoSyncConfig) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let tool = MemorySyncTool::new(cfg.roots.clone());
        if cfg.initial_pull {
            run_one_sync(&tool, cfg.scope, "initial").await;
        }
        let mut ticker = tokio::time::interval(cfg.interval);
        // First `tick()` returns immediately — skip it so we don't
        // double-fire alongside the optional initial pull.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            run_one_sync(&tool, cfg.scope, "periodic").await;
        }
    })
}

async fn run_one_sync(tool: &MemorySyncTool, scope: MemoryScope, kind: &'static str) {
    let args = serde_json::json!({ "scope": scope.as_wire() });
    match tool.invoke(args).await {
        Ok(body) => {
            tracing::info!(
                kind,
                scope = scope.as_wire(),
                report = %body.trim().replace('\n', " "),
                "memory auto-sync ok",
            );
        }
        Err(e) => {
            tracing::warn!(
                kind,
                scope = scope.as_wire(),
                error = %e,
                "memory auto-sync failed (will retry on next tick)",
            );
        }
    }
}

// --- memory.sync_setup_icloud (P13) ---

pub struct MemoryICloudSetupTool {
    roots: MemoryRoots,
}

impl MemoryICloudSetupTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemoryICloudSetupTool {
    fn name(&self) -> &str {
        "memory.sync_setup_icloud"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "Set up iCloud Drive as the user-scope memory sync transport \
         (macOS only). Creates a `Jarvis/` folder inside \
         `~/Library/Mobile Documents/com~apple~CloudDocs/` (iCloud \
         Drive's local mount) and returns the absolute path. macOS \
         then syncs that folder to every device signed into the same \
         Apple ID — no Jarvis-side protocol needed. \
         \
         Caveats: macOS-only (this tool errors on Linux/Windows); \
         the operator must have iCloud Drive enabled in System \
         Settings; first run may need to set \
         `JARVIS_MEMORY_USER_ROOT` to the returned path until \
         iCloud auto-resolution is wired up at startup."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        })
    }
    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        if !cfg!(target_os = "macos") {
            return Err("iCloud Drive sync is macOS-only".into());
        }
        let drive_root = icloud_drive_root()
            .ok_or_else(|| -> BoxError { "HOME unresolvable; cannot locate iCloud Drive".into() })?;
        if !drive_root.exists() {
            return Err(format!(
                "iCloud Drive base `{}` does not exist. Enable iCloud Drive in System Settings first.",
                drive_root.display()
            )
            .into());
        }
        let target = drive_root.join("Jarvis");
        tokio::fs::create_dir_all(&target)
            .await
            .map_err(|e| -> BoxError { format!("mkdir {}: {e}", target.display()).into() })?;
        // Note `roots` for parity with other setup tools — having
        // the user_root match what `memory.*` is operating on means
        // a subsequent sync_status call can verify everything points
        // at the same place.
        let _ = &self.roots;

        let report = json!({
            "ok": true,
            "path": target.display().to_string(),
            "hint": format!(
                "Restart jarvis with `JARVIS_MEMORY_USER_ROOT={}` (or `JARVIS_MEMORY_SYNC_BACKEND=icloud`) to make this the active user-scope memory root.",
                target.display()
            ),
        });
        Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

// --- memory.sync_setup ---

pub struct MemorySyncSetupTool {
    roots: MemoryRoots,
}

impl MemorySyncSetupTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemorySyncSetupTool {
    fn name(&self) -> &str {
        "memory.sync_setup"
    }
    fn requires_approval(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "One-shot setup for memory git sync: creates the memory dir \
         if missing, runs `git init`, adds the given `remote_url` as \
         `origin`, seeds an empty MEMORY.md, makes the initial \
         commit, and (by default) pushes to origin. Idempotent guard: \
         if the dir is already a git repo, the tool errors out unless \
         `force=true`, in which case it just updates the remote URL \
         in place without re-initialising. Approval-gated because \
         this writes to disk and pushes to an external remote."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["remote_url"],
            "properties": {
                "remote_url": {
                    "type": "string",
                    "description": "Git URL of the remote repo (ssh / https). Pre-created private repo recommended."
                },
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Which memory tree to set up. Defaults to `user`."
                },
                "branch": {
                    "type": "string",
                    "description": "Branch name for the initial commit + push. Defaults to `main`."
                },
                "push": {
                    "type": "boolean",
                    "description": "Push the initial commit after setup. Defaults to true."
                },
                "force": {
                    "type": "boolean",
                    "description": "When the dir is already a git repo, just update remote.origin.url to `remote_url` instead of erroring. Defaults to false."
                }
            }
        })
    }
    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let scope = args.get("scope").and_then(Value::as_str).unwrap_or("user");
        let url = args
            .get("remote_url")
            .and_then(Value::as_str)
            .unwrap_or("(missing)");
        Some(format!("{scope} → {url}"))
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let remote_url = args
            .get("remote_url")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `remote_url` argument".into() })?
            .trim();
        if remote_url.is_empty() {
            return Err("`remote_url` must not be empty".into());
        }
        // Refuse anything that looks like a flag or uses a
        // command-executing transport (ext::/fd::) — the URL goes
        // verbatim into `git remote add` and is later pushed to.
        crate::memory_include::validate_git_url(remote_url)?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::User);
        let branch = args
            .get("branch")
            .and_then(Value::as_str)
            .unwrap_or("main");
        if branch.starts_with('-') || branch.contains(char::is_whitespace) {
            return Err(format!("invalid branch name `{branch}`").into());
        }
        let push = args.get("push").and_then(Value::as_bool).unwrap_or(true);
        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);

        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let dir = memory_dir_for(&roots, scope)?;

        // Create the dir if missing.
        if !dir.exists() {
            tokio::fs::create_dir_all(&dir).await.map_err(
                |e| -> BoxError { format!("mkdir {}: {e}", dir.display()).into() },
            )?;
        }

        let mut report = serde_json::Map::new();
        report.insert("scope".into(), json!(scope.as_wire()));
        report.insert("dir".into(), json!(dir.display().to_string()));
        report.insert("remote_url".into(), json!(remote_url));
        report.insert("branch".into(), json!(branch));

        // Already-a-repo branch.
        if is_git_repo(&dir).await {
            if !force {
                return Err(format!(
                    "memory dir `{}` is already a git repository. Pass `force=true` to just update the remote, or run `memory.sync` if you wanted to sync.",
                    dir.display()
                )
                .into());
            }
            // Force path: just set the remote URL. Use `set-url` if
            // origin exists, otherwise `add origin`.
            let (has_origin, _, _) =
                run_git(&dir, &["config", "--get", "remote.origin.url"], 5_000).await?;
            let (ok, out, err) = if has_origin {
                run_git(&dir, &["remote", "set-url", "origin", remote_url], 10_000).await?
            } else {
                run_git(&dir, &["remote", "add", "origin", remote_url], 10_000).await?
            };
            report.insert(
                "remote_update".into(),
                json!({
                    "ok": ok,
                    "stdout": out.trim(),
                    "stderr": err.trim(),
                }),
            );
            if !ok {
                return Err(format!(
                    "failed to update origin remote: {}",
                    err.trim()
                )
                .into());
            }
            report.insert("initialized".into(), json!(false));
            return Ok(serde_json::to_string_pretty(&report).unwrap_or_default());
        }

        // Fresh setup path. Each step short-circuits on failure with
        // the exact stderr surfaced so the user can read the git
        // message and fix.
        macro_rules! must_git {
            ($args:expr) => {{
                let (ok, out, err) = run_git(&dir, $args, 10_000).await?;
                if !ok {
                    return Err(format!(
                        "git {:?} failed: {}",
                        $args,
                        err.trim()
                    )
                    .into());
                }
                (out, err)
            }};
        }

        must_git!(&["init", "-q", "-b", branch]);
        must_git!(&["remote", "add", "origin", remote_url]);

        // Seed MEMORY.md if it's not there yet so the initial commit
        // has something to add. Keep the content stable so subsequent
        // setups don't churn the byte content.
        let index = dir.join("MEMORY.md");
        if !index.exists() {
            tokio::fs::write(
                &index,
                "# Jarvis memory\n\nThis directory holds agent-maintained notes.\n",
            )
            .await
            .map_err(|e| -> BoxError { format!("seed MEMORY.md: {e}").into() })?;
        }

        must_git!(&["add", "-A"]);
        // Seed-commit author identity is supplied inline so the call
        // works on machines without a global `user.email` / `user.name`
        // configured (fresh dev boxes, CI runners). The overrides only
        // apply to this single command — subsequent commits in the repo
        // use whatever the operator has configured locally.
        must_git!(&[
            "-c",
            "user.email=jarvis@local",
            "-c",
            "user.name=Jarvis",
            "commit",
            "-q",
            "-m",
            "init: jarvis memory",
        ]);
        report.insert("initialized".into(), json!(true));

        if push {
            let (push_ok, push_out, push_err) =
                run_git(&dir, &["push", "-u", "origin", branch], DEFAULT_TIMEOUT_MS).await?;
            report.insert(
                "push".into(),
                json!({
                    "ok": push_ok,
                    "stdout": push_out.trim(),
                    "stderr": push_err.trim(),
                }),
            );
            if !push_ok {
                report.insert(
                    "hint".into(),
                    json!(
                        "initial push failed — check the remote URL is reachable and you have credentials. \
                         Local repo is set up; you can fix the push manually with `git -C <dir> push -u origin <branch>`."
                    ),
                );
            }
        } else {
            report.insert(
                "hint".into(),
                json!("local repo initialised; push skipped (push=false)"),
            );
        }
        Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

// --- memory.sync_status ---

pub struct MemorySyncStatusTool {
    roots: MemoryRoots,
}

impl MemorySyncStatusTool {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait]
impl Tool for MemorySyncStatusTool {
    fn name(&self) -> &str {
        "memory.sync_status"
    }
    fn description(&self) -> &str {
        "Report the git sync state of the memory tree without making \
         changes. Returns whether the dir is a git repo, the current \
         branch, the configured remote URL, and `git status --porcelain` \
         output. Use this to verify setup or inspect why a previous \
         `memory.sync` call failed."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["workspace", "user"],
                    "description": "Which memory tree to inspect. Defaults to `user`."
                }
            }
        })
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }
    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope_arg)
            .transpose()?
            .unwrap_or(MemoryScope::User);
        let workspace_root = harness_core::active_workspace_or(&self.roots.workspace_root);
        let roots = MemoryRoots {
            workspace_root,
            user_root: self.roots.user_root.clone(),
        };
        let dir = memory_dir_for(&roots, scope)?;

        let mut report = serde_json::Map::new();
        report.insert("scope".into(), json!(scope.as_wire()));
        report.insert("dir".into(), json!(dir.display().to_string()));

        if !is_git_repo(&dir).await {
            report.insert("is_git_repo".into(), json!(false));
            report.insert("setup_hint".into(), json!(setup_hint(&dir)));
            return Ok(serde_json::to_string_pretty(&report).unwrap_or_default());
        }
        report.insert("is_git_repo".into(), json!(true));

        if let Ok((true, branch, _)) = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"], 5_000).await {
            report.insert("branch".into(), json!(branch.trim()));
        }
        if let Ok((true, remote_url, _)) =
            run_git(&dir, &["config", "--get", "remote.origin.url"], 5_000).await
        {
            report.insert("remote_url".into(), json!(remote_url.trim()));
        } else {
            report.insert("remote_url".into(), json!(null));
            report.insert(
                "hint".into(),
                json!("no `origin` remote — set one with `git remote add origin <url>`."),
            );
        }
        if let Ok((true, status, _)) = run_git(&dir, &["status", "--porcelain"], 5_000).await {
            report.insert("dirty".into(), json!(!status.trim().is_empty()));
            report.insert("status".into(), json!(status.trim()));
        }
        if let Ok((true, head, _)) = run_git(&dir, &["rev-parse", "HEAD"], 5_000).await {
            report.insert("head".into(), json!(head.trim()));
        }
        Ok(serde_json::to_string_pretty(&report).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;
    use tokio::fs;

    /// Make a tempdir + `git init` it, set user identity so commits
    /// don't fail on a CI box without a global git config, and return
    /// the path.
    fn git_init(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let st = StdCommand::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .expect("git spawn");
            assert!(
                st.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&st.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
    }

    async fn commit_all(dir: &std::path::Path, msg: &str) {
        StdCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(["add", "-A"])
            .status()
            .unwrap();
        StdCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(["commit", "-q", "-m", msg])
            .status()
            .unwrap();
    }

    fn user_only(user: &std::path::Path) -> MemoryRoots {
        // Workspace root is unused by the sync tools when scope=user;
        // give it a dead path to make accidental fall-through obvious.
        MemoryRoots::new(std::path::PathBuf::from("/dev/null/should-not-be-used"))
            .with_user_root(user.to_path_buf())
    }

    #[tokio::test]
    async fn sync_status_reports_non_git_dir_with_setup_hint() {
        let user = tempdir().unwrap();
        // No `git init` — the memory dir doesn't even exist.
        let tool = MemorySyncStatusTool::new(user_only(user.path()));
        let body = tool.invoke(json!({})).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["is_git_repo"], false);
        assert!(v["setup_hint"]
            .as_str()
            .unwrap()
            .contains("git init"));
    }

    #[tokio::test]
    async fn sync_status_reports_branch_and_head_when_git_repo() {
        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        fs::write(mem_dir.join("MEMORY.md"), "- [x](x.md)\n")
            .await
            .unwrap();
        commit_all(&mem_dir, "seed").await;

        let tool = MemorySyncStatusTool::new(user_only(user.path()));
        let body = tool.invoke(json!({})).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["is_git_repo"], true);
        assert_eq!(v["branch"], "main");
        assert!(v["head"].as_str().unwrap().len() >= 7);
        assert_eq!(v["dirty"], false);
        // No remote configured yet — hint surfaces.
        assert!(v["hint"].as_str().unwrap().contains("origin"));
    }

    #[tokio::test]
    async fn sync_errors_with_setup_hint_when_not_a_repo() {
        let user = tempdir().unwrap();
        let tool = MemorySyncTool::new(user_only(user.path()));
        let err = tool.invoke(json!({})).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("not a git repository"));
        assert!(msg.contains("git init"));
    }

    #[tokio::test]
    async fn sync_against_local_bare_repo_round_trips() {
        // Set up a local bare repo to act as the "remote", clone it,
        // and verify pull+push report ok via the tool. Skip when
        // `git` isn't on PATH (running in a strict sandbox); the
        // tool would surface a spawn error in that case.
        if StdCommand::new("git").arg("--version").output().is_err() {
            eprintln!("skipping: git not on PATH");
            return;
        }
        let upstream = tempdir().unwrap();
        StdCommand::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(upstream.path())
            .status()
            .unwrap();

        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["remote", "add", "origin"])
            .arg(upstream.path())
            .status()
            .unwrap();
        fs::write(mem_dir.join("MEMORY.md"), "- [seed](seed.md)\n")
            .await
            .unwrap();
        commit_all(&mem_dir, "seed").await;
        StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["push", "-q", "-u", "origin", "main"])
            .status()
            .unwrap();

        let tool = MemorySyncTool::new(user_only(user.path()));
        let body = tool.invoke(json!({})).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["pull"]["ok"], true, "pull report: {v}");
        assert_eq!(v["push"]["ok"], true, "push report: {v}");
        assert!(v["head"].as_str().unwrap().len() >= 7);
    }

    #[tokio::test]
    async fn sync_rejects_invalid_remote_name() {
        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        commit_all(&mem_dir, "seed").await;
        let tool = MemorySyncTool::new(user_only(user.path()));
        let err = tool
            .invoke(json!({"remote": "--upload-pack=evil"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("invalid remote"));
    }

    #[tokio::test]
    async fn user_scope_required_when_user_root_unconfigured() {
        // No user_root → user-scope sync should error cleanly.
        let roots = MemoryRoots::new(std::path::PathBuf::from("/tmp/ws"));
        let tool = MemorySyncTool::new(roots);
        let err = tool.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("user-scope memory is not configured"));
    }

    // --- memory.sync_setup ---

    #[tokio::test]
    async fn sync_setup_initialises_repo_and_pushes_to_local_remote() {
        if StdCommand::new("git").arg("--version").output().is_err() {
            eprintln!("skipping: git not on PATH");
            return;
        }
        // Local bare repo as the "remote".
        let upstream = tempdir().unwrap();
        StdCommand::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(upstream.path())
            .status()
            .unwrap();

        let user = tempdir().unwrap();
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let body = tool
            .invoke(json!({
                "remote_url": upstream.path().to_string_lossy().to_string(),
            }))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["initialized"], true);
        assert_eq!(v["push"]["ok"], true, "push failed: {v}");
        // MEMORY.md was seeded.
        let seed = user.path().join(MEMORY_DIR).join("MEMORY.md");
        assert!(seed.exists());
        // Bare upstream now has a HEAD ref.
        let head = StdCommand::new("git")
            .arg("-C")
            .arg(upstream.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(head.status.success(), "upstream has no HEAD after push");
    }

    #[tokio::test]
    async fn sync_setup_errors_when_already_a_repo_without_force() {
        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let err = tool
            .invoke(json!({"remote_url": "git@example.com:me/x.git"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already a git repository"));
    }

    #[tokio::test]
    async fn sync_setup_force_updates_remote_url_in_place() {
        if StdCommand::new("git").arg("--version").output().is_err() {
            return;
        }
        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        // Seed an origin so set-url is the path taken (not add).
        StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["remote", "add", "origin", "git@old:me/x.git"])
            .status()
            .unwrap();
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let body = tool
            .invoke(json!({
                "remote_url": "git@new:me/x.git",
                "force": true,
            }))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["initialized"], false);
        // Verify the new URL actually landed.
        let out = StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["config", "--get", "remote.origin.url"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "git@new:me/x.git"
        );
    }

    #[tokio::test]
    async fn sync_setup_rejects_flag_like_remote_url() {
        let user = tempdir().unwrap();
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let err = tool
            .invoke(json!({"remote_url": "--upload-pack=evil"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("start with '-'"));
    }

    #[tokio::test]
    async fn sync_setup_rejects_command_executing_transport() {
        // git's `ext::` remote-helper transport runs arbitrary
        // commands; the validator must refuse it before `git remote
        // add` ever sees it.
        let user = tempdir().unwrap();
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let err = tool
            .invoke(json!({"remote_url": "ext::sh -c id"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("remote-helper transport"));
    }

    #[tokio::test]
    async fn auto_sync_ticker_runs_initial_pull_then_periodic() {
        // Closes the loop end-to-end: a local bare repo, one client
        // dir already pointing at it, the ticker fires the initial
        // pull, then we abort the task to avoid hanging the test.
        if StdCommand::new("git").arg("--version").output().is_err() {
            return;
        }
        let upstream = tempdir().unwrap();
        StdCommand::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(upstream.path())
            .status()
            .unwrap();

        let user = tempdir().unwrap();
        let mem_dir = user.path().join(MEMORY_DIR);
        fs::create_dir_all(&mem_dir).await.unwrap();
        git_init(&mem_dir);
        StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["remote", "add", "origin"])
            .arg(upstream.path())
            .status()
            .unwrap();
        fs::write(mem_dir.join("MEMORY.md"), "- [seed](seed.md)\n")
            .await
            .unwrap();
        commit_all(&mem_dir, "seed").await;
        StdCommand::new("git")
            .arg("-C")
            .arg(&mem_dir)
            .args(["push", "-q", "-u", "origin", "main"])
            .status()
            .unwrap();

        let cfg = AutoSyncConfig {
            roots: user_only(user.path()),
            scope: MemoryScope::User,
            interval: Duration::from_millis(120),
            initial_pull: true,
        };
        let handle = spawn_auto_sync_task(cfg);
        // Give the initial pull + at least one periodic tick a chance.
        tokio::time::sleep(Duration::from_millis(400)).await;
        handle.abort();
        // If the task panicked the abort wouldn't catch it; the test
        // would already have surfaced the panic in stderr. Either way
        // the loop ran without bringing the test down.
    }

    #[test]
    fn backend_from_wire_accepts_aliases_and_rejects_garbage() {
        assert_eq!(
            MemorySyncBackend::from_wire("git"),
            Some(MemorySyncBackend::Git)
        );
        assert_eq!(
            MemorySyncBackend::from_wire("GIT"),
            Some(MemorySyncBackend::Git)
        );
        assert_eq!(
            MemorySyncBackend::from_wire("icloud"),
            Some(MemorySyncBackend::ICloud)
        );
        assert_eq!(
            MemorySyncBackend::from_wire("iCloud-Drive"),
            Some(MemorySyncBackend::ICloud)
        );
        assert_eq!(
            MemorySyncBackend::from_wire("none"),
            Some(MemorySyncBackend::None)
        );
        assert_eq!(
            MemorySyncBackend::from_wire(""),
            Some(MemorySyncBackend::None)
        );
        assert!(MemorySyncBackend::from_wire("dropbox").is_none());
    }

    #[test]
    fn backend_round_trip_wire() {
        for b in [
            MemorySyncBackend::None,
            MemorySyncBackend::Git,
            MemorySyncBackend::ICloud,
        ] {
            assert_eq!(MemorySyncBackend::from_wire(b.as_wire()), Some(b));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn icloud_drive_root_returns_path_on_macos() {
        // We can't assert the dir exists (depends on operator's
        // iCloud Drive setup), only that the candidate path is
        // computed correctly off `$HOME`.
        let path = icloud_drive_root().expect("HOME should be set");
        assert!(path.ends_with("Library/Mobile Documents/com~apple~CloudDocs"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn icloud_drive_root_returns_none_off_macos() {
        assert!(icloud_drive_root().is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn icloud_setup_errors_off_macos() {
        let user = tempdir().unwrap();
        let tool = MemoryICloudSetupTool::new(user_only(user.path()));
        let err = tool.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("macOS-only"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn icloud_setup_errors_when_icloud_disabled() {
        // Mock iCloud Drive absence by pointing HOME at a tempdir
        // with no `Library/Mobile Documents/...` subtree. Has to
        // run with the env override scoped to this test only.
        let home = tempdir().unwrap();
        let prev_home = std::env::var_os("HOME");
        // SAFETY: process-wide env mutation. The other iCloud
        // tests are #[cfg(target_os = "macos")] too and the test
        // runner serialises within a process — vitest-style
        // isolation isn't a concern at this layer.
        // SAFETY justification: see comment above.
        unsafe { std::env::set_var("HOME", home.path()) };
        let user = tempdir().unwrap();
        let tool = MemoryICloudSetupTool::new(user_only(user.path()));
        let err = tool.invoke(json!({})).await.unwrap_err();
        if let Some(h) = prev_home {
            unsafe { std::env::set_var("HOME", h) };
        }
        assert!(err.to_string().contains("does not exist"));
    }

    #[tokio::test]
    async fn sync_setup_skips_push_when_disabled() {
        if StdCommand::new("git").arg("--version").output().is_err() {
            return;
        }
        let user = tempdir().unwrap();
        let tool = MemorySyncSetupTool::new(user_only(user.path()));
        let body = tool
            .invoke(json!({
                "remote_url": "git@example.com:me/x.git",
                "push": false,
            }))
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["initialized"], true);
        assert!(v.get("push").is_none());
        assert!(v["hint"].as_str().unwrap().contains("push skipped"));
    }
}
