use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use harness_core::{
    ActivityStore, Agent, AgentConfig, AgentProfileStore, ConversationStore, DocStore, LlmProvider,
    PermissionMode, PermissionStore, ProjectStore, RequirementRunStore, RequirementStore,
    TodoStore, ToolRegistry,
};
use harness_mcp::McpManager;
use harness_plugin::PluginManager;
use harness_skill::SkillCatalog;
use harness_store::WorkspaceStore;

use crate::project_memory::ProjectMemoryConfig;
use crate::provider_registry::{ProviderRegistry, RouteError, Routed};
use crate::worktree::WorktreeMode;

/// Runtime metadata the binary populates at startup so the
/// `GET /v1/server/info` endpoint (and the Settings page that reads
/// it) can render an honest snapshot of how the server is configured.
///
/// **Never carries secrets** — no DB URL with credentials, no API
/// keys, no auth tokens. Only the bits a UI honestly needs to show
/// "this is what the operator set up". Fields are all optional so
/// older callers / test harnesses don't have to populate them.
#[derive(Debug, Clone, Default)]
pub struct ServerInfo {
    /// Bind address the server is listening on.
    pub listen_addr: Option<String>,
    /// Path to the config file currently in effect (or `None` if no
    /// file was loaded — env-only deployment).
    pub config_path: Option<PathBuf>,
    /// Just the URL scheme of `JARVIS_DB_URL` (e.g. `"sqlite"`,
    /// `"postgres"`, `"json"`). Strips the host/path/credentials so
    /// the UI can say "you're on Postgres" without leaking the URL.
    pub persistence_scheme: Option<String>,
    /// Memory backend in use. Typical values: `"window"`, `"summary"`.
    /// `None` means no `Memory` was attached to the agent template
    /// (raw conversation flows to the LLM unbounded).
    pub memory_mode: Option<String>,
    /// Token budget the memory backend is targeting.
    pub memory_budget_tokens: Option<usize>,
    /// `JARVIS_APPROVAL_MODE` value. Typical: `"auto"` / `"deny"`.
    /// `None` means no policy was configured (gated tools run
    /// unconditionally — the historical default).
    pub approval_mode: Option<String>,
    /// `true` if the binary picked the coding-mode system prompt
    /// (any of `fs.edit` / `fs.write` / `fs.patch` / `shell.exec`
    /// is enabled).
    pub coding_mode: bool,
    /// `true` if the workspace's agent instruction files
    /// (`AGENTS.md`, `JARVIS.md`, `.jarvis/JARVIS.md`,
    /// `.jarvis/rules/*.md`, etc.) were appended to the system prompt
    /// at startup.
    pub project_context_loaded: bool,
    /// Byte cap that was applied when loading project context.
    pub project_context_bytes_cap: Option<usize>,
    /// `true` if Claude Code-style file-based project memory was
    /// appended to the system prompt.
    pub project_memory_loaded: bool,
    /// Project memory directory, relative to workspace root unless
    /// configured as an absolute path.
    pub project_memory_dir: Option<String>,
    /// Byte cap applied to the loaded `MEMORY.md` index.
    pub project_memory_bytes_cap: Option<usize>,
    /// Prefixes of any external MCP servers spawned at startup
    /// (`JARVIS_MCP_SERVERS=github=…,filesystem=…` → `["github", "filesystem"]`).
    pub mcp_prefixes: Vec<String>,
    /// Crate version (`env!("CARGO_PKG_VERSION")` from the binary).
    pub version: Option<String>,
}

