//! `jarvis status` — pretty-print the effective configuration.
//!
//! The point is to answer "what would `jarvis serve` do right now?"
//! without actually starting a server. We resolve config the same
//! way `serve` does (env > file > default), then list:
//!
//! - which config file (if any) was loaded
//! - which provider / model is active and where its endpoint is
//! - which auth source each provider would use (env / disk / Codex CLI / none)
//! - which tools are gated on, and the workspace root
//! - persistence, memory, approval mode
//! - external MCP servers
//!
//! No secrets are printed — API keys are shown as a length-redacted
//! marker, and Codex tokens are only acknowledged as "loaded".

use std::path::Path;

use anyhow::Result;

use crate::auth_store;
use crate::config::Config;

pub fn run(explicit: Option<&Path>) -> Result<()> {
    // Re-do config discovery so a `--config` flag passes through.
    let loaded = Config::discover(explicit)?;
    let (cfg_path, cfg) = match loaded {
        Some((p, c)) => (Some(p), c),
        None => (None, Config::default()),
    };

    println!("# jarvis status");
    println!();

    // ---- config file ----
    match cfg_path {
        Some(p) => println!("Config file:    {}", p.display()),
        None => println!("Config file:    (none — using env vars / built-in defaults)"),
    }
    println!();

    // ---- provider ----
    let provider = pick_string("JARVIS_PROVIDER", cfg.default_provider.as_deref(), "openai");
    let primary_section = cfg.provider(&provider);
    let model = pick_string_opt("JARVIS_MODEL", primary_section.default_model.as_deref())
        .unwrap_or_else(|| default_model_for(&provider).to_string());
    println!("Provider:       {provider} (default)");
    println!("  model:        {model}");
    println!("  endpoint:     {}", endpoint_hint(&provider, &cfg));
    let extras: Vec<String> = cfg
        .providers
        .iter()
        .filter(|(name, p)| p.enabled && name.as_str() != provider)
        .map(|(name, p)| {
            let m = p.default_model.as_deref().unwrap_or("?");
            format!("{name}={m}")
        })
        .collect();
    if !extras.is_empty() {
        println!("  also enabled: {}", extras.join(", "));
    }
    println!();

    // ---- auth ----
    println!("Auth:");
    for (id, env_var) in [
        ("openai", Some("OPENAI_API_KEY")),
        ("openai-responses", Some("OPENAI_API_KEY")),
        ("anthropic", Some("ANTHROPIC_API_KEY")),
        ("google", Some("GOOGLE_API_KEY")),
        ("codex", None),
        ("kimi", Some("KIMI_API_KEY")),
        ("kimi-code", Some("KIMI_CODE_API_KEY")),
        ("ollama", Some("OLLAMA_API_KEY")),
    ] {
        let active = id == provider;
        let marker = if active { "▸" } else { " " };
        let status_line = describe_auth(id, env_var, &cfg);
        println!("  {marker} {id:<18} {status_line}");
    }
    println!();

    // ---- tools ----
    let fs_root = pick_string_opt("JARVIS_FS_ROOT", cfg.tools.fs_root.as_deref().map(path_str))
        .unwrap_or_else(|| ".".to_string());
    let fs_write = pick_bool("JARVIS_ENABLE_FS_WRITE", cfg.tools.enable_fs_write);
    let fs_edit = pick_bool("JARVIS_ENABLE_FS_EDIT", cfg.tools.enable_fs_edit);
    let fs_patch = pick_bool("JARVIS_ENABLE_FS_PATCH", cfg.tools.enable_fs_patch);
    let shell = pick_bool("JARVIS_ENABLE_SHELL_EXEC", cfg.tools.enable_shell_exec);
    let git_disabled = std::env::var_os("JARVIS_DISABLE_GIT_READ").is_some()
        || cfg.tools.enable_git_read == Some(false);
    println!("Tools:");
    println!("  fs_root:      {fs_root}");
    println!("  workspace.context  always on");
    println!("  project.checks     always on");
    println!("  plan.update        always on");
    println!("  fs.read       always on");
    println!("  fs.list       always on");
    println!("  code.grep     always on");
    println!("  http.fetch    always on");
    println!("  git.*         {}", on_off(!git_disabled));
    println!("  fs.write      {}", on_off(fs_write));
    println!("  fs.edit       {}", on_off(fs_edit));
    println!("  fs.patch      {}", on_off(fs_patch));
    println!("  shell.exec    {}", on_off(shell));
    let mcp_count = mcp_count(&cfg);
    println!(
        "  external MCP: {}",
        if mcp_count == 0 {
            "(none)".to_string()
        } else {
            format!("{mcp_count} configured")
        }
    );
    println!();

    // ---- persistence ----
    match pick_string_opt("JARVIS_DB_URL", cfg.persistence.url.as_deref()) {
        Some(url) => println!("Persistence:    {url}"),
        None => println!("Persistence:    disabled (set JARVIS_DB_URL or [persistence].url)"),
    }
    println!();

    // ---- memory ----
    let mem_tokens = std::env::var("JARVIS_MEMORY_TOKENS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .or(cfg.memory.tokens);
    match mem_tokens {
        Some(t) => {
            let mode = pick_string_opt("JARVIS_MEMORY_MODE", cfg.memory.mode.as_deref())
                .unwrap_or_else(|| "window".to_string());
            println!("Memory:         {t} tokens ({mode})");
        }
        None => println!("Memory:         disabled"),
    }
    println!();

    // ---- approval ----
    match pick_string_opt("JARVIS_APPROVAL_MODE", cfg.approval.mode.as_deref()) {
        Some(mode) => println!("Approval:       {mode} (WS clients can override interactively)"),
        None => println!(
            "Approval:       not configured \
             (gated tools run unconditionally unless WS overrides)"
        ),
    }
    println!();

    // ---- server ----
    let addr = pick_string("JARVIS_ADDR", cfg.server.addr.as_deref(), "0.0.0.0:7001");
    println!("Server addr:    {addr}");

    Ok(())
}

fn describe_auth(provider: &str, env_var: Option<&str>, cfg: &Config) -> String {
    if provider == "codex" {
        // Auth source priority mirrors serve.rs:
        //   1. <jarvis-config>/auth/codex.json (`jarvis login`)
        //   2. $CODEX_HOME/auth.json (`codex login`)
        if let Ok(jarvis_path) = auth_store::auth_path("codex") {
            if jarvis_path.is_file() {
                return format!("✓ jarvis-owned: {} (loaded)", jarvis_path.display());
            }
        }
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| cfg.provider("codex").home.clone())
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".codex"))
            });
        match codex_home {
            Some(h) if h.join("auth.json").is_file() => {
                format!("✓ codex CLI: {} (loaded)", h.join("auth.json").display())
            }
            Some(h) => format!(
                "⚠ no auth.json at {} — run `jarvis login --provider codex`",
                h.display()
            ),
            None => "⚠ no CODEX_HOME or HOME set".into(),
        }
    } else if let Some(env_var) = env_var {
        if std::env::var_os(env_var).is_some() {
            return format!("✓ {} env var set", env_var);
        }
        // Ollama doesn't require a key — only some hosted proxies do.
        // Skip the "✗ no key" pessimism in the common local-server case.
        if provider == "ollama" {
            let disk = auth_store::load_api_key("ollama").ok().flatten();
            return match disk {
                Some(key) => format!("✓ disk: {}", redact(&key)),
                None => "○ no key (local server doesn't need one)".into(),
            };
        }
        // `openai-responses` reuses the same key as `openai` (same
        // `OPENAI_API_KEY`). Look up under both names so we don't
        // mislead the user about what would happen.
        let primary_key = auth_store::load_api_key(provider).ok().flatten();
        let aliased = if provider == "openai-responses" && primary_key.is_none() {
            auth_store::load_api_key("openai").ok().flatten()
        } else {
            None
        };
        match (primary_key, aliased) {
            (Some(key), _) => format!("✓ disk: {}", redact(&key)),
            (None, Some(key)) => format!("✓ disk via openai: {}", redact(&key)),
            (None, None) => format!("✗ no {} and no auth file", env_var),
        }
    } else {
        "—".into()
    }
}

