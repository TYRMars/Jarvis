// Provider profiles: a data-driven catalog of LLM provider kinds.
// Ported from harness-llm/src/profile.rs.
//
// The composition root historically grew an N-arm `match name` block — every
// new OpenAI-compatible backend (OpenRouter, NVIDIA NIM, Moonshot, MiniMax,
// MiMo, LM Studio, …) needed a code change. A profile captures the *data* that
// differs between those backends — default base URL, default model, env-var
// name for the API key, transport family (Chat Completions vs Responses vs
// Anthropic Messages vs Google generateContent) — so the binary's match
// collapses to a handful of `ProviderTransport` arms while new backends become
// a single static entry in BUILTIN_PROFILES.
//
// Profiles also carry a static ModelCapability catalog so the Web UI can
// render capability badges (tools / vision / reasoning / long-context / local)
// without making the user type each field by hand. The catalog is best-effort
// — entries that aren't known are returned as `undefined` and the UI falls
// through to a conservative "unknown" rendering rather than blocking the
// request.
//
// Phase 0 keeps the catalog *static*. A later phase can plug in dynamic
// discovery (OpenRouter `/v1/models`, etc.) without changing this surface.
//
// In addition to the data catalog (the Rust module's whole content), this port
// realises the concept the catalog exists to serve: ProfileProvider wraps an
// inner LlmProvider and applies the profile's per-request defaults — filling in
// the default model when none is set, and refusing model overrides for kinds
// whose request_compat.modelFieldPassthrough is false (Codex). This mirrors
// what apps/jarvis::serve::build_provider does in Rust at the composition root.
import { ProviderError } from "@jarvis/core";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";

// ---------- Enumerated tags (serde rename_all in Rust → string unions here) ----------

/**
 * Wire-shape family the provider speaks. Determines which LlmProvider impl the
 * binary should construct for an entry of this kind. (serde kebab-case)
 */
export type ProviderTransport =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generate-content";

/**
 * How the provider authenticates outbound requests. Externally-tagged on
 * `kind` (serde `tag = "kind"`, kebab-case).
 * - `api-key-header`: send an API key on a custom header; `scheme` optional —
 *   when set, the value renders as `<scheme> <key>` (Anthropic: `x-api-key`,
 *   no scheme).
 * - `bearer`: standard `Authorization: Bearer <key>`.
 * - `codex-oauth`: ChatGPT subscription OAuth — Codex backend.
 * - `none`: no auth required (e.g. local Ollama).
 */
export type AuthKind =
  | { kind: "api-key-header"; header: string; scheme?: string }
  | { kind: "bearer" }
  | { kind: "codex-oauth" }
  | { kind: "none" };

/** Modality the model accepts on input or produces on output. (serde lowercase) */
export type Modality = "text" | "image" | "audio" | "video";

/** Rough cost band, surfaced as a UI badge. Default `unknown`. (serde kebab-case) */
export type CostHint = "free-local" | "low" | "medium" | "high" | "unknown";

/** Rough latency band (perception, not p50). Default `unknown`. (serde kebab-case) */
export type LatencyHint = "fast" | "balanced" | "slow" | "unknown";

/** Privacy stance of the provider. Default `unknown`. (serde kebab-case) */
export type PrivacyHint = "local" | "first-party-cloud" | "third-party-router" | "unknown";

/** How the wire shape encodes tool calls. Default `unknown`. (serde kebab-case) */
export type ToolCallStyle =
  | "open-ai"
  | "anthropic"
  | "google"
  | "open-ai-responses"
  | "none"
  | "unknown";

/** How the model accepts strict JSON / schema-typed output. Default `unknown`. (serde kebab-case) */
export type JsonSchemaStyle = "open-ai" | "tool-schema" | "none" | "unknown";

/** How the model surfaces reasoning blocks. Default `unknown`. (serde kebab-case) */
export type ReasoningStyle = "open-ai-reasoning" | "anthropic-thinking" | "none" | "unknown";

/**
 * Compatibility hints for request shaping. Phase 0 stores these; Phase 4 (auto
 * routing) consumes them for capability validation.
 */
