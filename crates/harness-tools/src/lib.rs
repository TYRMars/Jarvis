//! Built-in tools for the agent harness.
//!
//! Each tool is a small struct implementing `harness_core::Tool`. They are
//! grouped by namespace (`fs.*`, `http.*`, `time.*`) so tool names stay
//! unique when multiple crates register into the same `ToolRegistry`.
//!
//! Dangerous primitives (arbitrary shell exec, unsandboxed writes) are
//! deliberately not included. `fs.*` is always scoped to a root directory
//! supplied at construction, and refuses paths containing `..` or absolute
//! components.

pub mod echo;
pub mod fs;
pub mod http;
pub mod time;

pub use echo::EchoTool;
pub use fs::{FsListTool, FsReadTool, FsWriteTool};
pub use http::HttpFetchTool;
pub use time::TimeNowTool;

use harness_core::ToolRegistry;
use std::path::PathBuf;

/// Configuration for the default set of built-in tools.
pub struct BuiltinsConfig {
    /// Root directory for all `fs.*` tools. Relative tool arguments are
    /// resolved against this directory, and `..` / absolute paths are
    /// rejected.
    pub fs_root: PathBuf,
    /// Cap on response body size (in bytes) for `http.fetch`. Responses
    /// larger than this are truncated with a trailing marker.
    pub http_max_bytes: usize,
    /// Whether to register `fs.write`. Defaults to `false` because writes
    /// are the most dangerous primitive.
    pub enable_fs_write: bool,
}

impl Default for BuiltinsConfig {
    fn default() -> Self {
        Self {
            fs_root: PathBuf::from("."),
            http_max_bytes: 256 * 1024,
            enable_fs_write: false,
        }
    }
}

/// Register the full default toolset into `registry`. Individual tools can
/// still be registered one-by-one if you want finer control.
pub fn register_builtins(registry: &mut ToolRegistry, cfg: BuiltinsConfig) {
    registry.register(EchoTool);
    registry.register(TimeNowTool);
    registry.register(HttpFetchTool::new(cfg.http_max_bytes));
    registry.register(FsReadTool::new(cfg.fs_root.clone()));
    registry.register(FsListTool::new(cfg.fs_root.clone()));
    if cfg.enable_fs_write {
        registry.register(FsWriteTool::new(cfg.fs_root));
    }
}
