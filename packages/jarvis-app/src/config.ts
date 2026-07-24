// Pure env → JarvisConfig parsing. The SOLE place (alongside main.ts) that
// reads process.env in the Node workspace — the lint rule is exempted for
// packages/jarvis-app/**. Mirrors the resolution the Rust composition root
// (apps/jarvis/src/serve.rs) applies, minus the JSON config-file layer (env +
// built-in defaults only; the file layer is a documented deferral).
//
// `loadConfig(env)` takes an INJECTED env object so tests pass a fixture
// without mutating the real process.env. Everything here is synchronous,
// side-effect-free parsing — no store / provider / fs work happens until the
// provider/tools/state builders consume the returned config.
import * as os from "node:os";
import { ProfileRegistry, canonicalKind } from "@jarvis/llm";
import { memorySyncBackendFromWire, type MemorySyncBackend } from "@jarvis/tools";
import type { McpClientConfig } from "@jarvis/mcp";
import type { DdnsConfigInput, DdnsProviderKind } from "@jarvis/shared-types";

/** Provider kinds the binary knows how to construct. */
export type ProviderKind =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "google"
  | "codex"
  | "kimi"
  | "ollama";

// Hard fallback when the @jarvis/llm ProfileRegistry has no row for a kind
// (should never happen for the kinds we construct — every ProviderKind has a
// built-in profile). Kept tiny: openai's catalog default.
const FALLBACK_MODEL = "gpt-4o-mini";

/**
 * The compiled-in default model for `kind`, sourced from the @jarvis/llm
 * `ProfileRegistry` so it can NEVER drift from the capability catalog the
 * `CapabilityValidatingProvider` validates against (the old hand-maintained
 * map had already drifted: it said ollama→`llama3.1` while the catalog ships
 * `llama3.2`). `kimi` is canonicalised to the `moonshot` profile, matching the
 * Rust `canonicalKind` mapping.
 */
export function defaultModel(kind: ProviderKind): string {
  const profile = ProfileRegistry.get(canonicalKind(kind));
  return profile?.defaultModel ?? FALLBACK_MODEL;
}

/** Permission mode for new WS sessions. Mirrors the Rust `PermissionMode`. */
export type PermissionModeName = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

/** Short-term memory backend. */
export type MemoryMode = "window" | "summary";

/** Auto/Work-mode scheduler toggle. */
export type WorkMode = "off" | "auto";

/** One MCP server spec parsed from env (`JARVIS_MCP_SERVERS`, Composio, etc.). */
export type McpServerSpec = McpClientConfig;

/** Smart-router tier targets (`<provider>/<model>`), each optional. */
export interface RouterConfigParsed {
  enabled: boolean;
  /** Raw `<provider>/<model>` strings per tier; unset tiers fall through. */
  simple?: string;
  medium?: string;
  complex?: string;
  reasoning?: string;
}

/** Tool-gating flags (write/exec are opt-in; any non-falsey value enables). */
export interface ToolGating {
  enableFsWrite: boolean;
  enableFsEdit: boolean;
  enableFsPatch: boolean;
  enableShellExec: boolean;
  shellTimeoutMs: number;
  /** `git.*` read group is on unless `JARVIS_DISABLE_GIT_READ` is set. */
  enableGitRead: boolean;
  httpMaxBytes: number;
  /** Allow `http.fetch` to reach private/loopback hosts (SSRF guard off).
   * `JARVIS_HTTP_ALLOW_PRIVATE`; default false. */
  httpAllowPrivateHosts: boolean;
}

/** The fully-parsed runtime configuration handed to every builder. */
export interface JarvisConfig {
  provider: ProviderKind;
  model: string;
  /** Per-provider credentials + base-URL overrides (only the load-bearing ones). */
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  kimiApiKey?: string;
  ollamaApiKey?: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  googleBaseUrl?: string;
  kimiBaseUrl?: string;
  codexBaseUrl?: string;
  ollamaBaseUrl?: string;
  anthropicVersion?: string;
  /** Codex auth: static dev token + optional account id; else CODEX_HOME on disk. */
  codexAccessToken?: string;
  codexAccountId?: string;
  codexHome?: string;