/// Shared application state injected into every handler.
///
/// Holds a `ProviderRegistry` (so requests can pick which LLM to
/// hit) plus an "agent template" that captures the parts of
/// `AgentConfig` that don't depend on the chosen provider — tools,
/// system prompt, max iterations, memory, approver. Each request
/// builds a fresh `Agent` from `template + selected provider`.
///
/// This keeps Agent construction per-request cheap (just an `Arc`
/// shuffle) while letting different turns target different
/// providers within the same process.
#[derive(Clone)]
pub struct AppState {
    pub providers: Arc<ProviderRegistry>,
    pub agent_template: AgentConfig,
    /// Optional persistence layer. `None` means conversations are in-memory
    /// only (the current default); handlers that want to save history should
    /// no-op when this is absent.
    pub store: Option<Arc<dyn ConversationStore>>,
    /// Optional [`ProjectStore`]. Lives parallel to `store`; both are
    /// usually populated together by `connect_all` at startup. `None`
    /// means the `/v1/projects` routes return `503` and conversation
    /// creation can't bind to a project (free chat still works).
    pub projects: Option<Arc<dyn ProjectStore>>,
    /// Optional file-based project memory runtime. When set, project-
    /// bound conversations receive the project's generated memory
    /// files (`MEMORY.md`, `kanban.md`, `calendar.md`) as a synthetic
    /// system block, and the binary may run a RequirementStore
    /// subscriber that keeps those files fresh after board changes.
    pub project_memory: Option<ProjectMemoryConfig>,
    /// The resolved workspace root — same path that all `fs.*` /
    /// `git.*` / `code.grep` / `shell.exec` tools are scoped to.
    /// Set by the binary at startup; surfaced via `GET /v1/workspace`
    /// so clients (web UI, CLI, scripts) can render "you are working
    /// in <path>" without guessing. `None` only when AppState is
    /// constructed by tests / examples that don't care.
    pub workspace_root: Option<PathBuf>,
    /// Server-runtime metadata for the `GET /v1/server/info` endpoint.
    /// Populated by the binary at startup via
    /// [`with_server_info`](Self::with_server_info); empty by default
    /// so test harnesses don't have to fill it.
    pub server_info: ServerInfo,
    /// Permission rule store (process-wide). When set, every WS
    /// session wraps its `ChannelApprover` in a `RuleApprover` keyed
    /// against this store. `None` means rule-based approval is
    /// disabled — the binary always installs one in production.
    pub permission_store: Option<Arc<dyn PermissionStore>>,
    /// The default mode every new WS session starts in. The session
    /// can flip its own mode via the `set_mode` frame; this is just
    /// the per-process baseline (e.g. `--permission-mode plan`).
    pub default_permission_mode: PermissionMode,
    /// Canonical, mutable tool registry. The MCP / plugin managers
    /// add and remove tools here at runtime; per-request snapshots
    /// are taken in `build_agent[_with]` under a brief read lock so
    /// the agent loop never sees a lock guard. Seeded from
    /// `agent_template.tools` in [`from_registry`](Self::from_registry).
    pub tools: Arc<RwLock<ToolRegistry>>,
    /// Optional MCP manager. When present, `/v1/mcp/servers*` routes
    /// expose runtime add / remove / health probes; the manager
    /// shares this struct's [`tools`](Self::tools) handle so
    /// modifications are visible to the next per-request snapshot.
    pub mcp: Option<Arc<McpManager>>,
    /// Optional skill catalogue. Loaded at startup from per-user +
    /// per-workspace SKILL.md trees and mutated at runtime by the
    /// plugin manager (install adds, uninstall removes). Reads
    /// borrow under [`std::sync::RwLock::read`]; writes go through
    /// [`std::sync::RwLock::write`] — both critical sections are
    /// HashMap-sized so contention is negligible.
    pub skills: Option<Arc<RwLock<SkillCatalog>>>,
    /// Optional plugin manager. When present, `/v1/plugins*`
    /// endpoints expose install / uninstall / list and the
    /// manager mutates the shared `skills` catalog + `mcp` manager
    /// as plugins come and go.
    pub plugins: Option<Arc<PluginManager>>,
    /// Optional persisted workspaces registry. Backs the chat
    /// header's "Recent" dropdown and the per-conversation
    /// workspace binding (so `Resume` can restore which folder a
    /// session was started in).
    pub workspaces: Option<Arc<WorkspaceStore>>,
    /// Optional persistent project TODO store. When `Some(_)`,
    /// `/v1/todos` REST endpoints work and WS sessions broadcast
    /// `todo_upserted` / `todo_deleted` frames. `None` ⇒ those
    /// endpoints return 503 and the agent's `todo.*` tools are
    /// unregistered (set up in the binary's composition root).
    pub todos: Option<Arc<dyn TodoStore>>,
    /// Optional persistent project Requirement store. When `Some(_)`,
    /// the `/v1/projects/:project_id/requirements*` REST endpoints
    /// work and WS sessions broadcast `requirement_upserted` /
    /// `requirement_deleted` frames. `None` ⇒ those endpoints return
    /// 503 (set up in the binary's composition root). The
    /// per-project kanban Web UI (`/projects` route) reads via REST
    /// and live-updates via the WS bridge.
    pub requirements: Option<Arc<dyn RequirementStore>>,
    /// Optional persistent Requirement-run store. When `Some(_)`,
    /// `POST /v1/requirements/:id/runs` writes a typed
    /// [`RequirementRun`](harness_core::RequirementRun) row at run
    /// start, the new `/v1/requirements/:id/runs` (list) /
    /// `/v1/runs/:id` (get/patch) / `/v1/runs/:id/verification`
    /// endpoints work, and WS sessions broadcast
    /// `requirement_run_started` / `_finished` / `_verified` frames.
    /// `None` ⇒ run history is ephemeral (the typed `RequirementRun`
    /// in the start-run response is the only place it shows up) and
    /// the new endpoints return 503.
    pub requirement_runs: Option<Arc<dyn RequirementRunStore>>,
    /// Optional persistent per-Requirement audit timeline store.
    /// When `Some(_)`, the requirement / run REST handlers append
    /// rows on every state-changing mutation, the new
    /// `GET /v1/requirements/:id/activities` endpoint returns the
    /// timeline, and WS sessions broadcast `activity_appended`
    /// frames. `None` ⇒ no audit trail recorded; the GET endpoint
    /// returns 503.
    pub activities: Option<Arc<dyn ActivityStore>>,
    /// Optional persistent named-agent-profile store. When
    /// `Some(_)`, the Settings page's Agents tab and the kanban
    /// card assignee picker work; `start_run` looks up the
    /// requirement's `assignee_id` and prepends the matching
    /// profile's `system_prompt` to the manifest summary so the
    /// model sees the assignee's instructions before turn 1.
    /// `None` ⇒ `/v1/agent-profiles*` returns 503 and `start_run`
    /// behaves as before (no per-assignee prompt enrichment).
    pub agent_profiles: Option<Arc<dyn AgentProfileStore>>,
    /// Optional persistent Doc store — backs the `/docs` page.
    /// Returns 503 from `/v1/doc-projects*` when `None`.
    pub docs: Option<Arc<dyn DocStore>>,
    /// Inject the current pending/in_progress/blocked TODOs into
    /// the system prompt at the start of every turn? Defaults to
    /// `true` — gives the agent cheap awareness without an extra
    /// `todo.list` round-trip. The binary flips it to `false` when
    /// `JARVIS_NO_TODOS_IN_PROMPT` is set. No-op when `todos` is
    /// `None`.
    pub todos_in_prompt: bool,
    /// Phase 5 — worktree isolation mode (`Off` / `PerRun`).
    /// Sourced from `JARVIS_WORKTREE_MODE`. When `PerRun` and the
    /// workspace is a git repo, `start_run` mints a fresh worktree
    /// at `<worktree_root>/<run_id>` and stamps the path onto the
    /// run; verification routes its cwd through it.
    pub worktree_mode: WorktreeMode,
    /// Phase 5 — base directory for per-run worktrees. Defaults
    /// to `<workspace_root>/.jarvis/worktrees` (resolved at
    /// startup). `None` here when `worktree_mode == Off` —
    /// callers should treat absence as "feature off".
    pub worktree_root: Option<PathBuf>,
    /// Phase 5 — when true, allow worktree creation off a dirty
    /// main checkout. Sourced from `JARVIS_WORKTREE_ALLOW_DIRTY`.
    /// Default false (refuse).
    pub worktree_allow_dirty: bool,
    /// v1.0 — runtime on/off switch for the auto-mode scheduler.
    /// `None` means the binary didn't wire one up (tests, mcp-serve
    /// mode, etc.) and `auto_mode::spawn` falls back to "always
    /// disabled". When `Some(_)`, the spawned tick loop polls this
    /// flag and the `GET/POST /v1/auto-mode` REST endpoints
    /// read/write it. Initial value is set by the binary from
    /// `AutoModeConfig.mode` (i.e. `JARVIS_WORK_MODE`).
    pub auto_mode_runtime: Option<crate::auto_mode::AutoModeRuntime>,
    /// In-process ledger of active/recent chat turns. Web clients use
    /// this to recover server-side run status after a sidebar refresh
    /// or a second browser window opens.
    pub chat_runs: Arc<crate::chat_runs::ChatRunRegistry>,
}

