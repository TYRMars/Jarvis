//! `jarvis serve` and `jarvis mcp-serve` implementations.
//!
//! All the wiring that was historically in `main.rs` lives here, just
//! parameterised on `(Config, ServeArgs)`. Resolution order is
//! `flag > env > config-file > built-in default`, applied per field
//! via the `pick_*` helpers.
//!
//! Backwards compatibility: when no config file is present and no new
//! flags are passed, behaviour is identical to the old env-var-only
//! surface — every `pick_*` helper falls through to the same default
//! the old code used.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use harness_core::{AgentConfig, AlwaysApprove, AlwaysDeny, Approver, Memory, ToolRegistry};
use harness_llm::{
    AnthropicConfig, AnthropicProvider, CodexAuth, GoogleConfig, GoogleProvider, OpenAiConfig,
    OpenAiProvider, ResponsesConfig, ResponsesProvider,
};
use harness_mcp::{
    serve_registry_stdio, McpClientConfig, McpManager, McpTransport,
};
use harness_memory::{SlidingWindowMemory, SummarizingMemory};
use harness_server::{
    default_skill_roots, serve, AppState, PermissionMode, ProviderRegistry, ServerInfo,
};
use harness_plugin::PluginManager;
use harness_skill::SkillCatalog;
use harness_store::{default_workspaces_path, WorkspaceStore};
use harness_tools::{register_builtins, BuiltinsConfig, Sandbox, ShellLimits};
use tracing::info;

use crate::auth_store;
use crate::config::Config;
use crate::ServeArgs;

