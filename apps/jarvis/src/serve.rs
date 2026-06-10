//! `jarvis serve` and `jarvis mcp-serve` implementations.
//!
//! All the wiring that was historically in `main.rs` lives here, just
//! parameterised on `(Config, ServeArgs)`. Resolution order is
//! `flag > env > config-file > built-in default`, applied per field
//! via the `pick_*` helpers.
//!
//! Backwards compatibility: when no config file is present and no new
//! flags are passed, the env-var-only surface is preserved. The
//! workspace root is the one intentional exception: without any user
//! choice it now lands under `~/.jarvis/workspace` instead of the
//! process cwd.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;

use anyhow::{Context, Result};
use harness_core::{AgentConfig, AlwaysApprove, AlwaysDeny, Approver, LlmProvider, Memory, ToolRegistry};
use harness_observability::{EvalStore, ObservabilityStore};
use harness_project::{RequirementRunStore};
use harness_llm::{
    canonical_kind, AnthropicConfig, AnthropicProvider, CapabilityValidatingProvider, CodexAuth,
    FallbackEntry, FallbackProvider,
    GoogleConfig, GoogleProvider, ModelCapability, OpenAiConfig, OpenAiProvider, ProfileRegistry,
    ProviderProfile, ProviderTransport, ResponsesConfig, ResponsesProvider,
};
use harness_mcp::{serve_registry_stdio, McpClientConfig, McpManager, McpTransport};
use harness_memory::{SlidingWindowMemory, SummarizingMemory};
use harness_plugin::PluginManager;
use harness_server::{
    default_skill_roots, serve, AppState, ModelRoutePolicy, ModelTarget, PermissionMode,
    ProjectMemoryConfig, ProviderRegistry, ServerInfo,
};
use harness_skill::SkillCatalog;
use harness_store::{default_workspaces_path, WorkspaceStore};
use harness_tools::{register_builtins, BuiltinsConfig, HarnessHealthTool, Sandbox, ShellLimits};
use tracing::{info, warn};

use crate::auth_store;
use crate::config::Config;
use crate::ServeArgs;

const PROJECT_CONTEXT_LOAD_TIMEOUT_MS: u64 = 1_500;
const SKILL_CATALOG_LOAD_TIMEOUT_MS: u64 = 1_500;

