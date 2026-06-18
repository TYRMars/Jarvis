// provider.ts — build the primary LlmProvider from a JarvisConfig.
//
// Mirrors the Rust composition root's `build_provider` (apps/jarvis/src/
// serve.rs): select by `config.provider`, construct the matching @jarvis/llm
// provider, wrap it in `CapabilityValidatingProvider` (so a request for a model
// the catalog knows can't do tools fails fast instead of returning a cryptic
// 400), and optionally layer a `RoutingProvider` (smart routing) on top.
//
// `FallbackProvider` is built by the same helper but only kicks in when the
// caller supplies extra providers in `deps.extraProviders` — the env-driven
// path doesn't enable extra providers in this P1 cut (the multi-provider
// `--enable` / `[provider].enabled` config layer is a documented deferral), so
// fallback stays a no-op unless a test wires it.
//
// `deps.fetchImpl` is injected straight into each constructed provider so tests
// can stub the network without monkeypatching global fetch.
import type { LlmProvider } from "@jarvis/core";
import {
  AnthropicProvider,
  CapabilityValidatingProvider,
  CodexAuth,
  FallbackProvider,
  GoogleProvider,
  OpenAiProvider,
  ResponsesProvider,
  canonicalKind,
  lookupCapability,
  ProfileRegistry,
  fallbackEntry,
  type FallbackEntry,
  type ModelCapability,
} from "@jarvis/llm";
import { HeuristicClassifier, RoutingProvider, RouterConfig, modelRef, parseModelRef, type Tier } from "@jarvis/router";

import type { JarvisConfig, ProviderKind } from "./config.ts";

/** Optional dependency injection for tests / advanced wiring. */
export interface BuildProviderDeps {
  /** Inject a `fetch` implementation into every constructed provider. */
  fetchImpl?: typeof fetch;
  /**
   * Pre-built extra providers keyed by name. Used to populate the fallback
   * chain + the smart-router provider map. The env-driven path leaves this
   * empty (multi-provider enablement is deferred); tests can populate it.
   */
  extraProviders?: Map<string, LlmProvider>;
  /**
   * Inject `CodexAuth` directly (tests / a resolved login). When unset and the
   * provider is `codex`, auth is derived from the static token / CODEX_HOME on
   * the config (see {@link resolveCodexAuth}).
   */
  codexAuth?: CodexAuth;
}

/**
 * Construct the RAW provider for `kind` (no capability/router/fallback
 * wrappers). Pure construction off the resolved config — every env read already
 * happened in `loadConfig`. Throws when the required credential is missing.
 */
