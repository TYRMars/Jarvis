import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ChatRequest,
  ChatResponse,
  LlmChunk,
  LlmProvider,
  Message,
} from "@jarvis/core";
import { assistantText, toolResult, userMessage } from "@jarvis/core";

import {
  ALL_TIERS,
  RouterConfig,
  modelRef,
  parseModelRef,
} from "./tier.ts";
import { HeuristicClassifier } from "./classify.ts";
import type { Classifier } from "./classify.ts";
import { RoutingProvider, stampResponseId } from "./provider.ts";
import type { Tier } from "./tier.ts";

// ---------- Tier table (tier.rs parity) ----------

test("parseModelRef: accepts slash form", () => {
  const r = parseModelRef("anthropic/claude-opus");
  assert.deepEqual(r, { provider: "anthropic", model: "claude-opus" });
});

test("parseModelRef: keeps slashes in the model segment", () => {
  // split_once → only the first `/` separates provider from model.
  assert.deepEqual(parseModelRef("vendor/org/model-x"), { provider: "vendor", model: "org/model-x" });
});

test("parseModelRef: rejects empty segments and missing slash", () => {
  assert.equal(parseModelRef("openai/"), undefined);
  assert.equal(parseModelRef("/m"), undefined);
  assert.equal(parseModelRef("noslash"), undefined);
});

test("RouterConfig.target: falls back to default; withTier is immutable", () => {
  const base = new RouterConfig(modelRef("openai", "gpt-4o-mini"));
  const cfg = base.withTier("complex", modelRef("anthropic", "claude-opus"));
  assert.equal(cfg.target("complex").model, "claude-opus");
  // medium is unset → default.
  assert.equal(cfg.target("medium").model, "gpt-4o-mini");
  // builder did not mutate the base.
  assert.equal(base.target("complex").model, "gpt-4o-mini");
});

test("ALL_TIERS lists every variant in difficulty order", () => {
  assert.deepEqual(ALL_TIERS, ["simple", "medium", "complex", "reasoning"]);
});

// ---------- HeuristicClassifier (classify.rs parity) ----------

test("classify: short text is simple (ASCII + CJK)", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("ok"), "simple");
  assert.equal(await c.classify("好的，继续"), "simple");
});

test("classify: code fence forces complex", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("fix this:\n```rust\nfn x() {}\n```"), "complex");
});

test("classify: english keyword (whole token) is complex", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("please refactor the auth module"), "complex");
});

test("classify: chinese keyword is complex", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("帮我分析一下这段逻辑"), "complex");
});

test("classify: mid-length plain text is medium", async () => {
  const c = new HeuristicClassifier();
  const msg =
    "Can you explain what this function returns and whether it " +
    "handles the empty input case the way a caller would expect";
  assert.equal(await c.classify(msg), "medium");
});

test("classify: substring of a keyword does NOT force complex (#89)", async () => {
  const c = new HeuristicClassifier();
  // "implementation" / "redesigned" contain a keyword as a substring but are
  // not whole-token matches — they must stay medium.
  const msg =
    "I was reading the implementation notes and the page got " +
    "redesigned, but otherwise everything looked fine to me here";
  assert.equal(await c.classify(msg), "medium");
});

test("classify: whole-word keyword adjacent to punctuation still complex", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("can you debug, then optimize the loop?"), "complex");
});

test("classify: blank/whitespace is medium (not simple)", async () => {
  const c = new HeuristicClassifier();
  assert.equal(await c.classify("   "), "medium");
  assert.equal(await c.classify(""), "medium");
});

test("classify: very long plain prompt forces complex via char threshold", async () => {
  const c = new HeuristicClassifier({ complexMinChars: 600 });
  const long = "a ".repeat(400); // 800 chars, no keyword/fence
  assert.equal(await c.classify(long), "complex");
});

test("classify: thresholds are configurable", async () => {
  const c = new HeuristicClassifier({ simpleMaxChars: 3, complexMinChars: 10 });
  assert.equal(await c.classify("hey"), "simple"); // 3 ≤ 3
  assert.equal(await c.classify("hello!"), "medium"); // 6, between
  assert.equal(await c.classify("0123456789"), "complex"); // 10 ≥ 10
});

// ---------- Test doubles ----------

/** Records the model it was asked to run + the chain handles it received. */
class RecordingProvider implements LlmProvider {
  lastModel: string | undefined;
  lastPrev: string | null | undefined;
  lastOrigin: number | null | undefined;
  readonly tag: string;
  readonly #responseId: string | null;