/// `jarvis serve` (default subcommand).
pub async fn run(
    cfg: Option<Config>,
    args: ServeArgs,
    config_path: Option<PathBuf>,
    telemetry: Option<harness_server::TelemetryStatus>,
) -> Result<()> {
    let cfg = cfg.unwrap_or_default();

    let mut tools = ToolRegistry::new();
    let mut bcfg = builtins_config_with_workspace(&cfg, args.workspace.as_deref());
    let workspace_root = bcfg.fs_root.clone();
    let coding_mode = bcfg.enable_fs_write
        || bcfg.enable_fs_edit
        || bcfg.enable_fs_patch
        || bcfg.enable_shell_exec;

    // `enter_plan_mode` defaults to ON in coding mode so the model
    // can volunteer "let me draft a plan first" before risky edits.
    // Operators who want the historical "operator-driven plan-mode
    // entry only" can flip `JARVIS_ENABLE_ENTER_PLAN_MODE=0` or set
    // `[agent].allow_self_plan_mode = false`. Resolution mirrors the
    // existing `pick_bool_flag` order: env > config > default.
    bcfg.enable_enter_plan_mode = pick_bool_flag(
        "JARVIS_ENABLE_ENTER_PLAN_MODE",
        cfg.agent.allow_self_plan_mode,
        coding_mode,
    );
    // `memory.*` tools stay off by default but obey the same
    // env/config override pattern so operators can flip them on
    // without recompiling. Coding mode is *not* enough to flip
    // these — memory is a longer-term storage primitive whose
    // value depends on the operator actively wanting it.
    bcfg.enable_memory = pick_bool_flag(
        "JARVIS_ENABLE_MEMORY",
        cfg.agent.enable_memory,
        false,
    );
    // P9 — user-scope memory root. Defaults to the operator's home
    // directory (the `.jarvis/memory/` subtree under it), so a
    // single `~/.jarvis/memory/MEMORY.md` follows the user across
    // workspaces. `JARVIS_MEMORY_USER_ROOT=/path` overrides for
    // ops that want it under e.g. Dropbox; `=` (empty) disables.
    // Unset and home unresolvable ⇒ user scope is off, writes to
    // `scope:"user"` error cleanly.
    bcfg.memory_user_root = resolve_memory_user_root();
    // P10 — git-as-transport memory sync. Off by default; flip
    // on when the operator has set up `git remote add origin
    // <url>` inside their memory dirs.
    bcfg.enable_memory_sync = pick_bool_flag(
        "JARVIS_ENABLE_MEMORY_SYNC",
        cfg.agent.enable_memory_sync,
        false,
    );
    // P13 — explicit sync backend choice. Resolution order:
    //   1. JARVIS_MEMORY_SYNC_BACKEND env
    //   2. [agent].memory_sync_backend config
    //   3. fall back to `Git` when legacy `enable_memory_sync` is
    //      on, `None` otherwise (handled inside register_builtins)
    let backend_pick = pick_string_opt(
        "JARVIS_MEMORY_SYNC_BACKEND",
        cfg.agent.memory_sync_backend.as_deref(),
    );
    bcfg.memory_sync_backend = match backend_pick {
        Some(s) => harness_tools::MemorySyncBackend::from_wire(&s)
            .unwrap_or(harness_tools::MemorySyncBackend::None),
        None => harness_tools::MemorySyncBackend::None,
    };
    // iCloud backend auto-resolves user_root to iCloud Drive when
    // the operator didn't pin one explicitly. Saves them having to
    // remember `~/Library/Mobile Documents/com~apple~CloudDocs/`.
    if matches!(
        bcfg.memory_sync_backend,
        harness_tools::MemorySyncBackend::ICloud
    ) && bcfg.memory_user_root.is_none()
    {
        match harness_tools::icloud_memory_root() {
            Some(p) => {
                info!(path = %p.display(), "iCloud backend: pinning user memory root");
                bcfg.memory_user_root = Some(p);
            }
            None => {
                warn!(
                    "iCloud backend selected but iCloud Drive base \
                     (`~/Library/Mobile Documents/com~apple~CloudDocs/`) not found; \
                     iCloud sync will be unavailable. \
                     Enable iCloud Drive in System Settings, then restart."
                );
            }
        }
    }
    // P11.2 — background auto-sync ticker. Sub-flag of
    // `enable_memory_sync` because there's nothing to tick when
    // the sync tools aren't even registered. Default off so the
    // existing "agent calls memory.sync explicitly" workflow
    // doesn't grow background network calls without explicit
    // opt-in. P13: the ticker is git-only — iCloud syncs at OS
    // level, so a Jarvis-side ticker would be redundant.
    let git_backend_active = matches!(
        bcfg.memory_sync_backend,
        harness_tools::MemorySyncBackend::Git
    ) || (bcfg.enable_memory_sync
        && matches!(
            bcfg.memory_sync_backend,
            harness_tools::MemorySyncBackend::None
        ));
    let auto_sync_enabled =
        git_backend_active && pick_bool_flag("JARVIS_MEMORY_AUTO_SYNC", None, false);
    let auto_sync_user_root = bcfg.memory_user_root.clone();
    let auto_sync_interval = std::env::var("JARVIS_MEMORY_AUTO_SYNC_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(harness_tools::memory_sync::DEFAULT_AUTO_SYNC_INTERVAL_SECS);

    // Open persistence early so the TODO store can flow into
    // [`BuiltinsConfig`] before [`register_builtins`] runs. The same
    // URL drives all three stores (conversations, projects, todos);
    // [`harness_store::connect_all`] shares the underlying pool /
    // directory so a single backend covers everything.
    //
    // Resolution order: `JARVIS_DB_URL` env > `[persistence].url` from
    // config > **default JSON-file path under the user's data
    // directory**. The default keeps "out of the box" deployments
    // persistent without forcing operators to discover an env var or
    // hand-edit config; SQL backends (`sqlite:` / `postgres:` /
    // `mysql:`) are opt-in via cargo features when a DB makes sense.
    let persistence_url = pick_string_opt("JARVIS_DB_URL", cfg.persistence.url.as_deref())
        .or_else(default_json_persistence_url);
    let persistence_scheme = persistence_url
        .as_deref()
        .and_then(|s| s.split(':').next().map(str::to_string));
    let (
        store,
        project_store,
        todo_store,
        requirement_store,
        requirement_run_store,
        activity_store,
        agent_profile_store,
        doc_store,
        comment_store,
        label_store,
        channel_instance_store,
        channel_binding_store,
        automation_store,
    ) = match persistence_url.as_deref() {
        Some(url) => {
            let bundle = harness_store::connect_all(url)
                .await
                .with_context(|| format!("opening persistence url `{url}`"))?;
            info!(
                url = %url,
                "conversation + project + todo + requirement + run + activity + agent_profile + doc + comment + label + channel-instance + channel-binding store connected"
            );
            (
                Some(bundle.conversations),
                Some(bundle.projects),
                Some(bundle.todos),
                Some(bundle.requirements),
                Some(bundle.requirement_runs),
                Some(bundle.activities),
                Some(bundle.agent_profiles),
                Some(bundle.docs),
                Some(bundle.comments),
                Some(bundle.labels),
                Some(bundle.channel_instances),
                Some(bundle.channel_bindings),
                Some(bundle.automations),
            )
        }
        None => {
            info!(
                "no persistence URL resolved (HOME unset?); running in-memory \
                 (conversations / TODOs / requirements / runs / activities / profiles / docs / comments / labels / channels / bindings will not survive restart)"
            );
            (
                None, None, None, None, None, None, None, None, None, None, None, None, None,
            )
        }
    };

    let observability_url = std::env::var("JARVIS_OBSERVABILITY_STORE_URL")
        .ok()
        .or_else(default_json_observability_url);
    let observability_max_runs = observability_max_runs();
    let observability_store = match observability_url.as_deref() {
        Some(url) => match harness_store::connect_observability_capped(url, observability_max_runs)
            .await
        {
            Ok(store) => {
                info!(url = %url, max_runs = ?observability_max_runs, "local observability store connected");
                Some(store)
            }
            Err(e) => {
                warn!(url = %url, error = %e, "observability store unavailable; dashboard summaries disabled");
                None
            }
        },
        None => {
            warn!("observability store URL not resolved; dashboard summaries disabled");
            None
        }
    };

    let eval_store_url = std::env::var("JARVIS_EVAL_STORE_URL")
        .ok()
        .or_else(default_json_eval_url);
    let eval_store = match eval_store_url.as_deref() {
        Some(url) => match harness_store::connect_evals(url).await {
            Ok(store) => {
                info!(url = %url, "local eval store connected");
                Some(store)
            }
            Err(e) => {
                warn!(url = %url, error = %e, "eval store unavailable; eval history disabled");
                None
            }
        },
        None => {
            warn!("eval store URL not resolved; eval history disabled");
            None
        }
    };

    // Self-improving-agent — skill-usage telemetry (Phase 0) +
    // long-term User Memory (Phase 1). Both default under
    // `<data-dir>/jarvis/learning` (skill usage) and
    // `<data-dir>/jarvis/memories` (memory); operators can override
    // with `JARVIS_LEARNING_STORE_URL` / `JARVIS_MEMORY_STORE_URL`.
    // Disable both with `JARVIS_LEARNING=0`.
    let learning_disabled = std::env::var("JARVIS_LEARNING")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off" | "disabled"
            )
        })
        .unwrap_or(false);
    let (learning_store, memory_store, skill_lifecycle_store) = if learning_disabled {
        info!(
            "learning subsystem disabled via JARVIS_LEARNING; skill usage telemetry + memory + lifecycle off"
        );
        (None, None, None)
    } else {
        let learning_url = std::env::var("JARVIS_LEARNING_STORE_URL")
            .ok()
            .or_else(default_json_learning_url);
        let max_events = learning_max_events();
        let learning = match learning_url.as_deref() {
            Some(url) => match harness_store::connect_skill_usage_capped(url, max_events).await {
                Ok(store) => {
                    info!(url = %url, "local learning store connected (skill usage telemetry on)");
                    Some(store)
                }
                Err(e) => {
                    warn!(
                        url = %url,
                        error = %e,
                        "learning store unavailable; skill usage telemetry disabled"
                    );
                    None
                }
            },
            None => {
                warn!("learning store URL not resolved; skill usage telemetry disabled");
                None
            }
        };

        let memory_url = std::env::var("JARVIS_MEMORY_STORE_URL")
            .ok()
            .or_else(default_json_memory_url);
        let memory_max_items = memory_max_items();
        let memory = match memory_url.as_deref() {
            Some(url) => match harness_store::connect_memory_capped(url, memory_max_items).await {
                Ok(store) => {
                    info!(url = %url, max_items = ?memory_max_items, "local memory store connected (user memories on)");
                    Some(store)
                }
                Err(e) => {
                    warn!(
                        url = %url,
                        error = %e,
                        "memory store unavailable; /v1/memories will 503"
                    );
                    None
                }
            },
            None => {
                warn!("memory store URL not resolved; /v1/memories will 503");
                None
            }
        };

        // Phase 2 — skill lifecycle store. Reuses the learning data
        // dir (a dedicated `JARVIS_SKILL_LIFECYCLE_STORE_URL` can
        // override). Tracks Active / Stale / Archived state per skill.
        let lifecycle_url = std::env::var("JARVIS_SKILL_LIFECYCLE_STORE_URL")
            .ok()
            .or_else(default_json_learning_url);
        let lifecycle = match lifecycle_url.as_deref() {
            Some(url) => match harness_store::connect_skill_lifecycle(url).await {
                Ok(store) => {
                    info!(url = %url, "local skill-lifecycle store connected (archive/restore on)");
                    Some(store)
                }
                Err(e) => {
                    warn!(
                        url = %url,
                        error = %e,
                        "skill-lifecycle store unavailable; /v1/skills/*/lifecycle will 503"
                    );
                    None
                }
            },
            None => {
                warn!("skill-lifecycle store URL not resolved; lifecycle routes will 503");
                None
            }
        };

        (learning, memory, lifecycle)
    };

    // `JARVIS_DISABLE_TODOS=1` opts out of the persistent TODO board
    // even when a DB is configured. Useful for shared deployments
    // that want todos managed elsewhere.
    let todos_disabled = std::env::var_os("JARVIS_DISABLE_TODOS").is_some();
    let active_todo_store = if todos_disabled {
        None
    } else {
        todo_store.clone()
    };
    bcfg.todo_store = active_todo_store.clone();
    if active_todo_store.is_some() {
        info!("persistent TODO store active (todo.* tools registered)");
    } else if todos_disabled {
        info!("persistent TODOs disabled via JARVIS_DISABLE_TODOS");
    }
    bcfg.project_store = project_store.clone();
    if project_store.is_some() {
        info!("persistent project store active (project.* tools registered)");
    }
    bcfg.doc_store = doc_store.clone();
    if doc_store.is_some() {
        info!("persistent doc store active (doc.* tools registered)");
    }
    // `requirement.*` tools require both the requirement and
    // activity stores — see `BuiltinsConfig::requirement_store` doc.
    bcfg.requirement_store = requirement_store.clone();
    bcfg.activity_store = activity_store.clone();
    if requirement_store.is_some() && activity_store.is_some() {
        info!("persistent requirement + activity stores active (requirement.* tools registered)");
    }
    // `roadmap.import` is gated separately — it needs the project +
    // requirement stores but doesn't write Activity rows. Logging the
    // two registration paths separately so operators can tell which
    // tools the model actually got.
    if project_store.is_some() && requirement_store.is_some() {
        info!("project + requirement stores both active (roadmap.import tool registered)");
    }
    // `channel.send` tool — share the same adapter registry the
    // `/v1/channels*` REST endpoints will use later (built once,
    // injected into AppState below). The tool needs `(store ×
    // registry)`; without a channel-instance store there's nothing
    // to dispatch to, so the tool stays unregistered in that case.
    let channel_adapter_registry = std::sync::Arc::new(
        harness_server::ChannelAdapterRegistry::with_defaults(),
    );
    if let Some(store) = channel_instance_store.clone() {
        bcfg.channel_dispatcher = Some(std::sync::Arc::new(
            harness_server::ChannelDispatcherImpl {
                store,
                registry: std::sync::Arc::clone(&channel_adapter_registry),
            },
        )
            as std::sync::Arc<dyn harness_channel::ChannelDispatcher>);
        info!("channel-instance store active (channel.send tool registered)");
    }
    // Self-improving-agent Phase 1 — wrap the raw memory store in a
    // `GuardedMemoryStore` so every write path (REST, tools, the
    // auto-mode failure-capture path) shares one prompt-injection /
    // credential validator AND broadcasts on the same channel that
    // the WS handler subscribes to. Done at the composition root so
    // none of the downstream code has to know about it.
    let (memory_store, memory_events): (
        Option<std::sync::Arc<dyn harness_learning::MemoryStore>>,
        Option<tokio::sync::broadcast::Sender<harness_learning::MemoryEvent>>,
    ) = match memory_store {
        Some(raw) => {
            let (guarded, tx) = harness_store::GuardedMemoryStore::with_fresh_channel(raw);
            (
                Some(std::sync::Arc::new(guarded)
                    as std::sync::Arc<dyn harness_learning::MemoryStore>),
                Some(tx),
            )
        }
        None => (None, None),
    };
    if let Some(ms) = memory_store.clone() {
        bcfg.user_memory_store = Some(ms);
        info!("user memory store active (learning.memory.* tools registered, validator + WS frames on)");
    }

    // Snapshot the few flags later code paths still need before
    // `register_builtins` consumes `bcfg`. Avoids cloning the whole
    // config (which holds Arc<dyn Store> handles).
    let memory_tools_enabled = bcfg.enable_memory;
    let memory_user_root = bcfg.memory_user_root.clone();
    // Effective backend after the same resolution
    // `register_builtins` applies: an explicit backend wins,
    // otherwise the legacy `enable_memory_sync` bool maps to Git.
    let memory_sync_backend_active = match bcfg.memory_sync_backend {
        harness_tools::MemorySyncBackend::None if bcfg.enable_memory_sync => {
            harness_tools::MemorySyncBackend::Git
        }
        other => other,
    };
    register_builtins(&mut tools, bcfg);
    tools.register(HarnessHealthTool::new(
        observability_store.clone(),
        eval_store.clone(),
        requirement_run_store.clone(),
    ));
    info!(workspace = %workspace_root.display(), "workspace root resolved");

    let provider_name = pick_string(
        args.provider.as_deref(),
        "JARVIS_PROVIDER",
        cfg.default_provider.as_deref(),
        "openai",
    );
    let primary_section = cfg.provider(&provider_name);
    let model_override = args
        .model
        .clone()
        .or_else(|| std::env::var("JARVIS_MODEL").ok())
        .or_else(|| primary_section.default_model.clone());

    // The "primary" provider — the one that drives the default
    // request route, the active model display, and (importantly)
    // the LLM the summarising-memory backend uses.
    let mut primary_built = build_provider(&provider_name, model_override, &cfg).await?;
    let model = primary_built.model.clone();

    // Other enabled providers come from two sources:
    //   1. `providers.<name>.enabled = true` in config.json
    //   2. `--enable <name>` repeated on the CLI
    // Both lists are merged here; each entry gets built with its
    // own `default_model` (config) or the provider's compiled-in
    // fallback. Missing auth for an enabled provider is fatal —
    // better to fail at startup than have a runtime route surprise
    // the operator.
    let mut seen = std::collections::HashSet::new();
    seen.insert(provider_name.clone());
    type Extra = (String, BuiltProvider, Vec<String>);
    let mut extras: Vec<Extra> = Vec::new();
    let from_cfg = cfg
        .providers
        .iter()
        .filter(|(_, p)| p.enabled)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    for name in from_cfg.into_iter().chain(args.enable.iter().cloned()) {
        if !seen.insert(name.clone()) {
            continue;
        }
        let extra_section = cfg.provider(&name);
        let extra_built = build_provider(&name, extra_section.default_model.clone(), &cfg).await?;
        extras.push((name, extra_built, extra_section.models.clone()));
    }

    // Phase 4.5 — fallback retry wrapper. When the route policy
    // declares a non-empty `fallbacks` chain, wrap the primary
    // provider so 429/5xx/timeout failures walk the chain. Targets
    // are looked up against the already-built primary + extras —
    // entries pointing at unconfigured providers are dropped with
    // a WARN. Does nothing when `policy.fallbacks` is empty.
    let route_policy = build_route_policy(&cfg);
    if !route_policy.is_empty() {
        info!(
            slots = route_policy_summary(&route_policy),
            "route policy resolved",
        );
    }
    if !route_policy.fallbacks.is_empty() {
        let chain: Vec<FallbackEntry> = route_policy
            .fallbacks
            .iter()
            .filter_map(|target| {
                if target.provider == provider_name {
                    return None;
                }
                let entry = extras
                    .iter()
                    .find(|(name, _, _)| name == &target.provider)
                    .map(|(name, built, _)| FallbackEntry::new(name, built.provider.clone()));
                if entry.is_none() {
                    warn!(
                        provider = %target.provider,
                        "fallback target's provider is not configured/enabled — skipping",
                    );
                }
                entry
            })
            .collect();
        if !chain.is_empty() {
            let wrapped =
                FallbackProvider::new(provider_name.clone(), primary_built.provider.clone(), chain);
            info!(
                primary = %provider_name,
                chain = wrapped.fallback_count(),
                "primary provider wrapped with fallback chain",
            );
            primary_built.provider = Arc::new(wrapped);
        }
    }
    let llm = primary_built.provider.clone();

    // Hand the built-ins to the canonical, mutable registry. The
    // MCP manager (and, later, the plugin manager) share this Arc so
    // their runtime mutations show up in every per-request agent
    // snapshot taken by `AppState::build_agent`.
    let canonical_tools: Arc<RwLock<ToolRegistry>> = Arc::new(RwLock::new(tools));

    // Optional: bring up external MCP servers from config + env.
    let mcp_configs = mcp_client_configs(&cfg)?;
    let mcp_manager = Arc::new(McpManager::new(Arc::clone(&canonical_tools)));
    if !mcp_configs.is_empty() {
        mcp_manager
            .bootstrap(mcp_configs)
            .await
            .context("bootstrap mcp servers")?;
    }
    let mcp_running = mcp_manager.list().await;
    let mcp_prefixes: Vec<String> = mcp_running.iter().map(|s| s.prefix.clone()).collect();
    let registered = canonical_tools.read().map(|r| r.len()).unwrap_or_default();
    info!(
        provider = %provider_name,
        model = %model,
        registered,
        mcp_servers = mcp_running.len(),
        "tools registered",
    );

    // The route policy was built earlier so the fallback wrapper
    // could see it. Reuse the same Arc for the SubAgent factories
    // and AppState below.
    let route_policy_arc = Arc::new(route_policy.clone());

    // Built-in subagents (`subagent.read_doc` / `.review` / `.codex`
    // / `.claude_code`). Each one carves a per-subagent tool subset
    // from the canonical registry and registers as a wrapper tool;
    // see `crate::subagents::register_builtins` for the per-kind
    // toolset rationale. Non-fatal: missing ClaudeCode SDK only
    // skips that one subagent.
    // Snapshot every constructed provider keyed by name so the
    // subagent factories can resolve `RouteSlot` targets that point
    // at a *different* provider than the primary (e.g. a
    // `[routing] coding = "codex/gpt-5.4-codex"` when the primary is
    // OpenAI). Falls back to `primary_provider` when the slot points
    // at an unconfigured provider — better to run on a working one
    // than to silently disable the subagent.
    let mut providers_by_name: std::collections::HashMap<String, Arc<dyn LlmProvider>> =
        std::collections::HashMap::new();
    providers_by_name.insert(provider_name.clone(), primary_built.provider.clone());
    for (name, built, _) in &extras {
        providers_by_name.insert(name.clone(), built.provider.clone());
    }
    // Snapshot the raw providers for the optional smart router before
    // `providers_by_name` is moved into the subagent factory below. The
    // router delegates to these *un-wrapped* providers, so it can never
    // recurse into itself when a tier's target names the primary.
    let providers_for_router = providers_by_name.clone();
    let _subagent_count = crate::subagents::register_builtins(
        &canonical_tools,
        llm.clone(),
        model.clone(),
        workspace_root.clone(),
        requirement_store.clone(),
        activity_store.clone(),
        route_policy_arc.clone(),
        providers_by_name,
    )
    .await;

    // Persistence (`store` / `project_store` / `todo_store`) was
    // opened earlier so the TODO store could flow into
    // `BuiltinsConfig`. The same handles are reused below — no
    // second connection.
    // Assemble the system prompt via the typed slot builder. The
    // result is byte-equivalent to the prior `push_str` flow (slots
    // joined with `\n\n` in slot order) so the LLM prompt-cache
    // fingerprint doesn't rotate, but the structure makes it easy
    // for future subsystems (M3.1 Project Memory writes, sub-agent
    // overrides) to drop their text into a known slot without
    // touching this site.
    let mut prompt_builder = harness_core::SystemPromptBuilder::new()
        .with_base(pick_system_prompt(&cfg, coding_mode));
    let project_ctx_cap = project_context_max_bytes(&cfg);
    let mut project_context_loaded = false;
    if include_project_context(&cfg) {
        if let Some(extra) = load_instructions_bounded(workspace_root.clone(), project_ctx_cap) {
            info!(
                bytes = extra.len(),
                cap = project_ctx_cap,
                "loaded project instructions (AGENTS.md / JARVIS.md / CLAUDE.md / .jarvis)"
            );
            if extra.contains("project context truncated at") {
                warn!(
                    cap = project_ctx_cap,
                    "project instructions exceeded cap — output truncated. \
                     Set JARVIS_PROJECT_CONTEXT_BYTES=<n> or [agent].project_context_max_bytes \
                     to raise (default lowered to 8 KiB to keep system prompt focused)."
                );
            }
            prompt_builder = prompt_builder.append_runtime_inject(extra);
            project_context_loaded = true;
        }
    }
    let project_memory_dir = project_memory_dir(&cfg);
    let project_memory_cap = project_memory_max_bytes(&cfg);
    let project_memory_setting = project_memory_enabled_setting(&cfg);
    let project_memory_runtime = (project_memory_setting != Some(false)).then(|| {
        ProjectMemoryConfig::new(
            workspace_root.clone(),
            project_memory_dir.clone(),
            project_memory_cap,
        )
    });
    let mut project_memory_loaded = false;
    if include_project_memory(&workspace_root, &project_memory_dir, project_memory_setting) {
        if let Some(extra) = harness_tools::workspace::load_project_memory(
            &workspace_root,
            &project_memory_dir,
            project_memory_cap,
            project_memory_setting == Some(true),
        ) {
            info!(
                bytes = extra.len(),
                dir = %project_memory_dir.display(),
                "loaded project memory prompt"
            );
            prompt_builder = prompt_builder.append_runtime_inject(extra);
            project_memory_loaded = true;
        }
    }
    // Agent-maintained memory indices (M3.1 + P9). When the memory
    // tools are enabled, inject both scopes' MEMORY.md files so the
    // model wakes up with "what do I know about this project" AND
    // "what do I know about this user" before turn 1. Each entry's
    // body is fetched on demand via `memory.read(slug, scope?)`.
    let user_memory_root = resolve_memory_user_root();
    let mut memory_index_loaded = false;
    let include_cache_root = home_dir()
        .map(|h| h.join(".jarvis/include-cache"))
        .unwrap_or_else(|| std::env::temp_dir().join("jarvis-include-cache"));
    // P18.3 — optional gentle TTL refresh. `JARVIS_INCLUDE_TTL_HOURS=N`
    // causes git+ includes whose cache is older than N hours to
    // trigger a `git pull --ff-only` before being injected.
    // Unset (or `0`) keeps the original "manual refresh only"
    // behaviour from P16.
    let include_ttl = std::env::var("JARVIS_INCLUDE_TTL_HOURS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .map(|n| std::time::Duration::from_secs(n * 3600));
    if memory_tools_enabled {
        // Shared dedup set spans both scope walks so a directive
        // included from both workspace + user injects only once.
        let mut include_seen: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let (next, loaded) = inject_memory_with_includes(
            prompt_builder,
            "project memory index",
            "workspace",
            &workspace_root,
            &include_cache_root,
            &mut include_seen,
            include_ttl,
        )
        .await;
        prompt_builder = next;
        if loaded {
            memory_index_loaded = true;
        }
        if let Some(user_root) = user_memory_root.as_deref() {
            let (next, loaded) = inject_memory_with_includes(
                prompt_builder,
                "user memory index",
                "user",
                user_root,
                &include_cache_root,
                &mut include_seen,
                include_ttl,
            )
            .await;
            prompt_builder = next;
            if loaded {
                memory_index_loaded = true;
            }
        }
    }
    let _ = memory_index_loaded; // reserved for future telemetry
    let system_prompt = prompt_builder.build();
    info!(
        slots = ?prompt_builder.trace(),
        total_bytes = system_prompt.len(),
        "system prompt assembled",
    );
    // Snapshot the canonical registry as the agent template's tool
    // catalogue. `AppState::build_agent` always re-snapshots from
    // `canonical_tools` per request, so this seed is only for the
    // template's `Default::default`-style use.
    let template_tools = canonical_tools
        .read()
        .map(|r| (*r).clone())
        .unwrap_or_default();
    let mut agent_cfg = AgentConfig::new(model.clone())
        .with_system_prompt(system_prompt)
        .with_tools(template_tools)
        .with_max_iterations(80);
    // Build a route resolver for `RouteSlot::Summarization` so the
    // summariser memory can target a cheaper / dedicated model. The
    // closure captures cloned Arcs of every built provider keyed by
    // name + the resolved `ModelRoutePolicy`, so it has nothing to
    // borrow from this scope and lives for the lifetime of the
    // memory object.
    let summary_resolver = build_route_resolver_for_slot(
        harness_server::RouteSlot::Summarization,
        &provider_name,
        &primary_built,
        &extras,
        &route_policy,
    );
    let mut memory_stats: Option<Arc<dyn harness_core::MemoryStatsProvider>> = None;
    if let Some(bundle) = build_memory(&cfg, &llm, &model, store.as_ref(), summary_resolver)? {
        agent_cfg = agent_cfg.with_memory(bundle.memory);
        memory_stats = bundle.stats;
    }
    if let Some(approver) = build_approver(&cfg)? {
        agent_cfg = agent_cfg.with_approver(approver);
    }
    // Parallel tool-call dispatch — env var wins over config flag,
    // both default off. When on, a multi-call assistant turn runs
    // its tools concurrently *and* the wire request advertises
    // `parallel_tool_calls=true` so capable models emit several at
    // once. The capability-validating wrapper still downgrades for
    // models without `supports_parallel_tool_calls`.
    let parallel = std::env::var("JARVIS_PARALLEL_TOOL_CALLS")
        .ok()
        .map(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or_else(|| cfg.agent.parallel_tool_calls.unwrap_or(false));
    if parallel {
        agent_cfg = agent_cfg.with_parallel_tool_calls(true);
        info!("agent loop opted into parallel tool-call dispatch");
    }

    // Build the provider registry. Default = primary provider name;
    // prefix rules cover the bare-model-name case so requests with
    // just `model: "kimi-k2-thinking"` (no provider) still route
    // correctly when both `openai` and `kimi` are enabled.
    let mut registry = ProviderRegistry::new(provider_name.clone())
        // `kimi-for-coding` is the only Kimi Code model id; route
        // it before the generic `kimi-` rule so it doesn't get
        // mis-routed to the Moonshot platform provider.
        .with_prefix_rule("kimi-for-coding", "kimi-code")
        .with_prefix_rule("kimi-", "kimi")
        .with_prefix_rule("moonshot-", "kimi")
        .with_prefix_rule("claude-", "anthropic")
        .with_prefix_rule("gemini-", "google")
        .with_prefix_rule("gpt-5.", "codex");
    // Smart routing (opt-in via `JARVIS_ROUTER_ENABLED`). When on, the
    // primary registry entry is a `RoutingProvider` that classifies each
    // request's difficulty and rewrites the model before delegating to
    // the right raw provider. Requests that explicitly target a
    // *different* provider bypass it (the registry routes them past this
    // entry). When off, the raw primary provider is registered as before.
    let primary_for_registry: Arc<dyn LlmProvider> = build_smart_router(
        &provider_name,
        &model,
        primary_built.provider.clone(),
        providers_for_router,
    )
    .unwrap_or_else(|| primary_built.provider.clone());
    registry.insert_with_capabilities(
        provider_name.clone(),
        primary_for_registry,
        primary_built.model.clone(),
        primary_section.models.clone(),
        primary_built.kind.clone(),
        primary_built.capabilities.clone(),
    );
    let mut active_models: Vec<String> = vec![format!("{provider_name}={model}")];
    for (name, built, extra_models) in extras {
        active_models.push(format!("{name}={}", built.model));
        registry.insert_with_capabilities(
            name,
            built.provider,
            built.model,
            extra_models,
            built.kind,
            built.capabilities,
        );
    }
    info!(
        primary = %provider_name,
        active = %active_models.join(","),
        "providers registered",
    );

    // Open the permission store (user-scope + project-scope JSON
    // files). Always created — the rule engine is the new contract;
    // even deployments with no rules get an empty `Ask` table that
    // the WS handler wraps `ChannelApprover` in. Failures fall back
    // to a session-only store so a misconfigured filesystem doesn't
    // crash startup.
    let user_perm_path = dirs_user_config().ok().map(|d| d.join("permissions.json"));
    let project_perm_path = Some(workspace_root.join(".jarvis").join("permissions.json"));
    let permission_store: std::sync::Arc<dyn harness_server::PermissionStore> =
        match harness_store::JsonFilePermissionStore::open(
            user_perm_path.clone(),
            project_perm_path.clone(),
        )
        .await
        {
            Ok(s) => std::sync::Arc::new(s),
            Err(e) => {
                tracing::warn!(error = %e, "permission store open failed; falling back to session-only");
                std::sync::Arc::new(
                    harness_store::JsonFilePermissionStore::open(None, None)
                        .await
                        .expect("session-only store can't fail"),
                )
            }
        };
    let permission_mode = pick_permission_mode(&cfg, &args)?;
    info!(
        mode = %permission_mode.as_str(),
        user_path = ?user_perm_path,
        project_path = ?project_perm_path,
        "permission store ready",
    );

    // Build the skill catalogue. Layers (lowest precedence first):
    //   1. Bundled defaults compiled into the binary (`work`, `doc`).
    //   2. User-scope ($XDG_CONFIG_HOME/jarvis/skills, override via
    //      $JARVIS_SKILLS_DIR).
    //   3. Workspace-scope (<root>/.jarvis/skills).
    // Later layers shadow earlier ones, so `~/.config/jarvis/skills/work/SKILL.md`
    // overrides the bundled `work` and the workspace can override both.
    // Loading is silent on missing dirs; malformed SKILL.md files
    // warn and skip.
    let user_skills_dir = std::env::var_os("JARVIS_SKILLS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_user_config().ok().map(|d| d.join("skills")));
    let workspace_skills_dir = Some(workspace_root.join(".jarvis").join("skills"));
    let skill_roots = default_skill_roots(user_skills_dir.clone(), workspace_skills_dir);
    let mut catalog = SkillCatalog::new();
    catalog.merge_bundled(harness_skill::bundled_defaults());
    catalog = merge_skill_roots_bounded(catalog, skill_roots);
    let skill_catalog = Arc::new(RwLock::new(catalog));
    let initial_skill_count = skill_catalog.read().map(|g| g.len()).unwrap_or(0);
    info!(skills = initial_skill_count, "skill catalog loaded");

    // Plugin manager — installs land at $XDG_CONFIG_HOME/jarvis/
    // plugins/ (override `JARVIS_PLUGINS_DIR`). On startup we
    // re-attach every entry the ledger remembers so plugin
    // skills + MCP servers come back without manual reinstall.
    let plugins_dir = std::env::var_os("JARVIS_PLUGINS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_user_config().ok().map(|d| d.join("plugins")))
        .unwrap_or_else(|| PathBuf::from(".jarvis/plugins"));
    let plugin_manager = match PluginManager::new(
        plugins_dir.clone(),
        Arc::clone(&skill_catalog),
        Arc::clone(&mcp_manager),
    ) {
        Ok(m) => Arc::new(m),
        Err(e) => {
            tracing::warn!(error = %e, dir = %plugins_dir.display(), "plugin manager init failed");
            // Fall back to a temp-dir manager so the rest of the
            // server still comes up; install / uninstall will
            // surface the real error when they try to write.
            let tmp = std::env::temp_dir().join("jarvis-plugins-fallback");
            Arc::new(
                PluginManager::new(tmp, Arc::clone(&skill_catalog), Arc::clone(&mcp_manager))
                    .expect("fallback temp-dir plugin manager"),
            )
        }
    };
    if let Err(e) = plugin_manager.reattach_installed().await {
        tracing::warn!(error = %e, "plugin reattach failed");
    }
    let plugin_count = plugin_manager.list().await.len();
    info!(plugins = plugin_count, dir = %plugins_dir.display(), "plugin manager ready");

    // Workspaces registry (recent dropdown + per-conversation
    // bindings). File-backed at `<config-dir>/workspaces.json`;
    // when no config dir is reachable the store falls back to
    // session-only mode so the rest of the server still works.
    let workspaces_path = dirs_user_config()
        .ok()
        .and_then(|d| default_workspaces_path(Some(&d)));
    let workspaces = Arc::new(WorkspaceStore::open(workspaces_path));
    info!(
        recent = workspaces.list_recent().len(),
        "workspaces store ready",
    );

    // Phase 5 — worktree isolation env-var parsing. The mode
    // string defaults to "off" if absent / unrecognised; the root
    // defaults to `<workspace>/.jarvis/worktrees`. Both kept
    // available regardless of mode so a future runtime toggle
    // (e.g. via /v1/server/info) doesn't have to re-parse.
    let worktree_mode = std::env::var("JARVIS_WORKTREE_MODE")
        .ok()
        .as_deref()
        .and_then(harness_server::WorktreeMode::from_wire)
        .unwrap_or_default();
    let worktree_root = std::env::var("JARVIS_WORKTREE_ROOT")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| Some(workspace_root.join(".jarvis").join("worktrees")));
    let worktree_allow_dirty = std::env::var_os("JARVIS_WORKTREE_ALLOW_DIRTY").is_some();
    if worktree_mode != harness_server::WorktreeMode::Off {
        info!(
            mode = ?worktree_mode,
            root = %worktree_root.as_deref().map(|p| p.display().to_string()).unwrap_or_default(),
            allow_dirty = worktree_allow_dirty,
            "worktree isolation enabled (per-run worktrees will be minted)",
        );
    }

    let mut state = AppState::from_registry(registry, agent_cfg)
        .with_workspace_root(workspace_root.clone())
        .with_tools(Arc::clone(&canonical_tools))
        .with_mcp(Arc::clone(&mcp_manager))
        .with_skills(Arc::clone(&skill_catalog))
        .with_user_skills_dir(
            user_skills_dir
                .clone()
                .unwrap_or_else(|| workspace_root.join(".jarvis").join("skills")),
        )
        .with_plugins(Arc::clone(&plugin_manager))
        .with_workspaces(Arc::clone(&workspaces))
        .with_worktree_config(worktree_mode, worktree_root, worktree_allow_dirty)
        .with_route_policy(route_policy)
        .with_subagent_runs(harness_server::SubAgentRunRegistry::new());
    if let Some(stats) = memory_stats {
        state = state.with_memory_stats(stats);
    }
    // P14 — expose memory runtime metadata to the Web UI / REST.
    // Only attached when the memory tools are actually enabled —
    // otherwise the panel's REST endpoints render 503 cleanly so
    // the UI knows to show an "off, enable in config" state.
    if memory_tools_enabled {
        state = state.with_memory_runtime(harness_server::MemoryRuntime {
            workspace_root: workspace_root.clone(),
            user_root: memory_user_root.clone(),
            backend: memory_sync_backend_active,
        });
    }
    if let Some(pm) = project_memory_runtime.clone() {
        state = state.with_project_memory(pm);
    }
    if let Some(s) = store {
        state = state.with_store(s);
    }
    if let Some(ps) = project_store {
        state = state.with_project_store(ps);
    }
    if let Some(ts) = active_todo_store {
        state = state.with_todo_store(ts);
    }
    if let Some(rs) = requirement_store {
        state = state.with_requirement_store(rs);
    }
    if let Some(runs) = requirement_run_store {
        state = state.with_run_store(runs);
    }
    if let Some(acts) = activity_store {
        state = state.with_activity_store(acts);
    }
    if let Some(profs) = agent_profile_store {
        state = state.with_agent_profile_store(profs);
    }
    if let Some(ds) = doc_store {
        state = state.with_doc_store(ds);
    }
    if let Some(cs) = comment_store {
        state = state.with_comment_store(cs);
    }
    if let Some(ls) = label_store {
        state = state.with_label_store(ls);
    }
    if let Some(cis) = channel_instance_store {
        state = state.with_channel_instance_store(cis);
    }
    if let Some(cbs) = channel_binding_store {
        state = state.with_channel_binding_store(cbs);
    }
    if let Some(autos) = automation_store {
        state = state.with_automation_store(autos);
    }
    // Declarative workflows share the conversation persistence URL so
    // definitions + runs survive restarts under the JSON backend. SQL
    // deployments fall back to in-memory inside `connect_workflows`.
    if let Some(url) = persistence_url.as_deref() {
        match harness_store::connect_workflows(url).await {
            Ok(wf) => state = state.with_workflows(wf),
            Err(e) => {
                warn!(url = %url, error = %e, "workflow store unavailable; /v1/workflows disabled")
            }
        }
    }
    // Share the same adapter registry the `channel.send` tool uses,
    // so any future runtime adapter registration (tests, custom
    // binaries) stays consistent across the REST surface and the
    // agent tool.
    state = state.with_channel_adapters(channel_adapter_registry);
    if let Some(os) = observability_store {
        state = state.with_observability_store(os);
    }
    if let Some(es) = eval_store {
        state = state.with_eval_store(es);
    }
    if let Some(ls) = learning_store {
        state = state.with_skill_usage_store(ls);
    }
    if let Some(ms) = memory_store {
        state = state.with_user_memory_store(ms);
    }
    if let Some(tx) = memory_events {
        state = state.with_memory_events(tx);
    }
    if let Some(lc) = skill_lifecycle_store {
        state = state.with_skill_lifecycle_store(lc);
    }
    if let Some(ts) = telemetry {
        state = state.with_telemetry_status(ts);
    }
    // Project-scoped long-term memory. The auto loop captures
    // `gotcha` rows from failed runs and prepends recent rows into
    // the next run's system prompt. We unconditionally wire an
    // in-memory backend so the `/v1/projects/:id/memories` route is
    // always live; persistence-backed implementations can land later
    // and override this via `connect_all`.
    state = state.with_project_memory_store(std::sync::Arc::new(
        harness_store::MemoryProjectMemoryStore::new(),
    ));
    // `JARVIS_NO_TODOS_IN_PROMPT=1` opts out of injecting the
    // current TODO list into the system prompt every turn. The
    // `todo.*` tools stay registered (the model can still query
    // explicitly) — only the automatic injection goes away.
    let inject_todos = std::env::var_os("JARVIS_NO_TODOS_IN_PROMPT").is_none();
    state = state.with_todos_in_prompt(inject_todos);
    state = state
        .with_permission_store(permission_store)
        .with_default_permission_mode(permission_mode);

    let addr_str = pick_string(
        args.addr.as_deref(),
        "JARVIS_ADDR",
        cfg.server.addr.as_deref(),
        "0.0.0.0:7001",
    );
    let addr: SocketAddr = addr_str
        .parse()
        .with_context(|| format!("invalid bind address `{addr_str}`"))?;

    // Populate the server-info snapshot the Settings page reads via
    // `GET /v1/server/info`. Fields are derived from the same env-var
    // / config plumbing used above, but stay strictly informational —
    // never include the persistence URL credentials, API keys, or
    // OAuth tokens.
    let memory_mode =
        if cfg.memory.tokens.is_some() || std::env::var("JARVIS_MEMORY_TOKENS").is_ok() {
            Some(
                pick_string_opt("JARVIS_MEMORY_MODE", cfg.memory.mode.as_deref())
                    .unwrap_or_else(|| "window".to_string()),
            )
        } else {
            None
        };
    let memory_budget = std::env::var("JARVIS_MEMORY_TOKENS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .or(cfg.memory.tokens);
    let approval_mode = pick_string_opt("JARVIS_APPROVAL_MODE", cfg.approval.mode.as_deref());

    let server_info = ServerInfo {
        listen_addr: Some(addr_str.clone()),
        config_path,
        persistence_scheme,
        memory_mode,
        memory_budget_tokens: memory_budget,
        approval_mode,
        coding_mode,
        project_context_loaded,
        project_context_bytes_cap: Some(project_ctx_cap),
        project_memory_loaded,
        project_memory_dir: Some(project_memory_dir.display().to_string()),
        project_memory_bytes_cap: Some(project_memory_cap),
        mcp_prefixes,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    state = state.with_server_info(server_info);

    // Phase 6 — auto mode scheduler. Off by default; opt in via
    // `JARVIS_WORK_MODE=auto` or a workspace `WORKFLOW.md`. The
    // workflow file intentionally mirrors Symphony's shape where it
    // helps: YAML front matter carries scheduler policy, Markdown
    // body becomes the unattended run prompt. Env vars still win so
    // operators can override a repo default in CI / SSH sessions.
    let mut auto_cfg = harness_server::AutoModeConfig::default();
    let workflow_path = std::env::var_os("JARVIS_WORKFLOW_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("WORKFLOW.md"));
    match harness_server::AutoWorkflow::load(&workflow_path) {
        Ok(Some(workflow)) => {
            workflow.apply_to(&mut auto_cfg);
            info!(path = %workflow_path.display(), "auto workflow loaded");
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(error = %e, path = %workflow_path.display(), "auto workflow ignored");
        }
    }
    if let Ok(s) = std::env::var("JARVIS_WORK_MODE") {
        match harness_server::AutoMode::from_wire(&s) {
            Some(mode) => auto_cfg.mode = mode,
            None => tracing::warn!(value = %s, "JARVIS_WORK_MODE ignored; expected off or auto"),
        }
    }
    if let Ok(v) = std::env::var("JARVIS_WORK_TICK_SECONDS")
        .and_then(|s| s.parse::<u64>().map_err(|_| std::env::VarError::NotPresent))
    {
        auto_cfg.tick_seconds = v.max(1);
    }
    if let Ok(v) = std::env::var("JARVIS_WORK_MAX_UNITS_PER_TICK").and_then(|s| {
        s.parse::<usize>()
            .map_err(|_| std::env::VarError::NotPresent)
    }) {
        auto_cfg.max_units_per_tick = v.max(1);
    }
    // Real concurrency cap — independent from the per-tick burst.
    // See `AutoModeConfig` docs for the full split.
    if let Ok(v) = std::env::var("JARVIS_WORK_MAX_CONCURRENT").and_then(|s| {
        s.parse::<usize>()
            .map_err(|_| std::env::VarError::NotPresent)
    }) {
        auto_cfg.max_concurrent_units = v.max(1);
    }
    if let Ok(v) = std::env::var("JARVIS_WORK_MAX_RETRIES").and_then(|s| {
        s.parse::<usize>()
            .map_err(|_| std::env::VarError::NotPresent)
    }) {
        auto_cfg.max_retries = v;
    }
    if let Ok(v) = std::env::var("JARVIS_WORK_RUN_TIMEOUT_MS")
        .and_then(|s| s.parse::<u64>().map_err(|_| std::env::VarError::NotPresent))
    {
        auto_cfg.run_timeout_ms = v.max(1);
    }
    if std::env::var_os("JARVIS_WORK_ALLOW_UNASSIGNED").is_some() {
        auto_cfg.allow_unassigned = true;
    }
    if let Ok(s) = std::env::var("JARVIS_WORK_DEFAULT_ASSIGNEE") {
        let s = s.trim();
        if !s.is_empty() {
            auto_cfg.default_assignee = Some(s.to_string());
        }
    }
    if let Ok(s) = std::env::var("JARVIS_WORK_PROMPT") {
        let s = s.trim();
        if !s.is_empty() {
            auto_cfg.workflow_prompt = Some(s.to_string());
        }
    }
    // v1.0 SubAgent — flip to opt-in reviewer-subagent dispatch when
    // the env var is set to anything non-empty / non-`0` / non-`false`.
    if let Ok(s) = std::env::var("JARVIS_REVIEWER_AUTO_ACCEPT") {
        let s = s.trim().to_ascii_lowercase();
        if !s.is_empty() && s != "0" && s != "false" && s != "no" && s != "off" {
            auto_cfg.reviewer_auto_accept = true;
        }
    }
    // Build the runtime with the resolved concurrency cap so the
    // semaphore pool size matches what `tick` will enforce. The
    // spawn helper falls back to default capacity when the runtime
    // is built fresh inside it, but our binary always pre-creates
    // it so the auto-mode REST routes (`POST /v1/auto-mode`) see a
    // runtime they can toggle.
    let auto_runtime = harness_server::AutoModeRuntime::with_capacity(
        auto_cfg.mode,
        auto_cfg.max_concurrent_units,
    );
    state = state.with_auto_mode_runtime(auto_runtime);
    let auto_cfg_arc = std::sync::Arc::new(auto_cfg.clone());
    state = state.with_auto_mode_config(auto_cfg_arc);
    // One-shot sweep for orphan RequirementRuns left by older
    // binaries that didn't have the WS-terminal reconciliation hook.
    // Runs before `spawn_auto_mode` so the first auto-mode tick sees
    // the corrected store state. Cheap (bounded by # requirements);
    // returns 0 instantly when stores aren't configured.
    let reconciled =
        harness_server::sweep_orphan_requirements_on_startup(&state).await;
    if reconciled > 0 {
        info!(
            count = reconciled,
            "startup sweep reconciled orphan requirement runs"
        );
    }
    harness_server::spawn_auto_mode(state.clone(), auto_cfg);
    harness_server::spawn_automation_scheduler(state.clone());
    if let (Some(pm), Some(projects), Some(requirements)) = (
        project_memory_runtime,
        state.projects.clone(),
        state.requirements.clone(),
    ) {
        harness_server::spawn_project_memory_sync(pm, projects, requirements);
        info!("project memory sync active (kanban.md + calendar.md update after board mutations)");
    }

    info!(%addr, "jarvis listening");

    if args.open {
        let url = browser_open_url(&addr);
        tokio::spawn(async move {
            // Give axum a brief moment to start accepting connections
            // before we shell out to the OS browser handler. 200 ms is
            // well below human perception and avoids racing the bind.
            tokio::time::sleep(Duration::from_millis(200)).await;
            info!(%url, "opening Web UI in default browser");
            if let Err(e) = open::that(&url) {
                warn!(error = %e, %url, "failed to open browser; visit the URL manually");
            }
        });
    }

    // P11.2 — background memory auto-sync. Started after AppState
    // is finalised but before `serve(...)` runs forever; the
    // handle is held by `serve(...)`'s lifetime via Drop semantics.
    // When the process exits the task drops along with it.
    let _auto_sync_handle = if auto_sync_enabled {
        if let Some(user_root) = auto_sync_user_root {
            let mut roots = harness_tools::MemoryRoots::new(workspace_root.clone());
            roots = roots.with_user_root(user_root);
            let cfg = harness_tools::memory_sync::AutoSyncConfig {
                roots,
                scope: harness_tools::MemoryScope::User,
                interval: std::time::Duration::from_secs(auto_sync_interval),
                initial_pull: true,
            };
            info!(
                interval_secs = auto_sync_interval,
                "memory auto-sync ticker started"
            );
            Some(harness_tools::memory_sync::spawn_auto_sync_task(cfg))
        } else {
            warn!("JARVIS_MEMORY_AUTO_SYNC set but user_root is unconfigured; ticker not started");
            None
        }
    } else {
        None
    };

    serve(addr, state).await?;

    drop(mcp_manager);
    Ok(())
}

/// Map a bind address to a browser-friendly URL. `0.0.0.0` and `::`
/// are reachable for *listening* but invalid as client targets, so we
/// substitute the loopback address. Everything else is used verbatim.
fn browser_open_url(addr: &SocketAddr) -> String {
    let port = addr.port();
    let ip = addr.ip();
    if ip.is_unspecified() {
        if ip.is_ipv6() {
            format!("http://[::1]:{port}")
        } else {
            format!("http://127.0.0.1:{port}")
        }
    } else if ip.is_ipv6() {
        format!("http://[{ip}]:{port}")
    } else {
        format!("http://{ip}:{port}")
    }
}

fn load_instructions_bounded(workspace_root: PathBuf, max_bytes: usize) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(harness_tools::workspace::load_instructions(
            &workspace_root,
            max_bytes,
        ));
    });
    match rx.recv_timeout(Duration::from_millis(PROJECT_CONTEXT_LOAD_TIMEOUT_MS)) {
        Ok(extra) => extra,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            warn!(
                timeout_ms = PROJECT_CONTEXT_LOAD_TIMEOUT_MS,
                "loading project instructions timed out; starting without injected project context"
            );
            None
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => None,
    }
}

fn merge_skill_roots_bounded(
    catalog: SkillCatalog,
    skill_roots: Vec<(PathBuf, harness_skill::SkillSource)>,
) -> SkillCatalog {
    let fallback = catalog.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut catalog = catalog;
        for (root, source) in skill_roots {
            catalog.merge_disk(&root, source);
        }
        let _ = tx.send(catalog);
    });
    match rx.recv_timeout(Duration::from_millis(SKILL_CATALOG_LOAD_TIMEOUT_MS)) {
        Ok(catalog) => catalog,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            warn!(
                timeout_ms = SKILL_CATALOG_LOAD_TIMEOUT_MS,
                "loading disk skills timed out; starting with bundled skill catalog"
            );
            fallback
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => fallback,
    }
}

