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
pub mod claude_code;
pub mod codex;
pub mod doc;
pub mod echo;
pub mod exit_plan;
pub mod fs;
pub mod git;
pub mod grep;
pub mod http;
pub mod patch;
pub mod plan;
pub mod project;
pub mod requirement;
pub mod roadmap;
mod sandbox;
pub mod shell;
pub mod time;
pub mod todo;
pub mod workspace;

pub use ask::AskTextTool;
pub use checks::ProjectChecksTool;
pub use claude_code::{ClaudeCodeRunTool, PermissionMode as ClaudeCodePermissionMode};
pub use codex::{CodexRunTool, SandboxMode as CodexSandboxMode};
pub use doc::{
    DocCreateTool, DocDeleteTool, DocDraftGetTool, DocDraftSaveTool, DocGetTool, DocListTool,
    DocUpdateTool,
};
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
pub use project::{
    ProjectArchiveTool, ProjectCreateTool, ProjectDeleteTool, ProjectGetTool, ProjectListTool,
    ProjectRestoreTool, ProjectUpdateTool,
};
pub use requirement::{
    RequirementBlockTool, RequirementCompleteTool, RequirementListTool, RequirementStartTool,
};
pub use roadmap::RoadmapImportTool;
pub use shell::{Sandbox, ShellExecTool, ShellLimits};
pub use time::TimeNowTool;
pub use todo::{TodoAddTool, TodoDeleteTool, TodoListTool, TodoUpdateTool};
pub use workspace::WorkspaceContextTool;

use harness_core::{ActivityStore, DocStore, ProjectStore, RequirementStore, TodoStore, ToolRegistry};
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
    /// Backing store for [`Project`](harness_core::Project) CRUD.
    /// When `Some(_)`, the seven `project.*` tools are registered.
    /// When `None` (default), the tools are skipped (same opt-in
    /// pattern as `todo_store`). Write operations (`create`,
    /// `update`, `archive`, `restore`, `delete`) are
    /// approval-gated.
    pub project_store: Option<Arc<dyn ProjectStore>>,
    /// Backing store for [`DocProject`](harness_core::DocProject) +
    /// [`DocDraft`](harness_core::DocDraft) CRUD. When `Some(_)`,
    /// the seven `doc.*` / `doc.draft.*` tools are registered. When
    /// `None` (default), they're skipped. Write operations
    /// (`create`, `update`, `delete`, `draft.save`) are
    /// approval-gated.
    pub doc_store: Option<Arc<dyn DocStore>>,
    /// Backing store for [`Requirement`](harness_core::Requirement)
    /// kanban rows. Paired with [`Self::activity_store`] — both
    /// must be `Some(_)` for the four `requirement.*` tools to
    /// register. A half-enabled set (mutations land but the audit
    /// row goes nowhere) is strictly worse than off, so the
    /// registration block requires both. Write operations
    /// (`start`, `block`, `complete`) are approval-gated.
    pub requirement_store: Option<Arc<dyn RequirementStore>>,
    /// Backing store for per-requirement
    /// [`Activity`](harness_core::Activity) audit rows. Required
    /// alongside [`Self::requirement_store`] for the
    /// `requirement.*` tools — see that field's doc for rationale.
    pub activity_store: Option<Arc<dyn ActivityStore>>,
    /// Whether to register `codex.run`. Defaults to `false` — spawning
    /// the Codex CLI as a sub-agent is a powerful primitive that
    /// touches the host filesystem under Codex's own sandbox; opt in
    /// only when the operator has actually decided that delegation
    /// makes sense. See [`docs/proposals/codex-subagent.zh-CN.md`].
    pub enable_codex_run: bool,
    /// Whether to register `claude_code.run`. Same opt-in rationale as
    /// [`Self::enable_codex_run`]; see
    /// [`docs/proposals/claude-code-subagent.zh-CN.md`].
    pub enable_claude_code_run: bool,
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
            project_store: None,
            doc_store: None,
            requirement_store: None,
            activity_store: None,
            enable_codex_run: false,
            enable_claude_code_run: false,
        }
    }
}

/// Register the full default toolset into `registry`. Individual tools can
/// still be registered one-by-one if you want finer control.
pub fn register_builtins(registry: &mut ToolRegistry, cfg: BuiltinsConfig) {
    let root = cfg.fs_root;
    // `roadmap.import` needs both the project + requirement stores
    // and is registered after the per-store blocks consume `cfg`.
    // Clone now so the borrow checker doesn't trip up on that.
    let roadmap_projects = cfg.project_store.clone();
    let roadmap_requirements = cfg.requirement_store.clone();
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
    if cfg.enable_codex_run {
        registry.register(CodexRunTool::new(root.clone()));
    }
    if cfg.enable_claude_code_run {
        registry.register(ClaudeCodeRunTool::new(root.clone()));
    }
    if let Some(store) = cfg.todo_store {
        registry.register(TodoListTool::new(store.clone(), root.clone()));
        registry.register(TodoAddTool::new(store.clone(), root.clone()));
        registry.register(TodoUpdateTool::new(store.clone()));
        registry.register(TodoDeleteTool::new(store));
    }
    if let Some(store) = cfg.project_store {
        registry.register(ProjectListTool::new(store.clone()));
        registry.register(ProjectGetTool::new(store.clone()));
        registry.register(ProjectCreateTool::new(store.clone()));
        registry.register(ProjectUpdateTool::new(store.clone()));
        registry.register(ProjectArchiveTool::new(store.clone()));
        registry.register(ProjectRestoreTool::new(store.clone()));
        registry.register(ProjectDeleteTool::new(store));
    }
    if let Some(store) = cfg.doc_store {
        registry.register(DocListTool::new(store.clone(), root.clone()));
        registry.register(DocGetTool::new(store.clone()));
        registry.register(DocCreateTool::new(store.clone(), root.clone()));
        registry.register(DocUpdateTool::new(store.clone()));
        registry.register(DocDeleteTool::new(store.clone()));
        registry.register(DocDraftGetTool::new(store.clone()));
        registry.register(DocDraftSaveTool::new(store));
    }
    // `requirement.*` tools mutate kanban state AND need to write
    // audit rows. Both stores must be available — registering only
    // the mutation half would silently drop the activity timeline,
    // which is strictly worse than not exposing the tools at all.
    if let (Some(req_store), Some(act_store)) = (cfg.requirement_store, cfg.activity_store) {
        registry.register(RequirementListTool::new(req_store.clone()));
        registry.register(RequirementStartTool::new(req_store.clone(), act_store.clone()));
        registry.register(RequirementBlockTool::new(req_store.clone(), act_store.clone()));
        registry.register(RequirementCompleteTool::new(req_store, act_store));
    }
    // `roadmap.import` is one of the writes the model can make on its
    // own without a kanban audit row (it creates fresh Requirements
    // rather than mutating one's status). Approval-gated; off unless
    // both stores are configured.
    if let (Some(projects), Some(requirements)) = (roadmap_projects, roadmap_requirements) {
        registry.register(RoadmapImportTool::new(projects, requirements, root.clone()));
    }
}