impl AppState {
    /// Build state from an explicit registry plus a template
    /// `AgentConfig`. The template's `model` field is ignored —
    /// per-request routing always overrides it.
    pub fn from_registry(providers: ProviderRegistry, template: AgentConfig) -> Self {
        let seed: ToolRegistry = (*template.tools).clone();
        Self {
            providers: Arc::new(providers),
            agent_template: template,
            store: None,
            projects: None,
            project_memory: None,
            workspace_root: None,
            server_info: ServerInfo::default(),
            permission_store: None,
            default_permission_mode: PermissionMode::default(),
            tools: Arc::new(RwLock::new(seed)),
            mcp: None,
            skills: None,
            plugins: None,
            workspaces: None,
            todos: None,
            requirements: None,
            requirement_runs: None,
            activities: None,
            agent_profiles: None,
            docs: None,
            todos_in_prompt: true,
            worktree_mode: WorktreeMode::Off,
            worktree_root: None,
            worktree_allow_dirty: false,
            auto_mode_runtime: None,
            chat_runs: crate::chat_runs::ChatRunRegistry::new(),
        }
    }

    /// Backwards-compatible single-provider constructor. Wraps the
    /// agent's `LlmProvider` in a one-entry registry keyed by
    /// `"default"`, with the agent's configured `model` as that
    /// entry's default model. Tests and simple deployments that
    /// don't need multi-provider routing use this.
    pub fn new(agent: Arc<Agent>) -> Self {
        let llm: Arc<dyn LlmProvider> = agent.llm.clone();
        let mut registry = ProviderRegistry::new("default");
        registry.insert("default", llm, agent.config.model.clone());
        let seed: ToolRegistry = (*agent.config.tools).clone();
        Self {
            providers: Arc::new(registry),
            agent_template: agent.config.clone(),
            store: None,
            projects: None,
            project_memory: None,
            workspace_root: None,
            server_info: ServerInfo::default(),
            permission_store: None,
            default_permission_mode: PermissionMode::default(),
            tools: Arc::new(RwLock::new(seed)),
            mcp: None,
            skills: None,
            plugins: None,
            workspaces: None,
            todos: None,
            requirements: None,
            requirement_runs: None,
            activities: None,
            agent_profiles: None,
            docs: None,
            todos_in_prompt: true,
            worktree_mode: WorktreeMode::Off,
            worktree_root: None,
            worktree_allow_dirty: false,
            auto_mode_runtime: None,
            chat_runs: crate::chat_runs::ChatRunRegistry::new(),
        }
    }