/// `jarvis mcp-serve` — stdio MCP server. No LLM provider needed.
pub async fn run_mcp(cfg: Option<Config>) -> Result<()> {
    let cfg = cfg.unwrap_or_default();
    let mut tools = ToolRegistry::new();
    register_builtins(&mut tools, builtins_config(&cfg));
    let (requirement_runs, observability, evals) = connect_harness_health_sources(&cfg).await;
    tools.register(HarnessHealthTool::new(
        observability,
        evals,
        requirement_runs,
    ));
    info!(registered = tools.len(), "serving tools over mcp stdio");
    serve_registry_stdio(Arc::new(tools)).await?;
    Ok(())
}

async fn connect_harness_health_sources(
    cfg: &Config,
) -> (
    Option<Arc<dyn RequirementRunStore>>,
    Option<Arc<dyn ObservabilityStore>>,
    Option<Arc<dyn EvalStore>>,
) {
    let persistence_url = pick_string_opt("JARVIS_DB_URL", cfg.persistence.url.as_deref())
        .or_else(default_json_persistence_url);
    let requirement_runs = match persistence_url.as_deref() {
        Some(url) => match harness_store::connect_requirement_runs(url).await {
            Ok(store) => {
                info!(url = %url, "requirement-run store connected for harness.health mcp tool");
                Some(store)
            }
            Err(e) => {
                warn!(url = %url, error = %e, "requirement-run store unavailable for harness.health mcp tool");
                None
            }
        },
        None => {
            warn!("persistence URL not resolved; harness.health mcp tool will not include requirement-run data");
            None
        }
    };

    let observability_url = std::env::var("JARVIS_OBSERVABILITY_STORE_URL")
        .ok()
        .or_else(default_json_observability_url);
    let observability = match observability_url.as_deref() {
        Some(url) => match harness_store::connect_observability_capped(url, observability_max_runs())
            .await
        {
            Ok(store) => {
                info!(url = %url, "observability store connected for harness.health mcp tool");
                Some(store)
            }
            Err(e) => {
                warn!(url = %url, error = %e, "observability store unavailable for harness.health mcp tool");
                None
            }
        },
        None => {
            warn!("observability store URL not resolved; harness.health mcp tool will not include observed-run data");
            None
        }
    };

    let eval_url = std::env::var("JARVIS_EVAL_STORE_URL")
        .ok()
        .or_else(default_json_eval_url);
    let evals = match eval_url.as_deref() {
        Some(url) => match harness_store::connect_evals(url).await {
            Ok(store) => {
                info!(url = %url, "eval store connected for harness.health mcp tool");
                Some(store)
            }
            Err(e) => {
                warn!(url = %url, error = %e, "eval store unavailable for harness.health mcp tool");
                None
            }
        },
        None => {
            warn!(
                "eval store URL not resolved; harness.health mcp tool will not include eval data"
            );
            None
        }
    };

    (requirement_runs, observability, evals)
}

