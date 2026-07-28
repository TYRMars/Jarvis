// Regression tests for the composition-root wiring bugs surfaced during the
// adversarial verification pass. Deterministic, no network, no real keys.
//
//   1. The per-provider default model is sourced from the @jarvis/llm
//      ProfileRegistry, so it can never drift from the capability catalog the
//      CapabilityValidatingProvider gates against (the old hardcoded map had
//      ollama→`llama3.1` while the catalog ships `llama3.2`).
//   2. The historic `--mcp-serve` boolean flag still routes to the `mcp-serve`
//      subcommand (Rust back-compat alias).
//   3. `summary`-mode short-term memory attaches the cross-process persistence
//      tier (`withPersistence`) over the conversation store, writing summaries
//      under the reserved `__memory__.summary:<hash>` key namespace.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ProfileRegistry, canonicalKind } from "@jarvis/llm";
import { makeMemoryStores } from "@jarvis/store";
import { SlidingWindowMemory, SummarizingMemory } from "@jarvis/memory";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";
import { assistantText, defaultCompleteStream } from "@jarvis/core";

import { loadConfig, defaultModel, type ProviderKind } from "./config.ts";
import { parseCliArgs } from "./main.ts";
import { buildMemory, buildProviderCatalog, resolveMemoryBudget } from "./state.ts";
import { ConversationSummaryStore, persistKey } from "./summary-store.ts";

const ALL_KINDS: ProviderKind[] = [
  "openai",
  "openai-responses",
  "anthropic",
  "google",
  "codex",
  "kimi",
  "ollama",
];

/** A stub provider — never reached by these tests (no LLM calls). */
class StubProvider implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve({ message: assistantText("unused"), finish_reason: "stop" });
  }
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    return defaultCompleteStream(this, req);
  }
}

// ---------------------------------------------------------------------------
// (1) default-model drift guard
// ---------------------------------------------------------------------------

test("ollama default model matches the catalog (regression: was llama3.1)", () => {
  assert.equal(defaultModel("ollama"), "llama3.2");
  assert.equal(loadConfig({ JARVIS_PROVIDER: "ollama" }).model, "llama3.2");
});

test("every provider-kind default is sourced from the ProfileRegistry", () => {
  for (const kind of ALL_KINDS) {
    const profile = ProfileRegistry.get(canonicalKind(kind));
    assert.ok(profile !== undefined, `no built-in profile for kind \`${kind}\``);
    assert.equal(
      defaultModel(kind),
      profile.defaultModel,
      `default model for \`${kind}\` drifted from the catalog`,
    );
    // loadConfig must agree (no override).
    const cfg = loadConfig({ JARVIS_PROVIDER: kind });
    assert.equal(cfg.model, profile.defaultModel);
  }
});

test("JARVIS_MODEL overrides the catalog default", () => {
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "gpt-4o" });
  assert.equal(cfg.model, "gpt-4o");
});

// ---------------------------------------------------------------------------
// (2) subcommand dispatch + the legacy `--mcp-serve` flag
// ---------------------------------------------------------------------------

test("the legacy --mcp-serve flag routes to the mcp-serve subcommand", () => {
  assert.equal(parseCliArgs(["--mcp-serve"]).subcommand, "mcp-serve");
});

test("an explicit positional subcommand wins over the legacy flag", () => {
  // `jarvis status --mcp-serve` is nonsensical but the positional must win.
  assert.equal(parseCliArgs(["status", "--mcp-serve"]).subcommand, "status");
});

test("no args defaults to serve; known positionals dispatch verbatim", () => {
  assert.equal(parseCliArgs([]).subcommand, "serve");
  for (const sub of ["serve", "mcp-serve", "init", "login", "status", "workspace"] as const) {
    assert.equal(parseCliArgs([sub]).subcommand, sub);
  }
  // An unknown positional falls back to serve (never throws).
  assert.equal(parseCliArgs(["frobnicate"]).subcommand, "serve");
});

test("--workspace / --fs-root / --addr / --provider / --key parse", () => {
  const a = parseCliArgs(["serve", "--workspace", "/w", "--addr", "1.2.3.4:9", "--provider", "anthropic"]);
  assert.equal(a.workspace, "/w");
  assert.equal(a.addr, "1.2.3.4:9");
  assert.equal(a.provider, "anthropic");
  const b = parseCliArgs(["workspace", "--fs-root", "/r", "--json"]);
  assert.equal(b.workspace, "/r");
  assert.equal(b.json, true);
  const c = parseCliArgs(["login", "--key", "sk-x"]);
  assert.equal(c.key, "sk-x");
});

