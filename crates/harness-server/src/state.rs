use std::path::PathBuf;
use std::sync::Arc;

use harness_core::{
    Agent, AgentConfig, ConversationStore, LlmProvider, PermissionMode, PermissionStore,
    ProjectStore,
};

use crate::provider_registry::{ProviderRegistry, RouteError, Routed};

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
    /// `true` if the workspace's `AGENTS.md` / `CLAUDE.md` /
    /// `AGENT.md` instruction files were appended to the system
    /// prompt at startup.
    pub project_context_loaded: bool,
    /// Byte cap that was applied when loading project context.
    pub project_context_bytes_cap: Option<usize>,
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
}

impl AppState {
    /// Build state from an explicit registry plus a template
    /// `AgentConfig`. The template's `model` field is ignored —
    /// per-request routing always overrides it.
    pub fn from_registry(providers: ProviderRegistry, template: AgentConfig) -> Self {
        Self {
            providers: Arc::new(providers),
            agent_template: template,
            store: None,
            projects: None,
            workspace_root: None,
            server_info: ServerInfo::default(),
            permission_store: None,
            default_permission_mode: PermissionMode::default(),
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
        Self {
            providers: Arc::new(registry),
            agent_template: agent.config.clone(),
            store: None,
            projects: None,
            workspace_root: None,
            server_info: ServerInfo::default(),
            permission_store: None,
            default_permission_mode: PermissionMode::default(),
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
        customise(&mut cfg);
        Ok(Arc::new(Agent::new(routed.entry.provider.clone(), cfg)))
    }

    fn agent_from_routed(&self, routed: Routed<'_>) -> Agent {
        let mut cfg = self.agent_template.clone();
        cfg.model = routed.model;
        Agent::new(routed.entry.provider.clone(), cfg)
    }
}