/// `jarvis serve` (default subcommand).
pub async fn run(cfg: Option<Config>, args: ServeArgs, config_path: Option<PathBuf>) -> Result<()> {
    let cfg = cfg.unwrap_or_default();

    let mut tools = ToolRegistry::new();
    let mut bcfg = builtins_config_with_workspace(&cfg, args.workspace.as_deref());
    let workspace_root = bcfg.fs_root.clone();
    let coding_mode = bcfg.enable_fs_write
        || bcfg.enable_fs_edit
        || bcfg.enable_fs_patch
        || bcfg.enable_shell_exec;

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
    ) = match persistence_url.as_deref() {
        Some(url) => {
            let bundle = harness_store::connect_all(url)
                .await
                .with_context(|| format!("opening persistence url `{url}`"))?;
            info!(
                url = %url,
                "conversation + project + todo + requirement + run + activity + agent_profile + doc store connected"
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
            )
        }
        None => {
            info!(
                "no persistence URL resolved (HOME unset?); running in-memory \
                 (conversations / TODOs / requirements / runs / activities / profiles / docs will not survive restart)"
            );
            (None, None, None, None, None, None, None, None)
        }
    };
    // `JARVIS_DISABLE_TODOS=1` opts out of the persistent TODO board
    // even when a DB is configured. Useful for shared deployments
    // that want todos managed elsewhere.
    let todos_disabled = std::env::var_os("JARVIS_DISABLE_TODOS").is_some();
    let active_todo_store = if todos_disabled { None } else { todo_store.clone() };
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

    register_builtins(&mut tools, bcfg);
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
    let (llm, model) = build_provider(&provider_name, model_override, &cfg).await?;

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
    type Extra = (
        String,
        Arc<dyn harness_core::LlmProvider>,
        String,
        Vec<String>,
    );
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
        let (extra_llm, extra_model) =
            build_provider(&name, extra_section.default_model.clone(), &cfg).await?;
        extras.push((name, extra_llm, extra_model, extra_section.models.clone()));
    }

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
    let registered = canonical_tools
        .read()
        .map(|r| r.len())
        .unwrap_or_default();
    info!(
        provider = %provider_name,
        model = %model,
        registered,
        mcp_servers = mcp_running.len(),
        "tools registered",
    );

    // Persistence (`store` / `project_store` / `todo_store`) was
    // opened earlier so the TODO store could flow into
    // `BuiltinsConfig`. The same handles are reused below — no
    // second connection.
    let mut system_prompt = pick_system_prompt(&cfg, coding_mode);
    let project_ctx_cap = project_context_max_bytes(&cfg);
    let mut project_context_loaded = false;
    if include_project_context(&cfg) {
        if let Some(extra) = harness_tools::workspace::load_instructions(
            &workspace_root,
            project_ctx_cap,
        ) {
            info!(
                bytes = extra.len(),
                "loaded project instructions (AGENTS.md / CLAUDE.md / AGENT.md)"
            );
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&extra);
            project_context_loaded = true;
        }
    }
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
        .with_max_iterations(30);
    if let Some(mem) = build_memory(&cfg, &llm, &model, store.as_ref())? {
        agent_cfg = agent_cfg.with_memory(mem);
    }
    if let Some(approver) = build_approver(&cfg)? {
        agent_cfg = agent_cfg.with_approver(approver);
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
    registry.insert_with_models(
        provider_name.clone(),
        llm,
        model.clone(),
        primary_section.models.clone(),
    );
    let mut active_models: Vec<String> = vec![format!("{provider_name}={model}")];
    for (name, extra_llm, extra_model, extra_models) in extras {
        active_models.push(format!("{name}={extra_model}"));
        registry.insert_with_models(name, extra_llm, extra_model, extra_models);
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
    let user_perm_path = dirs_user_config()
        .ok()
        .map(|d| d.join("permissions.json"));
    let project_perm_path = Some(workspace_root.join(".jarvis").join("permissions.json"));
    let permission_store: std::sync::Arc<dyn harness_server::PermissionStore> = match harness_store::JsonFilePermissionStore::open(
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
    let skill_roots = default_skill_roots(user_skills_dir, workspace_skills_dir);
    let mut catalog = SkillCatalog::new();
    catalog.merge_bundled(harness_skill::bundled_defaults());
    for (root, source) in skill_roots {
        catalog.merge_disk(&root, source);
    }
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
            Arc::new(PluginManager::new(tmp, Arc::clone(&skill_catalog), Arc::clone(&mcp_manager))
                .expect("fallback temp-dir plugin manager"))
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
        .with_plugins(Arc::clone(&plugin_manager))
        .with_workspaces(Arc::clone(&workspaces))
        .with_worktree_config(worktree_mode, worktree_root, worktree_allow_dirty);
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
    let memory_mode = if cfg.memory.tokens.is_some() || std::env::var("JARVIS_MEMORY_TOKENS").is_ok()
    {
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
        mcp_prefixes,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    state = state.with_server_info(server_info);
    info!(%addr, "jarvis listening");
    serve(addr, state).await?;

    drop(mcp_manager);
    Ok(())
}

/// `jarvis mcp-serve` — stdio MCP server. No LLM provider needed.
pub async fn run_mcp(cfg: Option<Config>) -> Result<()> {
    let cfg = cfg.unwrap_or_default();
    let mut tools = ToolRegistry::new();
    register_builtins(&mut tools, builtins_config(&cfg));
    info!(registered = tools.len(), "serving tools over mcp stdio");
    serve_registry_stdio(Arc::new(tools)).await?;
    Ok(())
}

/// `jarvis workspace` — print the resolved workspace root + git
/// state. Mirrors `GET /v1/workspace` so scripts and humans see the
/// same answer. Resolution mirrors `serve` exactly:
/// `--workspace > JARVIS_FS_ROOT > [tools].fs_root > .`.
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
/// order: CLI flag > `JARVIS_FS_ROOT` > `[tools].fs_root` > `.`.
fn builtins_config_with_workspace(
    cfg: &Config,
    workspace_override: Option<&std::path::Path>,
) -> BuiltinsConfig {
    let defaults = BuiltinsConfig::default();
    let fs_root = match workspace_override {
        Some(p) => p.to_path_buf(),
        None => pick_path("JARVIS_FS_ROOT", cfg.tools.fs_root.as_deref(), || {
            PathBuf::from(".")
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
        shell_sandbox: pick_shell_sandbox(cfg),
        shell_limits: pick_shell_limits(),
        ..defaults
    }
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

async fn build_provider(
    name: &str,
    model_override: Option<String>,
    cfg: &Config,
) -> Result<(Arc<dyn harness_core::LlmProvider>, String)> {
    let section = cfg.provider(name);
    match name {
        "openai" => {
            let api_key = resolve_api_key("openai", "OPENAI_API_KEY")?;
            let model = model_override.unwrap_or_else(|| "gpt-4o-mini".to_string());
            let mut oacfg = OpenAiConfig::new(api_key).with_default_model(&model);
            if let Some(base) = pick_string_opt("OPENAI_BASE_URL", section.base_url.as_deref()) {
                oacfg = oacfg.with_base_url(base);
            }
            Ok((Arc::new(OpenAiProvider::new(oacfg)), model))
        }
        "anthropic" => {
            let api_key = resolve_api_key("anthropic", "ANTHROPIC_API_KEY")?;
            let model = model_override.unwrap_or_else(|| "claude-3-5-sonnet-latest".to_string());
            let mut acfg = AnthropicConfig::new(api_key);
            if let Some(base) = pick_string_opt("ANTHROPIC_BASE_URL", section.base_url.as_deref()) {
                acfg = acfg.with_base_url(base);
            }
            if let Some(version) = pick_string_opt("ANTHROPIC_VERSION", section.version.as_deref())
            {
                acfg = acfg.with_anthropic_version(version);
            }
            Ok((Arc::new(AnthropicProvider::new(acfg)), model))
        }
        "google" => {
            // Google has two equivalent env-var names, plus the
            // auth-store entry. Try in order: GOOGLE_API_KEY,
            // GEMINI_API_KEY, auth file.
            let api_key = std::env::var("GOOGLE_API_KEY")
                .ok()
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .or_else(|| auth_store::load_api_key("google").ok().flatten())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no GOOGLE_API_KEY / GEMINI_API_KEY env var or auth file \
                         for provider=google. Run `jarvis init` or set the env var."
                    )
                })?;
            let model = model_override.unwrap_or_else(|| "gemini-1.5-flash".to_string());
            let mut gcfg = GoogleConfig::new(api_key);
            if let Some(base) = pick_string_opt("GOOGLE_BASE_URL", section.base_url.as_deref()) {
                gcfg = gcfg.with_base_url(base);
            }
            Ok((Arc::new(GoogleProvider::new(gcfg)), model))
        }
        "codex" => {
            // Auth source priority:
            //   1. CODEX_ACCESS_TOKEN env var (dev backdoor — static,
            //      no refresh)
            //   2. <jarvis-config>/auth/codex.json (the file
            //      `jarvis login --provider codex` writes; preferred
            //      because jarvis owns the lifecycle)
            //   3. $CODEX_HOME/auth.json (default ~/.codex/auth.json
            //      — falls back to the file the OpenAI Codex CLI
            //      writes, for users who already ran `codex login`)
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
            let model = model_override.unwrap_or_else(|| "gpt-5.4-mini".to_string());
            let mut rcfg = ResponsesConfig::codex(auth).with_default_model(&model);
            if let Some(base) = pick_string_opt("CODEX_BASE_URL", section.base_url.as_deref()) {
                rcfg = rcfg.with_base_url(base);
            }
            if let Some(path) = pick_string_opt("CODEX_RESPONSES_PATH", section.path.as_deref()) {
                rcfg = rcfg.with_path(path);
            }
            if let Some(originator) =
                pick_string_opt("CODEX_ORIGINATOR", section.originator.as_deref())
            {
                rcfg = rcfg.with_originator(originator);
            }
            if let Some(summary) = pick_string_opt(
                "CODEX_REASONING_SUMMARY",
                section.reasoning_summary.as_deref(),
            ) {
                rcfg = rcfg.with_reasoning_summary(summary);
            }
            if let Some(effort) = pick_string_opt(
                "CODEX_REASONING_EFFORT",
                section.reasoning_effort.as_deref(),
            ) {
                rcfg = rcfg.with_reasoning_effort(effort);
            }
            if pick_bool_flag(
                "CODEX_INCLUDE_ENCRYPTED_REASONING",
                section.include_encrypted_reasoning,
                false,
            ) {
                rcfg = rcfg.with_encrypted_reasoning(true);
            }
            if let Some(tier) =
                pick_string_opt("CODEX_SERVICE_TIER", section.service_tier.as_deref())
            {
                rcfg = rcfg.with_service_tier(tier);
            }
            let provider = ResponsesProvider::new(rcfg);
            info!(
                endpoint = %provider.endpoint(),
                "codex provider enabled (subject to ChatGPT Terms of Service)",
            );
            Ok((Arc::new(provider), model))
        }
        "openai-responses" => {
            // Same auth surface as `openai`; reuse the openai key
            // from env or auth file.
            let api_key = resolve_api_key("openai", "OPENAI_API_KEY")?;
            let model = model_override.unwrap_or_else(|| "gpt-4o-mini".to_string());
            let mut rcfg = ResponsesConfig::openai_responses(api_key).with_default_model(&model);
            if let Some(base) = pick_string_opt("OPENAI_BASE_URL", section.base_url.as_deref()) {
                rcfg = rcfg.with_base_url(base);
            }
            if let Some(summary) = pick_string_opt(
                "OPENAI_REASONING_SUMMARY",
                section.reasoning_summary.as_deref(),
            ) {
                rcfg = rcfg.with_reasoning_summary(summary);
            }
            if let Some(effort) = pick_string_opt(
                "OPENAI_REASONING_EFFORT",
                section.reasoning_effort.as_deref(),
            ) {
                rcfg = rcfg.with_reasoning_effort(effort);
            }
            if pick_bool_flag(
                "OPENAI_INCLUDE_ENCRYPTED_REASONING",
                section.include_encrypted_reasoning,
                false,
            ) {
                rcfg = rcfg.with_encrypted_reasoning(true);
            }
            if let Some(tier) =
                pick_string_opt("OPENAI_SERVICE_TIER", section.service_tier.as_deref())
            {
                rcfg = rcfg.with_service_tier(tier);
            }
            let provider = ResponsesProvider::new(rcfg);
            info!(endpoint = %provider.endpoint(), "openai responses provider enabled");
            Ok((Arc::new(provider), model))
        }
        "ollama" => {
            // Ollama exposes an OpenAI-compatible chat-completions
            // endpoint at `<base>/chat/completions` (default base
            // `http://localhost:11434/v1`). It ignores the
            // `Authorization` header entirely, so we send a dummy
            // bearer to satisfy reqwest's `bearer_auth` builder.
            //
            // No auth file or env var is *required*, but we still
            // honour `OLLAMA_API_KEY` (some hosted Ollama proxies
            // such as OpenWebUI sit behind a real API key) and the
            // jarvis auth-store entry, in that order.
            let api_key = std::env::var("OLLAMA_API_KEY")
                .ok()
                .or_else(|| auth_store::load_api_key("ollama").ok().flatten())
                .unwrap_or_else(|| "ollama".to_string());
            let model = model_override.unwrap_or_else(|| "llama3.2".to_string());
            let base = pick_string_opt("OLLAMA_BASE_URL", section.base_url.as_deref())
                .unwrap_or_else(|| "http://localhost:11434/v1".to_string());
            let oacfg = OpenAiConfig::new(api_key)
                .with_base_url(base)
                .with_default_model(&model);
            Ok((Arc::new(OpenAiProvider::new(oacfg)), model))
        }
        "kimi" | "moonshot" => {
            // Moonshot's Kimi platform (`api.moonshot.cn` /
            // `api.moonshot.ai`) is OpenAI-Chat-Completions
            // wire-compatible, so we reuse `OpenAiProvider` and just
            // point it at the Moonshot endpoint with a Kimi key.
            let api_key = std::env::var("KIMI_API_KEY")
                .ok()
                .or_else(|| std::env::var("MOONSHOT_API_KEY").ok())
                .or_else(|| auth_store::load_api_key("kimi").ok().flatten())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no KIMI_API_KEY / MOONSHOT_API_KEY env var or auth file \
                         for provider=kimi. Run `jarvis init` (or \
                         `jarvis login --provider kimi`) to set one."
                    )
                })?;
            let model = model_override.unwrap_or_else(|| "kimi-k2-thinking".to_string());
            let base = pick_string_opt("KIMI_BASE_URL", section.base_url.as_deref())
                .unwrap_or_else(|| "https://api.moonshot.cn/v1".to_string());
            let oacfg = OpenAiConfig::new(api_key)
                .with_base_url(base)
                .with_empty_reasoning_content_for_tool_calls(true)
                .with_default_model(&model);
            Ok((Arc::new(OpenAiProvider::new(oacfg)), model))
        }
        "kimi-code" => {
            // Kimi Code (`api.kimi.com/coding/v1`) is the
            // subscription / flat-rate sibling of the Moonshot
            // platform. Same OpenAI-Chat-Completions wire shape but
            // a different account system, key prefix (`sk-kimi-…`),
            // and a single canonical model id (`kimi-for-coding`,
            // marketed as Kimi-k2.6).
            //
            // Critically, the endpoint also gates by `User-Agent`
            // — only known coding agents (`claude-code/...`,
            // `KimiCLI/...`, etc.) are accepted. Without spoofing
            // an allowed UA, the API returns
            // `403 access_terminated_error: Kimi For Coding is
            // currently only available for Coding Agents`. We send
            // `claude-code/0.1.0` by default, overridable via
            // `KIMI_CODE_USER_AGENT` for forward-compat.
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
            let user_agent = std::env::var("KIMI_CODE_USER_AGENT")
                .unwrap_or_else(|_| "claude-code/0.1.0".to_string());
            let http = reqwest::Client::builder()
                .user_agent(user_agent)
                .build()
                .context("build http client for kimi-code")?;
            let oacfg = OpenAiConfig::new(api_key)
                .with_base_url(base)
                .with_empty_reasoning_content_for_tool_calls(true)
                .with_default_model(&model);
            Ok((Arc::new(OpenAiProvider::with_client(oacfg, http)), model))
        }
        other => anyhow::bail!(
            "provider=`{other}` is not recognised; \
             use openai, openai-responses, anthropic, google, codex, kimi, kimi-code, or ollama"
        ),
    }
}

