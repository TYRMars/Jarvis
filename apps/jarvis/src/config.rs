//! JSON config loader for the `jarvis` binary.
//!
//! Schema layout: a flat `default_provider` pointer plus a
//! `providers: { name -> ProviderConfig }` map. Each entry self-
//! describes whether it's `enabled`, what its `default_model` is,
//! and which `models` show up in pickers (CLI / web UI). Provider-
//! specific fields (`base_url`, `home`, `reasoning_effort`, …) live
//! flat on the same struct — they're documented per-provider but
//! the schema stays uniform so operators learn one shape.
//!
//! Resolution layers (highest priority first), unchanged:
//!
//! 1. command-line flags
//! 2. `JARVIS_*` environment variables
//! 3. config file (`--config <path>`, `$JARVIS_CONFIG`,
//!    `$JARVIS_CONFIG_HOME/config.json`,
//!    `$XDG_CONFIG_HOME/jarvis/config.json`,
//!    `~/.jarvis/config.json`,
//!    `~/.config/jarvis/config.json`)
//! 4. compiled-in defaults
//!
//! Files are JSON; the older TOML format is no longer read. Re-run
//! `jarvis init --force` to regenerate after upgrading.
//!
//! Every field is optional. An empty `{}` parses cleanly and lets
//! everything fall through to env / default.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Top-level config. Empty sections / `None` fields / empty maps
/// are skipped on serialise so a config produced by `jarvis init`
/// only contains what the user actually set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    #[serde(skip_serializing_if = "is_default")]
    pub server: ServerSection,
    /// Locale for user-facing messages. `"en"` (default) or `"zh"`.
    /// Picked once during `jarvis init`; the server reads this back
    /// for any UX it surfaces (today: nothing; future: web UI
    /// labels and CLI re-prompts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Which provider is "the default" — the one that handles
    /// requests with no explicit `provider` field, no
    /// `provider/model` slash form, and no model-prefix match.
    /// Must be a key in `providers` and must be `enabled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    /// Provider catalogue. Keyed by canonical name (`openai`,
    /// `kimi`, `codex`, …). All entries that are `enabled = true`
    /// get constructed at startup; their `models` arrays merge
    /// into the picker the web UI shows.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub providers: BTreeMap<String, ProviderConfig>,
    #[serde(skip_serializing_if = "is_default")]
    pub agent: AgentSection,
    #[serde(skip_serializing_if = "is_default")]
    pub tools: ToolsSection,
    #[serde(skip_serializing_if = "is_default")]
    pub memory: MemorySection,
    #[serde(skip_serializing_if = "is_default")]
    pub persistence: PersistenceSection,
    #[serde(skip_serializing_if = "is_default")]
    pub approval: ApprovalSection,
    /// External MCP servers. Two shapes are accepted per entry:
    ///
    /// - **Legacy string** — e.g. `"uvx mcp-server-filesystem /tmp"`.
    ///   Spawned over stdio with no filtering / aliasing. Same shape
    ///   the old config used; existing configs keep working.
    /// - **Structured spec** — `McpServerSpec` with explicit
    ///   `transport`, optional `allow_tools`, `deny_tools`, `alias`,
    ///   `enabled`. Lets configs target HTTP transports (when the
    ///   rmcp HTTP feature is enabled) and per-server filtering.
    #[serde(
        rename = "mcp_servers",
        alias = "mcp-servers",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub mcp_servers: BTreeMap<String, McpServerEntry>,
}