    pub fn with_store(mut self, store: Arc<dyn ConversationStore>) -> Self {
        self.store = Some(store);
        self
    }

    /// Attach a [`ProjectStore`]. Independent of `with_store`; the
    /// binary normally calls both at startup so the conversation and
    /// project halves of the same backend are wired up together.
    pub fn with_project_store(mut self, projects: Arc<dyn ProjectStore>) -> Self {
        self.projects = Some(projects);
        self
    }

    /// Attach file-based project memory configuration.
    pub fn with_project_memory(mut self, config: ProjectMemoryConfig) -> Self {
        self.project_memory = Some(config);
        self
    }

    /// Pin the resolved workspace root so `GET /v1/workspace` can
    /// surface it to clients. The binary calls this at startup;
    /// transports / tests that don't need the endpoint can leave it.
    pub fn with_workspace_root(mut self, root: PathBuf) -> Self {
        self.workspace_root = Some(root);
        self
    }

    /// Attach runtime metadata for `GET /v1/server/info`. The binary
    /// calls this at startup; tests can ignore the field.
    pub fn with_server_info(mut self, info: ServerInfo) -> Self {
        self.server_info = info;
        self
    }

    /// Wire in the process-wide permission store. WS sessions wrap
    /// their per-socket `ChannelApprover` in a `RuleApprover` keyed
    /// against this store; the REST `/v1/permissions` routes serve
    /// CRUD against it.
    pub fn with_permission_store(mut self, store: Arc<dyn PermissionStore>) -> Self {
        self.permission_store = Some(store);
        self
    }