export interface RequestCompat {
  toolCallStyle: ToolCallStyle;
  jsonSchemaStyle: JsonSchemaStyle;
  reasoningStyle: ReasoningStyle;
  /**
   * When `false`, the provider rejects requests whose `model` differs from its
   * configured default. Most providers pass it through — Codex famously doesn't.
   */
  modelFieldPassthrough: boolean;
}

// ---------- ModelCapability ----------

/**
 * One model's capability snapshot. Surfaced via `GET /v1/model-catalog` and
 * used by the chat-input validator to short-circuit "you're requesting tools
 * but this model doesn't do tools" requests.
 *
 * Every capability field is optional so "we don't know" is distinguishable
 * from "no, definitively not". Unknown fields fall through to "skip the
 * validation" — never block a request because we lack a catalog entry.
 *
 * Optional fields are omitted (not set to defaults) so JSON.stringify matches
 * serde's `skip_serializing_if`. `costHint` / `latencyHint` / `privacyHint`
 * default to `"unknown"` and are likewise skipped when default.
 */
export interface ModelCapability {
  /** Provider kind (matches ProviderProfile.kind). */
  provider: string;
  /** The wire model id — what we send on `model:`. */
  model: string;
  displayName?: string;
  /** Family bucket for grouping in the picker (e.g. `"gpt-5"`). */
  family?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: Modality[];
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
  supportsImages?: boolean;
  supportsEmbeddings?: boolean;
  costHint?: CostHint;
  latencyHint?: LatencyHint;
  privacyHint?: PrivacyHint;
}

/**
 * Quick UI badge list. Order is stable so renderers can rely on it without
 * sorting. Mirrors `ModelCapability::badges`.
 */
export function capabilityBadges(c: ModelCapability): string[] {
  const out: string[] = [];
  if (c.supportsToolCalls === true) out.push("tools");
  if (c.supportsReasoning === true) out.push("reasoning");
  if (c.supportsImages === true || (c.inputModalities ?? []).includes("image")) out.push("vision");
  if ((c.contextWindow ?? 0) >= 64_000) out.push("64k+");
  if (c.privacyHint === "local") out.push("local");
  else if (c.privacyHint === "third-party-router") out.push("router");
  return out;
}

// ---------- ProviderProfile ----------

/**
 * The full description of a provider kind. Returned from `ProfileRegistry.get`
 * and consumed by the binary's `build_provider` dispatch.
 */
export interface ProviderProfile {
  /** Stable id used as the `kind` field. Lowercase kebab-case. */
  kind: string;
  /** Human-readable label for the provider wizard. */
  displayName: string;
  transport: ProviderTransport;
  /**
   * HTTP base URL applied when the user doesn't supply one. `null` only for
   * Codex (the binary derives the URL from the Codex preset).
   */
  defaultBaseUrl: string | null;
  auth: AuthKind;
  /**
   * Env vars the binary should consult, in order, when looking for an API key.
   * The auth-store is always tried after these.
   */
  apiKeyEnv: string[];
  /** Default model id sent on the wire when no explicit override is configured. */
  defaultModel: string;
  /** Static catalog of known models. Each entry's `provider` must match `kind`. */
  modelCatalog: ModelCapability[];
  /** Bare-model-name prefixes that route to this provider via prefix rules. */
  modelPrefixes: string[];
  requestCompat: RequestCompat;
  /**
   * `true` when the operator should treat the catalog defaults as "verify
   * against the live endpoint before relying on them".
   */
  verificationRequired: boolean;
}

/** Best-effort capability lookup for a model within one profile. */
export function capabilityFor(p: ProviderProfile, model: string): ModelCapability | undefined {
  return p.modelCatalog.find((c) => c.model === model);
}

// ---------- Built-in catalog ----------

