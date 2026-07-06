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

// Regression (#366): providers format upstream errors as `status <code>: <body>`.
// The structured status must decide, so a transient 5xx/429 whose body merely
// mentions an auth subsystem still triggers failover, and a real auth status
// stays fatal even when the body looks otherwise.
test("isTransientError classifies on the HTTP status, not auth words in the body", () => {
  assert.equal(
    isTransientError(new ProviderError("status 503: authentication service temporarily unavailable")),
    true,
    "503 with 'authentication' in the body is still transient",
  );
  assert.equal(
    isTransientError(new ProviderError("status 429: rate limited (trace 401-abc, unauthorized retry)")),
    true,
    "429 whose body mentions 401/unauthorized is still transient",
  );
  assert.equal(
    isTransientError(new ProviderError("status 500: internal error, invalid api key upstream")),
    true,
    "500 with 'invalid api key' in the body is still transient",
  );
  assert.equal(
    isTransientError(new ProviderError("status 408: request timeout")),
    true,
    "408 request-timeout is transient",
  );
  // Genuine auth/bad-request statuses stay fatal regardless of body wording.
  assert.equal(
    isTransientError(new ProviderError("status 401: server temporarily unavailable, please retry")),
    false,
    "401 stays fatal even if the body sounds transient",
  );
  assert.equal(isTransientError(new ProviderError("status 403: forbidden")), false);
  assert.equal(isTransientError(new ProviderError("status 400: bad request")), false);
  assert.equal(isTransientError(new ProviderError("status 404: model not found")), false);
});

test("FallbackProvider walks the chain on a 5xx whose body mentions authentication", async () => {
  const primary = StubProvider.err("status 503: authentication service temporarily unavailable");
  const fb = StubProvider.ok("fb");
  const wrapper = new FallbackProvider("primary", primary, [fallbackEntry("fb", fb)]);
  const resp = await wrapper.complete(req());
  assert.equal(primary.calls, 1);
  assert.equal(fb.calls, 1, "a transient 5xx must trigger failover even with auth words in the body");
  assert.equal(assistantContent(resp.message), "fb");
});
