import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";
import { ProviderError } from "@jarvis/core";
import {
  BUILTIN_PROFILES,
  ProfileProvider,
  ProfileRegistry,
  canonicalKind,
  capabilityBadges,
  capabilityFor,
  flatBuiltinCatalog,
  lookupCapability,
} from "./profile.ts";
import type { ModelCapability, ProviderProfile } from "./profile.ts";

// ---------- Registry / catalog (ports of the Rust unit tests) ----------

test("registry resolves each built-in kind with a non-empty display name", () => {
  for (const kind of [
    "openai",
    "openai-responses",
    "codex",
    "anthropic",
    "google",
    "openrouter",
    "moonshot",
    "nvidia-nim",
    "nous",
    "minimax",
    "mimo",
    "ollama",
    "lmstudio",
    "huggingface",
  ]) {
    const p = ProfileRegistry.get(kind);
    assert.ok(p, `missing kind=${kind}`);
    assert.equal(p.kind, kind);
    assert.notEqual(p.displayName, "", `empty display_name for ${kind}`);
  }
});

test("registry: 14 built-in profiles; all() returns them; unknown kind → undefined", () => {
  assert.equal(BUILTIN_PROFILES.length, 14);
  assert.equal(ProfileRegistry.all().length, 14);
  assert.equal(ProfileRegistry.get("no-such-kind"), undefined);
});

test("kimi alias canonicalises to moonshot; others pass through", () => {
  assert.equal(canonicalKind("kimi"), "moonshot");
  assert.equal(canonicalKind("openai"), "openai");
});

test("openrouter models carry third-party-router privacy + a router badge", () => {
  const p = ProfileRegistry.get("openrouter");
  assert.ok(p);
  const cap = p.modelCatalog[0]!;
  assert.equal(cap.privacyHint, "third-party-router");
  assert.ok(capabilityBadges(cap).includes("router"));
});

test("ollama: no auth + local privacy + local badge", () => {
  const p = ProfileRegistry.get("ollama");
  assert.ok(p);
  assert.equal(p.auth.kind, "none");
  const cap = p.modelCatalog[0]!;
  assert.equal(cap.privacyHint, "local");
  assert.ok(capabilityBadges(cap).includes("local"));
});

test("anthropic uses the x-api-key header with no scheme", () => {
  const p = ProfileRegistry.get("anthropic");
  assert.ok(p);
  assert.equal(p.auth.kind, "api-key-header");
  if (p.auth.kind === "api-key-header") {
    assert.equal(p.auth.header, "x-api-key");
    assert.equal(p.auth.scheme, undefined);
  }
});

test("codex does not pass through the model field", () => {
  const p = ProfileRegistry.get("codex");
  assert.ok(p);
  assert.equal(p.requestCompat.modelFieldPassthrough, false);
  assert.equal(p.defaultBaseUrl, null); // Codex derives its endpoint from the preset
});

test("capabilityFor resolves a known model; badges include tools", () => {
  const p = ProfileRegistry.get("openai");
  assert.ok(p);
  const cap = capabilityFor(p, "gpt-4o-mini");
  assert.ok(cap);
  assert.equal(cap.supportsToolCalls, true);
  assert.ok(capabilityBadges(cap).includes("tools"));
});

test("lookupCapability returns undefined for unknown model or kind", () => {
  assert.equal(lookupCapability("openai", "no-such-model"), undefined);
  assert.equal(lookupCapability("no-such-kind", "anything"), undefined);
  assert.ok(lookupCapability("openai", "gpt-4o-mini"));
});

test("capabilityBadges: 64k+ from context window, reasoning + vision flags", () => {
  const cap: ModelCapability = {
    provider: "x",
    model: "y",
    contextWindow: 200_000,
    supportsToolCalls: true,
    supportsReasoning: true,
    supportsImages: true,
  };
  assert.deepEqual(capabilityBadges(cap), ["tools", "reasoning", "vision", "64k+"]);
  // vision can also come from input modalities
  assert.ok(capabilityBadges({ provider: "x", model: "z", inputModalities: ["image"] }).includes("vision"));
  // small context window → no 64k+ badge
  assert.equal(capabilityBadges({ provider: "x", model: "s", contextWindow: 32_000 }).includes("64k+"), false);
});

test("flat catalog marks provider defaults and spreads capability fields", () => {
  const cat = flatBuiltinCatalog();
  const openaiDefault = cat.find((e) => e.providerKind === "openai" && e.model === "gpt-4o-mini");
  assert.ok(openaiDefault);
  assert.equal(openaiDefault.isProviderDefault, true);
  assert.equal(openaiDefault.providerDisplayName, "OpenAI");
  // capability fields are flattened onto the entry (serde flatten parity)
  assert.equal(openaiDefault.supportsToolCalls, true);

  const openaiOther = cat.find((e) => e.providerKind === "openai" && e.model === "gpt-4o");
  assert.ok(openaiOther);
  assert.equal(openaiOther.isProviderDefault, false);
});

