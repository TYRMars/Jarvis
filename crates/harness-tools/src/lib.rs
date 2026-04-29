//! Built-in tools for the agent harness.
//!
//! Each tool is a small struct implementing `harness_core::Tool`. They are
//! grouped by namespace (`ask.*`, `fs.*`, `http.*`, `shell.*`, `time.*`) so tool
//! names stay unique when multiple crates register into the same
//! `ToolRegistry`.
//!
//! Write primitives (`fs.write`, `fs.edit`) and `shell.exec` are *not*
//! registered by default — they need explicit opt-in via
//! [`BuiltinsConfig`]. Read primitives (`fs.read`, `fs.list`,
//! `http.fetch`, `time.now`, `echo`, `ask.text`) are always on.

pub mod ask;
pub mod checks;
pub mod echo;
pub mod exit_plan;
pub mod fs;
pub mod git;
pub mod grep;
pub mod http;
pub mod patch;
pub mod plan;
mod sandbox;
pub mod shell;
pub mod time;
pub mod todo;
pub mod workspace;

pub use ask::AskTextTool;
pub use checks::ProjectChecksTool;
pub use echo::EchoTool;
pub use exit_plan::ExitPlanTool;
pub use fs::{FsEditTool, FsListTool, FsReadTool, FsWriteTool};
pub use git::{
    GitAddTool, GitCommitTool, GitDiffTool, GitLogTool, GitMergeTool, GitShowTool, GitStatusTool,
};
pub use grep::CodeGrepTool;
pub use http::HttpFetchTool;
pub use patch::FsPatchTool;
pub use plan::PlanUpdateTool;
pub use shell::{Sandbox, ShellExecTool, ShellLimits};
pub use time::TimeNowTool;
pub use todo::{TodoAddTool, TodoDeleteTool, TodoListTool, TodoUpdateTool};
pub use workspace::WorkspaceContextTool;

use harness_core::{ToolRegistry, TodoStore};
use std::path::PathBuf;
use std::sync::Arc;

/// Configuration for the default set of built-in tools.
pub struct BuiltinsConfig {
    /// Root directory for all `fs.*` tools and the `shell.exec` cwd.
    /// Relative tool arguments are resolved against this directory, and
    /// `..` / absolute paths are rejected.
    pub fs_root: PathBuf,
    /// Cap on response body size (in bytes) for `http.fetch`. Responses
    /// larger than this are truncated with a trailing marker.
    pub http_max_bytes: usize,
    /// Whether to register `fs.write`. Defaults to `false` because writes
    /// are a destructive primitive.
    pub enable_fs_write: bool,
    /// Whether to register `fs.edit`. Defaults to `false` because it
    /// mutates files. `fs.edit` is the preferred primitive for editing
    /// existing files — it requires the model to identify a unique
    /// snippet, which limits accidental damage compared to `fs.write`.
    pub enable_fs_edit: bool,
    /// Whether to register `fs.patch`. Defaults to `false` because
    /// it mutates files. `fs.patch` applies a unified diff (multi-
    /// hunk, multi-file) atomically — preferred over `fs.edit` when
    /// the change spans more than one location. Always approval-gated.
    pub enable_fs_patch: bool,
    /// Whether to register `shell.exec`. Defaults to `false` — arbitrary
    /// command execution against the host is the most dangerous primitive
    /// in the toolbox.
    pub enable_shell_exec: bool,
    /// Default timeout (ms) for `shell.exec` invocations that don't
    /// supply one. The model can still pass a smaller value per call.
    pub shell_default_timeout_ms: u64,
    /// OS-level isolation backend for `shell.exec`. Defaults to
    /// [`Sandbox::None`] so existing setups keep working byte-for-byte;
    /// flip to [`Sandbox::Auto`] for defence in depth.
    pub shell_sandbox: Sandbox,
    /// CPU / memory / fd / process caps applied via `setrlimit` in
    /// the child's `pre_exec` hook. Defaults to all-`None` (no caps);
    /// call [`ShellLimits::safe_defaults`] for a 60s/2GB/256fd/256proc
    /// preset.
    pub shell_limits: ShellLimits,
    /// Whether to register the read-only `git.*` tools (`git.status`,
    /// `git.diff`, `git.log`, `git.show`). Defaults to `true` — they
    /// are read-only and shell out to the host's `git` binary, which
    /// is virtually always present on a developer machine. If `git`
    /// isn't on `PATH`, the tools error at invoke time rather than
    /// failing registration; flip this to `false` to skip them entirely.
    pub enable_git_read: bool,
    /// Whether to register the write-side git tools (`git.add`,
    /// `git.commit`, `git.merge`). Defaults to `false` — they mutate
    /// the index / working tree / refs and are approval-gated.
    /// `JARVIS_ENABLE_GIT_WRITE=1` flips this on. Pushes / fetches are
    /// deliberately not exposed: those touch the network and a remote
    /// you may not have explicitly authorised the agent for.
    pub enable_git_write: bool,
    /// Backing store for the persistent project TODO board. When
    /// `Some(_)`, the four `todo.*` tools are registered. When
    /// `None` (default), the tools are skipped — falling back to
    /// in-memory storage would defeat the persistence promise, so
    /// the model simply can't see them.
    pub todo_store: Option<Arc<dyn TodoStore>>,
}

