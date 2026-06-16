// CLI config — parsed from an INJECTED env object so tests pass a fixture env
// (never mutating the real process.env). Mirrors the env contract documented
// in the root CLAUDE.md "Environment variables" section, but scoped to what a
// terminal coding-agent actually needs: provider/model/keys + fsRoot + tool
// gating + permission mode. Deliberately simpler than the jarvis-app server
// composition root — no Codex OAuth flow, no auth store, no config file. The
// Rust precedent is apps/jarvis-cli/src/provider.rs ("a quick local turn"
// tool; for OAuth / stored credentials run `jarvis serve" instead).
//
// This is a composition root: it is one of the two packages (alongside
// @jarvis/jarvis-app) where reading process.env is allowed by the lint rule.

/** Provider identifiers the CLI knows how to construct env-only. */
export type ProviderKind = "openai" | "anthropic" | "google" | "ollama" | "kimi" | "openai-responses";

/**
 * Permission mode. The full enum from the env contract is accepted; only the
 * pipe-mode auto-approve distinction (`auto` / `bypass`) is load-bearing today
 * because the Node @jarvis/core does not yet expose a tool-filter (Plan Mode is
 * deferred). REPL approvals are per-call regardless of mode.
 */
export type PermissionMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "accept-edits",
  "plan",
  "auto",
  "bypass",
];

/** Short-term memory backend selector. */
export type MemoryMode = "window" | "summary";

/** Fully-resolved CLI configuration. The agent + REPL build off this. */
export interface CliConfig {
  provider: ProviderKind;
  /** Resolved model id (provider default unless overridden). */
  model: string;
  /** Provider API key (empty string for ollama, which talks to a local server). */
  apiKey: string;
  /** Optional base-URL override (Kimi/Ollama/proxies). */
  baseUrl?: string;
  /** `anthropic-version` header (anthropic only). */
  anthropicVersion?: string;

  /** Workspace root for fs.* / git.* / code.grep / shell.exec. */
  fsRoot: string;

  /** Tool gating — write/exec primitives are opt-in. */
  enableFsWrite: boolean;
  enableFsEdit: boolean;
  enableFsPatch: boolean;
  enableShellExec: boolean;
  enableGitRead: boolean;
  enableEnterPlanMode: boolean;
  shellTimeoutMs: number;

  /** Initial permission mode. */
  permissionMode: PermissionMode;

  /** Cap on agent-loop iterations per turn. */
  maxIterations: number;

  /** Whether to auto-load AGENTS.md / CLAUDE.md / AGENT.md into the prompt. */
  includeProjectContext: boolean;
  /** Byte cap for the project-context block. */
  projectContextBytes: number;

  /** Short-term memory: undefined disables (full history every turn). */
  memoryTokens?: number;
  memoryMode: MemoryMode;
  memoryModel?: string;
}

/** Per-provider default model. Mirrors the env-contract table. */
const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "gpt-4o-mini",
  "openai-responses": "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-1.5-flash",
  ollama: "llama3.2",
  kimi: "kimi-k2-thinking",
};

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_PROJECT_CONTEXT_BYTES = 32 * 1024;

type Env = Record<string, string | undefined>;

/** Truthy iff the env var is set to ANY non-empty value (matches the Rust gate). */
function envFlag(env: Env, key: string): boolean {
  const v = env[key];
  return v !== undefined && v !== "";
}

function parseProvider(raw: string | undefined): ProviderKind {
  const v = (raw ?? "openai").trim().toLowerCase();
  switch (v) {
    case "openai":
    case "anthropic":
    case "google":
    case "ollama":
    case "kimi":
    case "openai-responses":
      return v;
    case "":
      return "openai";
    default:
      throw new Error(
        `unknown provider \`${raw}\`; CLI supports openai / anthropic / google / ollama / kimi / openai-responses`,
      );
  }
}

