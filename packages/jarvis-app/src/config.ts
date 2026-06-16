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
import { ProfileRegistry, canonicalKind } from "@jarvis/llm";

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

/** One MCP server spec parsed from `JARVIS_MCP_SERVERS` (`prefix=command args`). */
export interface McpServerSpec {
  prefix: string;
  command: string;
  args: string[];
}

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

  mcpServers: McpServerSpec[];
  router: RouterConfigParsed;
  workMode: WorkMode;
  workTickSeconds: number;
  workMaxConcurrent: number;
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
    out.push({ prefix, command, args: parts.slice(1) });
  }
  return out;
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
  };

  const memoryTokensRaw = firstNonEmpty(env, "JARVIS_MEMORY_TOKENS");
  const memoryTokens = memoryTokensRaw === undefined ? undefined : parseIntOr(memoryTokensRaw, 0);

  const router: RouterConfigParsed = {
    enabled: truthy(env.JARVIS_ROUTER_ENABLED),
    simple: firstNonEmpty(env, "JARVIS_ROUTER_TIER_SIMPLE"),
    medium: firstNonEmpty(env, "JARVIS_ROUTER_TIER_MEDIUM"),
    complex: firstNonEmpty(env, "JARVIS_ROUTER_TIER_COMPLEX"),
    reasoning: firstNonEmpty(env, "JARVIS_ROUTER_TIER_REASONING"),
  };

  return {
    provider,
    model,
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

    addr: firstNonEmpty(env, "JARVIS_ADDR") ?? "0.0.0.0:7001",
    fsRoot: firstNonEmpty(env, "JARVIS_FS_ROOT") ?? ".",
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

    mcpServers: parseMcpServers(env.JARVIS_MCP_SERVERS),
    router,
    workMode: parseWorkMode(env.JARVIS_WORK_MODE),
    workTickSeconds: parseIntOr(env.JARVIS_WORK_TICK_SECONDS, 30),
    workMaxConcurrent: parseIntOr(env.JARVIS_WORK_MAX_CONCURRENT, 2),
  };
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