/// `jarvis workspace` — print the resolved workspace root + git
/// state. Mirrors `GET /v1/workspace` so scripts and humans see the
/// same answer. Resolution mirrors `serve` exactly:
/// `--workspace > JARVIS_FS_ROOT > [tools].fs_root > ~/.jarvis/workspace`.
pub async fn run_workspace(
    cfg: Option<Config>,
    workspace_override: Option<PathBuf>,
    json: bool,
) -> Result<()> {
    let cfg = cfg.unwrap_or_default();
    let bcfg = builtins_config_with_workspace(&cfg, workspace_override.as_deref());
    let root = bcfg.fs_root.clone();
    let canonical = tokio::fs::canonicalize(&root).await.unwrap_or(root);
    let snapshot = workspace_snapshot(&canonical).await;
    if json {
        println!("{}", serde_json::to_string_pretty(&snapshot)?);
    } else {
        let root_str = snapshot["root"].as_str().unwrap_or("(unknown)");
        let vcs = snapshot["vcs"].as_str().unwrap_or("none");
        println!("workspace: {root_str}");
        println!("vcs:       {vcs}");
        if vcs == "git" {
            let branch = snapshot["branch"].as_str().unwrap_or("(detached)");
            let head = snapshot["head"].as_str().unwrap_or("(unknown)");
            let dirty = snapshot["dirty"].as_bool().unwrap_or(false);
            let dirty_marker = if dirty { "● dirty" } else { "✓ clean" };
            println!("branch:    {branch} ({head}) {dirty_marker}");
        }
    }
    Ok(())
}