fn build_memory(
    cfg: &Config,
    llm: &Arc<dyn harness_core::LlmProvider>,
    active_model: &str,
    store: Option<&Arc<dyn harness_core::ConversationStore>>,
) -> Result<Option<Arc<dyn Memory>>> {
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
            info!(
                memory_tokens = budget,
                summary_model = %summary_model,
                persisted,
                "summarising memory enabled",
            );
            Arc::new(sm)
        }
        "window" => {
            info!(memory_tokens = budget, "sliding-window memory enabled");
            Arc::new(SlidingWindowMemory::new(budget).with_estimator(estimator))
        }
        other => {
            anyhow::bail!("memory.mode=`{other}` is not recognised; use `window` or `summary`");
        }
    };
    Ok(Some(mem))
}

fn build_approver(cfg: &Config) -> Result<Option<Arc<dyn Approver>>> {
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
fn dirs_user_data() -> Result<PathBuf> {
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
fn default_json_persistence_url() -> Option<String> {
    let dir = dirs_user_data().ok()?.join("conversations");
    // Three slashes makes it a proper file URI (`json:///abs/path`).
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
Before editing, call workspace.context to orient yourself, then inspect git status. \
Do not overwrite user changes you did not make. \
Prefer code.grep, fs.read, fs.list, git.status, and git.diff before reaching for shell.exec. \
When you need a human decision, missing information, or a choice among acceptable options, \
use ask.text instead of guessing. \
Use fs.edit (uniqueness-checked single replace) or fs.patch (unified-diff multi-hunk) for small \
reviewable edits; reach for fs.write only to create new files. \
When you run checks (tests, lints, builds), keep them focused on the change rather than the \
whole repo. \
At the start of a fresh session, call todo.list to see persistent project follow-ups; \
record new follow-ups via todo.add (not plan.update — that's for the current turn only) \
and mark them completed/blocked as you go. \
End every coding turn with a short report: which files changed, which checks ran, which checks \
were skipped and why, and any residual risk you couldn't verify.";

/// Should we auto-load `AGENTS.md` / `CLAUDE.md` / `AGENT.md`
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
/// prompt. Defaults to 32 KiB — enough for any realistic AGENTS.md
/// / CLAUDE.md, far short of blowing a small-context model.
fn project_context_max_bytes(cfg: &Config) -> usize {
    std::env::var("JARVIS_PROJECT_CONTEXT_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .or(cfg.agent.project_context_max_bytes)
        .unwrap_or(32 * 1024)
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

/// Resolve a provider's bearer/API key with this priority order:
/// env var first, then the on-disk auth file written by `jarvis
/// init`. Returns a clear error pointing the operator at `jarvis
/// init` if neither is set. API keys deliberately are never read
/// from the TOML config file — secrets and preferences live in
/// different files.
fn resolve_api_key(provider: &str, env_var: &str) -> Result<String> {
    if let Ok(v) = std::env::var(env_var) {
        return Ok(v);
    }
    if let Some(v) = auth_store::load_api_key(provider).ok().flatten() {
        return Ok(v);
    }
    anyhow::bail!(
        "no {env_var} env var or auth file for provider=`{provider}`. \
         Run `jarvis init` (or `jarvis login --provider {provider}`) to set one, \
         or export {env_var}."
    )
}
