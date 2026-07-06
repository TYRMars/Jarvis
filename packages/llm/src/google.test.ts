import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, LlmChunk, Message } from "@jarvis/core";
import { GoogleProvider, StreamAccumulator, buildGoogleRequest } from "./google.ts";

function req(partial: Partial<ChatRequest> & { model: string; messages: Message[] }): ChatRequest {
  return partial;
}

// ---------- Outbound request building ----------

test("buildGoogleRequest: hoists system messages to systemInstruction", () => {
  const body = buildGoogleRequest(
    req({
      model: "gemini-1.5-pro",
      messages: [
        { role: "system", content: "you are jarvis" },
        { role: "user", content: "hi" },
      ],
    }),
  );
  assert.equal((body.systemInstruction?.parts[0] as { text: string }).text, "you are jarvis");
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0]?.role, "user");
});

test("buildGoogleRequest: joins multiple system messages with blank lines", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "hi" },
      ],
    }),
  );
  assert.equal((body.systemInstruction?.parts[0] as { text: string }).text, "one\n\ntwo");
});

test("buildGoogleRequest: assistant maps to model role with text part", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    }),
  );
  assert.equal(body.contents[1]?.role, "model");
  assert.equal((body.contents[1]?.parts[0] as { text: string }).text, "hello");
});

test("buildGoogleRequest: assistant tool_calls become functionCall parts (args passed through as object)", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "ask" },
        {
          role: "assistant",
          content: "sure",
          tool_calls: [{ id: "id_1", name: "echo", arguments: { text: "hi" } }],
        },
      ],
    }),
  );
  const parts = body.contents[1]?.parts ?? [];
  assert.equal(parts.length, 2);
  assert.equal((parts[0] as { text: string }).text, "sure");
  const fc = parts[1] as { functionCall: { name: string; args: { text: string } } };
  assert.equal(fc.functionCall.name, "echo");
  assert.equal(fc.functionCall.args.text, "hi");
});

test("buildGoogleRequest: empty model turn emits an empty text part", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant" }, // no content, no tool_calls
      ],
    }),
  );
  assert.equal(body.contents[1]?.role, "model");
  assert.deepEqual(body.contents[1]?.parts, [{ text: "" }]);
});

test("buildGoogleRequest: tool result resolves name via the turn lookup, wrapped as {result}", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "ask" },
        { role: "assistant", tool_calls: [{ id: "abc", name: "echo", arguments: {} }] },
        { role: "tool", tool_call_id: "abc", content: "got it" },
      ],
    }),
  );
  const c = body.contents[2];
  assert.equal(c?.role, "user");
  const fr = c?.parts[0] as { functionResponse: { name: string; response: { result: string } } };
  assert.equal(fr.functionResponse.name, "echo");
  assert.equal(fr.functionResponse.response.result, "got it");
});

test("buildGoogleRequest: consecutive tool results coalesce into one user message", () => {
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "ask" },
        {
          role: "assistant",
          tool_calls: [
            { id: "a", name: "x", arguments: {} },
            { id: "b", name: "y", arguments: {} },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "first" },
        { role: "tool", tool_call_id: "b", content: "second" },
      ],
    }),
  );
  // user, model, user (with two functionResponse parts)
  assert.equal(body.contents.length, 3);
  const parts = body.contents[2]?.parts ?? [];
  assert.equal(parts.length, 2);
  assert.equal((parts[0] as { functionResponse: { name: string } }).functionResponse.name, "x");
  assert.equal((parts[1] as { functionResponse: { name: string } }).functionResponse.name, "y");
});