fn endpoint_hint(provider: &str, cfg: &Config) -> String {
    let base = |env_var: &str, file: Option<&str>, default: &str| {
        std::env::var(env_var)
            .ok()
            .or_else(|| file.map(str::to_string))
            .unwrap_or_else(|| default.to_string())
    };
    let section = cfg.provider(provider);
    match provider {
        "openai" => format!(
            "{}/chat/completions",
            base(
                "OPENAI_BASE_URL",
                section.base_url.as_deref(),
                "https://api.openai.com/v1",
            )
        ),
        "openai-responses" => format!(
            "{}/responses",
            base(
                "OPENAI_BASE_URL",
                section.base_url.as_deref(),
                "https://api.openai.com/v1",
            )
        ),
        "anthropic" => format!(
            "{}/messages",
            base(
                "ANTHROPIC_BASE_URL",
                section.base_url.as_deref(),
                "https://api.anthropic.com/v1",
            )
        ),
        "google" => base(
            "GOOGLE_BASE_URL",
            section.base_url.as_deref(),
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        "codex" => {
            let base_url = base(
                "CODEX_BASE_URL",
                section.base_url.as_deref(),
                "https://chatgpt.com/backend-api",
            );
            let path = base(
                "CODEX_RESPONSES_PATH",
                section.path.as_deref(),
                "/codex/responses",
            );
            format!("{base_url}{path}")
        }
        "kimi" | "moonshot" => format!(
            "{}/chat/completions",
            base(
                "KIMI_BASE_URL",
                section.base_url.as_deref(),
                "https://api.moonshot.cn/v1",
            )
        ),
        "kimi-code" => format!(
            "{}/chat/completions",
            base(
                "KIMI_CODE_BASE_URL",
                section.base_url.as_deref(),
                "https://api.kimi.com/coding/v1",
            )
        ),
        "ollama" => format!(
            "{}/chat/completions",
            base(
                "OLLAMA_BASE_URL",
                section.base_url.as_deref(),
                "http://localhost:11434/v1",
            )
        ),
        other => format!("(unknown provider: {other})"),
    }
}

fn mcp_count(cfg: &Config) -> usize {
    let mut count = cfg.mcp_servers.len();
    if let Ok(spec) = std::env::var("JARVIS_MCP_SERVERS") {
        for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if let Some((prefix, _)) = entry.split_once('=') {
                // Env entries override file ones; if the prefix is in
                // both, only count once.
                if !cfg.mcp_servers.contains_key(prefix.trim()) {
                    count += 1;
                }
            }
        }
    }
    count
}