impl Default for BuiltinsConfig {
    fn default() -> Self {
        Self {
            fs_root: PathBuf::from("."),
            http_max_bytes: 256 * 1024,
            enable_fs_write: false,
            enable_fs_edit: false,
            enable_fs_patch: false,
            enable_shell_exec: false,
            shell_default_timeout_ms: 30_000,
            shell_sandbox: Sandbox::None,
            shell_limits: ShellLimits::default(),
            enable_git_read: true,
            enable_git_write: false,
            todo_store: None,
        }
    }
}

/// Register the full default toolset into `registry`. Individual tools can
/// still be registered one-by-one if you want finer control.
pub fn register_builtins(registry: &mut ToolRegistry, cfg: BuiltinsConfig) {
    let root = cfg.fs_root;
    registry.register(EchoTool);
    registry.register(TimeNowTool);
    registry.register(HttpFetchTool::new(cfg.http_max_bytes));
    registry.register(FsReadTool::new(root.clone()));
    registry.register(FsListTool::new(root.clone()));
    registry.register(CodeGrepTool::new(root.clone()));
    registry.register(WorkspaceContextTool::new(root.clone()));
    registry.register(ProjectChecksTool::new(root.clone()));
    registry.register(PlanUpdateTool);
    registry.register(AskTextTool);
    // `exit_plan` is the terminal tool the agent calls in Plan Mode
    // to hand a draft plan back to the user. It's harmless outside
    // Plan Mode (the model has no reason to call it), and always-on
    // means the Plan-Mode tool filter doesn't have to mutate the
    // registry to enable it — much simpler than per-mode registration.
    registry.register(ExitPlanTool);
    if cfg.enable_fs_write {
        registry.register(FsWriteTool::new(root.clone()));
    }
    if cfg.enable_fs_edit {
        registry.register(FsEditTool::new(root.clone()));
    }
    if cfg.enable_fs_patch {
        registry.register(FsPatchTool::new(root.clone()));
    }
    if cfg.enable_git_read {
        registry.register(GitStatusTool::new(root.clone()));
        registry.register(GitDiffTool::new(root.clone()));
        registry.register(GitLogTool::new(root.clone()));
        registry.register(GitShowTool::new(root.clone()));
    }
    if cfg.enable_git_write {
        registry.register(GitAddTool::new(root.clone()));
        registry.register(GitCommitTool::new(root.clone()));
        registry.register(GitMergeTool::new(root.clone()));
    }
    if cfg.enable_shell_exec {
        registry.register(
            ShellExecTool::new(root.clone())
                .with_default_timeout_ms(cfg.shell_default_timeout_ms)
                .with_sandbox(cfg.shell_sandbox)
                .with_limits(cfg.shell_limits),
        );
    }
    if let Some(store) = cfg.todo_store {
        registry.register(TodoListTool::new(store.clone(), root.clone()));
        registry.register(TodoAddTool::new(store.clone(), root.clone()));
        registry.register(TodoUpdateTool::new(store.clone()));
        registry.register(TodoDeleteTool::new(store));
    }
}