    /// Set the default mode every new WS session starts in. Each
    /// session keeps its own mode handle that can be flipped at
    /// runtime; this is just the boot-time baseline.
    pub fn with_default_permission_mode(mut self, mode: PermissionMode) -> Self {
        self.default_permission_mode = mode;
        self
    }

    /// Replace the canonical tool registry handle. The binary calls
    /// this when it wants the same `Arc<RwLock<ToolRegistry>>` shared
    /// with an [`McpManager`] (and, later, a plugin manager) so all
    /// three see the same mutations.
    pub fn with_tools(mut self, tools: Arc<RwLock<ToolRegistry>>) -> Self {
        self.tools = tools;
        self
    }

    /// Inject a runtime MCP manager. The manager must already be
    /// constructed against `self.tools` (or an equivalent
    /// [`Arc::clone`]) so add / remove operations propagate to the
    /// per-request snapshots.
    pub fn with_mcp(mut self, mcp: Arc<McpManager>) -> Self {
        self.mcp = Some(mcp);
        self
    }

    /// Attach the loaded skill catalogue. The binary calls this
    /// once at startup with the freshly-loaded catalog; routes
    /// return 503 until it's set. The handle is shared with the
    /// plugin manager (and any future plugin source) so install /
    /// uninstall propagate to live `/v1/skills*` reads.
    pub fn with_skills(mut self, catalog: Arc<RwLock<SkillCatalog>>) -> Self {
        self.skills = Some(catalog);
        self
    }

    /// Inject the plugin manager. Without one, `/v1/plugins*`
    /// returns 503. The manager must be backed by the same
    /// `skills` and `mcp` handles attached above so install /
    /// uninstall propagate to the live catalogue.
    pub fn with_plugins(mut self, plugins: Arc<PluginManager>) -> Self {
        self.plugins = Some(plugins);
        self
    }

    /// Inject the workspaces registry. Without one, `/v1/workspaces*`
    /// returns 503 and the WS handler can still pin a path per
    /// session — it just won't remember the choice across restarts.
    pub fn with_workspaces(mut self, store: Arc<WorkspaceStore>) -> Self {
        self.workspaces = Some(store);
        self
    }

    /// Wire in the persistent TODO store. Without one,
    /// `/v1/todos*` returns 503; the agent's `todo.*` tools are
    /// also unregistered (the binary handles that via
    /// `BuiltinsConfig::todo_store`).
    pub fn with_todo_store(mut self, store: Arc<dyn TodoStore>) -> Self {
        self.todos = Some(store);
        self
    }

    /// Wire in the persistent Requirement store. Without one, the
    /// `/v1/projects/:id/requirements*` endpoints return 503 and
    /// the `/projects` kanban Web UI falls back to localStorage.
    pub fn with_requirement_store(mut self, store: Arc<dyn RequirementStore>) -> Self {
        self.requirements = Some(store);
        self
    }

    /// Wire in the persistent Requirement-run store. Without one,
    /// `start_run` still mints + returns a typed Pending row but
    /// does not persist it; the new `/v1/requirements/:id/runs`
    /// list and `/v1/runs/:id*` mutation endpoints return 503.
    pub fn with_run_store(mut self, store: Arc<dyn RequirementRunStore>) -> Self {
        self.requirement_runs = Some(store);
        self
    }

    /// Wire in the persistent Activity timeline store. Without
    /// one, requirement / run mutations skip the audit append (no
    /// error — the operation succeeds and the `activity_appended`
    /// WS frame just doesn't fire) and the new
    /// `GET /v1/requirements/:id/activities` endpoint returns 503.
    pub fn with_activity_store(mut self, store: Arc<dyn ActivityStore>) -> Self {
        self.activities = Some(store);
        self
    }