  constructor(tag: string, responseId: string | null = null) {
    this.tag = tag;
    this.#responseId = responseId;
  }

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.lastModel = req.model;
    this.lastPrev = req.previous_response_id;
    this.lastOrigin = req.chain_origin;
    const prev = req.previous_response_id ?? "none";
    const origin = req.chain_origin == null ? "none" : String(req.chain_origin);
    return Promise.resolve({
      message: assistantText(`${this.tag}:${req.model}|prev=${prev}|origin=${origin}`),
      finish_reason: "stop",
      response_id: this.#responseId,
    });
  }

  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    this.lastModel = req.model;
    this.lastPrev = req.previous_response_id;
    this.lastOrigin = req.chain_origin;
    const prev = req.previous_response_id ?? "none";
    const origin = req.chain_origin == null ? "none" : String(req.chain_origin);
    const tag = this.tag;
    const model = req.model;
    const responseId = this.#responseId;
    return (async function* (): AsyncGenerator<LlmChunk> {
      yield {
        type: "finish",
        message: assistantText(`${tag}:${model}|prev=${prev}|origin=${origin}`),
        finish_reason: "stop",
        response_id: responseId,
      };
    })();
  }
}

class FixedClassifier implements Classifier {
  readonly #tier: Tier;
  constructor(tier: Tier) {
    this.#tier = tier;
  }
  classify(): Promise<Tier> {
    return Promise.resolve(this.#tier);
  }
}

function body(resp: ChatResponse): string {
  const m = resp.message as Extract<Message, { role: "assistant" }>;
  return m.content ?? "";
}

function buildProviders(): {
  openai: RecordingProvider;
  anthropic: RecordingProvider;
  map: Map<string, LlmProvider>;
} {
  const openai = new RecordingProvider("openai");
  const anthropic = new RecordingProvider("anthropic");
  const map = new Map<string, LlmProvider>([
    ["openai", openai],
    ["anthropic", anthropic],
  ]);
  return { openai, anthropic, map };
}

// ---------- RoutingProvider: model rewrite + delegation ----------

test("routes a tier to its configured provider and rewrites the model", async () => {
  const { anthropic, map } = buildProviders();
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini")).withTier(
    "complex",
    modelRef("anthropic", "claude-opus"),
  );
  const rp = new RoutingProvider(
    new RecordingProvider("fb"),
    map,
    cfg,
    new FixedClassifier("complex"),
  );
  // Incoming model is ignored — routing overrides it.
  const resp = await rp.complete({ model: "ignored", messages: [] });
  assert.ok(body(resp).startsWith("anthropic:claude-opus"));
  // The downstream provider actually received the rewritten model.
  assert.equal(anthropic.lastModel, "claude-opus");
});

test("unconfigured tier uses the default target", async () => {
  const { openai, map } = buildProviders();
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"));
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("medium"));
  const resp = await rp.complete({ model: "x", messages: [] });
  assert.ok(body(resp).startsWith("openai:gpt-4o-mini"));
  assert.equal(openai.lastModel, "gpt-4o-mini");
});

test("unknown provider falls back but keeps the configured model", async () => {
  const { map } = buildProviders();
  const fallback = new RecordingProvider("fb");
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini")).withTier(
    "simple",
    modelRef("ghost", "tiny"),
  );
  const rp = new RoutingProvider(fallback, map, cfg, new FixedClassifier("simple"));
  const resp = await rp.complete({ model: "x", messages: [] });
  // "ghost" not registered → fallback provider, configured model.
  assert.ok(body(resp).startsWith("fb:tiny"));
  assert.equal(fallback.lastModel, "tiny");
});

test("classification reads the last USER message, ignoring a trailing tool result", async () => {
  const { anthropic, map } = buildProviders();
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"))
    .withTier("simple", modelRef("openai", "cheap"))
    .withTier("complex", modelRef("anthropic", "claude-opus"));
  const rp = new RoutingProvider(
    new RecordingProvider("fb"),
    map,
    cfg,
    new HeuristicClassifier(),
  );
  const req: ChatRequest = {
    model: "x",
    messages: [userMessage("please refactor the parser"), toolResult("call_1", "done")],
  };
  // "refactor" keyword ⇒ complex ⇒ anthropic/claude-opus, despite the trailing tool msg.
  const resp = await rp.complete(req);
  assert.ok(body(resp).startsWith("anthropic:claude-opus"));
  assert.equal(anthropic.lastModel, "claude-opus");
});

// ---------- RoutingProvider: chain-handle reconciliation ----------

test("same provider preserves + unstamps the chain handle, re-stamps the reply", async () => {
  const openai = new RecordingProvider("openai", "resp_xyz");
  const map = new Map<string, LlmProvider>([["openai", openai]]);
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"));
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("simple"));

  const resp = await rp.complete({
    model: "x",
    messages: [],
    previous_response_id: stampResponseId("openai", "gpt-4o-mini", "resp_xyz"),
    chain_origin: 3,
  });
  // Provider saw the UNSTAMPED id + the origin.
  assert.equal(openai.lastPrev, "resp_xyz");
  assert.equal(openai.lastOrigin, 3);
  // Reply id is re-stamped for the next turn.
  assert.equal(resp.response_id, stampResponseId("openai", "gpt-4o-mini", "resp_xyz"));
});