fn default_model_for(provider: &str) -> &'static str {
    match provider {
        "openai" | "openai-responses" => "gpt-4o-mini",
        "anthropic" => "claude-3-5-sonnet-latest",
        "google" => "gemini-1.5-flash",
        "codex" => "gpt-5-codex-mini",
        _ => "gpt-4o-mini",
    }
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap_or("<non-utf8>")
}

fn pick_string(env_var: &str, file: Option<&str>, default: &str) -> String {
    std::env::var(env_var)
        .ok()
        .or_else(|| file.map(str::to_string))
        .unwrap_or_else(|| default.to_string())
}

fn pick_string_opt(env_var: &str, file: Option<&str>) -> Option<String> {
    std::env::var(env_var)
        .ok()
        .or_else(|| file.map(str::to_string))
}

fn pick_bool(env_var: &str, file: Option<bool>) -> bool {
    if std::env::var_os(env_var).is_some() {
        return true;
    }
    file.unwrap_or(false)
}

fn on_off(b: bool) -> &'static str {
    if b {
        "✓ enabled"
    } else {
        "  disabled"
    }
}

fn redact(secret: &str) -> String {
    let len = secret.chars().count();
    if len <= 8 {
        return format!("({} chars)", len);
    }
    let prefix: String = secret.chars().take(3).collect();
    format!("{prefix}…({len} chars)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_short_string_hides_value() {
        let r = redact("sk-12");
        assert!(!r.contains("sk-12"), "got: {r}");
    }

    #[test]
    fn redact_long_string_keeps_only_prefix() {
        let r = redact("sk-aaaaaaaaaaaa");
        assert!(r.starts_with("sk-"), "got: {r}");
        assert!(!r.contains("aaaa"), "got: {r}");
    }

    #[test]
    fn endpoint_hint_for_codex_uses_overridable_base() {
        use crate::config::ProviderConfig;
        let mut cfg = Config::default();
        cfg.providers.insert(
            "codex".into(),
            ProviderConfig {
                enabled: true,
                base_url: Some("https://example.test/api".into()),
                path: Some("/v2/codex/responses".into()),
                ..ProviderConfig::default()
            },
        );
        let h = endpoint_hint("codex", &cfg);
        assert_eq!(h, "https://example.test/api/v2/codex/responses");
    }
}