/// Same shape as `harness_server::routes::workspace_snapshot`. We
/// re-derive it here so the CLI doesn't have to spin up an HTTP
/// server just to ask its own binary a local question.
async fn workspace_snapshot(root: &std::path::Path) -> serde_json::Value {
    use std::process::Stdio;
    use tokio::process::Command;
    let display = root.display().to_string();
    let run_git = |args: Vec<&'static str>| {
        let root = root.to_path_buf();
        async move {
            let out = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output()
                .await
                .ok()?;
            if !out.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    };
    let inside = run_git(vec!["rev-parse", "--is-inside-work-tree"]).await;
    if !matches!(inside.as_deref(), Some("true")) {
        return serde_json::json!({ "root": display, "vcs": "none" });
    }
    let branch = run_git(vec!["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .filter(|s| !s.is_empty() && s != "HEAD");
    let head = run_git(vec!["rev-parse", "--short", "HEAD"])
        .await
        .filter(|s| !s.is_empty());
    let dirty = !run_git(vec!["status", "--porcelain"])
        .await
        .unwrap_or_default()
        .is_empty();
    serde_json::json!({
        "root": display,
        "vcs": "git",
        "branch": branch,
        "head": head,
        "dirty": dirty,
    })
}

// ---------- builders ----------

fn builtins_config(cfg: &Config) -> BuiltinsConfig {
    builtins_config_with_workspace(cfg, None)
}

/// Same as [`builtins_config`] but lets the caller force a specific
/// workspace (the `--workspace` / `--fs-root` CLI flag). Resolution
/// order: CLI flag > `JARVIS_FS_ROOT` > `[tools].fs_root` >
/// `~/.jarvis/workspace`.
fn builtins_config_with_workspace(
    cfg: &Config,
    workspace_override: Option<&std::path::Path>,
) -> BuiltinsConfig {
    let defaults = BuiltinsConfig::default();
    let fs_root = match workspace_override {
        Some(p) => p.to_path_buf(),
        None => pick_path("JARVIS_FS_ROOT", cfg.tools.fs_root.as_deref(), || {
            ensure_default_workspace_root(default_jarvis_workspace_root())
        }),
    };
    BuiltinsConfig {
        fs_root,
        enable_fs_write: pick_bool_flag("JARVIS_ENABLE_FS_WRITE", cfg.tools.enable_fs_write, false),
        enable_fs_edit: pick_bool_flag("JARVIS_ENABLE_FS_EDIT", cfg.tools.enable_fs_edit, false),
        enable_fs_patch: pick_bool_flag("JARVIS_ENABLE_FS_PATCH", cfg.tools.enable_fs_patch, false),
        enable_shell_exec: pick_bool_flag(
            "JARVIS_ENABLE_SHELL_EXEC",
            cfg.tools.enable_shell_exec,
            false,
        ),
        enable_git_read: pick_git_read_flag(cfg),
        enable_git_write: pick_bool_flag(
            "JARVIS_ENABLE_GIT_WRITE",
            cfg.tools.enable_git_write,
            false,
        ),
        shell_default_timeout_ms: std::env::var("JARVIS_SHELL_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .or(cfg.tools.shell_timeout_ms)
            .unwrap_or(defaults.shell_default_timeout_ms),
        http_max_bytes: std::env::var("JARVIS_HTTP_MAX_BYTES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults.http_max_bytes),
        fs_max_bytes: std::env::var("JARVIS_FS_MAX_BYTES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults.fs_max_bytes),
        shell_sandbox: pick_shell_sandbox(cfg),
        shell_limits: pick_shell_limits(),
        ..defaults
    }
}

pub(crate) fn default_jarvis_workspace_root() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".jarvis")
        .join("workspace")
}

fn ensure_default_workspace_root(path: PathBuf) -> PathBuf {
    if let Err(error) = std::fs::create_dir_all(&path) {
        warn!(
            error = %error,
            path = %path.display(),
            "default workspace directory could not be created"
        );
    }
    path
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Per-include body cap when injected into the system prompt
/// (P18). Anything larger gets truncated with a stable marker so
/// the model knows there's more behind it. Same value as
/// `harness_tools::memory::MAX_INDEX_BYTES` because that's also
/// the limit on the index file itself — keeps the prompt budget
/// predictable when both scopes pull from sizeable upstreams.
const INCLUDE_INJECT_MAX_BYTES: usize = 25 * 1024;

/// P16/P18: read one memory scope's MEMORY.md, append it as a
/// slot in the prompt, then walk its include directives and
/// append each upstream MEMORY.md as its own
/// `=== included from <label> ===` block.
///
/// - **Cycle-safe by construction**: depth=1 only.
/// - **Cross-scope dedup**: `seen` accumulates directive
///   wire-strings across workspace + user invocations, so a
///   `git+...` URL referenced by both scopes is injected only
///   once (whichever scope sees it first wins).
/// - **Body cap**: each upstream body is truncated to
///   [`INCLUDE_INJECT_MAX_BYTES`] before append, with a marker.
/// - **Failures are warn'd**, never propagated — a broken
///   include can't bring down startup.
///
/// Returns the (possibly mutated) builder + whether anything was
/// injected for this scope.
async fn inject_memory_with_includes(
    mut builder: harness_core::SystemPromptBuilder,
    label: &str,
    scope_tag: &str,
    root: &std::path::Path,
    cache_root: &std::path::Path,
    seen: &mut std::collections::HashSet<String>,
    ttl: Option<std::time::Duration>,
) -> (harness_core::SystemPromptBuilder, bool) {
    let body = match harness_tools::memory::read_index(root).await {
        Ok(Some(b)) if !b.trim().is_empty() => b,
        Ok(_) => return (builder, false),
        Err(e) => {
            warn!(error = %e, scope = scope_tag, path = %root.display(),
                  "failed to load memory index");
            return (builder, false);
        }
    };
    let block = format!("=== {label} ===\n{}", body.trim_end());
    info!(
        bytes = block.len(),
        scope = scope_tag,
        path = %root.display(),
        "loaded memory index"
    );
    builder = builder.append_runtime_inject(block);

    let directives = harness_tools::memory_include::parse_include_directives(&body);
    for d in directives {
        let key = d.as_wire();
        if !seen.insert(key.clone()) {
            info!(target = %d.label(), scope = scope_tag,
                  "include skipped (already injected from another scope)");
            continue;
        }
        // P18.3 — TTL-driven gentle refresh before resolve.
        // Skipped when no TTL is configured or the directive
        // isn't a git URL. Failures are logged inside the helper;
        // we keep the stale cache and continue.
        if let Some(ttl_dur) = ttl {
            let _ = harness_tools::memory_include::maybe_refresh_git_cache(
                &d, cache_root, ttl_dur,
            )
            .await;
        }
        let dir = match harness_tools::memory_include::resolve_include(&d, cache_root).await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, target = %d.label(),
                      "include resolution failed; skipping");
                continue;
            }
        };
        let path = dir.join("MEMORY.md");
        let upstream = match tokio::fs::read_to_string(&path).await {
            Ok(b) => b,
            Err(e) => {
                warn!(error = %e, target = %d.label(),
                      "include read failed; skipping");
                continue;
            }
        };
        let trimmed = upstream.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let capped = if trimmed.len() > INCLUDE_INJECT_MAX_BYTES {
            // Truncate at a UTF-8 char boundary, then append a
            // stable marker so the byte count of the marker
            // doesn't shift the cache key.
            let mut cut = INCLUDE_INJECT_MAX_BYTES;
            while cut > 0 && !trimmed.is_char_boundary(cut) {
                cut -= 1;
            }
            let mut s = trimmed[..cut].to_string();
            s.push_str(
                "\n\n[... include body truncated to fit system-prompt budget ...]",
            );
            s
        } else {
            trimmed.to_string()
        };
        let inc_block = format!("=== included from {} ===\n{}", d.label(), capped);
        info!(
            bytes = inc_block.len(),
            target = %d.label(),
            truncated = trimmed.len() > INCLUDE_INJECT_MAX_BYTES,
            "loaded include"
        );
        builder = builder.append_runtime_inject(inc_block);
    }
    (builder, true)
}

/// Resolve where user-scope memory (P9) should live.
/// Order: explicit env var > `~`. Empty env value disables the
/// scope. Returns `None` when the home directory can't be resolved
/// and no override is set — user-scope writes will then error
/// cleanly via the tool's "user-scope not configured" message.
fn resolve_memory_user_root() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("JARVIS_MEMORY_USER_ROOT") {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            // Explicitly disabled.
            return None;
        }
        return Some(PathBuf::from(trimmed));
    }
    home_dir().map(|h| h.join(".jarvis"))
}

/// Read `JARVIS_SHELL_LIMITS=safe` to opt into the
/// 60s/2GB/256fd/256proc preset, or set individual env vars
/// (`JARVIS_SHELL_CPU_SECS`, `JARVIS_SHELL_AS_BYTES`,
/// `JARVIS_SHELL_NOFILE`, `JARVIS_SHELL_NPROC`) for finer grain.
/// Unset = no caps (current behaviour).
fn pick_shell_limits() -> ShellLimits {
    let mut limits = match std::env::var("JARVIS_SHELL_LIMITS").as_deref() {
        Ok("safe") | Ok("default") => ShellLimits::safe_defaults(),
        _ => ShellLimits::default(),
    };
    if let Some(v) = read_env_u64("JARVIS_SHELL_CPU_SECS") {
        limits.cpu_seconds = Some(v);
    }
    if let Some(v) = read_env_u64("JARVIS_SHELL_AS_BYTES") {
        limits.address_space_bytes = Some(v);
    }
    if let Some(v) = read_env_u64("JARVIS_SHELL_NOFILE") {
        limits.max_open_files = Some(v);
    }
    if let Some(v) = read_env_u64("JARVIS_SHELL_NPROC") {
        limits.max_processes = Some(v);
    }
    limits
}

fn read_env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|s| s.parse().ok())
}

/// Resolve `JARVIS_SHELL_SANDBOX` (env > config > default `none`) into a
/// concrete [`Sandbox`]. `JARVIS_SHELL_NETWORK` (`0`/default off, any
/// other value on) controls whether the chosen backend exposes the
/// host network. Unknown sandbox values fall through to `None` with a
/// `warn!`.
fn pick_shell_sandbox(cfg: &Config) -> Sandbox {
    let mode = pick_string_opt("JARVIS_SHELL_SANDBOX", cfg.tools.shell_sandbox.as_deref())
        .unwrap_or_else(|| "none".to_string());
    let allow_network = std::env::var("JARVIS_SHELL_NETWORK")
        .ok()
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false);
    match mode.to_ascii_lowercase().as_str() {
        "none" => Sandbox::None,
        "auto" => Sandbox::Auto { allow_network },
        "bubblewrap" | "bwrap" => Sandbox::Bubblewrap { allow_network },
        "sandbox-exec" | "sandbox_exec" | "macos" => Sandbox::SandboxExec { allow_network },
        other => {
            tracing::warn!(
                value = other,
                "JARVIS_SHELL_SANDBOX value unrecognised; falling back to `none`"
            );
            Sandbox::None
        }
    }
}

/// What a provider construction yields. The registry consumes
/// `provider` + `model` + `models` to route requests; `kind`
/// records the canonical profile so `/v1/model-catalog` and the
/// settings UI can correlate with [`harness_llm::ProfileRegistry`].
pub(crate) struct BuiltProvider {
    pub provider: Arc<dyn harness_core::LlmProvider>,
    pub model: String,
    /// Canonical kind (e.g. `"moonshot"` for both `kimi` and
    /// `moonshot` config entries) — keys into [`ProfileRegistry::get`].
    pub kind: String,
    /// Static capability snapshots for the user-advertised model
    /// list. Models without an entry in the profile catalog are
    /// silently dropped (the picker falls back to "unknown").
    pub capabilities: Vec<ModelCapability>,
}