export async function buildRawProvider(
  config: JarvisConfig,
  deps: BuildProviderDeps = {},
): Promise<LlmProvider> {
  const fetchImpl = deps.fetchImpl;
  switch (config.provider) {
    case "openai": {
      return new OpenAiProvider({
        apiKey: requireKey(config.openaiApiKey, "OPENAI_API_KEY", "openai"),
        ...(config.openaiBaseUrl !== undefined ? { baseUrl: config.openaiBaseUrl } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    }
    case "kimi": {
      // Kimi reuses the OpenAI wire format via a swapped base URL.
      return new OpenAiProvider({
        apiKey: requireKey(config.kimiApiKey, "KIMI_API_KEY", "kimi"),
        baseUrl: config.kimiBaseUrl ?? "https://api.moonshot.cn/v1",
        // Kimi K2 thinking endpoints want an empty reasoning_content on
        // historical tool-call turns (matches the Rust Kimi base-URL swap).
        includeEmptyReasoningContentForToolCalls: true,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    }
    case "ollama": {
      // Ollama reuses the OpenAI wire format; the local server ignores the key.
      return new OpenAiProvider({
        apiKey: config.ollamaApiKey ?? "ollama",
        baseUrl: config.ollamaBaseUrl ?? "http://localhost:11434/v1",
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    }
    case "anthropic": {
      return new AnthropicProvider({
        apiKey: requireKey(config.anthropicApiKey, "ANTHROPIC_API_KEY", "anthropic"),
        ...(config.anthropicBaseUrl !== undefined ? { baseUrl: config.anthropicBaseUrl } : {}),
        ...(config.anthropicVersion !== undefined ? { anthropicVersion: config.anthropicVersion } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    }
    case "google": {
      return new GoogleProvider({
        apiKey: requireKey(config.googleApiKey, "GOOGLE_API_KEY", "google"),
        ...(config.googleBaseUrl !== undefined ? { baseUrl: config.googleBaseUrl } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    }
    case "openai-responses": {
      const overrides: Record<string, unknown> = {};
      if (config.openaiBaseUrl !== undefined) overrides.baseUrl = config.openaiBaseUrl;
      if (fetchImpl !== undefined) overrides.fetchImpl = fetchImpl;
      return ResponsesProvider.openaiResponses(
        requireKey(config.openaiApiKey, "OPENAI_API_KEY", "openai-responses"),
        overrides,
      );
    }
    case "codex": {
      const auth = deps.codexAuth ?? (await resolveCodexAuth(config, fetchImpl));
      const overrides: Record<string, unknown> = {};
      if (config.codexBaseUrl !== undefined) overrides.baseUrl = config.codexBaseUrl;
      if (fetchImpl !== undefined) overrides.fetchImpl = fetchImpl;
      return ResponsesProvider.codex(auth, overrides);
    }
    default:
      return assertNever(config.provider);
  }
}

/**
 * Build the primary provider, fully wrapped: capability validation always,
 * then (when extra providers are supplied) a fallback chain, then (when the
 * router is enabled) a `RoutingProvider`. The router/fallback layering matches
 * the Rust order — fallback wraps the raw primary, the router delegates to the
 * UN-wrapped providers so it can never recurse into itself.
 */
export async function buildProvider(
  config: JarvisConfig,
  deps: BuildProviderDeps = {},
): Promise<LlmProvider> {
  const raw = await buildRawProvider(config, deps);
  const validated = wrapWithCapabilities(raw, config.provider);

  // The map of providers the router (and fallback chain) may delegate to. The
  // primary is keyed under its own name; extras (tests) merge in.
  const providersByName = new Map<string, LlmProvider>();
  providersByName.set(config.provider, validated);
  if (deps.extraProviders) {
    for (const [name, p] of deps.extraProviders) providersByName.set(name, p);
  }

  // Optional fallback chain — only entries that name a *different*, configured
  // provider survive (self-references are dropped by FallbackProvider itself).
  let primary = validated;
  if (deps.extraProviders && deps.extraProviders.size > 0) {
    const chain: FallbackEntry[] = [];
    for (const [name, p] of deps.extraProviders) {
      if (name === config.provider) continue;
      chain.push(fallbackEntry(name, p));
    }
    if (chain.length > 0) {
      primary = new FallbackProvider(config.provider, validated, chain);
    }
  }

  // Optional smart router. When enabled, the primary registry entry becomes a
  // RoutingProvider that classifies each request and rewrites the model before
  // delegating. The router delegates to the UN-fallback-wrapped providers map.
  const router = buildSmartRouter(config, primary, providersByName);
  return router ?? primary;
}

/**
 * Wrap a raw provider in `CapabilityValidatingProvider` using the built-in
 * profile catalog for the provider kind. Unknown kinds get an empty catalog
 * (every request passes through — capability data is best-effort).
 */
export function wrapWithCapabilities(inner: LlmProvider, kind: ProviderKind): LlmProvider {
  return new CapabilityValidatingProvider(inner, capabilityCatalog(kind));
}

/** The capability rows the built-in profile knows for `kind` (empty if unknown). */
export function capabilityCatalog(kind: ProviderKind): ModelCapability[] {
  const profile = ProfileRegistry.get(canonicalKind(kind));
  return profile ? [...profile.modelCatalog] : [];
}

/**
 * Build a `RoutingProvider` when `config.router.enabled`. Each tier target is a
 * `<provider>/<model>` string; an unset / malformed tier falls through to the
 * default (the primary `(provider, model)`). Returns undefined when routing is
 * off so the caller registers the raw primary unchanged.
 */
export function buildSmartRouter(
  config: JarvisConfig,
  primary: LlmProvider,
  providersByName: Map<string, LlmProvider>,
): RoutingProvider | undefined {
  if (!config.router.enabled) return undefined;

  const defaultTarget = modelRef(config.provider, config.model);
  let routerConfig = new RouterConfig(defaultTarget);
  const tierEntries: [Tier, string | undefined][] = [
    ["simple", config.router.simple],
    ["medium", config.router.medium],
    ["complex", config.router.complex],
    ["reasoning", config.router.reasoning],
  ];
  for (const [tier, raw] of tierEntries) {
    if (raw === undefined) continue;
    const ref = parseModelRef(raw);
    if (ref !== undefined) routerConfig = routerConfig.withTier(tier, ref);
  }

  // The router needs every tier target's provider in its map. We only have the
  // primary wired here (extras are a deferral), so unconfigured targets fall
  // back to the primary inside RoutingProvider — matching the Rust "run on a
  // working provider rather than silently disable" rule.
  return new RoutingProvider(primary, providersByName, routerConfig, new HeuristicClassifier());
}

/**
 * Resolve `CodexAuth` for the `codex` provider. Prefers the static dev token
 * (`CODEX_ACCESS_TOKEN` / `CODEX_ACCOUNT_ID`) when present; otherwise reads
 * `auth.json` under `CODEX_HOME` (default `~/.codex`).
 */
export async function resolveCodexAuth(
  config: JarvisConfig,
  fetchImpl?: typeof fetch,
): Promise<CodexAuth> {
  const opts = fetchImpl !== undefined ? { fetchImpl } : {};
  if (config.codexAccessToken !== undefined) {
    return CodexAuth.fromStatic(
      {
        accessToken: config.codexAccessToken,
        accountId: config.codexAccountId ?? null,
      },
      opts,
    );
  }
  const home = config.codexHome ?? defaultCodexHome();
  return CodexAuth.loadFromCodexHome(home, opts);
}

/** `~/.codex` — the Codex CLI's default credential home. */
function defaultCodexHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return `${home}/.codex`;
}

function requireKey(key: string | undefined, envName: string, provider: string): string {
  if (key === undefined || key === "") {
    throw new Error(`${envName} is required for provider \`${provider}\``);
  }
  return key;
}

function assertNever(x: never): never {
  throw new Error(`unhandled provider: ${String(x)}`);
}

export { lookupCapability };