test("buildGoogleRequest: tool-name resolution is per-turn despite colliding gem ids (issue #45)", () => {
  // Synthesised `gem_<index>` ids restart at gem_0 each turn; a
  // conversation-wide map would let turn 2's gem_0 (code.grep) shadow turn 1's
  // gem_0 (fs.read). Resolution must be scoped to the reply's own turn.
  const body = buildGoogleRequest(
    req({
      model: "m",
      messages: [
        { role: "user", content: "turn one" },
        { role: "assistant", tool_calls: [{ id: "gem_0", name: "fs.read", arguments: {} }] },
        { role: "tool", tool_call_id: "gem_0", content: "file contents" },
        { role: "user", content: "turn two" },
        { role: "assistant", tool_calls: [{ id: "gem_0", name: "code.grep", arguments: {} }] },
        { role: "tool", tool_call_id: "gem_0", content: "grep hits" },
      ],
    }),
  );
  // user, model, user(result), user(question), model, user(result)
  assert.equal(body.contents.length, 6);
  const r1 = body.contents[2]?.parts[0] as {
    functionResponse: { name: string; response: { result: string } };
  };
  assert.equal(r1.functionResponse.name, "fs.read");
  assert.equal(r1.functionResponse.response.result, "file contents");
  const r2 = body.contents[5]?.parts[0] as {
    functionResponse: { name: string; response: { result: string } };
  };
  assert.equal(r2.functionResponse.name, "code.grep");
  assert.equal(r2.functionResponse.response.result, "grep hits");
});

test("buildGoogleRequest: tools become a single functionDeclarations group; generationConfig only when set", () => {
  const withTools = buildGoogleRequest(
    req({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", description: "d", parameters: { type: "object" } }],
      temperature: 0.5,
      max_tokens: 256,
    }),
  );
  assert.equal(withTools.tools?.length, 1);
  assert.equal(withTools.tools?.[0]?.functionDeclarations[0]?.name, "echo");
  assert.deepEqual(withTools.generationConfig, { temperature: 0.5, maxOutputTokens: 256 });

  const bare = buildGoogleRequest(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(bare.tools, undefined);
  assert.equal(bare.generationConfig, undefined);
});

// ---------- Non-streaming response decode ----------

test("intoChatResponse via complete: decodes text + functionCall, synthesises gem id", async () => {
  const responseBody = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "thinking..." }, { functionCall: { name: "echo", args: { text: "hi" } } }],
        },
        finishReason: "STOP",
      },
    ],
  };
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(req({ model: "gemini-1.5-pro", messages: [{ role: "user", content: "hi" }] }));
  const m = resp.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.content, "thinking...");
  assert.equal(m.tool_calls?.length, 1);
  assert.ok(m.tool_calls?.[0]?.id.startsWith("gem_"));
  assert.equal(m.tool_calls?.[0]?.name, "echo");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
  // Gemini reports "STOP" even on a function-call turn; we remap to
  // "tool_calls" so the core loop actually dispatches the tool (issue #356).
  assert.equal(resp.finish_reason, "tool_calls");
});

test("complete: missing finishReason with tool calls maps to tool_calls", async () => {
  const responseBody = {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "echo", args: {} } }] } }],
  };
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(resp.finish_reason, "tool_calls");
});

test("complete: MAX_TOKENS maps to length; usageMetadata maps to core Usage", async () => {
  const responseBody = {
    candidates: [{ content: { role: "model", parts: [{ text: "truncated" }] }, finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, cachedContentTokenCount: 4, thoughtsTokenCount: 2 },
  };
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(resp.finish_reason, "length");
  assert.equal(resp.usage?.prompt_tokens, 12);
  assert.equal(resp.usage?.completion_tokens, 3);
  assert.equal(resp.usage?.cached_prompt_tokens, 4);
  assert.equal(resp.usage?.reasoning_tokens, 2);
});

test("complete: unknown finishReason becomes { other }", async () => {
  const responseBody = {
    candidates: [{ content: { role: "model", parts: [{ text: "blocked" }] }, finishReason: "SAFETY" }],
  };
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.deepEqual(resp.finish_reason, { other: "SAFETY" });
});

test("complete: empty candidates throws ProviderError", async () => {
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
  });
  await assert.rejects(
    () => provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] })),
    /no candidates/,
  );
});

test("complete: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response("denied", { status: 403 }),
  });
  await assert.rejects(
    () => provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] })),
    /status 403: denied/,
  );
});

// ---------- StreamAccumulator ----------

function ingestAll(acc: StreamAccumulator, chunks: unknown[]): LlmChunk[] {
  const out: LlmChunk[] = [];
  for (const c of chunks) out.push(...acc.ingest(c as never));
  out.push(...acc.flush());
  return out;
}

