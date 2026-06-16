// `plugin.json` manifest.
//
// Ported from crates/harness-plugin/src/manifest.rs.
//
// Schema:
//   {
//     "name": "my-plugin",
//     "version": "0.1.0",
//     "description": "...",
//     "author": "...",
//     "license": "MIT",
//     "homepage": "https://example.com/my-plugin",
//     "skills": ["skills/code-review"],
//     "mcp_servers": {
//       "github": {
//         "transport": { "type": "stdio", "command": "uvx",
//                        "args": ["mcp-server-github"] },
//         "alias": { "createIssue": "create-issue" }
//       }
//     }
//   }
//
// Under `mcp_servers`, each entry's `prefix` field is omitted in the
// manifest — it's filled in from the map key during parsing. Supplying it
// anyway is harmless: the value is overridden to match the key.
//
// Unknown top-level fields are kept (forward-compat with future Phase-4
// `slash_commands` / `hooks` keys) so older binaries don't reject manifests
// that use them; the manager just won't act on them.
import type { McpClientConfig, McpTransport } from "@jarvis/mcp";

/** Error kinds out of {@link parsePluginManifest}. Mirrors Rust's `PluginManifestError`. */
export type PluginManifestErrorKind = "invalid_name" | "missing_field" | "invalid_json";

/** Thrown by {@link parsePluginManifest}. `kind` mirrors the Rust variant. */
export class PluginManifestError extends Error {
  readonly kind: PluginManifestErrorKind;

  constructor(kind: PluginManifestErrorKind, message: string) {
    super(message);
    this.name = "PluginManifestError";
    this.kind = kind;
  }
}

/**
 * Parsed `plugin.json`. Optional fields default to "absent" so minimal
 * plugins (just a name + version + description) round-trip cleanly.
 *
 * Serde shape: optional scalars (`author` / `license` / `homepage`) are
 * `skip_serializing_if = Option::is_none` (absent when unset); the collection
 * fields (`skills` / `mcp_servers` / `channel_adapters` / `slash_commands` /
 * `hooks`) are `skip_serializing_if = "is_empty"`, so we mirror that on
 * serialise (see {@link pluginManifestToJson}). `mcp_servers` /
 * `channel_adapters` are `BTreeMap`s — key order is alphabetical on the wire.
 */
export interface PluginManifest {
  /**
   * Unique kebab-case identifier. Doubles as the dir name on disk under
   * `<plugins-root>/<name>/`.
   */
  name: string;
  /** Free-form version string. */
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  /**
   * Relative paths (inside the plugin directory) that point at SKILL.md
   * folders. Each one is registered into the catalog with `source: "plugin"`
   * on install.
   */
  skills: string[];
  /**
   * Prefix → MCP server config. The PluginManager calls `mcp.add` for each one
   * on install.
   *
   * On the wire the entry's `prefix` field is **optional**: during parsing, a
   * missing `prefix` is filled in from the map key, so authors don't have to
   * repeat it. An explicitly-set `prefix` is overridden to match the key (the
   * map key always wins).
   */
  mcp_servers: Record<string, McpClientConfig>;
  /**
   * External messaging-channel adapters (Feishu / DingTalk / WeCom / …). Map
   * key is the canonical channel handle; value carries the transport + env.
   * Phase 1: parsed and validated, but the manager does not yet spawn anything.
   */
  channel_adapters: Record<string, ChannelAdapterSpec>;
  // ---- forward-compat (Phase 4) ----
  /** Slash-command files. Recorded as metadata only today. */
  slash_commands: SlashCommandSpec[];
  /** Hook scripts. Recorded as metadata only today. */
  hooks: HookSpec[];
}

/**
 * One entry in a plugin's `channel_adapters` map. Phase 1 supports only the
 * `stdio` transport — same shape MCP servers use.
 */