// Reusable RequestCompat presets (mirror the Rust `let openai_compat = …`).
const OPENAI_COMPAT: RequestCompat = {
  toolCallStyle: "open-ai",
  jsonSchemaStyle: "open-ai",
  reasoningStyle: "none",
  modelFieldPassthrough: true,
};
const OPENAI_RESPONSES_COMPAT: RequestCompat = {
  toolCallStyle: "open-ai-responses",
  jsonSchemaStyle: "open-ai",
  reasoningStyle: "open-ai-reasoning",
  modelFieldPassthrough: true,
};
const ANTHROPIC_COMPAT: RequestCompat = {
  toolCallStyle: "anthropic",
  jsonSchemaStyle: "tool-schema",
  reasoningStyle: "anthropic-thinking",
  modelFieldPassthrough: true,
};
const GOOGLE_COMPAT: RequestCompat = {
  toolCallStyle: "google",
  jsonSchemaStyle: "tool-schema",
  reasoningStyle: "none",
  modelFieldPassthrough: true,
};
const CODEX_COMPAT: RequestCompat = {
  toolCallStyle: "open-ai-responses",
  jsonSchemaStyle: "open-ai",
  reasoningStyle: "open-ai-reasoning",
  // Codex backend rejects `model:` overrides — see responses.ts notes.
  modelFieldPassthrough: false,
};

/**
 * Compact ModelCapability constructor mirroring the Rust `mc(...)` helper:
 * fixes `supportsStreaming = true`, leaves everything not passed unset (so it
 * serialises as absent). Omits `undefined` fields so JSON.stringify matches
 * serde and `"unknown"` hint defaults are skipped.
 */
function mc(
  provider: string,
  model: string,
  display: string | undefined,
  family: string | undefined,
  ctx: number | undefined,
  tools: boolean | undefined,
  reasoning: boolean | undefined,
  vision: boolean | undefined,
  cost: CostHint,
  latency: LatencyHint,
  privacy: PrivacyHint,
): ModelCapability {
  const out: ModelCapability = { provider, model };
  if (display !== undefined) out.displayName = display;
  if (family !== undefined) out.family = family;
  if (ctx !== undefined) out.contextWindow = ctx;
  out.supportsStreaming = true;
  if (tools !== undefined) out.supportsToolCalls = tools;
  if (reasoning !== undefined) out.supportsReasoning = reasoning;
  if (vision !== undefined) out.supportsImages = vision;
  if (cost !== "unknown") out.costHint = cost;
  if (latency !== "unknown") out.latencyHint = latency;
  if (privacy !== "unknown") out.privacyHint = privacy;
  return out;
}

