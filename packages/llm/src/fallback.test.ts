import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider, Message } from "@jarvis/core";
import { ProviderError, assistantText } from "@jarvis/core";
import { FallbackProvider, fallbackEntry, isTransientError } from "./fallback.ts";

// ---------- Tiny fake inner provider ----------

/**
 * Stub provider that returns whatever its `outcome` callback produces, with a
 * call counter to verify ordering — mirrors the Rust test's StubProvider.
 */
class StubProvider implements LlmProvider {
  calls = 0;
  readonly #outcome: () => ChatResponse;

  constructor(outcome: () => ChatResponse) {
    this.#outcome = outcome;
  }

  static ok(label: string): StubProvider {
    return new StubProvider(() => ({
      message: assistantText(label),
      finish_reason: "stop",
      response_id: null,
    }));
  }

  static err(message: string): StubProvider {
    return new StubProvider(() => {
      throw new ProviderError(message);
    });
  }

  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    try {
      return Promise.resolve(this.#outcome());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  completeStream(_req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    this.calls += 1;
    const resp = this.#outcome(); // throws → rejects, matching the blocking path
    async function* one(): AsyncIterable<LlmChunk> {
      yield { type: "finish", message: resp.message, finish_reason: resp.finish_reason, response_id: null };
    }
    return Promise.resolve(one());
  }
}

function req(): ChatRequest {
  return { model: "test", messages: [{ role: "user", content: "hi" }] };
}

function assistantContent(m: Message): string | null | undefined {
  return (m as Extract<Message, { role: "assistant" }>).content;
}

// ---------- complete() fallback walk ----------

test("primary success skips fallbacks", async () => {
  const primary = StubProvider.ok("primary");
  const fb = StubProvider.ok("fb");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  const resp = await wrapper.complete(req());
  assert.equal(primary.calls, 1);
  assert.equal(fb.calls, 0, "fallback must not be called when primary succeeds");
  assert.equal(assistantContent(resp.message), "primary");
});

test("primary 429 walks to the first fallback and stops", async () => {
  const primary = StubProvider.err("HTTP 429 Too Many Requests");
  const fb1 = StubProvider.ok("fb1");
  const fb2 = StubProvider.ok("fb2");
  const wrapper = new FallbackProvider("primary", primary, [
    fallbackEntry("fb1", fb1),
    fallbackEntry("fb2", fb2),
  ]);
  const resp = await wrapper.complete(req());
  assert.equal(primary.calls, 1);
  assert.equal(fb1.calls, 1);
  assert.equal(fb2.calls, 0, "second fallback shouldn't fire after fb1 succeeds");
  assert.equal(assistantContent(resp.message), "fb1");
});

test("auth failure does not walk the chain", async () => {
  const primary = StubProvider.err("HTTP 401 Unauthorized: invalid api key");
  const fb = StubProvider.ok("fb");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  await assert.rejects(() => wrapper.complete(req()), /401/);
  assert.equal(primary.calls, 1);
  assert.equal(fb.calls, 0, "auth failures must not trigger fallback");
});

test("all-transient failures return the last error after exhausting the chain", async () => {
  const primary = StubProvider.err("503 Service Unavailable");
  const fb1 = StubProvider.err("502 Bad Gateway");
  const fb2 = StubProvider.err("connection reset by peer");
  const wrapper = new FallbackProvider("primary", primary, [
    fallbackEntry("fb1", fb1),
    fallbackEntry("fb2", fb2),
  ]);
  await assert.rejects(() => wrapper.complete(req()), /connection reset by peer/);
  assert.equal(primary.calls, 1);
  assert.equal(fb1.calls, 1);
  assert.equal(fb2.calls, 1);
});

test("self-referencing fallback is dropped by name", () => {
  const primary = StubProvider.ok("primary");
  const fbSelf = StubProvider.ok("primary");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("primary", fbSelf)]);
  assert.equal(wrapper.fallbackCount(), 0);
});

// ---------- streaming fallback ----------

test("completeStream walks to a fallback on a transient primary failure", async () => {
  const primary = StubProvider.err("503 Service Unavailable");
  const fb = StubProvider.ok("fb-stream");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  const stream = await wrapper.completeStream(req());
  const chunks: LlmChunk[] = [];
  for await (const c of stream) chunks.push(c);
  assert.equal(primary.calls, 1);
  assert.equal(fb.calls, 1);
  const finish = chunks.at(-1);
  assert.ok(finish && finish.type === "finish");
  assert.equal(assistantContent(finish.message), "fb-stream");
});

test("completeStream propagates a non-transient primary failure without retrying", async () => {
  const primary = StubProvider.err("HTTP 401 Unauthorized");
  const fb = StubProvider.ok("fb-stream");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  await assert.rejects(() => wrapper.completeStream(req()), /401/);
  assert.equal(fb.calls, 0);
});

// ---------- is_transient classifier ----------

test("isTransientError covers common transient signals", () => {
  assert.equal(isTransientError(new ProviderError("HTTP 429 too many")), true);
  assert.equal(isTransientError(new ProviderError("500 internal")), true);
  assert.equal(isTransientError(new ProviderError("connection refused")), true);
  assert.equal(isTransientError(new ProviderError("request timed out")), true);
  assert.equal(isTransientError(new ProviderError("rate_limit_exceeded")), true);
  assert.equal(isTransientError(new ProviderError("transport: error sending request for url")), true);
  assert.equal(
    isTransientError(
      new ProviderError("error sending request for url (https://api.example.com/v1/chat/completions)"),
    ),
    true,
  );
});

test("isTransientError rejects auth + bad-request signals", () => {
  assert.equal(isTransientError(new ProviderError("HTTP 401")), false);
  assert.equal(isTransientError(new ProviderError("invalid api key")), false);
  assert.equal(isTransientError(new ProviderError("model not found")), false);
  assert.equal(isTransientError(new ProviderError("400 bad json")), false);
});

test("isTransientError tolerates non-Error throwables (string / plain object)", () => {
  assert.equal(isTransientError("503 service unavailable"), true);
  assert.equal(isTransientError("401 unauthorized"), false);
});

test("structured status wins over an auth-mentioning response body (#366)", () => {
  // A genuine transient 5xx/429 whose *body* mentions auth must still fail over.
  assert.equal(
    isTransientError(
      new ProviderError("status 503: authentication service temporarily unavailable", 503),
    ),
    true,
  );
  assert.equal(
    isTransientError(new ProviderError("status 429: rate limited; trace 401abc", 429)),
    true,
  );
  // And a real auth failure with a structured status is still not transient.
  assert.equal(isTransientError(new ProviderError("status 401: invalid api key", 401)), false);
  assert.equal(isTransientError(new ProviderError("status 403: forbidden", 403)), false);
  // Other 4xx (bad request, model-not-found) remain non-transient.
  assert.equal(isTransientError(new ProviderError("status 400: bad request", 400)), false);
  assert.equal(isTransientError(new ProviderError("status 404: model not found", 404)), false);
});

test("FallbackProvider walks the chain on a 5xx whose body mentions auth (#366)", async () => {
  const primary = new StubProvider(() => {
    throw new ProviderError("status 503: authentication service temporarily unavailable", 503);
  });
  const fb = StubProvider.ok("fb-after-503");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  const resp = await wrapper.complete(req());
  assert.equal(primary.calls, 1);
  assert.equal(fb.calls, 1, "a 503-with-auth-body must trigger fallback");
  assert.equal(assistantContent(resp.message), "fb-after-503");
});