export interface ChannelAdapterSpec {
  transport: ChannelTransport;
  /**
   * Environment variables passed to the child process. The special form
   * `${env:NAME}` is **not** expanded here — the manager resolves it against
   * the host process env at spawn time so secrets stay out of the manifest.
   */
  env: Record<string, string>;
  /**
   * Whether to restart the adapter with exponential backoff when the
   * subprocess exits non-zero. Default `true`.
   */
  auto_restart: boolean;
}

/**
 * Transport for spawning a channel adapter subprocess. Mirrors the shape of
 * `McpTransport` but is deliberately a separate type. Phase 1 supports only
 * `stdio`; a `tag = "type", rename_all = "lowercase"` serde enum.
 */
export type ChannelTransport = {
  type: "stdio";
  command: string;
  args: string[];
};

export interface SlashCommandSpec {
  name: string;
  prompt_file: string;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
}

const DEFAULT_AUTO_RESTART = true;

/**
 * Parse + validate a `plugin.json` text. Throws {@link PluginManifestError}
 * on bad JSON, an invalid name, or a missing required field.
 *
 * Every nested `McpClientConfig.prefix` is forced to match its map key (both
 * here and in the deserialize pass), so authors needn't repeat it and an
 * explicit value is overridden.
 */
export function parsePluginManifest(text: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PluginManifestError("invalid_json", `invalid JSON: ${errText(e)}`);
  }
  const manifest = manifestFromJson(raw);
  validate(manifest);
  // Force every nested McpClientConfig.prefix to match its map key.
  for (const [key, cfg] of Object.entries(manifest.mcp_servers)) {
    cfg.prefix = key;
  }
  return manifest;
}

/**
 * Decode a parsed-JSON value into a {@link PluginManifest}. Unknown top-level
 * fields are ignored (forward-compat). Channel-adapter transports with an
 * unknown `type` are rejected (forward-incompatible — a future binary that
 * drops `stdio` must not silently succeed on an old manifest).
 */
function manifestFromJson(raw: unknown): PluginManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PluginManifestError("invalid_json", "invalid JSON: expected an object");
  }
  const obj = raw as Record<string, unknown>;

  const manifest: PluginManifest = {
    name: jsonString(obj["name"], "name"),
    version: jsonString(obj["version"], "version"),
    description: jsonString(obj["description"], "description"),
    skills: jsonStringArray(obj["skills"], "skills"),
    mcp_servers: mcpServersFromJson(obj["mcp_servers"]),
    channel_adapters: channelAdaptersFromJson(obj["channel_adapters"]),
    slash_commands: slashCommandsFromJson(obj["slash_commands"]),
    hooks: hooksFromJson(obj["hooks"]),
  };
  const author = optJsonString(obj["author"], "author");
  const license = optJsonString(obj["license"], "license");
  const homepage = optJsonString(obj["homepage"], "homepage");
  if (author !== undefined) manifest.author = author;
  if (license !== undefined) manifest.license = license;
  if (homepage !== undefined) manifest.homepage = homepage;
  return manifest;
}

/**
 * Build the `mcp_servers` map. Mirrors Rust's `deserialize_mcp_servers`:
 * inject `prefix = <key>` into each entry before validating it as an
 * `McpClientConfig` (the map key is authoritative).
 */
function mcpServersFromJson(raw: unknown): Record<string, McpClientConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginManifestError("invalid_json", "invalid JSON: `mcp_servers` must be an object");
  }
  const out: Record<string, McpClientConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = mcpClientConfigFromJson(key, value);
  }
  return out;
}

function mcpClientConfigFromJson(key: string, value: unknown): McpClientConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginManifestError(
      "invalid_json",
      `invalid JSON: mcp_servers.${key} must be an object`,
    );
  }
  const v = value as Record<string, unknown>;
  const cfg: McpClientConfig = {
    prefix: key, // map key always wins
    transport: mcpTransportFromJson(key, v["transport"]),
  };
  if (Array.isArray(v["allowTools"])) cfg.allowTools = v["allowTools"] as string[];
  if (Array.isArray(v["denyTools"])) cfg.denyTools = v["denyTools"] as string[];
  if (v["alias"] && typeof v["alias"] === "object" && !Array.isArray(v["alias"])) {
    cfg.alias = v["alias"] as Record<string, string>;
  }
  if (typeof v["enabled"] === "boolean") cfg.enabled = v["enabled"];
  return cfg;
}