  /** Listen address `host:port`. */
  addr: string;
  /** Resolved workspace root for fs.* / git.* / shell cwd. */
  fsRoot: string;
  /**
   * Directory of the built web SPA to serve at `/` (JARVIS_WEB_DIST). When
   * set, `serve` serves it with the react-router SPA fallback; absent →
   * API-only (no static UI). The Rust binary always bakes `dist/` in; here
   * the operator points at `apps/jarvis-web/dist` after `npm run build`.
   */
  webDistDir?: string;
  /** Auto-load AGENTS.md / CLAUDE.md / AGENT.md into the system prompt. */
  includeProjectContext: boolean;
  /** Cap on injected project-context bytes. */
  projectContextMaxBytes: number;
  /** Coding system prompt picked automatically; `false` disables the auto-switch. */
  codingPromptAuto: boolean;

  gating: ToolGating;
  permissionMode: PermissionModeName;

  /** Persistence URL (`json:` default under the user data dir, or unset → in-memory). */
  dbUrl?: string;
  /** `JARVIS_DISABLE_TODOS` opts out of the persistent todo board. */
  disableTodos: boolean;

  /** Short-term memory: only installed when a token budget is set. */
  memoryTokens?: number;
  memoryMode: MemoryMode;
  /** Summary-mode model override; defaults to the primary model. */
  memoryModel?: string;

  /**
   * Enable the markdown `memory.*` surface + its `/v1/memory/*` REST routes
   * (`JARVIS_ENABLE_MEMORY`, off by default). When on, `AppState.memoryRuntime`
   * is populated so the sync/include routes work instead of 503-ing.
   */
  enableMemory: boolean;
  /**
   * Enable LSP-backed post-edit diagnostics (`JARVIS_ENABLE_LSP`, off by
   * default). When on AND a write primitive is enabled, the composition root
   * spawns language servers on demand and `fs.write` / `fs.edit` / `fs.patch`
   * append a `<diagnostics>` block for the files they wrote. Servers are
   * PATH-probed; absent servers no-op.
   */
  enableLsp: boolean;
  /** Parent of the user-scope memory tree (`<root>/.jarvis/memory/`); defaults
   * to the home dir. `undefined` disables user-scope memory. */
  memoryUserRoot?: string;
  /** Memory sync transport (`JARVIS_MEMORY_SYNC_BACKEND`: none/git/icloud). */
  memorySyncBackend: MemorySyncBackend;

  mcpServers: McpServerSpec[];
  router: RouterConfigParsed;
  /**
   * Operator route-policy slot seeds from `JARVIS_ROUTE_*` (slot → raw
   * `"provider/model"`). Seeds the in-process /v1/routing policy at boot;
   * only `summarization` is consumed today (by the summariser).
   */
  routeSlots: Record<string, string>;
  workMode: WorkMode;
  workTickSeconds: number;
  workMaxConcurrent: number;

  // ---- Remote access (native mobile client + DDNS) ----
  /**
   * Bearer token required of NON-loopback callers (`JARVIS_ACCESS_TOKEN`). When
   * unset, the server stays unauthenticated (today's behaviour) — safe only on
   * loopback / a trusted LAN. MUST be set before exposing the server externally
   * (DDNS / 0.0.0.0 bind): the auth hook then 401s remote requests without it.
   */
  accessToken?: string;
  /** Advertise `_jarvis._tcp` over mDNS for zero-config LAN discovery
   * (`JARVIS_MDNS`). Off by default so a plain `serve` never starts a multicast
   * responder unasked. */
  mdns: boolean;
  /** Friendly device name surfaced by `GET /v1/remote/info` (the iOS connect
   * screen). `JARVIS_DEVICE_NAME`, defaults to the OS hostname. */
  deviceName: string;
  /** Create the DdnsRuntime (so `/v1/ddns/*` work) — set by `JARVIS_DDNS_ENABLE`
   * or implied by a `JARVIS_DDNS_PROVIDER` seed. */
  ddnsEnabled: boolean;
  /** Optional initial DDNS config seeded from env (the iOS app PUTs the rest). */
  ddnsSeed?: DdnsConfigInput;
}

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/** Any non-empty value other than `0`/`false`/`no`/`off` enables the flag. */
function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}

