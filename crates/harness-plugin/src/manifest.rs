//! `plugin.json` manifest.
//!
//! Schema:
//! ```json
//! {
//!   "name": "my-plugin",
//!   "version": "0.1.0",
//!   "description": "...",
//!   "author": "...",
//!   "license": "MIT",
//!   "homepage": "https://example.com/my-plugin",
//!   "skills": ["skills/code-review"],
//!   "mcp_servers": {
//!     "github": {
//!       "transport": { "type": "stdio", "command": "uvx",
//!                      "args": ["mcp-server-github"] },
//!       "alias": { "createIssue": "create-issue" }
//!     }
//!   }
//! }
//! ```
//!
//! Note that under `mcp_servers`, each entry's `prefix` field is
//! omitted in the manifest — it's filled in from the map key during
//! parsing. Supplying it anyway is harmless: the value is overridden
//! to match the key.
//!
//! Unknown fields are kept (forward-compat with future Phase-4
//! `slash_commands` / `hooks` keys) so older binaries don't reject
//! manifests that use them; the manager just won't act on them.

use std::collections::BTreeMap;

use harness_mcp::McpClientConfig;
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PluginManifestError {
    #[error("invalid plugin name `{0}` (must be kebab-case `[a-z0-9-]+`, 1..=64 chars)")]
    InvalidName(String),
    #[error("missing required field `{0}`")]
    MissingField(&'static str),
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}

/// Parsed `plugin.json`. Optional fields default to "absent" so
/// minimal plugins (just a name + version + description) round-trip
/// cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginManifest {
    /// Unique kebab-case identifier. Doubles as the dir name on
    /// disk under `<plugins-root>/<name>/`.
    pub name: String,
    /// Free-form version string.
    pub version: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// Relative paths (inside the plugin directory) that point at
    /// SKILL.md folders. Each one is registered into the catalog
    /// with `source: Plugin` on install.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// Prefix → MCP server config. The PluginManager calls
    /// `McpManager::add` for each one on install.
    ///
    /// On the wire the entry's `prefix` field is **optional**:
    /// during parsing, a missing `prefix` is filled in from the map
    /// key, so authors don't have to repeat it. An explicitly-set
    /// `prefix` is overridden to match the key (the map key always
    /// wins).
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "deserialize_mcp_servers"
    )]
    pub mcp_servers: BTreeMap<String, McpClientConfig>,
    /// External messaging-channel adapters (Feishu / DingTalk /
    /// WeCom / …). Each entry declares a subprocess that the
    /// `PluginManager` will spawn and supervise (Phase 2). Map key is
    /// the canonical channel handle (matches
    /// `harness_core::ChannelBinding::channel`); value carries the
    /// transport + env. **Phase 1:** parsed and validated, but the
    /// manager does not yet spawn anything — same staging used for
    /// `slash_commands` / `hooks`. See
    /// `docs/proposals/channel-plugins.md`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub channel_adapters: BTreeMap<String, ChannelAdapterSpec>,
    // ---- forward-compat (Phase 4) ----
    /// Slash-command files. Today the manager records them as
    /// metadata only; future work wires them into the slash router.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slash_commands: Vec<SlashCommandSpec>,
    /// Hook scripts. Today the manager records them as metadata
    /// only; future work runs them via the hook engine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<HookSpec>,
}

/// One entry in a plugin's `channel_adapters` map. Phase 1 supports
/// only the `stdio` transport — same shape MCP servers use. Future
/// phases may add `tcp` / `unix` for adapters running on a separate
/// machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChannelAdapterSpec {
    pub transport: ChannelTransport,
    /// Environment variables passed to the child process. The
    /// special form `${env:NAME}` is **not** expanded here — the
    /// `PluginManager` resolves it against the host process env at
    /// spawn time so secrets stay out of the manifest.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Whether to restart the adapter with exponential backoff when
    /// the subprocess exits non-zero. Default `true` — adapters are
    /// long-running listeners; abnormal exits are recoverable.
    #[serde(default = "default_auto_restart")]
    pub auto_restart: bool,
}

fn default_auto_restart() -> bool {
    true
}

/// Transport for spawning a channel adapter subprocess. Mirrors the
/// shape of [`harness_mcp::McpTransport`] so plugin authors familiar
/// with `mcp_servers` can copy the pattern; deliberately a separate
/// type because the channel protocol layered on top is different
/// (channel adapters speak the Jarvis WS protocol back to the
/// server, not JSON-RPC tool calls).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChannelTransport {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlashCommandSpec {
    pub name: String,
    pub prompt_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookSpec {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
}