function mcpTransportFromJson(key: string, raw: unknown): McpTransport {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PluginManifestError(
      "invalid_json",
      `invalid JSON: mcp_servers.${key}.transport must be an object`,
    );
  }
  const t = raw as Record<string, unknown>;
  const type = t["type"];
  if (type === "stdio") {
    const command = jsonString(t["command"], `mcp_servers.${key}.transport.command`);
    const args = jsonStringArray(t["args"], `mcp_servers.${key}.transport.args`);
    return { type: "stdio", command, args };
  }
  if (type === "http" || type === "streamable-http") {
    const url = jsonString(t["url"], `mcp_servers.${key}.transport.url`);
    const headers =
      t["headers"] && typeof t["headers"] === "object" && !Array.isArray(t["headers"])
        ? (t["headers"] as Record<string, string>)
        : undefined;
    return headers !== undefined ? { type, url, headers } : { type, url };
  }
  throw new PluginManifestError(
    "invalid_json",
    `invalid JSON: unknown mcp transport type \`${String(type)}\``,
  );
}

function channelAdaptersFromJson(raw: unknown): Record<string, ChannelAdapterSpec> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginManifestError(
      "invalid_json",
      "invalid JSON: `channel_adapters` must be an object",
    );
  }
  const out: Record<string, ChannelAdapterSpec> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = channelAdapterSpecFromJson(key, value);
  }
  return out;
}

function channelAdapterSpecFromJson(key: string, value: unknown): ChannelAdapterSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginManifestError(
      "invalid_json",
      `invalid JSON: channel_adapters.${key} must be an object`,
    );
  }
  const v = value as Record<string, unknown>;
  const transport = channelTransportFromJson(key, v["transport"]);
  const env = stringMapFromJson(v["env"], `channel_adapters.${key}.env`);
  let autoRestart = DEFAULT_AUTO_RESTART;
  if ("auto_restart" in v) {
    if (typeof v["auto_restart"] !== "boolean") {
      throw new PluginManifestError(
        "invalid_json",
        `invalid JSON: channel_adapters.${key}.auto_restart must be a boolean`,
      );
    }
    autoRestart = v["auto_restart"];
  }
  return { transport, env, auto_restart: autoRestart };
}

function channelTransportFromJson(key: string, raw: unknown): ChannelTransport {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PluginManifestError(
      "invalid_json",
      `invalid JSON: channel_adapters.${key}.transport must be an object`,
    );
  }
  const t = raw as Record<string, unknown>;
  if (t["type"] !== "stdio") {
    // Forward-incompatible transports must be rejected (vs. the permissive
    // treatment unknown top-level fields get).
    throw new PluginManifestError(
      "invalid_json",
      `invalid JSON: unknown channel transport type \`${String(t["type"])}\``,
    );
  }
  const command = jsonString(t["command"], `channel_adapters.${key}.transport.command`);
  const args = jsonStringArray(t["args"], `channel_adapters.${key}.transport.args`);
  return { type: "stdio", command, args };
}

function slashCommandsFromJson(raw: unknown): SlashCommandSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new PluginManifestError("invalid_json", "invalid JSON: `slash_commands` must be an array");
  }
  return raw.map((el, i) => {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      throw new PluginManifestError("invalid_json", `invalid JSON: slash_commands[${i}] must be an object`);
    }
    const o = el as Record<string, unknown>;
    return {
      name: jsonString(o["name"], `slash_commands[${i}].name`),
      prompt_file: jsonString(o["prompt_file"], `slash_commands[${i}].prompt_file`),
    };
  });
}