test("accumulator: text chunks concatenate; finish synthesised on flush", () => {
  const acc = new StreamAccumulator();
  const r1 = acc.ingest({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] } as never);
  const r2 = acc.ingest({ candidates: [{ content: { parts: [{ text: "lo" }] } }] } as never);
  const r3 = acc.ingest({
    candidates: [{ content: { parts: [{ text: " world" }] }, finishReason: "STOP" }],
  } as never);
  assert.deepEqual(r1, [{ type: "content_delta", content: "Hel" }]);
  assert.deepEqual(r2, [{ type: "content_delta", content: "lo" }]);
  assert.deepEqual(r3, [{ type: "content_delta", content: " world" }]);

  const tail = acc.flush();
  const finish = tail.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello world");
});

test("accumulator: functionCall arrives whole in one chunk (id+name, no fragment)", () => {
  const acc = new StreamAccumulator();
  const r = acc.ingest({
    candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: { text: "hi" } } }] } }],
  } as never);
  assert.equal(r.length, 1);
  const delta = r[0] as Extract<LlmChunk, { type: "tool_call_delta" }>;
  assert.equal(delta.index, 0);
  assert.ok(delta.id?.startsWith("gem_"));
  assert.equal(delta.name, "echo");
  assert.equal(delta.arguments_fragment, undefined);

  const finish = acc.flush().at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "tool_calls");
  const m = finish.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0]?.name, "echo");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("accumulator: mixed text + functionCall remaps STOP to tool_calls", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    { candidates: [{ content: { parts: [{ text: "thinking..." }] } }] },
    {
      candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: {} } }] }, finishReason: "STOP" }],
    },
  ]);
  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  // STOP + a functionCall part → tool_calls so the loop dispatches (issue #356).
  assert.equal(finish.finish_reason, "tool_calls");
  const m = finish.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.content, "thinking...");
  assert.equal(m.tool_calls?.length, 1);
});

test("accumulator: empty stream finalises to a stop finish", () => {
  const acc = new StreamAccumulator();
  const out = acc.flush();
  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "stop");
  const m = finish.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.content, undefined);
  assert.equal(m.tool_calls, undefined);
  // flush is idempotent — already finalised.
  assert.deepEqual(acc.flush(), []);
});

test("accumulator: unknown part shapes are ignored", () => {
  const acc = new StreamAccumulator();
  const r = acc.ingest({
    candidates: [{ content: { parts: [{ futureFeature: "should not break" }, { text: "real" }] } }],
  } as never);
  assert.deepEqual(r, [{ type: "content_delta", content: "real" }]);
});

test("accumulator: usage snapshot surfaces before finish on flush", () => {
  const acc = new StreamAccumulator();
  acc.ingest({
    candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  } as never);
  const tail = acc.flush();
  assert.equal(tail[0]?.type, "usage");
  assert.equal(tail[1]?.type, "finish");
  assert.equal((tail[0] as Extract<LlmChunk, { type: "usage" }>).usage.prompt_tokens, 10);
});

// ---------- End-to-end streaming via injected fetch ----------

test("completeStream: end-to-end SSE → content deltas + synthesised finish", async () => {
  const sse =
    'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}\n\n';
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(sse, { status: 200 }),
  });
  const stream = await provider.completeStream(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);

  const deltas = events.filter((e) => e.type === "content_delta").map((e) => (e as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo", " world"]);
  const usageIdx = events.findIndex((e) => e.type === "usage");
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(usageIdx !== -1 && finishIdx !== -1 && usageIdx < finishIdx);
  const finish = events[finishIdx] as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello world");
  assert.equal((events[usageIdx] as Extract<LlmChunk, { type: "usage" }>).usage.prompt_tokens, 7);
});

test("completeStream: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new GoogleProvider({
    apiKey: "k",
    fetchImpl: async () => new Response("bad", { status: 500 }),
  });
  await assert.rejects(
    async () => {
      const s = await provider.completeStream(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
      for await (const _ of s) void _;
    },
    /status 500: bad/,
  );
});
