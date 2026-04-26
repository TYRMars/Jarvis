//! Built-in tools for the agent harness.
//!
//! Each tool is a small struct implementing `harness_core::Tool`. They are
//! grouped by namespace (`fs.*`, `http.*`, `shell.*`, `time.*`) so tool
//! names stay unique when multiple crates register into the same
//! `ToolRegistry`.
//!
//! Write primitives (`fs.write`, `fs.edit`) and `shell.exec` are *not*
//! registered by default — they need explicit opt-in via
//! [`BuiltinsConfig`]. Read primitives (`fs.read`, `fs.list`,
//! `http.fetch`, `time.now`, `echo`) are always on.

pub mod echo;
pub mod fs;
pub mod grep;
pub mod http;
mod sandbox;
pub mod shell;
pub mod time;

pub use echo::EchoTool;
pub use fs::{FsEditTool, FsListTool, FsReadTool, FsWriteTool};
pub use grep::CodeGrepTool;
pub use http::HttpFetchTool;
pub use shell::{Sandbox, ShellExecTool, ShellLimits};
pub use time::TimeNowTool;

use harness_core::ToolRegistry;
use std::path::PathBuf;

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
}

impl Default for BuiltinsConfig {
    fn default() -> Self {
        Self {
            fs_root: PathBuf::from("."),
            http_max_bytes: 256 * 1024,
            enable_fs_write: false,
            enable_fs_edit: false,
            enable_shell_exec: false,
            shell_default_timeout_ms: 30_000,
            shell_sandbox: Sandbox::None,
            shell_limits: ShellLimits::default(),
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
    if cfg.enable_fs_write {
        registry.register(FsWriteTool::new(root.clone()));
    }
    if cfg.enable_fs_edit {
        registry.register(FsEditTool::new(root.clone()));
    }
    if cfg.enable_shell_exec {
        registry.register(
            ShellExecTool::new(root)
                .with_default_timeout_ms(cfg.shell_default_timeout_ms)
                .with_sandbox(cfg.shell_sandbox)
                .with_limits(cfg.shell_limits),
        );
    }
}