test("cross provider clears the foreign chain handle", async () => {
  const { anthropic, map } = buildProviders();
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini")).withTier(
    "complex",
    modelRef("anthropic", "claude-opus"),
  );
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("complex"));

  await rp.complete({
    model: "x",
    messages: [],
    previous_response_id: stampResponseId("openai", "gpt-4o-mini", "resp_xyz"),
    chain_origin: 3,
  });
  // The handle was minted by openai but this turn routes to anthropic → dropped.
  assert.equal(anthropic.lastPrev, null);
  assert.equal(anthropic.lastOrigin, null);
});

test("same provider, different model drops the chain handle (#245)", async () => {
  // simple → openai/gpt-5-mini, complex → openai/gpt-5: same provider, two
  // models. A handle minted by gpt-5-mini must NOT be forwarded to a gpt-5
  // request (a Responses previous_response_id is bound to its model → 400).
  const openai = new RecordingProvider("openai", "resp_new");
  const map = new Map<string, LlmProvider>([["openai", openai]]);
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"))
    .withTier("simple", modelRef("openai", "gpt-5-mini"))
    .withTier("complex", modelRef("openai", "gpt-5"));
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("complex"));

  const resp = await rp.complete({
    model: "x",
    messages: [],
    // Handle minted on a prior `simple` turn (gpt-5-mini).
    previous_response_id: stampResponseId("openai", "gpt-5-mini", "resp_xyz"),
    chain_origin: 3,
  });
  // Routed to gpt-5; the gpt-5-mini handle is dropped, not forwarded.
  assert.equal(openai.lastModel, "gpt-5");
  assert.equal(openai.lastPrev, null);
  assert.equal(openai.lastOrigin, null);
  // The fresh reply is stamped with the model that produced it.
  assert.equal(resp.response_id, stampResponseId("openai", "gpt-5", "resp_new"));
});

test("same provider, same model preserves the chain handle across tiers (#245)", async () => {
  // Both tiers map to the same (provider, model) → the handle is still valid
  // and must be forwarded (unstamped) so chaining keeps working.
  const openai = new RecordingProvider("openai", "resp_new");
  const map = new Map<string, LlmProvider>([["openai", openai]]);
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"))
    .withTier("simple", modelRef("openai", "gpt-5"))
    .withTier("complex", modelRef("openai", "gpt-5"));
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("complex"));

  await rp.complete({
    model: "x",
    messages: [],
    previous_response_id: stampResponseId("openai", "gpt-5", "resp_xyz"),
    chain_origin: 3,
  });
  assert.equal(openai.lastModel, "gpt-5");
  assert.equal(openai.lastPrev, "resp_xyz");
  assert.equal(openai.lastOrigin, 3);
});

test("untagged chain handle is cleared conservatively", async () => {
  const openai = new RecordingProvider("openai");
  const map = new Map<string, LlmProvider>([["openai", openai]]);
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini"));
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("simple"));

  await rp.complete({
    model: "x",
    messages: [],
    previous_response_id: "resp_legacy",
    chain_origin: 2,
  });
  assert.equal(openai.lastPrev, null);
  assert.equal(openai.lastOrigin, null);
});

test("complete does NOT mutate the caller's request object", async () => {
  const { map } = buildProviders();
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini")).withTier(
    "complex",
    modelRef("anthropic", "claude-opus"),
  );
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("complex"));
  const req: ChatRequest = {
    model: "original",
    messages: [],
    previous_response_id: stampResponseId("openai", "gpt-4o-mini", "resp_xyz"),
    chain_origin: 7,
  };
  await rp.complete(req);
  // Caller's object is untouched.
  assert.equal(req.model, "original");
  assert.equal(req.previous_response_id, stampResponseId("openai", "gpt-4o-mini", "resp_xyz"));
  assert.equal(req.chain_origin, 7);
});

// ---------- RoutingProvider: streaming ----------

test("completeStream rewrites the model, delegates, and re-stamps the finish id", async () => {
  const anthropic = new RecordingProvider("anthropic", "resp_xyz");
  const map = new Map<string, LlmProvider>([["anthropic", anthropic]]);
  const cfg = new RouterConfig(modelRef("openai", "gpt-4o-mini")).withTier(
    "complex",
    modelRef("anthropic", "claude-opus"),
  );
  const rp = new RoutingProvider(new RecordingProvider("fb"), map, cfg, new FixedClassifier("complex"));

  const stream = await rp.completeStream({
    model: "x",
    messages: [],
    previous_response_id: stampResponseId("openai", "gpt-4o-mini", "resp_xyz"),
    chain_origin: 3,
  });
  let last: LlmChunk | undefined;
  for await (const c of stream) last = c;

  assert.equal(anthropic.lastModel, "claude-opus");
  assert.ok(last && last.type === "finish");
  // Cross-provider → chain cleared on the way in.
  assert.match(body({ message: last.message, finish_reason: "stop" }), /anthropic:claude-opus\|prev=none\|origin=none/);
  // Finish id re-stamped with the routed provider and model.
  assert.equal(last.response_id, stampResponseId("anthropic", "claude-opus", "resp_xyz"));
});
