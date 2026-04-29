//! Plugin packaging for the agent harness.
//!
//! A *Plugin* is a directory with a `plugin.json` manifest at its
//! root. The manifest names the plugin and lists what it ships:
//!
//! - **skills**: relative paths to SKILL.md folders inside the
//!   plugin (registered into a shared [`harness_skill::SkillCatalog`]
//!   on install, removed on uninstall).
//! - **mcp_servers**: prefix → [`harness_mcp::McpClientConfig`] map
//!   that the [`harness_mcp::McpManager`] adopts on install.
//!
//! Future Phase-4 work will add slash commands and hooks; the
//! manifest schema reserves the field names but the manager skips
//! them today.
//!
//! Install / uninstall is a [`PluginManager`] operation: it copies
//! the plugin tree into a "plugins root" (defaults to
//! `~/.config/jarvis/plugins/<name>/`), updates an
//! `installed.json` ledger, and pushes the manifest's contents
//! into the supplied catalog + MCP manager. Failures roll back
//! every step before returning.

pub mod manager;
pub mod manifest;

pub use manager::{InstalledPlugin, PluginInstallReport, PluginManager, PluginManagerError};
pub use manifest::{
    parse_plugin_manifest, validate_plugin_name, PluginManifest, PluginManifestError,
};