/** Home dir, or undefined when unresolvable (→ user-scope memory disabled). */
function homeDirOrUndefined(): string | undefined {
  try {
    const h = os.homedir();
    return h === "" ? undefined : h;
  } catch {
    return undefined;
  }
}

/** First non-empty value among the listed env keys, else undefined. */
function firstNonEmpty(env: Env, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function parseIntOr(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsvList(v: string | undefined): string[] | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return out.length > 0 ? out : undefined;
}

/** Canonicalise the provider name; unknown values fall back to `openai`. */
function parseProvider(v: string | undefined): ProviderKind {
  switch ((v ?? "").trim().toLowerCase()) {
    case "openai":
      return "openai";
    case "openai-responses":
      return "openai-responses";
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "codex":
      return "codex";
    case "kimi":
    case "moonshot":
      return "kimi";
    case "ollama":
      return "ollama";
    default:
      return "openai";
  }
}

function parsePermissionMode(v: string | undefined): PermissionModeName {
  switch ((v ?? "").trim().toLowerCase()) {
    case "accept-edits":
      return "accept-edits";
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "bypass":
      return "bypass";
    case "ask":
      return "ask";
    default:
      return "ask";
  }
}

function parseMemoryMode(v: string | undefined): MemoryMode {
  return (v ?? "").trim().toLowerCase() === "summary" ? "summary" : "window";
}

function parseWorkMode(v: string | undefined): WorkMode {
  return (v ?? "").trim().toLowerCase() === "auto" ? "auto" : "off";
}

const DDNS_PROVIDERS: readonly DdnsProviderKind[] = [
  "cloudflare",
  "duckdns",
  "dyndns2",
  "aliyun",
  "dnspod",
];

function parseDdnsProvider(v: string | undefined): DdnsProviderKind | undefined {
  const s = (v ?? "").trim().toLowerCase();
  return (DDNS_PROVIDERS as readonly string[]).includes(s) ? (s as DdnsProviderKind) : undefined;
}

/**
 * Parse the `JARVIS_DDNS_*` env into an enable flag + optional seed config. The
 * runtime is created whenever `JARVIS_DDNS_ENABLE` is truthy OR a valid
 * `JARVIS_DDNS_PROVIDER` is present; the seed (provider + hostname) is applied
 * only on first run when no persisted config exists. Credentials come as a JSON
 * object in `JARVIS_DDNS_CREDENTIALS` (kept off the flat env surface so secrets
 * aren't sprinkled across a dozen vars).
 */
function parseDdnsEnv(env: Env, defaultPort: number): { enabled: boolean; seed?: DdnsConfigInput } {
  const provider = parseDdnsProvider(firstNonEmpty(env, "JARVIS_DDNS_PROVIDER"));
  const enabled = truthy(env.JARVIS_DDNS_ENABLE) || provider !== undefined;
  if (!enabled) return { enabled: false };
  const hostname = firstNonEmpty(env, "JARVIS_DDNS_HOSTNAME");
  if (provider === undefined || hostname === undefined) return { enabled: true };

  let credentials: Record<string, string> = {};
  const raw = firstNonEmpty(env, "JARVIS_DDNS_CREDENTIALS");
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        credentials = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      // Malformed JSON → no seed credentials (the iOS app can PUT them later).
    }
  }
  const seed: DdnsConfigInput = {
    provider,
    hostname,
    port: parseIntOr(firstNonEmpty(env, "JARVIS_DDNS_PORT"), defaultPort),
    interval_seconds: parseIntOr(firstNonEmpty(env, "JARVIS_DDNS_INTERVAL"), 300),
    upnp_enabled: truthy(env.JARVIS_DDNS_UPNP),
    credentials,
  };
  return { enabled: true, seed };
}

