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
//! Unknown fields are kept (forward-compat with future Phase-4
//! `slash_commands` / `hooks` keys) so older binaries don't reject
//! manifests that use them; the manager just won't act on them.

use std::collections::BTreeMap;

use harness_mcp::McpClientConfig;
use serde::{Deserialize, Serialize};
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
    /// `McpManager::add` for each one on install. The `prefix`
    /// field on each value is overridden to match the map key so
    /// callers don't have to repeat it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, McpClientConfig>,
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
                    "prefix": "ignored-overridden",
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
    fn rejects_invalid_name() {
        let raw = r#"{ "name": "Bad_Name", "version": "0", "description": "x" }"#;
        let err = parse_plugin_manifest(raw).unwrap_err();
        assert!(matches!(err, PluginManifestError::InvalidName(_)));
    }

    #[test]
    fn rejects_missing_description() {
        let raw = r#"{ "name": "x", "version": "0.1.0", "description": "" }"#;
        let err = parse_plugin_manifest(raw).unwrap_err();
        assert!(matches!(err, PluginManifestError::MissingField("description")));
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
                assert_eq!(args, &vec!["-y".to_string(), "gitnexus".to_string(), "mcp".to_string()]);
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
}