function hooksFromJson(raw: unknown): HookSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new PluginManifestError("invalid_json", "invalid JSON: `hooks` must be an array");
  }
  return raw.map((el, i) => {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      throw new PluginManifestError("invalid_json", `invalid JSON: hooks[${i}] must be an object`);
    }
    const o = el as Record<string, unknown>;
    const hook: HookSpec = {
      event: jsonString(o["event"], `hooks[${i}].event`),
      command: jsonString(o["command"], `hooks[${i}].command`),
    };
    const matcher = optJsonString(o["matcher"], `hooks[${i}].matcher`);
    if (matcher !== undefined) hook.matcher = matcher;
    return hook;
  });
}

function validate(m: PluginManifest): void {
  if (m.name.length === 0) {
    throw new PluginManifestError("missing_field", "missing required field `name`");
  }
  if (!validatePluginName(m.name)) {
    throw new PluginManifestError(
      "invalid_name",
      `invalid plugin name \`${m.name}\` (must be kebab-case \`[a-z0-9-]+\`, 1..=64 chars)`,
    );
  }
  if (m.version.length === 0) {
    throw new PluginManifestError("missing_field", "missing required field `version`");
  }
  if (m.description.length === 0) {
    throw new PluginManifestError("missing_field", "missing required field `description`");
  }
}

/**
 * Same shape as `@jarvis/skill`'s kebab-name check — kept duplicated to avoid
 * a dependency on a private helper. `[a-z0-9-]+`, 1..=64 bytes, no
 * leading/trailing `-`.
 */
export function validatePluginName(s: string): boolean {
  if (s.length === 0 || utf8Len(s) > 64) return false;
  if (s.startsWith("-") || s.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(s);
}

/**
 * Serialise a manifest back to a plain JSON object honouring serde's
 * skip-serializing rules (omit absent scalars + empty collections). Mirrors
 * the Rust `Serialize` derive so round-trips through the ledger are clean.
 */
export function pluginManifestToJson(m: PluginManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: m.name,
    version: m.version,
    description: m.description,
  };
  if (m.author !== undefined) out["author"] = m.author;
  if (m.license !== undefined) out["license"] = m.license;
  if (m.homepage !== undefined) out["homepage"] = m.homepage;
  if (m.skills.length > 0) out["skills"] = m.skills;
  if (Object.keys(m.mcp_servers).length > 0) out["mcp_servers"] = m.mcp_servers;
  if (Object.keys(m.channel_adapters).length > 0) out["channel_adapters"] = m.channel_adapters;
  if (m.slash_commands.length > 0) out["slash_commands"] = m.slash_commands;
  if (m.hooks.length > 0) out["hooks"] = m.hooks;
  return out;
}

// ---------- JSON-decoding helpers ----------

function jsonString(v: unknown, field: string): string {
  if (v === undefined || v === null) {
    // Required field absent → mirror serde's "missing field" surface, which
    // for plugin.json lands as InvalidJson (the manifest deserialize fails).
    throw new PluginManifestError("invalid_json", `invalid JSON: missing field \`${field}\``);
  }
  if (typeof v !== "string") {
    throw new PluginManifestError("invalid_json", `invalid JSON: field \`${field}\` must be a string`);
  }
  return v;
}

function optJsonString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new PluginManifestError("invalid_json", `invalid JSON: field \`${field}\` must be a string`);
  }
  return v;
}

function jsonStringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new PluginManifestError("invalid_json", `invalid JSON: field \`${field}\` must be an array`);
  }
  for (const el of v) {
    if (typeof el !== "string") {
      throw new PluginManifestError(
        "invalid_json",
        `invalid JSON: field \`${field}\` must be an array of strings`,
      );
    }
  }
  return v as string[];
}

function stringMapFromJson(v: unknown, field: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new PluginManifestError("invalid_json", `invalid JSON: field \`${field}\` must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new PluginManifestError(
        "invalid_json",
        `invalid JSON: field \`${field}.${key}\` must be a string`,
      );
    }
    out[key] = val;
  }
  return out;
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