/**
 * Parse `JARVIS_MCP_SERVERS` — comma-separated `prefix=command args...`. A
 * malformed entry (no `=`, empty prefix, or empty command) is skipped. The
 * command tail is whitespace-split for argv (no shell quoting — matches the
 * Rust env parsing's simple split).
 */
export function parseMcpServers(raw: string | undefined): McpServerSpec[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: McpServerSpec[] = [];
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const prefix = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1).trim();
    if (prefix === "" || rest === "") continue;
    const parts = rest.split(/\s+/);
    const command = parts[0];
    if (command === undefined || command === "") continue;
    out.push({ prefix, transport: { type: "stdio", command, args: parts.slice(1) } });
  }
  return out;
}

/**
 * Parse Composio's managed MCP endpoint into a normal Jarvis MCP config.
 *
 * Supported env shapes:
 * - `JARVIS_COMPOSIO_MCP_URL` — a full generated Composio MCP URL.
 * - `JARVIS_COMPOSIO_MCP_SERVER_ID` + `JARVIS_COMPOSIO_USER_ID` — builds
 *   `https://backend.composio.dev/v3/mcp/<server_id>?user_id=<user_id>`.
 *
 * `JARVIS_COMPOSIO_API_KEY` or `COMPOSIO_API_KEY` is sent as the `x-api-key`
 * header when present, matching Composio's MCP docs. Optional allow/deny lists
 * use comma-separated remote tool names.
 */
export function parseComposioMcpServer(env: Env): McpServerSpec | undefined {
  const explicitUrl = firstNonEmpty(env, "JARVIS_COMPOSIO_MCP_URL", "COMPOSIO_MCP_URL");
  const serverId = firstNonEmpty(env, "JARVIS_COMPOSIO_MCP_SERVER_ID", "COMPOSIO_MCP_SERVER_ID");
  const userId = firstNonEmpty(env, "JARVIS_COMPOSIO_USER_ID", "COMPOSIO_USER_ID");
  const url =
    explicitUrl ??
    (serverId !== undefined && userId !== undefined
      ? `https://backend.composio.dev/v3/mcp/${encodeURIComponent(serverId)}?user_id=${encodeURIComponent(userId)}`
      : undefined);
  if (url === undefined) return undefined;

  const apiKey = firstNonEmpty(env, "JARVIS_COMPOSIO_API_KEY", "COMPOSIO_API_KEY");
  const headers = apiKey !== undefined ? { "x-api-key": apiKey } : undefined;
  const cfg: McpServerSpec = {
    prefix: firstNonEmpty(env, "JARVIS_COMPOSIO_PREFIX") ?? "composio",
    transport: {
      type: "streamable-http",
      url,
      ...(headers !== undefined ? { headers } : {}),
    },
  };
  const allowTools = parseCsvList(firstNonEmpty(env, "JARVIS_COMPOSIO_ALLOW_TOOLS"));
  const denyTools = parseCsvList(firstNonEmpty(env, "JARVIS_COMPOSIO_DENY_TOOLS"));
  if (allowTools !== undefined) cfg.allowTools = allowTools;
  if (denyTools !== undefined) cfg.denyTools = denyTools;
  return cfg;
}

/**
 * Parse env into a {@link JarvisConfig}. Pure: reads only the injected `env`
 * map (defaults to `process.env`) and returns a plain object. No I/O, no
 * provider/store construction.
 */