async fn build_provider(
    name: &str,
    model_override: Option<String>,
    cfg: &Config,
) -> Result<BuiltProvider> {
    let section = cfg.provider(name);
    let kind_raw = name;
    let kind = canonical_kind(kind_raw);

    // The Kimi-Code provider needs a custom `reqwest::Client`
    // (User-Agent gating on the `kimi.com/coding/v1` endpoint),
    // which the profile registry can't model directly. Stay as a
    // one-off arm — every other transport flows through the
    // profile dispatch below.
    if kind == "kimi-code" {
        return build_kimi_code(name, model_override, &section);
    }

    let profile = ProfileRegistry::get(kind).ok_or_else(|| {
        anyhow::anyhow!(
            "provider kind=`{kind}` is not recognised. Known kinds: {}. \
             Use one of these in your config's `kind` field, or pick a \
             matching map key (e.g. `\"openai\"`, `\"openrouter\"`, `\"kimi\"`).",
            ProfileRegistry::all()
                .iter()
                .map(|p| p.kind)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;

    let mut built = match profile.transport {
        ProviderTransport::OpenAiChatCompletions => {
            build_openai_compat(name, profile, model_override, &section)?
        }
        ProviderTransport::OpenAiResponses => {
            build_responses(name, profile, model_override, &section, cfg)?
        }
        ProviderTransport::AnthropicMessages => {
            build_anthropic(name, profile, model_override, &section)?
        }
        ProviderTransport::GoogleGenerateContent => {
            build_google(name, profile, model_override, &section)?
        }
    };
    // Wrap with capability validation so requests against
    // unsupported model/tool combinations surface a clear error
    // before reaching the upstream API. The wrapper is transparent
    // for models not in the catalog and for compatible requests.
    if !built.capabilities.is_empty() {
        built.provider = Arc::new(CapabilityValidatingProvider::new(
            built.provider.clone(),
            built.capabilities.clone(),
        ));
    }
    Ok(built)
}

/// Resolve an API key for the given entry, walking the profile's
/// `api_key_env` list in order and then falling back to the
/// auth-store entry keyed by `entry_name`. Returns a clear error
/// pointing at `jarvis init` / `jarvis login` if nothing is
/// configured.
fn resolve_api_key_for_profile(entry_name: &str, profile: &ProviderProfile) -> Result<String> {
    for env in profile.api_key_env {
        if let Ok(v) = std::env::var(env) {
            if !v.is_empty() {
                return Ok(v);
            }
        }
    }
    if let Ok(Some(v)) = auth_store::load_api_key(entry_name) {
        return Ok(v);
    }
    let env_list = if profile.api_key_env.is_empty() {
        "(none — pass --provider config or use auth file)".to_string()
    } else {
        profile.api_key_env.join(" / ")
    };
    anyhow::bail!(
        "no {env_list} env var or auth file for provider=`{entry_name}` (kind=`{kind}`). \
         Run `jarvis init` (or `jarvis login --provider {entry_name}`) to set one.",
        kind = profile.kind,
    )
}

/// Resolve an API key for an "auth-optional" provider (Ollama,
/// LM Studio). Falls back to a sentinel string when nothing is
/// configured — the upstream endpoint either ignores it or
/// echoes it without checking.
fn resolve_optional_api_key(entry_name: &str, profile: &ProviderProfile, fallback: &str) -> String {
    for env in profile.api_key_env {
        if let Ok(v) = std::env::var(env) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    auth_store::load_api_key(entry_name)
        .ok()
        .flatten()
        .unwrap_or_else(|| fallback.to_string())
}

fn capabilities_for(profile: &ProviderProfile, advertised: &[String]) -> Vec<ModelCapability> {
    profile
        .model_catalog
        .iter()
        .filter(|c| advertised.iter().any(|m| m == &c.model))
        .cloned()
        .collect()
}

fn advertised_models(default_model: &str, section: &crate::config::ProviderConfig) -> Vec<String> {
    let mut out: Vec<String> = vec![default_model.to_string()];
    for m in &section.models {
        if !out.contains(m) {
            out.push(m.clone());
        }
    }
    out
}

fn build_openai_compat(
    name: &str,
    profile: &ProviderProfile,
    model_override: Option<String>,
    section: &crate::config::ProviderConfig,
) -> Result<BuiltProvider> {
    let kind = profile.kind;
    // For the auth-less local providers (Ollama / LM Studio),
    // missing keys aren't fatal.
    let auth_optional = matches!(profile.auth, harness_llm::AuthKind::None);

    let api_key = if auth_optional {
        resolve_optional_api_key(name, profile, kind)
    } else {
        resolve_api_key_for_profile(name, profile)?
    };

    let model = model_override.unwrap_or_else(|| profile.default_model.to_string());

    // Pick the per-kind primary base-url env var when the user
    // hasn't named one in config. Keeps backwards compat with all
    // the historical env vars (OPENAI_BASE_URL, KIMI_BASE_URL,
    // OLLAMA_BASE_URL, etc.) without hard-coding them in the
    // provider arms.
    let base_url = base_url_for_kind(kind, section.base_url.as_deref())
        .or_else(|| profile.default_base_url.map(str::to_string));

    let mut oacfg = OpenAiConfig::new(api_key).with_default_model(&model);
    if let Some(base) = base_url {
        oacfg = oacfg.with_base_url(base);
    }
    // Moonshot requires `reasoning_content` to be a string
    // (not null) when forwarding tool calls. Apply only to the
    // Kimi/Moonshot kind so other OpenAI-compatible endpoints
    // don't accidentally send the field.
    if kind == "moonshot" {
        oacfg = oacfg.with_empty_reasoning_content_for_tool_calls(true);
    }
    // OpenAI's prompt cache key — historically global, applied to
    // both `openai` and `codex`. Other kinds shouldn't ride this
    // namespace.
    if kind == "openai" {
        if let Ok(key) = std::env::var("OPENAI_PROMPT_CACHE_KEY") {
            if !key.is_empty() {
                oacfg = oacfg.with_prompt_cache_key(key);
            }
        }
    }

    let advertised = advertised_models(&model, section);
    let capabilities = capabilities_for(profile, &advertised);
    Ok(BuiltProvider {
        provider: Arc::new(OpenAiProvider::new(oacfg)),
        model,
        kind: kind.to_string(),
        capabilities,
    })
}

fn build_anthropic(
    name: &str,
    profile: &ProviderProfile,
    model_override: Option<String>,
    section: &crate::config::ProviderConfig,
) -> Result<BuiltProvider> {
    let api_key = resolve_api_key_for_profile(name, profile)?;
    let model = model_override.unwrap_or_else(|| profile.default_model.to_string());
    let mut acfg = AnthropicConfig::new(api_key);
    if let Some(base) = pick_string_opt("ANTHROPIC_BASE_URL", section.base_url.as_deref())
        .or_else(|| profile.default_base_url.map(str::to_string))
    {
        acfg = acfg.with_base_url(base);
    }
    if let Some(version) = pick_string_opt("ANTHROPIC_VERSION", section.version.as_deref()) {
        acfg = acfg.with_anthropic_version(version);
    }
    let advertised = advertised_models(&model, section);
    let capabilities = capabilities_for(profile, &advertised);
    Ok(BuiltProvider {
        provider: Arc::new(AnthropicProvider::new(acfg)),
        model,
        kind: profile.kind.to_string(),
        capabilities,
    })
}

fn build_google(
    name: &str,
    profile: &ProviderProfile,
    model_override: Option<String>,
    section: &crate::config::ProviderConfig,
) -> Result<BuiltProvider> {
    let api_key = resolve_api_key_for_profile(name, profile)?;
    let model = model_override.unwrap_or_else(|| profile.default_model.to_string());
    let mut gcfg = GoogleConfig::new(api_key);
    if let Some(base) = pick_string_opt("GOOGLE_BASE_URL", section.base_url.as_deref())
        .or_else(|| profile.default_base_url.map(str::to_string))
    {
        gcfg = gcfg.with_base_url(base);
    }
    let advertised = advertised_models(&model, section);
    let capabilities = capabilities_for(profile, &advertised);
    Ok(BuiltProvider {
        provider: Arc::new(GoogleProvider::new(gcfg)),
        model,
        kind: profile.kind.to_string(),
        capabilities,
    })
}

fn build_responses(
    name: &str,
    profile: &ProviderProfile,
    model_override: Option<String>,
    section: &crate::config::ProviderConfig,
    cfg: &Config,
) -> Result<BuiltProvider> {
    let kind = profile.kind;
    let model = model_override.unwrap_or_else(|| profile.default_model.to_string());

    let mut rcfg = match profile.auth {
        harness_llm::AuthKind::CodexOAuth => {
            // Auth source priority for codex:
            //   1. CODEX_ACCESS_TOKEN env var (dev backdoor —
            //      static, no refresh)
            //   2. <jarvis-config>/auth/codex.json (`jarvis login`)
            //   3. $CODEX_HOME/auth.json (Codex CLI compat)
            let auth = if let Ok(token) = std::env::var("CODEX_ACCESS_TOKEN") {
                let account = std::env::var("CODEX_ACCOUNT_ID").ok();
                CodexAuth::from_static(token, account)
            } else if let Some(jarvis_path) = jarvis_codex_auth_path() {
                if jarvis_path.is_file() {
                    CodexAuth::load_from_file(&jarvis_path)
                        .map_err(|e| anyhow::anyhow!("codex auth load failed: {e}"))?
                } else {
                    load_codex_from_cli_home(cfg)?
                }
            } else {
                load_codex_from_cli_home(cfg)?
            };
            ResponsesConfig::codex(auth).with_default_model(&model)
        }
        _ => {
            let api_key = resolve_api_key_for_profile(name, profile)?;
            ResponsesConfig::openai_responses(api_key).with_default_model(&model)
        }
    };

    // Per-kind env vars and config field names: codex uses CODEX_*
    // / `path` / `originator`; openai-responses uses OPENAI_*.
    let (env_base, env_summary, env_effort, env_encrypted, env_tier) = match kind {
        "codex" => (
            "CODEX_BASE_URL",
            "CODEX_REASONING_SUMMARY",
            "CODEX_REASONING_EFFORT",
            "CODEX_INCLUDE_ENCRYPTED_REASONING",
            "CODEX_SERVICE_TIER",
        ),
        _ => (
            "OPENAI_BASE_URL",
            "OPENAI_REASONING_SUMMARY",
            "OPENAI_REASONING_EFFORT",
            "OPENAI_INCLUDE_ENCRYPTED_REASONING",
            "OPENAI_SERVICE_TIER",
        ),
    };

    if let Some(base) = pick_string_opt(env_base, section.base_url.as_deref())
        .or_else(|| profile.default_base_url.map(str::to_string))
    {
        rcfg = rcfg.with_base_url(base);
    }
    if kind == "codex" {
        if let Some(path) = pick_string_opt("CODEX_RESPONSES_PATH", section.path.as_deref()) {
            rcfg = rcfg.with_path(path);
        }
        if let Some(originator) = pick_string_opt("CODEX_ORIGINATOR", section.originator.as_deref())
        {
            rcfg = rcfg.with_originator(originator);
        }
    }
    if let Some(summary) = pick_string_opt(env_summary, section.reasoning_summary.as_deref()) {
        rcfg = rcfg.with_reasoning_summary(summary);
    }
    if let Some(effort) = pick_string_opt(env_effort, section.reasoning_effort.as_deref()) {
        rcfg = rcfg.with_reasoning_effort(effort);
    }
    if pick_bool_flag(env_encrypted, section.include_encrypted_reasoning, false) {
        rcfg = rcfg.with_encrypted_reasoning(true);
    }
    if let Some(tier) = pick_string_opt(env_tier, section.service_tier.as_deref()) {
        rcfg = rcfg.with_service_tier(tier);
    }
    // Both flavours share the OpenAI prompt-cache namespace.
    if let Ok(key) = std::env::var("OPENAI_PROMPT_CACHE_KEY") {
        if !key.is_empty() {
            rcfg = rcfg.with_prompt_cache_key(key);
        }
    }

    let provider = ResponsesProvider::new(rcfg);
    if kind == "codex" {
        info!(
            endpoint = %provider.endpoint(),
            "codex provider enabled (subject to ChatGPT Terms of Service)",
        );
    } else {
        info!(endpoint = %provider.endpoint(), "openai responses provider enabled");
    }

    let advertised = advertised_models(&model, section);
    let capabilities = capabilities_for(profile, &advertised);
    Ok(BuiltProvider {
        provider: Arc::new(provider),
        model,
        kind: kind.to_string(),
        capabilities,
    })
}

fn build_kimi_code(
    name: &str,
    model_override: Option<String>,
    section: &crate::config::ProviderConfig,
) -> Result<BuiltProvider> {
    // Kimi Code (`api.kimi.com/coding/v1`) is the subscription /
    // flat-rate sibling of the Moonshot platform. Same OpenAI-Chat-
    // Completions wire shape but a different account system, key
    // prefix (`sk-kimi-…`), and a single canonical model id
    // (`kimi-for-coding`, marketed as Kimi-k2.6).
    //
    // Critically, the endpoint also gates by `User-Agent` — only
    // known coding agents (`claude-code/...`, `KimiCLI/...`, etc.)
    // are accepted. Without spoofing an allowed UA, the API returns
    // `403 access_terminated_error: Kimi For Coding is currently
    // only available for Coding Agents`. The custom `reqwest::Client`
    // is what makes this kind not fit the profile dispatch.
    let api_key = std::env::var("KIMI_CODE_API_KEY")
        .ok()
        .or_else(|| auth_store::load_api_key("kimi-code").ok().flatten())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no KIMI_CODE_API_KEY env var or auth file for provider=kimi-code. \
                 Run `jarvis login --provider kimi-code` to paste your \
                 kimi.com subscription key."
            )
        })?;
    let model = model_override.unwrap_or_else(|| "kimi-for-coding".to_string());
    let base = pick_string_opt("KIMI_CODE_BASE_URL", section.base_url.as_deref())
        .unwrap_or_else(|| "https://api.kimi.com/coding/v1".to_string());
    let user_agent =
        std::env::var("KIMI_CODE_USER_AGENT").unwrap_or_else(|_| "claude-code/0.1.0".to_string());
    let http = reqwest::Client::builder()
        .user_agent(user_agent)
        .build()
        .context("build http client for kimi-code")?;
    let oacfg = OpenAiConfig::new(api_key)
        .with_base_url(base)
        .with_empty_reasoning_content_for_tool_calls(true)
        .with_default_model(&model);
    let _ = name; // kept for symmetry with profile-driven builders
    Ok(BuiltProvider {
        provider: Arc::new(OpenAiProvider::with_client(oacfg, http)),
        model,
        kind: "kimi-code".to_string(),
        // No static catalog entry for kimi-code today — capability
        // is "single model, supports tools" implicitly.
        capabilities: Vec::new(),
    })
}

/// Per-kind override env-var names for the wire base URL. Keeps
/// existing operator habits (`KIMI_BASE_URL=…`, `OLLAMA_BASE_URL=…`)
/// working without hardcoding them in the provider arm.
fn base_url_for_kind(kind: &str, file: Option<&str>) -> Option<String> {
    match kind {
        "openai" => pick_string_opt("OPENAI_BASE_URL", file),
        "openrouter" => pick_string_opt("OPENROUTER_BASE_URL", file),
        "moonshot" => pick_string_opt("KIMI_BASE_URL", file),
        "ollama" => pick_string_opt("OLLAMA_BASE_URL", file),
        "lmstudio" => pick_string_opt("LMSTUDIO_BASE_URL", file),
        "nvidia-nim" => pick_string_opt("NIM_BASE_URL", file),
        "nous" => pick_string_opt("NOUS_BASE_URL", file),
        "minimax" => pick_string_opt("MINIMAX_BASE_URL", file),
        "mimo" => pick_string_opt("MIMO_BASE_URL", file),
        "huggingface" => pick_string_opt("HF_BASE_URL", file),
        // Fallthrough: only the config field, no env override.
        _ => file.map(str::to_string),
    }
}

/// Snapshot every constructed provider keyed by name and pair it with
/// a route policy lookup. The returned closure resolves the requested
/// slot on every call: if the slot's target points at a configured
/// provider in the snapshot, it returns `Some((llm, model))`; on any
/// miss (slot unset, target's provider not configured), it returns
/// `None` so callers fall through to their default. Returns `None`
/// outright when the policy has nothing for this slot, so callers
/// don't pay for an empty closure on every compaction.
fn build_route_resolver_for_slot(
    slot: harness_server::RouteSlot,
    primary_name: &str,
    primary_built: &BuiltProvider,
    extras: &[(String, BuiltProvider, Vec<String>)],
    policy: &harness_server::ModelRoutePolicy,
) -> Option<Arc<harness_memory::LlmRouteResolver>> {
    // Cheap pre-flight: if the slot has no configured target (and
    // `default` is also unset), the resolver would always return
    // `None` — skip building it.
    policy.target_for(slot)?;
    use std::collections::HashMap;
    let mut providers: HashMap<String, Arc<dyn harness_core::LlmProvider>> = HashMap::new();
    providers.insert(primary_name.to_string(), primary_built.provider.clone());
    for (name, built, _) in extras {
        providers.insert(name.clone(), built.provider.clone());
    }
    let policy = policy.clone();
    Some(Arc::new(move || {
        let target = policy.target_for(slot)?;
        let llm = providers.get(&target.provider)?.clone();
        Some((llm, target.model.clone()))
    }))
}

fn build_memory(
    cfg: &Config,
    llm: &Arc<dyn harness_core::LlmProvider>,
    active_model: &str,
    store: Option<&Arc<dyn harness_core::ConversationStore>>,
    route_resolver: Option<Arc<harness_memory::LlmRouteResolver>>,
) -> Result<Option<MemoryBundle>> {
    let budget = std::env::var("JARVIS_MEMORY_TOKENS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .or(cfg.memory.tokens);
    let Some(budget) = budget else {
        return Ok(None);
    };
    let mode = pick_string_opt("JARVIS_MEMORY_MODE", cfg.memory.mode.as_deref())
        .unwrap_or_else(|| "window".to_string());
    // Use the provider's tokeniser-backed estimator so the budget
    // reflects what the model actually counts. Cheap to ask once per
    // memory backend; the estimator is `Arc`-shared internally.
    let estimator = llm.estimator();
    let stats: Option<Arc<dyn harness_core::MemoryStatsProvider>>;
    let mem: Arc<dyn Memory> = match mode.as_str() {
        "summary" => {
            let summary_model = pick_string_opt("JARVIS_MEMORY_MODEL", cfg.memory.model.as_deref())
                .unwrap_or_else(|| active_model.to_string());
            let mut sm = SummarizingMemory::new(llm.clone(), &summary_model, budget)
                .with_estimator(estimator.clone());
            let persisted = store.is_some();
            if let Some(s) = store {
                sm = sm.with_persistence(s.clone());
            }
            // Route override only matters for summary mode — sliding
            // window doesn't call the LLM at all. Wired here so the
            // operator's `[routing] summarization = "kimi/kimi-k2"`
            // entry actually swaps the summariser's target.
            let routed = route_resolver.is_some();
            if let Some(r) = route_resolver {
                sm = sm.with_route_resolver(r);
            }
            info!(
                memory_tokens = budget,
                summary_model = %summary_model,
                persisted,
                routed,
                "summarising memory enabled",
            );
            // P8: expose the backend's compaction counters so the
            // diagnostics endpoint can render them. SlidingWindow
            // has no LLM-driven state worth tracking; its branch
            // below leaves `stats` as `None`.
            stats = Some(sm.counters() as Arc<dyn harness_core::MemoryStatsProvider>);
            Arc::new(sm)
        }
        "window" => {
            info!(memory_tokens = budget, "sliding-window memory enabled");
            let sw = SlidingWindowMemory::new(budget).with_estimator(estimator);
            // Expose the lightweight (compactions_total / window_dropped)
            // counters so `/v1/diagnostics/memory` returns something other
            // than 503 on the default `mode=window` deployment.
            stats = Some(sw.counters() as Arc<dyn harness_core::MemoryStatsProvider>);
            Arc::new(sw)
        }
        other => {
            anyhow::bail!("memory.mode=`{other}` is not recognised; use `window` or `summary`");
        }
    };
    Ok(Some(MemoryBundle { memory: mem, stats }))
}

/// Memory backend + the optional telemetry handle the diagnostics
/// surface needs. Wrapper struct so `build_memory` can return both
/// without the caller needing to branch on memory mode.
pub struct MemoryBundle {
    pub memory: Arc<dyn Memory>,
    pub stats: Option<Arc<dyn harness_core::MemoryStatsProvider>>,
}

/// Build the global [`Approver`] attached to the agent's
/// `AgentConfig`. Recognises both the new `JARVIS_PERMISSION_MODE`
/// (preferred — same env that drives [`pick_permission_mode`]) and
/// the legacy `JARVIS_APPROVAL_MODE` (kept for back-compat, no
/// second warn here since [`pick_permission_mode`] already logged
/// it). Mapping:
///
/// | env value             | source       | Approver       |
/// |-----------------------|--------------|----------------|
/// | `auto` / `bypass` / `accept-edits` | PERMISSION_MODE | `AlwaysApprove` |
/// | `plan`                | PERMISSION_MODE | `AlwaysDeny`    |
/// | `ask`                 | PERMISSION_MODE | `None` (per-tool gate via rule engine) |
/// | `auto`                | APPROVAL_MODE   | `AlwaysApprove` |
/// | `deny`                | APPROVAL_MODE   | `AlwaysDeny`    |
///
/// The per-socket WS transport overrides whichever Approver this
/// installs — see `/v1/chat/ws` notes in CLAUDE.md.
fn build_approver(cfg: &Config) -> Result<Option<Arc<dyn Approver>>> {
    if let Ok(mode) = std::env::var("JARVIS_PERMISSION_MODE") {
        let approver: Option<Arc<dyn Approver>> = match mode.as_str() {
            "auto" | "bypass" | "accept-edits" => Some(Arc::new(AlwaysApprove)),
            "plan" => Some(Arc::new(AlwaysDeny)),
            "ask" => None,
            _ => None,
        };
        if approver.is_some() {
            info!(permission_mode = %mode, "approval gate enabled");
        }
        return Ok(approver);
    }
    let mode = pick_string_opt("JARVIS_APPROVAL_MODE", cfg.approval.mode.as_deref());
    let Some(mode) = mode else {
        return Ok(None);
    };
    let approver: Arc<dyn Approver> = match mode.as_str() {
        "auto" => Arc::new(AlwaysApprove),
        "deny" => Arc::new(AlwaysDeny),
        other => anyhow::bail!("approval.mode=`{other}` is not recognised; use `auto` or `deny`"),
    };
    info!(approval_mode = %mode, "approval gate enabled");
    Ok(Some(approver))
}

/// Resolve the user-config dir (`~/.config/jarvis`) — used for the
/// per-user permission rules file. Falls back to `None` if HOME is
/// unset (tests, weird containers); the binary then runs with a
/// session-only store.
fn dirs_user_config() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(custom).join("jarvis"));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| anyhow::anyhow!("HOME / USERPROFILE not set"))?;
    Ok(home.join(".config").join("jarvis"))
}