test("profile serialises with camelCase keys (serde rename_all parity)", () => {
  const p = ProfileRegistry.get("openrouter");
  assert.ok(p);
  const v = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  assert.equal(v.kind, "openrouter");
  assert.equal(v.defaultBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(typeof v.requestCompat, "object");
});

test("ModelCapability omits unset + default-hint fields on serialise", () => {
  // The codex catalog leaves `supportsImages` (vision) unset.
  const cap = lookupCapability("codex", "gpt-5.4-mini");
  assert.ok(cap);
  const json = JSON.parse(JSON.stringify(cap)) as Record<string, unknown>;
  assert.equal("supportsImages" in json, false); // unset → absent
  assert.equal(json.supportsStreaming, true); // mc() always sets streaming
  assert.equal(json.costHint, "low"); // non-default hint kept
});

test("verificationRequired is set only for unverified profiles", () => {
  for (const kind of ["nvidia-nim", "nous", "minimax", "mimo", "huggingface"]) {
    assert.equal(ProfileRegistry.get(kind)?.verificationRequired, true, `${kind} should be flagged`);
  }
  for (const kind of ["openai", "anthropic", "google", "openrouter", "moonshot"]) {
    assert.equal(ProfileRegistry.get(kind)?.verificationRequired, false, `${kind} should be verified`);
  }
});

test("every catalog entry's provider matches its profile kind", () => {
  for (const p of ProfileRegistry.all()) {
    for (const cap of p.modelCatalog) {
      assert.equal(cap.provider, p.kind, `${p.kind} catalog entry ${cap.model} has wrong provider`);
    }
  }
});

// ---------- ProfileProvider wrapper (request rewriting with a fake inner) ----------

/** Records the request it last received and returns a canned response. */
class RecordingProvider implements LlmProvider {
  lastRequest: ChatRequest | undefined;

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = req;
    return Promise.resolve({
      message: { role: "assistant", content: `model=${req.model}` },
      finish_reason: "stop",
      response_id: null,
    });
  }

  async *#stream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    this.lastRequest = req;
    yield {
      type: "finish",
      message: { role: "assistant", content: `model=${req.model}` },
      finish_reason: "stop",
      response_id: null,
    };
  }

  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    return this.#stream(req);
  }
}

function profile(kind: string): ProviderProfile {
  const p = ProfileRegistry.get(kind);
  assert.ok(p, `missing profile ${kind}`);
  return p;
}

function baseReq(model: string): ChatRequest {
  return { model, messages: [{ role: "user", content: "hi" }] };
}

test("ProfileProvider: empty model is rewritten to the profile default", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("openai"), inner);
  const resp = await wrapped.complete(baseReq(""));
  assert.equal(inner.lastRequest?.model, "gpt-4o-mini");
  assert.equal((resp.message as { content?: string }).content, "model=gpt-4o-mini");
});

test("ProfileProvider: explicit model passes through for passthrough providers", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("openai"), inner);
  await wrapped.complete(baseReq("gpt-4o"));
  assert.equal(inner.lastRequest?.model, "gpt-4o");
});

test("ProfileProvider: resolveModel maps empty → default and keeps overrides", () => {
  const wrapped = new ProfileProvider(profile("anthropic"), new RecordingProvider());
  assert.equal(wrapped.resolveModel(""), "claude-3-5-sonnet-latest");
  assert.equal(wrapped.resolveModel("claude-3-5-haiku-latest"), "claude-3-5-haiku-latest");
  assert.equal(wrapped.profile.kind, "anthropic");
});

test("ProfileProvider: codex empty model resolves to its default", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("codex"), inner);
  await wrapped.complete(baseReq(""));
  assert.equal(inner.lastRequest?.model, "gpt-5.4-mini");
});

test("ProfileProvider: codex rejects a divergent model override (no passthrough)", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("codex"), inner);
  await assert.rejects(() => wrapped.complete(baseReq("gpt-4o")), ProviderError);
  // matching default is allowed
  await wrapped.complete(baseReq("gpt-5.4-mini"));
  assert.equal(inner.lastRequest?.model, "gpt-5.4-mini");
});

test("ProfileProvider: stream path applies the same model rewrite", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("google"), inner);
  const stream = await wrapped.completeStream(baseReq(""));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);
  assert.equal(inner.lastRequest?.model, "gemini-1.5-flash");
  const finish = events.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal((finish.message as { content?: string }).content, "model=gemini-1.5-flash");
});

test("ProfileProvider: a passthrough request object is forwarded unchanged when model matches", async () => {
  const inner = new RecordingProvider();
  const wrapped = new ProfileProvider(profile("openai"), inner);
  const original = baseReq("gpt-4o");
  await wrapped.complete(original);
  // no rewrite needed → same object identity (avoids a needless clone)
  assert.equal(inner.lastRequest, original);
});