export function loadConfig(env: Env = process.env): JarvisConfig {
  const provider = parseProvider(env.JARVIS_PROVIDER);
  const model = firstNonEmpty(env, "JARVIS_MODEL") ?? defaultModel(provider);

  const gating: ToolGating = {
    enableFsWrite: truthy(env.JARVIS_ENABLE_FS_WRITE),
    enableFsEdit: truthy(env.JARVIS_ENABLE_FS_EDIT),
    enableFsPatch: truthy(env.JARVIS_ENABLE_FS_PATCH),
    enableShellExec: truthy(env.JARVIS_ENABLE_SHELL_EXEC),
    shellTimeoutMs: parseIntOr(env.JARVIS_SHELL_TIMEOUT_MS, 30_000),
    // git.* read group is ON by default; the env var DISABLES it.
    enableGitRead: !truthy(env.JARVIS_DISABLE_GIT_READ),
    httpMaxBytes: parseIntOr(env.JARVIS_HTTP_MAX_BYTES, 256 * 1024),
    httpAllowPrivateHosts: truthy(env.JARVIS_HTTP_ALLOW_PRIVATE),
  };

  const memoryTokensRaw = firstNonEmpty(env, "JARVIS_MEMORY_TOKENS");
  const memoryTokens = memoryTokensRaw === undefined ? undefined : parseIntOr(memoryTokensRaw, 0);

  // Memory `memory.*` surface + sync routes. `userRoot` defaults to the home dir
  // (so user-scope memory works out of the box); an unparseable backend falls
  // back to `none` (sync disabled, includes still usable).
  const enableMemory = truthy(env.JARVIS_ENABLE_MEMORY);
  const enableLsp = truthy(env.JARVIS_ENABLE_LSP);
  const memorySyncBackend =
    memorySyncBackendFromWire(firstNonEmpty(env, "JARVIS_MEMORY_SYNC_BACKEND") ?? "none") ?? "none";
  const memoryUserRoot = firstNonEmpty(env, "JARVIS_MEMORY_USER_ROOT") ?? homeDirOrUndefined();

  const router: RouterConfigParsed = {
    enabled: truthy(env.JARVIS_ROUTER_ENABLED),
    simple: firstNonEmpty(env, "JARVIS_ROUTER_TIER_SIMPLE"),
    medium: firstNonEmpty(env, "JARVIS_ROUTER_TIER_MEDIUM"),
    complex: firstNonEmpty(env, "JARVIS_ROUTER_TIER_COMPLEX"),
    reasoning: firstNonEmpty(env, "JARVIS_ROUTER_TIER_REASONING"),
  };

  const routeSlots: Record<string, string> = {};
  for (const [slot, envVar] of [
    ["default", "JARVIS_ROUTE_DEFAULT"],
    ["coding", "JARVIS_ROUTE_CODING"],
    ["review", "JARVIS_ROUTE_REVIEW"],
    ["summarization", "JARVIS_ROUTE_SUMMARIZATION"],
    ["doc_reader", "JARVIS_ROUTE_DOC_READER"],
    ["vision", "JARVIS_ROUTE_VISION"],
    ["local_private", "JARVIS_ROUTE_LOCAL_PRIVATE"],
  ] as const) {
    const v = firstNonEmpty(env, envVar);
    if (v) routeSlots[slot] = v;
  }

  const composioMcp = parseComposioMcpServer(env);
  const mcpServers = parseMcpServers(env.JARVIS_MCP_SERVERS);
  if (composioMcp !== undefined) mcpServers.push(composioMcp);

  const addr = firstNonEmpty(env, "JARVIS_ADDR") ?? "0.0.0.0:7001";
  const ddnsEnv = parseDdnsEnv(env, parseAddr(addr).port);

  return {
    provider,
    model,
    routeSlots,
    openaiApiKey: firstNonEmpty(env, "OPENAI_API_KEY"),
    anthropicApiKey: firstNonEmpty(env, "ANTHROPIC_API_KEY"),
    googleApiKey: firstNonEmpty(env, "GOOGLE_API_KEY", "GEMINI_API_KEY"),
    kimiApiKey: firstNonEmpty(env, "KIMI_API_KEY", "MOONSHOT_API_KEY"),
    ollamaApiKey: firstNonEmpty(env, "OLLAMA_API_KEY"),
    openaiBaseUrl: firstNonEmpty(env, "OPENAI_BASE_URL"),
    anthropicBaseUrl: firstNonEmpty(env, "ANTHROPIC_BASE_URL"),
    googleBaseUrl: firstNonEmpty(env, "GOOGLE_BASE_URL"),
    kimiBaseUrl: firstNonEmpty(env, "KIMI_BASE_URL"),
    codexBaseUrl: firstNonEmpty(env, "CODEX_BASE_URL"),
    ollamaBaseUrl: firstNonEmpty(env, "OLLAMA_BASE_URL"),
    anthropicVersion: firstNonEmpty(env, "ANTHROPIC_VERSION"),
    codexAccessToken: firstNonEmpty(env, "CODEX_ACCESS_TOKEN"),
    codexAccountId: firstNonEmpty(env, "CODEX_ACCOUNT_ID"),
    codexHome: firstNonEmpty(env, "CODEX_HOME"),

    addr,
    fsRoot: firstNonEmpty(env, "JARVIS_FS_ROOT") ?? ".",
    webDistDir: firstNonEmpty(env, "JARVIS_WEB_DIST"),
    includeProjectContext: !truthy(env.JARVIS_NO_PROJECT_CONTEXT),
    projectContextMaxBytes: parseIntOr(env.JARVIS_PROJECT_CONTEXT_BYTES, 8 * 1024),
    codingPromptAuto: true,

    gating,
    permissionMode: parsePermissionMode(env.JARVIS_PERMISSION_MODE),

    dbUrl: firstNonEmpty(env, "JARVIS_DB_URL"),
    disableTodos: truthy(env.JARVIS_DISABLE_TODOS),

    memoryTokens,
    memoryMode: parseMemoryMode(env.JARVIS_MEMORY_MODE),
    memoryModel: firstNonEmpty(env, "JARVIS_MEMORY_MODEL"),
    enableMemory,
    enableLsp,
    memorySyncBackend,
    memoryUserRoot,

    mcpServers,
    router,
    workMode: parseWorkMode(env.JARVIS_WORK_MODE),
    workTickSeconds: parseIntOr(env.JARVIS_WORK_TICK_SECONDS, 30),
    workMaxConcurrent: parseIntOr(env.JARVIS_WORK_MAX_CONCURRENT, 2),

    accessToken: firstNonEmpty(env, "JARVIS_ACCESS_TOKEN"),
    mdns: truthy(env.JARVIS_MDNS),
    deviceName: firstNonEmpty(env, "JARVIS_DEVICE_NAME") ?? safeHostname(),
    ddnsEnabled: ddnsEnv.enabled,
    ...(ddnsEnv.seed !== undefined ? { ddnsSeed: ddnsEnv.seed } : {}),
  };
}

/** OS hostname, or a stable fallback when it can't be read. */
function safeHostname(): string {
  try {
    return os.hostname() || "jarvis";
  } catch {
    return "jarvis";
  }
}

/**
 * Split a `host:port` address (the `JARVIS_ADDR` form) into Fastify's
 * `{ host, port }`. IPv6 isn't handled (parity with the simple Rust parse);
 * an unparseable port falls back to 7001.
 */
export function parseAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) return { host: addr, port: 7001 };
  const host = addr.slice(0, idx) || "0.0.0.0";
  const port = parseIntOr(addr.slice(idx + 1), 7001);
  return { host, port };
}