/// One MCP server entry as parsed from config. The map key is the
/// server's prefix; this enum captures the value shape.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum McpServerEntry {
    /// `"uvx mcp-server-x foo bar"` — first whitespace-separated
    /// token is the command, the rest are positional args. Stdio
    /// transport, no filtering, no aliasing.
    Legacy(String),
    /// Structured form with explicit transport + optional filters.
    Full(McpServerSpec),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct McpServerSpec {
    /// Transport details. `None` is treated as "stdio with the
    /// `command` / `args` flat fields below" so a tagged
    /// `transport` block is optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<harness_mcp::McpTransport>,
    /// Stdio shorthand (used when `transport` is omitted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Allowlist of remote tool names; absent = accept all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_tools: Option<Vec<String>>,
    /// Tool names to skip even if otherwise allowed.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deny_tools: Vec<String>,
    /// Per-tool rename: `remote_name -> local_short_name`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub alias: BTreeMap<String, String>,
    /// Defaults to `true` when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

fn is_default<T: Default + PartialEq>(t: &T) -> bool {
    *t == T::default()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerSection {
    /// e.g. `"127.0.0.1:7001"`. Maps to `JARVIS_ADDR`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentSection {
    /// Explicit override for the agent's system prompt. When set,
    /// this string is used verbatim and the auto coding-prompt
    /// pick is skipped. Use this when you want a fixed persona
    /// (e.g. `"You are a Rust mentor reviewing PRs"`) regardless
    /// of which tools are enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Whether to swap the default system prompt for a coding-aware
    /// one when any mutation tool (`fs.edit`, `fs.write`,
    /// `shell.exec`) is enabled. Defaults to `true`. Set to `false`
    /// to keep the simple "you are Jarvis" prompt even in coding
    /// mode. Ignored when `system_prompt` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding_prompt_auto: Option<bool>,
    /// Whether to auto-load `AGENTS.md` / `CLAUDE.md` / `AGENT.md`
    /// from the workspace root and append them to the system prompt.
    /// Defaults to `true` (the de-facto standard for coding agents).
    /// Env override: `JARVIS_NO_PROJECT_CONTEXT=1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_project_context: Option<bool>,
    /// Cap on combined size (bytes) of the auto-loaded project
    /// context. Defaults to 32 KiB. Env override:
    /// `JARVIS_PROJECT_CONTEXT_BYTES`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_context_max_bytes: Option<usize>,
}

/// Per-provider config. All fields optional; provider-specific
/// fields are flat (`base_url`, `home`, …) and ignored by
/// providers that don't use them. The doc comments below name
/// which provider consumes which field.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderConfig {
    /// `false` (default) means the provider isn't constructed at
    /// startup. Set to `true` for every provider you want to be
    /// reachable via routing — including the one named in
    /// `default_provider`.
    #[serde(skip_serializing_if = "is_false")]
    pub enabled: bool,
    /// Which model this provider reports as its default. The web
    /// UI treats this as the picker's pre-selected entry; the API
    /// uses it when a request hits this provider with no `model`
    /// field set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Curated list shown to the user (web UI / wizard). May
    /// include the `default_model` (it'll be flagged as default).
    /// `default_model` is implicitly added to this list at
    /// runtime if you forget — but listing it explicitly is the
    /// expected style.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,

    // ---- transport-style fields (most providers) ----
    /// Used by `openai`, `openai-responses`, `anthropic`,
    /// `google`, `codex`, `kimi`. Each one has its own default;
    /// see `serve.rs` `build_provider`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,

    // ---- anthropic ----
    /// `anthropic-version` header. Only used by `anthropic`.
    /// Defaults to `2023-06-01`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,

    // ---- codex ----
    /// `~/.codex` style location of the OAuth `auth.json` file.
    /// Only used by `codex`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<PathBuf>,
    /// Endpoint suffix on the Codex base URL. Only used by
    /// `codex`. Defaults to `/codex/responses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Sent as the `originator` header. Only used by `codex`.
    /// Defaults to `"jarvis"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub originator: Option<String>,

    // ---- reasoning (codex + openai-responses) ----
    /// `auto` / `concise` / `detailed`. Used by `codex` and
    /// `openai-responses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    /// `low` / `medium` / `high` / `xhigh`. Used by `codex` and
    /// `openai-responses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Whether to ask the server to return encrypted reasoning
    /// blocks for cross-turn cache. Used by `codex` and
    /// `openai-responses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_encrypted_reasoning: Option<bool>,
    /// `auto` / `priority` / `flex`. Used by `codex` and
    /// `openai-responses`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ToolsSection {
    /// Maps to `JARVIS_FS_ROOT`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs_root: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_fs_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_fs_edit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_fs_patch: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_shell_exec: Option<bool>,
    /// Whether to register the read-only `git.*` tools. Defaults to `true`;
    /// set to `false` (or `JARVIS_DISABLE_GIT_READ=1`) to skip them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_git_read: Option<bool>,
    /// Whether to register the write-side git tools (`git.add`,
    /// `git.commit`, `git.merge`). Defaults to `false`; flip to `true`
    /// (or set `JARVIS_ENABLE_GIT_WRITE=1`) to enable. All three are
    /// approval-gated regardless of this flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_git_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_timeout_ms: Option<u64>,
    /// `none` (default), `auto`, `bubblewrap` / `bwrap`,
    /// `sandbox-exec`. Maps to `JARVIS_SHELL_SANDBOX`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_sandbox: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MemorySection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<usize>,
    /// `window` (default) or `summary`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Override the model used for summarisation. Defaults to the
    /// active provider's default model if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Enable Claude Code-style file-based project memory. When unset,
    /// Jarvis auto-loads memory only if the project memory directory
    /// already exists; set `true` to create/load it, `false` to disable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_enabled: Option<bool>,
    /// Project memory directory. Relative paths are resolved under the
    /// workspace root. Defaults to `.jarvis/memory`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    /// Byte cap for the loaded `MEMORY.md` index. Defaults to 25 KiB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PersistenceSection {
    /// Maps to `JARVIS_DB_URL`. `json://...` (default) /
    /// `sqlite::memory:` / `sqlite://./db.sqlite` /
    /// `postgres://...` / `mysql://...`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ApprovalSection {
    /// `auto` (always approve, audit-only) or `deny` (always deny).
    /// WS clients can override with interactive approval regardless.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

impl Config {
    /// Read and parse a JSON config from `path`. Errors include
    /// the path so the operator can spot which file is malformed.
    pub fn load_from_path(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read config {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parse config {}", path.display()))
    }

    /// Serialise to a pretty-printed JSON string. `None` fields
    /// and empty maps are skipped so a barely-touched `Config`
    /// produces a small, focused file rather than a noisy
    /// template.
    pub fn to_json_string(&self) -> Result<String> {
        serde_json::to_string_pretty(self).context("serialize config")
    }

    /// Walk the discovery list and return the first file that
    /// exists, parsed. `Ok(None)` means "no config file present" —
    /// that's a valid state, the binary continues with env / default.
    /// An explicit `--config <path>` (the `explicit` arg) wins and
    /// errors if the file is missing.
    pub fn discover(explicit: Option<&Path>) -> Result<Option<(PathBuf, Self)>> {
        if let Some(p) = explicit {
            let cfg = Self::load_from_path(p)?;
            return Ok(Some((p.to_path_buf(), cfg)));
        }
        for path in default_search_paths() {
            if path.is_file() {
                let cfg = Self::load_from_path(&path)?;
                return Ok(Some((path, cfg)));
            }
        }
        Ok(None)
    }

    /// Convenience: pull the active provider's `ProviderConfig`,
    /// or an empty default if the entry isn't present. Lets call
    /// sites read `cfg.provider("openai").base_url` without a
    /// chain of `unwrap_or_default`s.
    pub fn provider(&self, name: &str) -> ProviderConfig {
        self.providers.get(name).cloned().unwrap_or_default()
    }
}

/// Discovery order:
/// `$JARVIS_CONFIG` → `$JARVIS_CONFIG_HOME/config.json`
/// → `$XDG_CONFIG_HOME/jarvis/config.json`
/// → `~/.jarvis/config.json` → `~/.config/jarvis/config.json`
/// → (Windows) `%APPDATA%\jarvis\config.json`.
fn default_search_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("JARVIS_CONFIG") {
        out.push(PathBuf::from(p));
    }
    if let Ok(home) = std::env::var("JARVIS_CONFIG_HOME") {
        out.push(PathBuf::from(home).join("config.json"));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        out.push(PathBuf::from(xdg).join("jarvis").join("config.json"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(&home).join(".jarvis").join("config.json"));
        out.push(
            PathBuf::from(home)
                .join(".config")
                .join("jarvis")
                .join("config.json"),
        );
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata).join("jarvis").join("config.json"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_full_example() {
        let raw = r#"{
            "server": { "addr": "127.0.0.1:9000" },
            "default_provider": "kimi",
            "providers": {
                "kimi": {
                    "enabled": true,
                    "default_model": "kimi-k2-thinking",
                    "models": ["kimi-k2-thinking", "kimi-k2-turbo-preview"],
                    "base_url": "https://api.moonshot.cn/v1"
                },
                "codex": {
                    "enabled": false,
                    "default_model": "gpt-5.4-mini",
                    "models": ["gpt-5.4-mini", "gpt-5.4"],
                    "home": "/Users/me/.codex",
                    "reasoning_summary": "auto",
                    "include_encrypted_reasoning": true
                }
            },
            "tools": {
                "fs_root": "/Users/me/projects/foo",
                "enable_fs_edit": true,
                "enable_shell_exec": true,
                "shell_timeout_ms": 60000
            },
            "memory": {
                "tokens": 8000,
                "mode": "summary"
            },
            "persistence": { "url": "sqlite://./jarvis.db" },
            "approval": { "mode": "deny" },
            "mcp_servers": {
                "fs": "uvx mcp-server-filesystem /tmp",
                "git": "uvx mcp-server-git"
            }
        }"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.server.addr.as_deref(), Some("127.0.0.1:9000"));
        assert_eq!(cfg.default_provider.as_deref(), Some("kimi"));
        let kimi = cfg.providers.get("kimi").unwrap();
        assert!(kimi.enabled);
        assert_eq!(kimi.default_model.as_deref(), Some("kimi-k2-thinking"));
        assert_eq!(kimi.models.len(), 2);
        assert_eq!(kimi.base_url.as_deref(), Some("https://api.moonshot.cn/v1"));
        let codex = cfg.providers.get("codex").unwrap();
        assert!(!codex.enabled);
        assert_eq!(codex.home.as_deref(), Some(Path::new("/Users/me/.codex")));
        assert_eq!(codex.include_encrypted_reasoning, Some(true));
        assert_eq!(cfg.tools.shell_timeout_ms, Some(60000));
        assert_eq!(cfg.mcp_servers.len(), 2);
    }

    #[test]
    fn empty_object_yields_default() {
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert!(cfg.server.addr.is_none());
        assert!(cfg.default_provider.is_none());
        assert!(cfg.providers.is_empty());
        assert!(cfg.mcp_servers.is_empty());
    }

    #[test]
    fn rejects_unknown_keys() {
        let raw = r#"{ "memory": { "tokenz": 1234 } }"#;
        let err = serde_json::from_str::<Config>(raw).unwrap_err();
        assert!(err.to_string().contains("tokenz"), "got: {err}");
    }

    #[test]
    fn discover_returns_none_when_no_file() {
        let _lock = crate::test_env::lock();
        let dir = tempdir().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let saved_jarvis = std::env::var("JARVIS_CONFIG").ok();
        let saved_jarvis_home = std::env::var("JARVIS_CONFIG_HOME").ok();
        let saved_appdata = std::env::var("APPDATA").ok();
        unsafe {
            std::env::set_var("HOME", dir.path());
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("JARVIS_CONFIG");
            std::env::remove_var("JARVIS_CONFIG_HOME");
            std::env::remove_var("APPDATA");
        }

        let result = Config::discover(None).unwrap();
        assert!(result.is_none());

        unsafe {
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match saved_xdg {
                Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
            match saved_jarvis {
                Some(v) => std::env::set_var("JARVIS_CONFIG", v),
                None => std::env::remove_var("JARVIS_CONFIG"),
            }
            match saved_jarvis_home {
                Some(v) => std::env::set_var("JARVIS_CONFIG_HOME", v),
                None => std::env::remove_var("JARVIS_CONFIG_HOME"),
            }
            match saved_appdata {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
        }
    }

    #[test]
    fn discover_explicit_path_wins() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("custom.json");
        std::fs::write(&path, r#"{"server":{"addr":"10.0.0.1:8080"}}"#).unwrap();
        let (p, cfg) = Config::discover(Some(&path)).unwrap().unwrap();
        assert_eq!(p, path);
        assert_eq!(cfg.server.addr.as_deref(), Some("10.0.0.1:8080"));
    }

    #[test]
    fn discover_explicit_missing_errors() {
        let err = Config::discover(Some(Path::new("/no/such/file.json"))).unwrap_err();
        let s = err.to_string();
        assert!(
            s.contains("read config") || s.contains("/no/such"),
            "got: {s}"
        );
    }

    #[test]
    fn discover_uses_jarvis_config_home() {
        let _lock = crate::test_env::lock();
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"default_provider":"openai"}"#).unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let saved_jarvis = std::env::var("JARVIS_CONFIG").ok();
        let saved_jarvis_home = std::env::var("JARVIS_CONFIG_HOME").ok();
        let saved_appdata = std::env::var("APPDATA").ok();
        unsafe {
            std::env::set_var("JARVIS_CONFIG_HOME", dir.path());
            std::env::remove_var("JARVIS_CONFIG");
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("HOME");
            std::env::remove_var("APPDATA");
        }
        let (loaded, cfg) = Config::discover(None).unwrap().unwrap();
        assert_eq!(loaded, path);
        assert_eq!(cfg.default_provider.as_deref(), Some("openai"));
        unsafe {
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match saved_xdg {
                Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
            match saved_jarvis {
                Some(v) => std::env::set_var("JARVIS_CONFIG", v),
                None => std::env::remove_var("JARVIS_CONFIG"),
            }
            match saved_jarvis_home {
                Some(v) => std::env::set_var("JARVIS_CONFIG_HOME", v),
                None => std::env::remove_var("JARVIS_CONFIG_HOME"),
            }
            match saved_appdata {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
        }
    }

    #[test]
    fn discover_prefers_home_dot_jarvis_over_legacy_config() {
        let _lock = crate::test_env::lock();
        let dir = tempdir().unwrap();
        let modern = dir.path().join(".jarvis");
        let legacy = dir.path().join(".config/jarvis");
        std::fs::create_dir_all(&modern).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            modern.join("config.json"),
            r#"{"default_provider":"anthropic"}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("config.json"),
            r#"{"default_provider":"openai"}"#,
        )
        .unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let saved_jarvis = std::env::var("JARVIS_CONFIG").ok();
        let saved_jarvis_home = std::env::var("JARVIS_CONFIG_HOME").ok();
        let saved_appdata = std::env::var("APPDATA").ok();
        unsafe {
            std::env::set_var("HOME", dir.path());
            std::env::remove_var("JARVIS_CONFIG");
            std::env::remove_var("JARVIS_CONFIG_HOME");
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("APPDATA");
        }
        let (loaded, cfg) = Config::discover(None).unwrap().unwrap();
        assert_eq!(loaded, modern.join("config.json"));
        assert_eq!(cfg.default_provider.as_deref(), Some("anthropic"));
        unsafe {
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match saved_xdg {
                Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
            match saved_jarvis {
                Some(v) => std::env::set_var("JARVIS_CONFIG", v),
                None => std::env::remove_var("JARVIS_CONFIG"),
            }
            match saved_jarvis_home {
                Some(v) => std::env::set_var("JARVIS_CONFIG_HOME", v),
                None => std::env::remove_var("JARVIS_CONFIG_HOME"),
            }
            match saved_appdata {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
        }
    }

    #[test]
    fn default_config_serialises_compactly() {
        // Empty Config should serialise to `{}` (or very close).
        // Every field has skip_serializing_if so nothing pollutes.
        let s = Config::default().to_json_string().unwrap();
        assert!(
            !s.contains("\"providers\""),
            "expected providers key skipped on default, got:\n{s}"
        );
        assert!(
            !s.contains("\"tools\""),
            "expected tools key skipped on default, got:\n{s}"
        );
    }

    #[test]
    fn populated_config_round_trips() {
        let mut original = Config::default();
        original.server.addr = Some("127.0.0.1:8080".into());
        original.default_provider = Some("kimi".into());
        original.providers.insert(
            "kimi".into(),
            ProviderConfig {
                enabled: true,
                default_model: Some("kimi-k2-thinking".into()),
                models: vec!["kimi-k2-thinking".into(), "kimi-latest".into()],
                base_url: Some("https://api.moonshot.cn/v1".into()),
                ..ProviderConfig::default()
            },
        );
        original.providers.insert(
            "codex".into(),
            ProviderConfig {
                enabled: false,
                default_model: Some("gpt-5.4-mini".into()),
                models: vec!["gpt-5.4-mini".into(), "gpt-5.4".into()],
                home: Some(PathBuf::from("/Users/me/.codex")),
                reasoning_summary: Some("auto".into()),
                ..ProviderConfig::default()
            },
        );
        original.tools.fs_root = Some(PathBuf::from("/work"));
        original.tools.enable_fs_edit = Some(true);
        original.tools.enable_shell_exec = Some(false);
        original.memory.tokens = Some(8000);
        original.memory.mode = Some("summary".into());
        original.persistence.url = Some("json:///tmp/convos".into());
        original.approval.mode = Some("deny".into());
        original.mcp_servers.insert(
            "fs".into(),
            McpServerEntry::Legacy("uvx mcp-server-filesystem /tmp".into()),
        );

        let text = original.to_json_string().unwrap();
        let parsed: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(original, parsed, "round trip lost data:\n{text}");
    }

    #[test]
    fn provider_helper_returns_default_for_missing_entry() {
        let cfg = Config::default();
        let p = cfg.provider("openai");
        assert!(!p.enabled);
        assert!(p.models.is_empty());
        assert!(p.base_url.is_none());
    }
}
