// @jarvis/plugin — plugin packaging for the agent harness.
//
// Ported from the harness-plugin Rust crate. A *Plugin* is a directory with a
// `plugin.json` manifest at its root. The manifest names the plugin and lists
// what it ships:
//
// - **skills**: relative paths to SKILL.md folders inside the plugin
//   (registered into a shared `@jarvis/skill` SkillCatalog on install, removed
//   on uninstall).
// - **mcp_servers**: prefix → `McpClientConfig` map that the MCP manager adopts
//   on install. Each entry's `prefix` field is optional in JSON — it's filled
//   in from the map key during parsing.
//
// Install / uninstall is a {@link PluginManager} operation: it copies the
// plugin tree into a "plugins root", updates an `installed.json` ledger, and
// pushes the manifest's contents into the supplied catalog + MCP manager.
// Failures roll back every step before returning.

// ---------- manifest.ts (plugin.json parsing + value types) ----------
export {
  type PluginManifest,
  type ChannelAdapterSpec,
  type ChannelTransport,
  type SlashCommandSpec,
  type HookSpec,
  type PluginManifestErrorKind,
  PluginManifestError,
  parsePluginManifest,
  pluginManifestToJson,
  validatePluginName,
} from "./manifest.ts";

// ---------- manager.ts (install / uninstall + ledger) ----------
export {
  type McpManagerLike,
  type InstalledPlugin,
  type PluginInstallReport,
  type PluginManagerErrorKind,
  PluginManagerError,
  PluginManager,
} from "./manager.ts";