    /// Wire in the persistent named-agent-profile store. Without
    /// one, `/v1/agent-profiles*` returns 503 and the kanban
    /// card's assignee picker renders disabled.
    pub fn with_agent_profile_store(mut self, store: Arc<dyn AgentProfileStore>) -> Self {
        self.agent_profiles = Some(store);
        self
    }

    /// Wire in the persistent Doc store. Without one, the
    /// `/v1/doc-projects*` endpoints return 503 and the `/docs`
    /// page renders the empty state.
    pub fn with_doc_store(mut self, store: Arc<dyn DocStore>) -> Self {
        self.docs = Some(store);
        self
    }

    /// Toggle the per-turn TODO injection into the system prompt.
    /// The binary flips this to `false` when
    /// `JARVIS_NO_TODOS_IN_PROMPT` is set.
    pub fn with_todos_in_prompt(mut self, enabled: bool) -> Self {
        self.todos_in_prompt = enabled;
        self
    }

    /// Phase 5 — set the worktree mode + root + dirty-allow flag
    /// in one call. The binary calls this after parsing
    /// `JARVIS_WORKTREE_MODE` / `JARVIS_WORKTREE_ROOT` /
    /// `JARVIS_WORKTREE_ALLOW_DIRTY`.
    pub fn with_worktree_config(
        mut self,
        mode: WorktreeMode,
        root: Option<PathBuf>,
        allow_dirty: bool,
    ) -> Self {
        self.worktree_mode = mode;
        self.worktree_root = root;
        self.worktree_allow_dirty = allow_dirty;
        self
    }

    /// Attach the runtime on/off switch the auto-mode scheduler reads
    /// each tick. The binary creates one and shares it between
    /// `auto_mode::spawn` and the REST handlers; tests can ignore it.
    pub fn with_auto_mode_runtime(mut self, runtime: crate::auto_mode::AutoModeRuntime) -> Self {
        self.auto_mode_runtime = Some(runtime);
        self
    }

    /// Build a fresh `Agent` for one request, routed via the
    /// registry. The returned agent shares the template's tools /
    /// memory / approver / system_prompt / max_iterations.
    pub fn build_agent(
        &self,
        explicit_provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<Arc<Agent>, RouteError> {
        let routed = self.providers.pick(explicit_provider, model)?;
        Ok(Arc::new(self.agent_from_routed(routed)))
    }

    /// Like `build_agent` but lets the caller mutate the cloned
    /// `AgentConfig` before constructing — used by the WS handler
    /// to swap in a per-socket `ChannelApprover`.
    pub fn build_agent_with<F>(
        &self,
        explicit_provider: Option<&str>,
        model: Option<&str>,
        customise: F,
    ) -> Result<Arc<Agent>, RouteError>
    where
        F: FnOnce(&mut AgentConfig),
    {
        let routed = self.providers.pick(explicit_provider, model)?;
        let mut cfg = self.agent_template.clone();
        cfg.model = routed.model.clone();
        cfg.tools = self.snapshot_tools();
        customise(&mut cfg);
        Ok(Arc::new(Agent::new(routed.entry.provider.clone(), cfg)))
    }

    fn agent_from_routed(&self, routed: Routed<'_>) -> Agent {
        let mut cfg = self.agent_template.clone();
        cfg.model = routed.model;
        cfg.tools = self.snapshot_tools();
        Agent::new(routed.entry.provider.clone(), cfg)
    }

    /// Take a per-request snapshot of the canonical registry. The
    /// read lock is held only for the duration of `(*guard).clone()`
    /// — a HashMap clone over `Arc<dyn Tool>` values, no deep copy of
    /// tool implementations. On lock poisoning the template's frozen
    /// catalogue is returned so the agent loop never panics because a
    /// sibling thread crashed mid-write.
    fn snapshot_tools(&self) -> Arc<ToolRegistry> {
        match self.tools.read() {
            Ok(guard) => Arc::new((*guard).clone()),
            Err(_) => self.agent_template.tools.clone(),
        }
    }
}