export function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === undefined || raw.trim() === "") return "ask";
  const v = raw.trim().toLowerCase();
  if ((ALL_PERMISSION_MODES as readonly string[]).includes(v)) return v as PermissionMode;
  throw new Error(
    `permission_mode=\`${raw}\` not recognised; use ask / accept-edits / plan / auto / bypass`,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the API key for the chosen provider, applying the documented aliases. */
function resolveApiKey(env: Env, provider: ProviderKind): string {
  switch (provider) {
    case "openai":
    case "openai-responses": {
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error(`OPENAI_API_KEY is required for provider=${provider}`);
      return key;
    }
    case "anthropic": {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is required for provider=anthropic");
      return key;
    }
    case "google": {
      // GEMINI_API_KEY is an accepted alias (per the env contract).
      const key = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
      if (!key) throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is required for provider=google");
      return key;
    }
    case "kimi": {
      // MOONSHOT_API_KEY is an accepted alias (per the env contract).
      const key = env.KIMI_API_KEY ?? env.MOONSHOT_API_KEY;
      if (!key) throw new Error("KIMI_API_KEY or MOONSHOT_API_KEY is required for provider=kimi");
      return key;
    }
    case "ollama":
      // Local server ignores the key; some hosted proxies gate via OLLAMA_API_KEY.
      return env.OLLAMA_API_KEY ?? "ollama";
  }
}

/** Resolve the optional base-URL override for the chosen provider. */
function resolveBaseUrl(env: Env, provider: ProviderKind): string | undefined {
  switch (provider) {
    case "openai":
    case "openai-responses":
      return env.OPENAI_BASE_URL;
    case "anthropic":
      return env.ANTHROPIC_BASE_URL;
    case "google":
      return env.GOOGLE_BASE_URL;
    case "kimi":
      return env.KIMI_BASE_URL ?? DEFAULT_KIMI_BASE_URL;
    case "ollama":
      return env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  }
}

/**
 * Optional overrides a caller (argv parser) can layer on top of the env. CLI
 * flags win over env; env wins over built-in defaults. `undefined` fields fall
 * through to the env / default resolution.
 */
export interface CliConfigOverrides {
  provider?: string;
  model?: string;
  fsRoot?: string;
  permissionMode?: string;
  /** Force-enable fs.write (the `--allow-fs-write` flag). */
  allowFsWrite?: boolean;
  /** Force-enable shell.exec (the `--allow-shell` flag). */
  allowShell?: boolean;
  /** Force-disable the git.* read tools (the `--no-git-read` flag). */
  noGitRead?: boolean;
  /** Force-disable project-context auto-load (the `--no-project-context` flag). */
  noProjectContext?: boolean;
  maxIterations?: number;
}

/**
 * Build a {@link CliConfig} from an injected env object (defaults to the real
 * process.env in production; tests pass a fixture). Optional {@link
 * CliConfigOverrides} (parsed from argv) take precedence over env.
 *
 * Documented env knobs the CLI deliberately SKIPS (the server's job, not a
 * quick-local-turn tool's): JARVIS_DB_URL persistence, JARVIS_ROUTER_*, the
 * JARVIS_WORK_* auto-loop, JARVIS_MCP_SERVERS, Codex OAuth (CODEX_*), the
 * Responses reasoning knobs, and the operator-static JARVIS_ROUTE_* slots.
 */
export function loadCliConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: CliConfigOverrides = {},
): CliConfig {
  const provider = parseProvider(overrides.provider ?? env.JARVIS_PROVIDER);
  const apiKey = resolveApiKey(env, provider);
  const baseUrl = resolveBaseUrl(env, provider);
  const model = overrides.model?.trim() || env.JARVIS_MODEL?.trim() || DEFAULT_MODELS[provider];

  // Tool gating. The CLI defaults to "edits + patches on, write/shell off" —
  // the right balance for a coding REPL (the model iterates on existing files
  // without tripping fs.write's blunter semantics). Approval-gated regardless.
  // The JARVIS_ENABLE_* env flags and the `--allow-*` argv flags both opt in.
  const enableFsWrite = (overrides.allowFsWrite ?? false) || envFlag(env, "JARVIS_ENABLE_FS_WRITE");
  // fs.edit / fs.patch are ON unconditionally for the coding REPL — this mirrors
  // the Rust reference (apps/jarvis-cli/src/runner.rs::build_tools hardcodes
  // `enable_fs_edit: true` / `enable_fs_patch: true` with no env check). They
  // stay approval-gated regardless. (The earlier `envFlag(...) || true` form was
  // a no-op OR — the env read was dead — so it's collapsed to the literal.)
  const enableFsEdit = true;
  const enableFsPatch = true;
  const enableShellExec = (overrides.allowShell ?? false) || envFlag(env, "JARVIS_ENABLE_SHELL_EXEC");
  const enableGitRead = !((overrides.noGitRead ?? false) || envFlag(env, "JARVIS_DISABLE_GIT_READ"));

  const memoryTokensRaw = env.JARVIS_MEMORY_TOKENS;
  const memoryTokens =
    memoryTokensRaw !== undefined && memoryTokensRaw.trim() !== ""
      ? parsePositiveInt(memoryTokensRaw, 0) || undefined
      : undefined;
  const memoryMode: MemoryMode = env.JARVIS_MEMORY_MODE?.trim().toLowerCase() === "summary" ? "summary" : "window";

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    anthropicVersion: env.ANTHROPIC_VERSION,
    fsRoot: overrides.fsRoot ?? env.JARVIS_FS_ROOT ?? ".",
    enableFsWrite,
    enableFsEdit,
    enableFsPatch,
    enableShellExec,
    enableGitRead,
    // Coding REPL benefits from the model volunteering a plan-first pass.
    enableEnterPlanMode: true,
    shellTimeoutMs: parsePositiveInt(env.JARVIS_SHELL_TIMEOUT_MS, DEFAULT_SHELL_TIMEOUT_MS),
    permissionMode: parsePermissionMode(overrides.permissionMode ?? env.JARVIS_PERMISSION_MODE),
    maxIterations: overrides.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    includeProjectContext: !((overrides.noProjectContext ?? false) || envFlag(env, "JARVIS_NO_PROJECT_CONTEXT")),
    projectContextBytes: parsePositiveInt(env.JARVIS_PROJECT_CONTEXT_BYTES, DEFAULT_PROJECT_CONTEXT_BYTES),
    memoryTokens,
    memoryMode,
    memoryModel: env.JARVIS_MEMORY_MODEL?.trim() || undefined,
  };
}