// ---------------------------------------------------------------------------
// (3) summary-mode persistence tier
// ---------------------------------------------------------------------------

test("ConversationSummaryStore round-trips under the __memory__ namespace", async () => {
  const stores = makeMemoryStores();
  const summaryStore = new ConversationSummaryStore(stores.conversations);

  assert.equal(await summaryStore.get("deadbeef"), undefined); // miss
  await summaryStore.put("deadbeef", "a terse summary of the dropped turns");
  assert.equal(await summaryStore.get("deadbeef"), "a terse summary of the dropped turns");

  // Stored under the reserved key the HTTP server filters out of public lists.
  assert.equal(persistKey("deadbeef"), "__memory__.summary:deadbeef");
  const conv = await stores.conversations.load("__memory__.summary:deadbeef");
  assert.ok(conv !== undefined);
  assert.equal(conv.messages.length, 1);
  assert.equal(conv.messages[0]?.role, "system");
});

test("buildMemory: derives a budget from a known model's context window", () => {
  // No explicit JARVIS_MEMORY_TOKENS, but openai/gpt-4o-mini has a catalog
  // contextWindow (128k) → compaction is installed at contextWindow - reserved.
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai" });
  const mem = buildMemory(cfg, new StubProvider());
  assert.ok(mem instanceof SlidingWindowMemory, "known model → derived sliding-window budget");
});

test("buildMemory: undefined for an unknown model with no token budget", () => {
  // Unknown model → no catalog contextWindow → historical "no memory" behaviour.
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "some-unlisted-model-xyz" });
  assert.equal(buildMemory(cfg, new StubProvider()), undefined);
});

test("resolveMemoryBudget: explicit token budget wins; known model derives; unknown → undefined", () => {
  // Explicit budget passes through verbatim.
  assert.equal(
    resolveMemoryBudget(loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MEMORY_TOKENS: "1234" })),
    1234,
  );
  // gpt-4o-mini: 128k context − 20k reserve (0.2×128k clamped to 20k) = 108k.
  assert.equal(resolveMemoryBudget(loadConfig({ JARVIS_PROVIDER: "openai" })), 108_000);
  // Unknown model → no derivation.
  assert.equal(
    resolveMemoryBudget(loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "ghost-model-404" })),
    undefined,
  );
});

test("buildMemory: window mode → SlidingWindowMemory (no persistence tier)", () => {
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MEMORY_TOKENS: "2000" });
  const mem = buildMemory(cfg, new StubProvider(), new ConversationSummaryStore(makeMemoryStores().conversations));
  assert.ok(mem instanceof SlidingWindowMemory);
});

test("buildMemory: summary mode attaches the persistence tier when a store is supplied", () => {
  const cfg = loadConfig({
    JARVIS_PROVIDER: "openai",
    JARVIS_MEMORY_TOKENS: "2000",
    JARVIS_MEMORY_MODE: "summary",
  });
  const stores = makeMemoryStores();
  const mem = buildMemory(cfg, new StubProvider(), new ConversationSummaryStore(stores.conversations));
  // The fluent `withPersistence` returns the same SummarizingMemory instance.
  assert.ok(mem instanceof SummarizingMemory);
});

test("buildMemory: summary mode without a store still builds (no persistence)", () => {
  const cfg = loadConfig({
    JARVIS_PROVIDER: "openai",
    JARVIS_MEMORY_TOKENS: "2000",
    JARVIS_MEMORY_MODE: "summary",
  });
  const mem = buildMemory(cfg, new StubProvider());
  assert.ok(mem instanceof SummarizingMemory);
});

test("buildProviderCatalog: single is_default entry for the configured provider", () => {
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "gpt-4o-mini" });
  const cat = buildProviderCatalog(cfg);
  assert.equal(cat.default, "openai");
  assert.equal(cat.providers.length, 1);
  const p = cat.providers[0]!;
  assert.equal(p.name, "openai");
  assert.equal(p.default_model, "gpt-4o-mini");
  assert.equal(p.is_default, true);
  // the configured default model is always offered, even if not in the catalog
  assert.ok(p.models.includes("gpt-4o-mini"));
});

test("buildProviderCatalog: a non-catalog model is still offered as default_model", () => {
  const cfg = loadConfig({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "some-custom-model-xyz" });
  const cat = buildProviderCatalog(cfg);
  assert.equal(cat.providers[0]!.default_model, "some-custom-model-xyz");
  assert.ok(cat.providers[0]!.models.includes("some-custom-model-xyz"));
});