function buildBuiltinProfiles(): ProviderProfile[] {
  const openaiModels: ModelCapability[] = [
    mc("openai", "gpt-4o", "GPT-4o", "gpt-4o", 128_000, true, false, true, "medium", "balanced", "first-party-cloud"),
    mc("openai", "gpt-4o-mini", "GPT-4o mini", "gpt-4o", 128_000, true, false, true, "low", "fast", "first-party-cloud"),
  ];
  const openaiResponsesModels: ModelCapability[] = [
    mc("openai-responses", "gpt-4o", "GPT-4o (Responses)", "gpt-4o", 128_000, true, false, true, "medium", "balanced", "first-party-cloud"),
    mc("openai-responses", "o1", "o1 (reasoning)", "o-series", 200_000, true, true, true, "high", "slow", "first-party-cloud"),
  ];
  const codexModels: ModelCapability[] = [
    mc("codex", "gpt-5.4-mini", "GPT-5.4 mini (Codex)", "gpt-5.4", 200_000, true, true, undefined, "low", "fast", "first-party-cloud"),
    mc("codex", "gpt-5.4", "GPT-5.4 (Codex)", "gpt-5.4", 200_000, true, true, undefined, "high", "balanced", "first-party-cloud"),
  ];
  const anthropicModels: ModelCapability[] = [
    mc("anthropic", "claude-3-5-sonnet-latest", "Claude 3.5 Sonnet", "claude-3.5", 200_000, true, false, true, "high", "balanced", "first-party-cloud"),
    mc("anthropic", "claude-3-5-haiku-latest", "Claude 3.5 Haiku", "claude-3.5", 200_000, true, false, true, "low", "fast", "first-party-cloud"),
  ];
  const googleModels: ModelCapability[] = [
    mc("google", "gemini-1.5-flash", "Gemini 1.5 Flash", "gemini-1.5", 1_000_000, true, false, true, "low", "fast", "first-party-cloud"),
    mc("google", "gemini-1.5-pro", "Gemini 1.5 Pro", "gemini-1.5", 2_000_000, true, false, true, "high", "balanced", "first-party-cloud"),
  ];
  const openrouterModels: ModelCapability[] = [
    mc("openrouter", "anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5 (via OpenRouter)", "claude-4", 200_000, true, false, true, "high", "balanced", "third-party-router"),
    mc("openrouter", "openai/gpt-5.4", "GPT-5.4 (via OpenRouter)", "gpt-5.4", 200_000, true, true, true, "high", "balanced", "third-party-router"),
    mc("openrouter", "nousresearch/hermes-4", "Hermes 4 (via OpenRouter)", "hermes-4", 128_000, true, false, undefined, "low", "balanced", "third-party-router"),
  ];
  const moonshotModels: ModelCapability[] = [
    mc("moonshot", "kimi-k2-thinking", "Kimi k2 (thinking)", "kimi-k2", 200_000, true, true, undefined, "low", "balanced", "first-party-cloud"),
    mc("moonshot", "kimi-k2-turbo-preview", "Kimi k2 turbo (preview)", "kimi-k2", 128_000, true, false, undefined, "low", "fast", "first-party-cloud"),
  ];
  const nimModels: ModelCapability[] = [
    mc("nvidia-nim", "meta/llama-3.3-70b-instruct", "Llama 3.3 70B (NIM)", "llama-3.3", 131_072, true, false, undefined, "medium", "balanced", "first-party-cloud"),
  ];
  const nousModels: ModelCapability[] = [
    mc("nous", "hermes-4", "Hermes 4 (Nous)", "hermes-4", 128_000, true, false, undefined, "medium", "balanced", "first-party-cloud"),
  ];
  const minimaxModels: ModelCapability[] = [
    mc("minimax", "abab6.5", "MiniMax abab6.5", "abab6", 245_000, true, false, undefined, "medium", "balanced", "first-party-cloud"),
  ];
  const mimoModels: ModelCapability[] = [
    mc("mimo", "mimo-7b-rl", "Xiaomi MiMo 7B RL", "mimo", 32_000, true, false, undefined, "low", "fast", "first-party-cloud"),
  ];
  const ollamaModels: ModelCapability[] = [
    mc("ollama", "llama3.2", "Llama 3.2", "llama-3.2", 128_000, true, false, undefined, "free-local", "balanced", "local"),
    mc("ollama", "qwen3:14b", "Qwen 3 14B", "qwen-3", 32_000, true, false, undefined, "free-local", "balanced", "local"),
  ];
  const lmstudioModels: ModelCapability[] = [
    mc("lmstudio", "openai/gpt-oss-20b", "LM Studio (loaded model)", undefined, 32_000, true, false, undefined, "free-local", "balanced", "local"),
  ];
  const huggingfaceModels: ModelCapability[] = [];

  return [
    {
      kind: "openai",
      displayName: "OpenAI",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://api.openai.com/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["OPENAI_API_KEY"],
      defaultModel: "gpt-4o-mini",
      modelCatalog: openaiModels,
      modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "openai-responses",
      displayName: "OpenAI Responses",
      transport: "openai-responses",
      defaultBaseUrl: "https://api.openai.com/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["OPENAI_API_KEY"],
      defaultModel: "gpt-4o-mini",
      modelCatalog: openaiResponsesModels,
      modelPrefixes: [],
      requestCompat: OPENAI_RESPONSES_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "codex",
      displayName: "Codex (ChatGPT)",
      transport: "openai-responses",
      defaultBaseUrl: null, // Codex preset sets the endpoint
      auth: { kind: "codex-oauth" },
      apiKeyEnv: [],
      defaultModel: "gpt-5.4-mini",
      modelCatalog: codexModels,
      modelPrefixes: [],
      requestCompat: CODEX_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "anthropic",
      displayName: "Anthropic",
      transport: "anthropic-messages",
      defaultBaseUrl: "https://api.anthropic.com",
      auth: { kind: "api-key-header", header: "x-api-key" },
      apiKeyEnv: ["ANTHROPIC_API_KEY"],
      defaultModel: "claude-3-5-sonnet-latest",
      modelCatalog: anthropicModels,
      modelPrefixes: ["claude-"],
      requestCompat: ANTHROPIC_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "google",
      displayName: "Google Gemini",
      transport: "google-generate-content",
      defaultBaseUrl: "https://generativelanguage.googleapis.com",
      auth: { kind: "bearer" },
      apiKeyEnv: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      defaultModel: "gemini-1.5-flash",
      modelCatalog: googleModels,
      modelPrefixes: ["gemini-"],
      requestCompat: GOOGLE_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "openrouter",
      displayName: "OpenRouter",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["OPENROUTER_API_KEY"],
      defaultModel: "openai/gpt-5.4-mini",
      modelCatalog: openrouterModels,
      modelPrefixes: [],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "moonshot",
      displayName: "Moonshot (Kimi)",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://api.moonshot.cn/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
      defaultModel: "kimi-k2-thinking",
      modelCatalog: moonshotModels,
      modelPrefixes: ["kimi-", "moonshot-"],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "nvidia-nim",
      displayName: "NVIDIA NIM",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["NVIDIA_API_KEY", "NIM_API_KEY"],
      defaultModel: "meta/llama-3.3-70b-instruct",
      modelCatalog: nimModels,
      modelPrefixes: [],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: true,
    },
    {
      kind: "nous",
      displayName: "Nous Portal",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://inference-api.nousresearch.com/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["NOUS_API_KEY"],
      defaultModel: "hermes-4",
      modelCatalog: nousModels,
      modelPrefixes: ["hermes-"],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: true,
    },
    {
      kind: "minimax",
      displayName: "MiniMax",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://api.minimax.chat/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["MINIMAX_API_KEY"],
      defaultModel: "abab6.5",
      modelCatalog: minimaxModels,
      modelPrefixes: ["abab"],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: true,
    },
    {
      kind: "mimo",
      displayName: "Xiaomi MiMo",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://mimo.xiaomi.com/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["MIMO_API_KEY"],
      defaultModel: "mimo-7b-rl",
      modelCatalog: mimoModels,
      modelPrefixes: ["mimo-"],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: true,
    },
    {
      kind: "ollama",
      displayName: "Ollama (local)",
      transport: "openai-chat-completions",
      defaultBaseUrl: "http://localhost:11434/v1",
      auth: { kind: "none" },
      apiKeyEnv: ["OLLAMA_API_KEY"],
      defaultModel: "llama3.2",
      modelCatalog: ollamaModels,
      modelPrefixes: [],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "lmstudio",
      displayName: "LM Studio (local)",
      transport: "openai-chat-completions",
      defaultBaseUrl: "http://localhost:1234/v1",
      auth: { kind: "none" },
      apiKeyEnv: ["LMSTUDIO_API_KEY"],
      defaultModel: "openai/gpt-oss-20b",
      modelCatalog: lmstudioModels,
      modelPrefixes: [],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: false,
    },
    {
      kind: "huggingface",
      displayName: "Hugging Face Inference",
      transport: "openai-chat-completions",
      defaultBaseUrl: "https://api-inference.huggingface.co/v1",
      auth: { kind: "bearer" },
      apiKeyEnv: ["HF_API_KEY", "HUGGINGFACE_API_KEY"],
      defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
      modelCatalog: huggingfaceModels,
      modelPrefixes: [],
      requestCompat: OPENAI_COMPAT,
      verificationRequired: true,
    },
  ];
}