/// Make `McpClientConfig.prefix` optional in the manifest path: when
/// missing on a given entry, fill it in from the map key before
/// handing the value to `McpClientConfig::deserialize`. An
/// explicitly-set `prefix` is also rewritten to the key — the
/// post-parse pass in `parse_plugin_manifest` does the same as a
/// defence-in-depth measure for callers that build a manifest in
/// code rather than parsing JSON.
fn deserialize_mcp_servers<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, McpClientConfig>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: BTreeMap<String, serde_json::Value> = BTreeMap::deserialize(deserializer)?;
    let mut out = BTreeMap::new();
    for (key, mut value) in raw {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("prefix".to_string(), serde_json::Value::String(key.clone()));
        }
        let cfg: McpClientConfig =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        out.insert(key, cfg);
    }
    Ok(out)
}

pub fn parse_plugin_manifest(text: &str) -> Result<PluginManifest, PluginManifestError> {
    let mut manifest: PluginManifest =
        serde_json::from_str(text).map_err(|e| PluginManifestError::InvalidJson(e.to_string()))?;
    validate(&manifest)?;
    // Force every nested McpClientConfig.prefix to match its map key.
    let entries: Vec<(String, McpClientConfig)> = manifest
        .mcp_servers
        .iter()
        .map(|(k, v)| {
            let mut v = v.clone();
            v.prefix = k.clone();
            (k.clone(), v)
        })
        .collect();
    manifest.mcp_servers = entries.into_iter().collect();
    Ok(manifest)
}

fn validate(m: &PluginManifest) -> Result<(), PluginManifestError> {
    if m.name.is_empty() {
        return Err(PluginManifestError::MissingField("name"));
    }
    if !validate_plugin_name(&m.name) {
        return Err(PluginManifestError::InvalidName(m.name.clone()));
    }
    if m.version.is_empty() {
        return Err(PluginManifestError::MissingField("version"));
    }
    if m.description.is_empty() {
        return Err(PluginManifestError::MissingField("description"));
    }
    Ok(())
}