/// Resolve the user-data dir (`~/.local/share/jarvis`) — backs the
/// default JSON-file conversation/project/TODO store. Honours
/// `XDG_DATA_HOME` first so XDG-compliant setups land in the right
/// place. Returns an error if no home directory can be resolved
/// (rare — tests, locked-down containers).
pub(crate) fn dirs_user_data() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(custom).join("jarvis"));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| anyhow::anyhow!("HOME / USERPROFILE not set"))?;
    Ok(home.join(".local").join("share").join("jarvis"))
}

/// Default persistence URL when neither `JARVIS_DB_URL` nor
/// `[persistence].url` is set. Returns `json:///<data-dir>/conversations`
/// — `harness-store` creates the directory on first write. `None`
/// only when [`dirs_user_data`] can't resolve a home dir.
pub(crate) fn default_json_persistence_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("conversations");
    // Three slashes makes it a proper file URI (`json:///abs/path`).
    Some(format!("json://{}", dir.display()))
}

fn default_json_observability_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("observability");
    Some(format!("json://{}", dir.display()))
}

/// Resolve the observability `runs/` retention cap from
/// `JARVIS_OBSERVABILITY_MAX_RUNS`. Returns the value to hand to
/// [`harness_store::connect_observability_capped`]:
/// - unset → `Some(DEFAULT_MAX_OBSERVED_RUNS)` (bounded by default so
///   the store stops leaking one file per tool call),
/// - `0` / `off` / `unlimited` → `None` (pruning disabled),
/// - a positive integer → `Some(n)`,
/// - anything unparseable → the default, with a WARN.
fn observability_max_runs() -> Option<usize> {
    match std::env::var("JARVIS_OBSERVABILITY_MAX_RUNS") {
        Err(_) => Some(harness_store::DEFAULT_MAX_OBSERVED_RUNS),
        Ok(raw) => {
            let v = raw.trim();
            if v.eq_ignore_ascii_case("off")
                || v.eq_ignore_ascii_case("unlimited")
                || v == "0"
            {
                return None;
            }
            match v.parse::<usize>() {
                Ok(n) => Some(n),
                Err(_) => {
                    warn!(
                        value = %raw,
                        "JARVIS_OBSERVABILITY_MAX_RUNS not a non-negative integer; using default cap"
                    );
                    Some(harness_store::DEFAULT_MAX_OBSERVED_RUNS)
                }
            }
        }
    }
}

/// Resolve the Memory store retention cap from `JARVIS_MEMORY_MAX_ITEMS`.
/// Same shape as [`observability_max_runs`]:
/// - unset → `Some(DEFAULT_MAX_MEMORY_ITEMS)` (bounded by default so the
///   auto-loop's per-failure gotcha writes can't leak unbounded files),
/// - `0` / `off` / `unlimited` → `None` (pruning disabled),
/// - a positive integer → `Some(n)`,
/// - anything unparseable → the default, with a WARN.
fn memory_max_items() -> Option<usize> {
    match std::env::var("JARVIS_MEMORY_MAX_ITEMS") {
        Err(_) => Some(harness_store::DEFAULT_MAX_MEMORY_ITEMS),
        Ok(raw) => {
            let v = raw.trim();
            if v.eq_ignore_ascii_case("off") || v.eq_ignore_ascii_case("unlimited") || v == "0" {
                return None;
            }
            match v.parse::<usize>() {
                Ok(n) => Some(n),
                Err(_) => {
                    warn!(
                        value = %raw,
                        "JARVIS_MEMORY_MAX_ITEMS not a non-negative integer; using default cap"
                    );
                    Some(harness_store::DEFAULT_MAX_MEMORY_ITEMS)
                }
            }
        }
    }
}

/// Resolve the skill-usage `events/` retention cap from
/// `JARVIS_LEARNING_MAX_EVENTS`. Returns the value to hand to
/// [`harness_store::connect_skill_usage_capped`]:
/// - unset → `Some(DEFAULT_MAX_SKILL_USAGE_EVENTS)` (bounded by default so
///   the store stops leaking one file per skill `Listed`/`Viewed`/`Used`),
/// - `0` / `off` / `unlimited` → `None` (pruning disabled),
/// - a positive integer → `Some(n)`,
/// - anything unparseable → the default, with a WARN.
fn learning_max_events() -> Option<usize> {
    match std::env::var("JARVIS_LEARNING_MAX_EVENTS") {
        Err(_) => Some(harness_store::DEFAULT_MAX_SKILL_USAGE_EVENTS),
        Ok(raw) => {
            let v = raw.trim();
            if v.eq_ignore_ascii_case("off") || v.eq_ignore_ascii_case("unlimited") || v == "0" {
                return None;
            }
            match v.parse::<usize>() {
                Ok(n) => Some(n),
                Err(_) => {
                    warn!(
                        value = %raw,
                        "JARVIS_LEARNING_MAX_EVENTS not a non-negative integer; using default cap"
                    );
                    Some(harness_store::DEFAULT_MAX_SKILL_USAGE_EVENTS)
                }
            }
        }
    }
}

fn default_json_eval_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("evals");
    Some(format!("json://{}", dir.display()))
}

fn default_json_learning_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("learning");
    Some(format!("json://{}", dir.display()))
}

fn default_json_memory_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("memories");
    Some(format!("json://{}", dir.display()))
}

/// Resolve the boot-time permission mode. Order:
/// 1. `--permission-mode` CLI flag
/// 2. `JARVIS_PERMISSION_MODE` env
/// 3. legacy `JARVIS_APPROVAL_MODE` env (deprecated; mapped + warned)
/// 4. `[approval].mode` from config
/// 5. `Ask` (default)
///
/// Bypass mode requires `--dangerously-skip-permissions`. Bypass +
/// network-listening requires `--bypass-on-network` too — the binary
/// refuses to start otherwise.
fn pick_permission_mode(cfg: &Config, args: &crate::ServeArgs) -> Result<PermissionMode> {
    let raw = args
        .permission_mode
        .clone()
        .or_else(|| std::env::var("JARVIS_PERMISSION_MODE").ok())
        .or_else(|| {
            std::env::var("JARVIS_APPROVAL_MODE").ok().map(|m| {
                tracing::warn!(
                    legacy_value = %m,
                    "JARVIS_APPROVAL_MODE is deprecated; use --permission-mode / JARVIS_PERMISSION_MODE",
                );
                m
            })
        })
        .or_else(|| cfg.approval.mode.clone());

    let mode = match raw.as_deref() {
        None => PermissionMode::Ask,
        Some(s) => PermissionMode::parse(s)
            .ok_or_else(|| anyhow::anyhow!("permission_mode=`{s}` is not recognised; use ask / accept-edits / plan / auto / bypass"))?,
    };

    if matches!(mode, PermissionMode::Bypass) {
        if !args.dangerously_skip_permissions {
            anyhow::bail!(
                "permission_mode=bypass requires --dangerously-skip-permissions \
                 (this mode disables the approval prompt and the rule engine; \
                 only use inside isolated sandboxes)"
            );
        }
        // Refuse bypass if listening on a non-loopback addr without
        // the explicit `--bypass-on-network`. Loopback (127.0.0.1, ::1)
        // is fine because only the local user can reach the socket.
        let addr_str = pick_string(
            args.addr.as_deref(),
            "JARVIS_ADDR",
            cfg.server.addr.as_deref(),
            "0.0.0.0:7001",
        );
        let on_network = !addr_str.starts_with("127.")
            && !addr_str.starts_with("[::1]")
            && !addr_str.starts_with("localhost:");
        if on_network && !args.bypass_on_network {
            anyhow::bail!(
                "permission_mode=bypass + --addr {addr_str} requires --bypass-on-network \
                 (refuses to expose a no-prompt agent on a non-loopback address by default)"
            );
        }
    }
    Ok(mode)
}

/// Build the full set of MCP client configs from `[mcp_servers]`
/// in the config file, merged with the `JARVIS_MCP_SERVERS` env var
/// (comma-separated `prefix=command [args...]` entries — legacy
/// stdio-only). Env entries override file entries with the same
/// prefix.
fn mcp_client_configs(cfg: &Config) -> Result<Vec<McpClientConfig>> {
    use crate::config::McpServerEntry;
    use std::collections::BTreeMap as Map;

    let mut configs: Map<String, McpClientConfig> = Map::new();

    for (prefix, entry) in &cfg.mcp_servers {
        let cfg_entry = match entry {
            McpServerEntry::Legacy(cmdline) => parse_legacy_cmdline(prefix, cmdline)?,
            McpServerEntry::Full(spec) => spec_to_client_config(prefix, spec)?,
        };
        configs.insert(prefix.clone(), cfg_entry);
    }

    if let Ok(env_spec) = std::env::var("JARVIS_MCP_SERVERS") {
        for entry in env_spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let Some((prefix, cmd)) = entry.split_once('=') else {
                continue;
            };
            let prefix = prefix.trim().to_string();
            let parsed = parse_legacy_cmdline(&prefix, cmd.trim())?;
            configs.insert(prefix, parsed);
        }
    }

    Ok(configs.into_values().collect())
}

fn parse_legacy_cmdline(prefix: &str, cmdline: &str) -> Result<McpClientConfig> {
    let mut parts = cmdline.split_whitespace();
    let command = parts
        .next()
        .with_context(|| format!("mcp server `{prefix}` has no command"))?
        .to_string();
    let args: Vec<String> = parts.map(str::to_string).collect();
    Ok(McpClientConfig::new(prefix, command, args))
}

fn spec_to_client_config(
    prefix: &str,
    spec: &crate::config::McpServerSpec,
) -> Result<McpClientConfig> {
    let transport = match &spec.transport {
        Some(t) => t.clone(),
        None => {
            let command = spec
                .command
                .clone()
                .with_context(|| format!("mcp server `{prefix}` needs `transport` or `command`"))?;
            McpTransport::Stdio {
                command,
                args: spec.args.clone(),
                env: spec.env.clone(),
            }
        }
    };
    Ok(McpClientConfig {
        prefix: prefix.to_string(),
        transport,
        allow_tools: spec.allow_tools.clone(),
        deny_tools: spec.deny_tools.clone(),
        alias: spec.alias.clone(),
        enabled: spec.enabled.unwrap_or(true),
    })
}

// ---------- pick helpers ----------
//
// Resolution order is `flag > env > file > default`. The helpers
// take pre-resolved flag values (already an `Option<&str>` from
// clap) plus the env var name and the file value, and pick the
// first that's set.

/// Default chat-mode prompt — short, persona-only, no operational
/// guidance. Used when no mutation tool is enabled and the user
/// hasn't set their own prompt.
const GENERAL_SYSTEM_PROMPT: &str = "You are Jarvis, a concise and capable assistant. \
When you need a human decision, missing information, or a choice among acceptable options, \
use ask.text instead of guessing.";