/**
 * All built-in profiles. Computed once at module load (mirrors the Rust
 * `LazyLock`; in JS the assignment is the lazy-once-per-process equivalent).
 */
export const BUILTIN_PROFILES: ProviderProfile[] = buildBuiltinProfiles();

/**
 * Built-in profile registry. Lookups are by `kind`. Static content — the table
 * never changes within a process. Exposed as plain functions rather than a
 * class because there is no instance state (Rust used a unit struct).
 */
export const ProfileRegistry = {
  get(kind: string): ProviderProfile | undefined {
    return BUILTIN_PROFILES.find((p) => p.kind === kind);
  },
  all(): readonly ProviderProfile[] {
    return BUILTIN_PROFILES;
  },
} as const;

/**
 * Best-effort capability lookup across all built-in profiles. Returns
 * `undefined` when no profile knows about the `(kind, model)` pair — callers
 * should treat that as "unknown" rather than "definitively unsupported".
 */
export function lookupCapability(kind: string, model: string): ModelCapability | undefined {
  const p = ProfileRegistry.get(kind);
  return p ? capabilityFor(p, model) : undefined;
}

/**
 * Aliases — historical / config-file kind names that map onto a canonical
 * built-in profile. `kimi` is the long-standing alias for `moonshot`.
 */
