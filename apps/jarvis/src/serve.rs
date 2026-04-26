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

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use harness_core::{
    AgentConfig, AlwaysApprove, AlwaysDeny, Approver, Memory, ToolRegistry,
};
use harness_llm::{
    AnthropicConfig, AnthropicProvider, CodexAuth, GoogleConfig, GoogleProvider, OpenAiConfig,
    OpenAiProvider, ResponsesConfig, ResponsesProvider,
};
use harness_mcp::{connect_all_mcp, serve_registry_stdio, McpClientConfig};
use harness_memory::{SlidingWindowMemory, SummarizingMemory};
use harness_server::{serve, AppState, ProviderRegistry};
use harness_tools::{register_builtins, BuiltinsConfig, Sandbox, ShellLimits};
use tracing::info;

use crate::auth_store;
use crate::config::Config;
use crate::ServeArgs;

/// `jarvis serve` (default subcommand).
pub async fn run(cfg: Option<Config>, args: ServeArgs) -> Result<()> {
    let cfg = cfg.unwrap_or_default();

    let mut tools = ToolRegistry::new();
    register_builtins(&mut tools, builtins_config(&cfg));

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
    type Extra = (String, Arc<dyn harness_core::LlmProvider>, String, Vec<String>);
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

    // Optional: connect to external MCP servers.
    let mcp_specs = mcp_servers_spec(&cfg);
    let mcp_clients = if mcp_specs.is_empty() {
        Vec::new()
    } else {
        let configs = mcp_specs
            .into_iter()
            .map(|(prefix, cmdline)| parse_mcp_entry(&prefix, &cmdline))
            .collect::<Result<Vec<_>>>()?;
        connect_all_mcp(&configs, &mut tools).await?
    };
    info!(
        provider = %provider_name,
        model = %model,
        registered = tools.len(),
        mcp_servers = mcp_clients.len(),
        "tools registered",
    );

    // Optional persistence — opened up-front so `SummarizingMemory`
    // can also use it for cross-restart summary persistence.
    let store = match pick_string_opt("JARVIS_DB_URL", cfg.persistence.url.as_deref()) {
        Some(url) => {
            let s = harness_store::connect(&url)
                .await
                .with_context(|| format!("opening db url `{url}`"))?;
            info!(url = %url, "conversation store connected");
            Some(s)
        }
        None => None,
    };

    let mut agent_cfg = AgentConfig::new(model.clone())
        .with_system_prompt("You are Jarvis, a concise and capable assistant.")
        .with_tools(tools)
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

    let mut state = AppState::from_registry(registry, agent_cfg);
    if let Some(s) = store {
        state = state.with_store(s);
    }

    let addr_str = pick_string(
        args.addr.as_deref(),
        "JARVIS_ADDR",
        cfg.server.addr.as_deref(),
        "0.0.0.0:7001",
    );
    let addr: SocketAddr = addr_str
        .parse()
        .with_context(|| format!("invalid bind address `{addr_str}`"))?;
    info!(%addr, "jarvis listening");
    serve(addr, state).await?;

    drop(mcp_clients);
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

// ---------- builders ----------

fn builtins_config(cfg: &Config) -> BuiltinsConfig {
    let defaults = BuiltinsConfig::default();
    BuiltinsConfig {
        fs_root: pick_path("JARVIS_FS_ROOT", cfg.tools.fs_root.as_deref(), || {
            PathBuf::from(".")
        }),
        enable_fs_write: pick_bool_flag(
            "JARVIS_ENABLE_FS_WRITE",
            cfg.tools.enable_fs_write,
            false,
        ),
        enable_fs_edit: pick_bool_flag(
            "JARVIS_ENABLE_FS_EDIT",
            cfg.tools.enable_fs_edit,
            false,
        ),
        enable_shell_exec: pick_bool_flag(
            "JARVIS_ENABLE_SHELL_EXEC",
            cfg.tools.enable_shell_exec,
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
    let mode = pick_string_opt(
        "JARVIS_SHELL_SANDBOX",
        cfg.tools.shell_sandbox.as_deref(),
    )
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
            let model =
                model_override.unwrap_or_else(|| "gpt-4o-mini".to_string());
            let mut oacfg = OpenAiConfig::new(api_key).with_default_model(&model);
            if let Some(base) = pick_string_opt("OPENAI_BASE_URL", section.base_url.as_deref()) {
                oacfg = oacfg.with_base_url(base);
            }
            Ok((Arc::new(OpenAiProvider::new(oacfg)), model))
        }
        "anthropic" => {
            let api_key = resolve_api_key("anthropic", "ANTHROPIC_API_KEY")?;
            let model =
                model_override.unwrap_or_else(|| "claude-3-5-sonnet-latest".to_string());
            let mut acfg = AnthropicConfig::new(api_key);
            if let Some(base) =
                pick_string_opt("ANTHROPIC_BASE_URL", section.base_url.as_deref())
            {
                acfg = acfg.with_base_url(base);
            }
            if let Some(version) =
                pick_string_opt("ANTHROPIC_VERSION", section.version.as_deref())
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
            let model =
                model_override.unwrap_or_else(|| "gemini-1.5-flash".to_string());
            let mut gcfg = GoogleConfig::new(api_key);
            if let Some(base) =
                pick_string_opt("GOOGLE_BASE_URL", section.base_url.as_deref())
            {
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
            if let Some(base) =
                pick_string_opt("CODEX_BASE_URL", section.base_url.as_deref())
            {
                rcfg = rcfg.with_base_url(base);
            }
            if let Some(path) =
                pick_string_opt("CODEX_RESPONSES_PATH", section.path.as_deref())
            {
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
            if let Some(tier) = pick_string_opt(
                "CODEX_SERVICE_TIER",
                section.service_tier.as_deref(),
            ) {
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
            if let Some(base) =
                pick_string_opt("OPENAI_BASE_URL", section.base_url.as_deref())
            {
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
            if let Some(tier) = pick_string_opt(
                "OPENAI_SERVICE_TIER",
                section.service_tier.as_deref(),
            ) {
                rcfg = rcfg.with_service_tier(tier);
            }
            let provider = ResponsesProvider::new(rcfg);
            info!(endpoint = %provider.endpoint(), "openai responses provider enabled");
            Ok((Arc::new(provider), model))
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
            let base =
                pick_string_opt("KIMI_CODE_BASE_URL", section.base_url.as_deref())
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
            Ok((
                Arc::new(OpenAiProvider::with_client(oacfg, http)),
                model,
            ))
        }
        other => anyhow::bail!(
            "provider=`{other}` is not recognised; \
             use openai, openai-responses, anthropic, google, codex, kimi, or kimi-code"
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
            anyhow::bail!(
                "memory.mode=`{other}` is not recognised; use `window` or `summary`"
            );
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
        other => anyhow::bail!(
            "approval.mode=`{other}` is not recognised; use `auto` or `deny`"
        ),
    };
    info!(approval_mode = %mode, "approval gate enabled");
    Ok(Some(approver))
}

/// Merge the env-var `JARVIS_MCP_SERVERS` (comma-separated
/// `prefix=command` entries) with the config-file `[mcp_servers]`
/// table. Env entries win on key conflicts.
fn mcp_servers_spec(cfg: &Config) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = cfg.mcp_servers.clone();
    if let Ok(spec) = std::env::var("JARVIS_MCP_SERVERS") {
        for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if let Some((prefix, cmd)) = entry.split_once('=') {
                merged.insert(prefix.trim().to_string(), cmd.trim().to_string());
            }
        }
    }
    merged
}

fn parse_mcp_entry(prefix: &str, cmdline: &str) -> Result<McpClientConfig> {
    let mut parts = cmdline.split_whitespace();
    let command = parts
        .next()
        .with_context(|| format!("mcp server `{prefix}` has no command"))?
        .to_string();
    let args = parts.map(str::to_string).collect();
    Ok(McpClientConfig::new(prefix, command, args))
}

// ---------- pick helpers ----------
//
// Resolution order is `flag > env > file > default`. The helpers
// take pre-resolved flag values (already an `Option<&str>` from
// clap) plus the env var name and the file value, and pick the
// first that's set.

fn pick_string(
    flag: Option<&str>,
    env_var: &str,
    file: Option<&str>,
    default: &str,
) -> String {
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

fn pick_path(env_var: &str, file: Option<&std::path::Path>, default: impl FnOnce() -> PathBuf) -> PathBuf {
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