/// Same shape as `harness_skill::manifest::is_kebab_name` — kept
/// duplicated to avoid a dependency cycle on a private helper.
pub fn validate_plugin_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    if s.starts_with('-') || s.ends_with('-') {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_manifest() {
        let raw = r#"{ "name": "demo", "version": "0.1.0", "description": "A demo plugin." }"#;
        let m = parse_plugin_manifest(raw).unwrap();
        assert_eq!(m.name, "demo");
        assert_eq!(m.version, "0.1.0");
        assert!(m.skills.is_empty());
        assert!(m.mcp_servers.is_empty());
    }

    #[test]
    fn parses_full_manifest() {
        // Documents the canonical wire shape: `prefix` is omitted on
        // each `mcp_servers` entry — the map key supplies it.
        let raw = r#"{
            "name": "github-tools",
            "version": "0.2.0",
            "description": "Skills + MCP for GitHub workflows.",
            "author": "Jarvis Project",
            "license": "MIT",
            "homepage": "https://example.com",
            "skills": ["skills/triage", "skills/release"],
            "mcp_servers": {
                "github": {
                    "transport": { "type": "stdio", "command": "uvx", "args": ["mcp-server-github"] }
                }
            }
        }"#;
        let m = parse_plugin_manifest(raw).unwrap();
        assert_eq!(m.skills.len(), 2);
        let entry = m.mcp_servers.get("github").unwrap();
        assert_eq!(entry.prefix, "github", "prefix should match map key");
    }

    #[test]
    fn explicit_prefix_in_manifest_is_overridden_by_map_key() {
        // Tolerated for back-compat: an author who repeats `prefix`
        // (or copy-pastes from an in-code config) gets a sensible
        // result rather than a deserialize error or a mismatched
        // prefix at runtime. The map key is authoritative.
        let raw = r#"{
            "name": "github-tools",
            "version": "0.2.0",
            "description": "x",
            "mcp_servers": {
                "github": {
                    "prefix": "ignored-overridden",
                    "transport": { "type": "stdio", "command": "uvx", "args": ["mcp-server-github"] }
                }
            }
        }"#;
        let m = parse_plugin_manifest(raw).unwrap();
        let entry = m.mcp_servers.get("github").unwrap();
        assert_eq!(entry.prefix, "github");
    }

    #[test]
    fn rejects_invalid_name() {
        let raw = r#"{ "name": "Bad_Name", "version": "0", "description": "x" }"#;
        let err = parse_plugin_manifest(raw).unwrap_err();
        assert!(matches!(err, PluginManifestError::InvalidName(_)));
    }

    #[test]
    fn rejects_missing_description() {
        let raw = r#"{ "name": "x", "version": "0.1.0", "description": "" }"#;
        let err = parse_plugin_manifest(raw).unwrap_err();
        assert!(matches!(
            err,
            PluginManifestError::MissingField("description")
        ));
    }

    #[test]
    fn parses_in_tree_gitnexus_plugin() {
        // Pin the on-disk example to the schema so renames / typos in
        // examples/plugins/gitnexus/plugin.json fail in CI rather than
        // silently breaking `jarvis plugin install`.
        let raw = include_str!("../../../examples/plugins/gitnexus/plugin.json");
        let m = parse_plugin_manifest(raw).unwrap();
        assert_eq!(m.name, "gitnexus");
        assert_eq!(m.skills, vec!["skills/gitnexus-workflow"]);
        let entry = m.mcp_servers.get("gitnexus").expect("gitnexus mcp entry");
        assert_eq!(entry.prefix, "gitnexus");
        match &entry.transport {
            harness_mcp::McpTransport::Stdio { command, args, .. } => {
                assert_eq!(command, "npx");
                assert_eq!(
                    args,
                    &vec!["-y".to_string(), "gitnexus".to_string(), "mcp".to_string()]
                );
            }
            other => panic!("expected stdio transport, got {other:?}"),
        }
    }

    #[test]
    fn allows_unknown_fields_for_forward_compat() {
        let raw = r#"{
            "name": "x",
            "version": "0.1.0",
            "description": "z",
            "future_thing": { "a": 1 }
        }"#;
        // Should NOT error — serde defaults to ignoring unknown fields,
        // which is the intended forward-compat shape.
        assert!(parse_plugin_manifest(raw).is_ok());
    }

    #[test]
    fn parses_channel_adapter_block() {
        let raw = r#"{
            "name": "wecom-bot",
            "version": "0.1.0",
            "description": "WeCom AI Bot channel adapter",
            "channel_adapters": {
                "wecom": {
                    "transport": {
                        "type": "stdio",
                        "command": "jarvis-channel-wecom",
                        "args": []
                    },
                    "env": {
                        "WECOM_BOT_ID": "${env:WECOM_BOT_ID}",
                        "WECOM_SECRET": "${env:WECOM_SECRET}"
                    }
                }
            }
        }"#;
        let m = parse_plugin_manifest(raw).unwrap();
        let entry = m.channel_adapters.get("wecom").expect("wecom entry");
        match &entry.transport {
            ChannelTransport::Stdio { command, args } => {
                assert_eq!(command, "jarvis-channel-wecom");
                assert!(args.is_empty());
            }
        }
        assert_eq!(
            entry.env.get("WECOM_BOT_ID").map(String::as_str),
            Some("${env:WECOM_BOT_ID}"),
        );
        // Default auto_restart kicks in when the field is omitted.
        assert!(entry.auto_restart);
    }

    #[test]
    fn channel_adapter_auto_restart_can_be_overridden() {
        let raw = r#"{
            "name": "x",
            "version": "0.1.0",
            "description": "y",
            "channel_adapters": {
                "feishu": {
                    "transport": {"type": "stdio", "command": "jarvis-channel-feishu"},
                    "auto_restart": false
                }
            }
        }"#;
        let m = parse_plugin_manifest(raw).unwrap();
        assert!(!m.channel_adapters.get("feishu").unwrap().auto_restart);
    }

    #[test]
    fn channel_adapter_unknown_transport_type_fails() {
        // Forward-incompatible transports must be rejected (vs. the
        // permissive treatment unknown top-level fields get) so a
        // future binary that drops `stdio` doesn't silently succeed
        // on an old manifest.
        let raw = r#"{
            "name": "x",
            "version": "0.1.0",
            "description": "y",
            "channel_adapters": {
                "telegram": {
                    "transport": {"type": "tcp", "host": "localhost", "port": 9000}
                }
            }
        }"#;
        assert!(parse_plugin_manifest(raw).is_err());
    }
}