/// Coding-agent system prompt — used automatically when any of
/// `fs.edit`, `fs.write`, or `shell.exec` is enabled (signal: the
/// operator deliberately handed Jarvis the keys to mutate the
/// workspace). Mirrors the contract spelled out in
/// `docs/proposals/aicoding-agent.md` so the model knows to inspect
/// before editing, prefer small reviewable patches, run focused
/// checks, and end with a change report.
const CODING_SYSTEM_PROMPT: &str =
    "You are Jarvis, a coding agent working in the user's repository. \
\
Reuse what you already gathered. Before calling any tool, scan earlier turns of THIS \
conversation: if a recent tool result already answers the user's current question \
(workspace.context, todo.list, requirement.list, triage.scan_candidates, fs.read of \
the same path, code.grep of the same pattern, etc.), refer back to it instead of \
re-running the tool. Re-running orientation tools on every user turn wastes the \
user's tokens and dilutes your own attention. Only re-run when you have a specific \
reason to believe the underlying state changed (a write happened, the user said the \
file changed, enough turns have passed that staleness matters). \
\
If you don't already have the workspace layout in this conversation, call workspace.context \
once to orient yourself, and inspect git status before editing. \
Do not overwrite user changes you did not make. \
Prefer code.grep, fs.read, fs.list, git.status, and git.diff before reaching for shell.exec. \
When you need a human decision, missing information, or a choice among acceptable options, \
use ask.text instead of guessing. \
Use fs.edit (uniqueness-checked single replace) or fs.patch (unified-diff multi-hunk) for small \
reviewable edits; reach for fs.write only to create new files. \
When you run checks (tests, lints, builds), keep them focused on the change rather than the \
whole repo. \
Once per conversation (not per turn), call todo.list to see persistent project follow-ups; \
record new follow-ups via todo.add (not plan.update — that's for the current turn only) \
and mark them completed/blocked as you go. \
If your previous turn asked a yes/no question about a specific entity (\"标记为 Done?\", \
\"删除这个 Requirement?\", \"重新跑这次验证?\", etc.) and the user replies in the affirmative \
(\"yes\", \"可以\", \"go ahead\", \"行\", \"OK\"), treat that as authorization to act on **that exact \
entity** — its id is already in your earlier tool results. Do not re-enumerate via project.list / \
requirement.list to \"re-confirm\"; that turns a one-click confirmation into a multi-tool round-trip. \
If the user asks about project progress or 'what's still pending', use project.list to find a \
roadmap project for the current workspace (look for tags including \"roadmap\" — the slug usually \
ends in `-roadmap`), then requirement.list and group by status. If no such project exists and \
roadmap.import is available, suggest running it to bootstrap one from docs/proposals/ or \
ROADMAP.md. \
If the user invokes `/goal` or describes a long-running coding objective, act as the session/project \
coordinator: orient in the workspace, maintain durable TODOs / Requirements when those tools are \
available, and delegate focused implementation slices to subagent.codex when a fresh coding context \
would help. Keep the main conversation responsible for sequencing, approvals, blockers, review, and \
the final status report. \
\
Spec → Project workflow: when the user describes new work — either inline (\"add a user-avatar \
upload\") or by pointing at a doc (\"read docs/feature-x.md and lay out the work\") — drive the \
following sequence: \
(1) make sure you have the workspace context (call workspace.context only if you don't already have \
it from earlier in this conversation), and fs.read any doc the user named; \
(2) call plan.update with the proposed breakdown (titles only) and let the user confirm or edit; \
(3) once confirmed, resolve the project (project.list / project.get; project.create only if it \
genuinely does not exist), then call requirement.create per item — populate `verification_plan.commands` \
with focused checks (`cargo test -p <crate>`, `npm test --prefix <pkg>`, etc.) and pass \
`triage_state=approved` when the user explicitly accepted that exact list; \
(4) for follow-ups you discover while running other work, call requirement.create without overriding \
triage_state — they default to proposed_by_agent and wait in the Triage queue for the user. \
Do not bulk-create requirements without first showing the breakdown via plan.update. \
\
End every coding turn with a short report: which files changed, which checks ran, which checks \
were skipped and why, and any residual risk you couldn't verify.";

/// Should we auto-load `AGENTS.md` / `JARVIS.md` / `CLAUDE.md`,
/// `.jarvis/JARVIS.md`, and `.jarvis/rules/*.md`
/// from the workspace and append to the system prompt? Defaults to
/// `true` because that's what every coding-agent the user has
/// likely tried (Claude Code, Cursor, Codex, …) does. Opt out via
/// `JARVIS_NO_PROJECT_CONTEXT=1` or
/// `[agent].include_project_context = false`.
fn include_project_context(cfg: &Config) -> bool {
    if std::env::var_os("JARVIS_NO_PROJECT_CONTEXT").is_some() {
        return false;
    }
    cfg.agent.include_project_context.unwrap_or(true)
}

/// Cap on the total bytes of project context appended to the system
/// prompt. Defaults to 8 KiB — large enough for realistic AGENTS.md /
/// CLAUDE.md / .jarvis/rules files, but tight enough that the system
/// prompt doesn't drown out mid-conversation tool results in the
/// model's attention window. Override with `JARVIS_PROJECT_CONTEXT_BYTES`
/// or `[agent].project_context_max_bytes` when you have larger
/// instruction files you genuinely want to inline. The previous default
/// (32 KiB) regularly produced 30-KiB system blocks that pushed prior
/// tool output too deep for the model to reuse.
fn project_context_max_bytes(cfg: &Config) -> usize {
    std::env::var("JARVIS_PROJECT_CONTEXT_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .or(cfg.agent.project_context_max_bytes)
        .unwrap_or(8 * 1024)
}

/// Resolve the file-based project memory switch. `Some(true)` means
/// create/load the memory dir; `Some(false)` means disabled; `None`
/// means auto-load only when the dir already exists.
fn project_memory_enabled_setting(cfg: &Config) -> Option<bool> {
    if std::env::var_os("JARVIS_NO_PROJECT_MEMORY").is_some() {
        return Some(false);
    }
    if std::env::var_os("JARVIS_ENABLE_PROJECT_MEMORY").is_some() {
        return Some(true);
    }
    cfg.memory.project_enabled
}

fn project_memory_dir(cfg: &Config) -> PathBuf {
    std::env::var("JARVIS_PROJECT_MEMORY_DIR")
        .ok()
        .or_else(|| cfg.memory.project_dir.clone())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(harness_tools::workspace::PROJECT_MEMORY_DIR))
}

fn project_memory_max_bytes(cfg: &Config) -> usize {
    std::env::var("JARVIS_PROJECT_MEMORY_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .or(cfg.memory.project_max_bytes)
        .unwrap_or(harness_tools::workspace::PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES)
}

fn include_project_memory(
    workspace_root: &std::path::Path,
    memory_dir: &std::path::Path,
    setting: Option<bool>,
) -> bool {
    match setting {
        Some(v) => v,
        None => {
            let dir = if memory_dir.is_absolute() {
                memory_dir.to_path_buf()
            } else {
                workspace_root.join(memory_dir)
            };
            dir.is_dir()
        }
    }
}

/// Pick the agent's system prompt. Order: explicit
/// `[agent].system_prompt` from config (verbatim) > coding prompt
/// when `coding_mode && coding_prompt_auto != Some(false)` >
/// general prompt.
fn pick_system_prompt(cfg: &Config, coding_mode: bool) -> String {
    if let Some(custom) = cfg.agent.system_prompt.as_deref() {
        return custom.to_string();
    }
    let auto = cfg.agent.coding_prompt_auto.unwrap_or(true);
    if coding_mode && auto {
        CODING_SYSTEM_PROMPT.to_string()
    } else {
        GENERAL_SYSTEM_PROMPT.to_string()
    }
}

fn pick_string(flag: Option<&str>, env_var: &str, file: Option<&str>, default: &str) -> String {
    flag.map(str::to_string)
        .or_else(|| std::env::var(env_var).ok())
        .or_else(|| file.map(str::to_string))
        .unwrap_or_else(|| default.to_string())
}

/// Build the [`ModelRoutePolicy`] from the `[routing]` config block,
/// applying env-var overrides per slot. Each env var is the slash
/// form `<provider>/<model>`. Unparseable values fall through with a
/// WARN — the config either misses a slot, the slot stays empty, and
/// the caller falls back to its primary provider.
/// Build the optional smart-routing wrapper from `JARVIS_ROUTER_*` env.
///
/// Returns `None` — no wrapping, behaviour identical to today — unless
/// `JARVIS_ROUTER_ENABLED` is truthy. Tier targets come from
/// `JARVIS_ROUTER_TIER_{SIMPLE,MEDIUM,COMPLEX,REASONING}` in
/// `<provider>/<model>` form; any unset/typo'd tier falls through to the
/// primary `(provider, model)`. `providers` is delegated to by name, and
/// `fallback` (the primary) backs both unknown-provider targets and the
/// token estimator. This is the P0 wiring — a zero-cost heuristic
/// classifier; the LLM judge slots in behind the same call later.
fn build_smart_router(
    default_provider: &str,
    default_model: &str,
    fallback: Arc<dyn LlmProvider>,
    providers: std::collections::HashMap<String, Arc<dyn LlmProvider>>,
) -> Option<Arc<dyn LlmProvider>> {
    let enabled = std::env::var("JARVIS_ROUTER_ENABLED")
        .ok()
        .map(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(false);
    if !enabled {
        return None;
    }
    let mut config = harness_router::RouterConfig::new(harness_router::ModelRef::new(
        default_provider,
        default_model,
    ));
    let tiers = [
        ("JARVIS_ROUTER_TIER_SIMPLE", harness_router::Tier::Simple),
        ("JARVIS_ROUTER_TIER_MEDIUM", harness_router::Tier::Medium),
        ("JARVIS_ROUTER_TIER_COMPLEX", harness_router::Tier::Complex),
        ("JARVIS_ROUTER_TIER_REASONING", harness_router::Tier::Reasoning),
    ];
    for (env_name, tier) in tiers {
        let Some(raw) = std::env::var(env_name).ok().filter(|s| !s.is_empty()) else {
            continue;
        };
        match harness_router::ModelRef::parse(&raw) {
            Some(target) => config = config.with_tier(tier, target),
            None => warn!(
                env = env_name,
                value = %raw,
                "ignoring router tier — expected `<provider>/<model>` slash form",
            ),
        }
    }
    info!(
        tiers = config.tiers.len(),
        default = %format!("{default_provider}/{default_model}"),
        "smart router enabled (heuristic classifier) — primary provider auto-tiers by task difficulty",
    );
    let classifier = Arc::new(harness_router::HeuristicClassifier::default());
    Some(Arc::new(harness_router::RoutingProvider::new(
        fallback, providers, config, classifier,
    )))
}

fn build_route_policy(cfg: &Config) -> ModelRoutePolicy {
    fn parse_slot(env_name: &str, file_value: Option<&str>) -> Option<ModelTarget> {
        let raw = pick_string_opt(env_name, file_value)?;
        match ModelTarget::parse(&raw) {
            Some(t) => Some(t),
            None => {
                warn!(
                    env = env_name,
                    value = %raw,
                    "ignoring routing slot — expected `<provider>/<model>` slash form",
                );
                None
            }
        }
    }
    let r = &cfg.routing;
    ModelRoutePolicy {
        default: parse_slot("JARVIS_ROUTE_DEFAULT", r.default.as_deref()),
        coding: parse_slot("JARVIS_ROUTE_CODING", r.coding.as_deref()),
        review: parse_slot("JARVIS_ROUTE_REVIEW", r.review.as_deref()),
        summarization: parse_slot(
            "JARVIS_ROUTE_SUMMARIZATION",
            r.summarization.as_deref(),
        ),
        doc_reader: parse_slot("JARVIS_ROUTE_DOC_READER", r.doc_reader.as_deref()),
        vision: parse_slot("JARVIS_ROUTE_VISION", r.vision.as_deref()),
        local_private: parse_slot("JARVIS_ROUTE_LOCAL_PRIVATE", r.local_private.as_deref()),
        fallbacks: r
            .fallbacks
            .iter()
            .filter_map(|s| match ModelTarget::parse(s) {
                Some(t) => Some(t),
                None => {
                    warn!(value = %s, "ignoring fallback target — expected `<provider>/<model>` slash form");
                    None
                }
            })
            .collect(),
    }
}

/// One-line summary of which slots are populated, for the startup
/// log. Avoids leaking the full policy when the operator's config
/// is large.
fn route_policy_summary(p: &ModelRoutePolicy) -> String {
    let mut filled: Vec<&'static str> = Vec::new();
    if p.default.is_some() {
        filled.push("default");
    }
    if p.coding.is_some() {
        filled.push("coding");
    }
    if p.review.is_some() {
        filled.push("review");
    }
    if p.summarization.is_some() {
        filled.push("summarization");
    }
    if p.doc_reader.is_some() {
        filled.push("doc_reader");
    }
    if p.vision.is_some() {
        filled.push("vision");
    }
    if p.local_private.is_some() {
        filled.push("local_private");
    }
    let mut out = filled.join(",");
    if !p.fallbacks.is_empty() {
        if !out.is_empty() {
            out.push(';');
        }
        out.push_str(&format!("fallbacks={}", p.fallbacks.len()));
    }
    out
}

fn pick_string_opt(env_var: &str, file: Option<&str>) -> Option<String> {
    std::env::var(env_var)
        .ok()
        .or_else(|| file.map(str::to_string))
}

fn pick_path(
    env_var: &str,
    file: Option<&std::path::Path>,
    default: impl FnOnce() -> PathBuf,
) -> PathBuf {
    if let Ok(s) = std::env::var(env_var) {
        return PathBuf::from(s);
    }
    if let Some(p) = file {
        return p.to_path_buf();
    }
    default()
}

/// Boolean flags where "env var present" = true. The config file
/// stores an explicit `Option<bool>`; if the env var isn't set we
/// fall through to the file value, then the default.
fn pick_bool_flag(env_var: &str, file: Option<bool>, default: bool) -> bool {
    if std::env::var_os(env_var).is_some() {
        return true;
    }
    file.unwrap_or(default)
}

/// `git.*` is the only "default-on" toolset; the env knob and config field
/// both *disable* rather than *enable* it. Env wins over config; config
/// wins over the built-in default of `true`.
fn pick_git_read_flag(cfg: &Config) -> bool {
    if std::env::var_os("JARVIS_DISABLE_GIT_READ").is_some() {
        return false;
    }
    cfg.tools.enable_git_read.unwrap_or(true)
}

/// Resolve `<jarvis-config>/auth/codex.json` if we can derive a
/// config home. `None` means "no HOME / APPDATA" (rare in practice).
fn jarvis_codex_auth_path() -> Option<PathBuf> {
    auth_store::auth_path("codex").ok()
}

/// Fallback to `$CODEX_HOME/auth.json` (the file the OpenAI Codex
/// CLI writes). Used when `jarvis login` hasn't been run but the
/// user has authed via the Codex CLI.
fn load_codex_from_cli_home(cfg: &Config) -> Result<CodexAuth> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| cfg.provider("codex").home.clone())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
        .context("can't locate CODEX_HOME or HOME for codex auth")?;
    CodexAuth::load_from_codex_home(&codex_home).map_err(|e| {
        anyhow::anyhow!(
            "codex auth load failed: {e}\n\
             Run `jarvis login --provider codex` to authenticate (or `codex login` \
             from the OpenAI Codex CLI; or set CODEX_ACCESS_TOKEN for dev)."
        )
    })
}