export function canonicalKind(kind: string): string {
  return kind === "kimi" ? "moonshot" : kind;
}

// ---------- Flat catalog (the GET /v1/model-catalog wire shape) ----------

/**
 * Wire-shape for the `GET /v1/model-catalog` route. Flattens the per-provider
 * catalogs into one list. In Rust `ModelCapability` is flattened in (serde
 * `flatten`); here we spread the capability fields so the JSON shape matches.
 */
export type CatalogEntry = ModelCapability & {
  /** The profile kind (matches ProviderProfile.kind). */
  providerKind: string;
  providerDisplayName: string;
  /** `true` when this is the provider's default model (the picker pre-selects it). */
  isProviderDefault: boolean;
};

/** Build a flat catalog spanning all built-in profiles. */
export function flatBuiltinCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const p of ProfileRegistry.all()) {
    for (const cap of p.modelCatalog) {
      out.push({
        ...cap,
        providerKind: p.kind,
        providerDisplayName: p.displayName,
        isProviderDefault: cap.model === p.defaultModel,
      });
    }
  }
  return out;
}

// ---------- ProfileProvider wrapper ----------

/**
 * Wraps an inner LlmProvider and applies a profile's per-request defaults
 * before delegating. This is the runtime realisation of the catalog: the data
 * the profile carries (default model, `modelFieldPassthrough`) gets *applied*
 * here, the way apps/jarvis::serve::build_provider does at the Rust composition
 * root.
 *
 * Rewrites applied:
 *   * Empty / missing `model` → the profile's `defaultModel`.
 *   * When `requestCompat.modelFieldPassthrough` is `false` (Codex), a `model`
 *     that differs from `defaultModel` is rejected — the backend would 400.
 *     The model is also normalised to `defaultModel` so callers can't smuggle
 *     an override past us.
 */
export class ProfileProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #profile: ProviderProfile;

  constructor(profile: ProviderProfile, inner: LlmProvider) {
    this.#profile = profile;
    this.#inner = inner;
  }

  /** The profile this wrapper applies. */
  get profile(): ProviderProfile {
    return this.#profile;
  }

  // `async` so a synchronous throw from resolveModel surfaces as a rejected
  // Promise (the LlmProvider contract is Promise-returning), not a sync throw.
  async complete(req: ChatRequest): Promise<ChatResponse> {
    return this.#inner.complete(this.#applyDefaults(req));
  }

  // Likewise `async` so resolveModel's throw rejects rather than throwing
  // before the iterable is even constructed.
  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    return this.#inner.completeStream(this.#applyDefaults(req));
  }

  /**
   * Resolve the effective model for a request under this profile: empty model
   * → default; otherwise the requested model (subject to the passthrough gate).
   * Exposed for tests / callers that want the rewrite without dispatching.
   */
  resolveModel(model: string): string {
    if (model === "") return this.#profile.defaultModel;
    if (!this.#profile.requestCompat.modelFieldPassthrough && model !== this.#profile.defaultModel) {
      throw new ProviderError(
        `provider ${this.#profile.kind} rejects model override (got "${model}", pinned to "${this.#profile.defaultModel}")`,
      );
    }
    return model;
  }

  #applyDefaults(req: ChatRequest): ChatRequest {
    const model = this.resolveModel(req.model);
    return model === req.model ? req : { ...req, model };
  }
}
