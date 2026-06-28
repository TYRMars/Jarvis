import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, LlmChunk, Message } from "@jarvis/core";
import {
  OpenAiProvider,
  StreamAccumulator,
  buildOpenAiRequest,
  sanitizeToolName,
} from "./openai.ts";
import { autoCacheKey } from "./cache-key.ts";

// ---------- StreamAccumulator ----------

function ingestAll(acc: StreamAccumulator, chunks: unknown[]): LlmChunk[] {
  const out: LlmChunk[] = [];
  for (const c of chunks) out.push(...acc.ingest(c as never));
  const f = acc.flush();
  if (f) out.push(f);
  return out;
}

test("accumulator: content deltas reassemble; finish held until close", () => {
  const acc = new StreamAccumulator();
  const out1 = acc.ingest({ choices: [{ delta: { content: "Hel" } }] } as never);
  const out2 = acc.ingest({ choices: [{ delta: { content: "lo" } }] } as never);
  const out3 = acc.ingest({ choices: [{ delta: {}, finish_reason: "stop" }] } as never);
  assert.deepEqual(out1, [{ type: "content_delta", content: "Hel" }]);
  assert.deepEqual(out2, [{ type: "content_delta", content: "lo" }]);
  assert.equal(out3.length, 0); // finish buffered

  const finish = acc.flush();
  assert.ok(finish && finish.type === "finish");
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello");
});

test("accumulator: normalises cumulative content snapshots", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: "Hello world" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  const deltas = out.filter((c) => c.type === "content_delta").map((c) => (c as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo", " world"]);
  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello world");
});

test("accumulator: reassembles a tool call across chunks (args → parsed JSON)", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "echo", arguments: '{"te' } }] },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "tool_calls");
  const m = finish.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0]?.id, "call_abc");
  assert.equal(m.tool_calls?.[0]?.name, "echo");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("accumulator: usage chunk surfaces before the held finish", () => {
  const acc = new StreamAccumulator();
  const first = acc.ingest({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] } as never);
  assert.deepEqual(first, [{ type: "content_delta", content: "hi" }]); // finish buffered

  const second = acc.ingest({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  } as never);
  assert.equal(second[0]?.type, "usage");
  assert.equal(second[1]?.type, "finish");
  assert.equal((second[0] as { usage: { prompt_tokens: number } }).usage.prompt_tokens, 10);
  assert.equal(acc.flush(), undefined); // nothing left
});

test("accumulator: restores sanitised tool-call name from the map", () => {
  const acc = new StreamAccumulator(new Map([["fs_read", "fs.read"]]));
  const out = acc.ingest({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "fs_read", arguments: "{}" } }] } }],
  } as never);
  const delta = out.find((c) => c.type === "tool_call_delta") as { name?: string };
  assert.equal(delta.name, "fs.read");
  const finish = ingestAll(acc, [{ choices: [{ delta: {}, finish_reason: "tool_calls" }] }]).at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).tool_calls?.[0]?.name, "fs.read");
});

// ---------- Tool-name sanitisation ----------

test("sanitizeToolName: replaces dots, keeps letters, prefixes leading non-letter", () => {
  assert.equal(sanitizeToolName("fs.read"), "fs_read");
  assert.equal(sanitizeToolName("code.grep"), "code_grep");
  assert.equal(sanitizeToolName("echo"), "echo");
  assert.equal(sanitizeToolName("9foo"), "_9foo");
});

// ---------- Cache key ----------

test("cache key: namespaced format, 23 chars, hex tail", () => {
  const k = autoCacheKey("m", "s", "t");
  assert.ok(k.startsWith("jarvis-"));
  assert.equal(k.length, 23);
  assert.match(k.slice(7), /^[0-9a-f]{16}$/);
});

test("cache key: stable for identical inputs; distinct on model/system/tools", () => {
  assert.equal(autoCacheKey("m", "sys", "[]"), autoCacheKey("m", "sys", "[]"));
  assert.notEqual(autoCacheKey("m1", "sys", "[]"), autoCacheKey("m2", "sys", "[]"));
  assert.notEqual(autoCacheKey("m", "a", "[]"), autoCacheKey("m", "b", "[]"));
  assert.notEqual(autoCacheKey("m", "s", '[{"name":"a"}]'), autoCacheKey("m", "s", '[{"name":"a"},{"name":"b"}]'));
  // null separator keeps ("ab","c") distinct from ("a","bc")
  assert.notEqual(autoCacheKey("ab", "c", ""), autoCacheKey("a", "bc", ""));
});

// ---------- Outbound request building ----------

function req(partial: Partial<ChatRequest> & { model: string; messages: Message[] }): ChatRequest {
  return partial;
}

test("buildOpenAiRequest: renames tools and inline assistant tool_calls", () => {
  const { request, nameMap } = buildOpenAiRequest(
    req({
      model: "kimi-for-coding",
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", tool_calls: [{ id: "call_1", name: "fs.read", arguments: { path: "x" } }] },
      ],
      tools: [{ name: "fs.read", description: "read a file", parameters: { type: "object" } }],
    }),
    false,
    false,
    undefined,
  );
  const body = request as {
    tools: { function: { name: string } }[];
    messages: { role: string; tool_calls?: { function: { name: string; arguments: string } }[] }[];
  };
  assert.equal(body.tools[0]?.function.name, "fs_read");
  const asst = body.messages.find((m) => m.role === "assistant")!;
  assert.equal(asst.tool_calls?.[0]?.function.name, "fs_read");
  // arguments go out as a JSON-encoded string
  assert.equal(asst.tool_calls?.[0]?.function.arguments, '{"path":"x"}');
  assert.equal(nameMap.get("fs_read"), "fs.read");
});

test("buildOpenAiRequest: omits empty tools and falsy stream; stream adds stream_options", () => {
  const blocking = buildOpenAiRequest(req({ model: "m", messages: [{ role: "user", content: "hi" }] }), false, false, undefined).request;
  assert.equal("tools" in blocking, false);
  assert.equal("stream" in blocking, false);

  const streaming = buildOpenAiRequest(req({ model: "m", messages: [{ role: "user", content: "hi" }] }), true, false, undefined).request as Record<string, unknown>;
  assert.equal(streaming.stream, true);
  assert.deepEqual(streaming.stream_options, { include_usage: true });
});

test("buildOpenAiRequest: empty-reasoning flag emits placeholder for thinking tool calls", () => {
  const { request } = buildOpenAiRequest(
    req({
      model: "kimi-k2-thinking",
      messages: [{ role: "assistant", tool_calls: [{ id: "c", name: "fs.read", arguments: {} }] }],
    }),
    false,
    true,
    undefined,
  );
  const asst = (request as { messages: { role: string; reasoning_content?: string }[] }).messages[0]!;
  assert.equal(asst.reasoning_content, "");
});

test("buildOpenAiRequest: explicit cache key overrides auto-derive", () => {
  const { request } = buildOpenAiRequest(req({ model: "x", messages: [] }), false, false, "custom");
  assert.equal((request as { prompt_cache_key: string }).prompt_cache_key, "custom");
});

// ---------- End-to-end via injected fetch ----------

test("complete: parses choices, restores tool name, maps usage", async () => {
  const responseBody = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "fs_read", arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
  };
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(
    req({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [{ name: "fs.read", description: "d", parameters: { type: "object" } }],
    }),
  );
  assert.equal(resp.finish_reason, "tool_calls");
  const m = resp.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.tool_calls?.[0]?.name, "fs.read"); // restored from fs_read
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { path: "a.txt" });
  assert.equal(resp.usage?.prompt_tokens, 12);
  assert.equal(resp.usage?.cached_prompt_tokens, 4);
});

// Regression: OpenAI-compatible backends (Ollama / LM Studio / vLLM / Kimi) may
// report finish_reason:"stop" alongside a populated tool_calls array. A populated
// tool_calls array must be treated as authoritative so the agent loop dispatches
// the tools instead of ending the turn. See issue #246.
test("complete: explicit finish_reason 'stop' with tool_calls maps to tool_calls", async () => {
  const responseBody = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "fs_read", arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: "stop",
      },
    ],
  };
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }),
  });
  const resp = await provider.complete(
    req({
      model: "kimi-k2-thinking",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [{ name: "fs.read", description: "d", parameters: { type: "object" } }],
    }),
  );
  assert.equal(resp.finish_reason, "tool_calls"); // overridden from explicit "stop"
  const m = resp.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.tool_calls?.[0]?.name, "fs.read");
});

test("completeStream: finish 'stop' with tool_calls maps to tool_calls", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read","arguments":"{}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(sse, { status: 200 }),
  });
  const stream = await provider.completeStream(
    req({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "fs.read", description: "d", parameters: { type: "object" } }],
    }),
  );
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);
  const finish = events.find((e) => e.type === "finish") as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "tool_calls"); // overridden from explicit "stop"
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).tool_calls?.[0]?.name, "fs.read");
});

test("complete: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response("nope", { status: 429 }),
  });
  await assert.rejects(
    () => provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] })),
    /status 429: nope/,
  );
});

test("completeStream: end-to-end SSE → content deltas + finish", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    fetchImpl: async () => new Response(sse, { status: 200 }),
  });
  const stream = await provider.completeStream(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);

  const deltas = events.filter((e) => e.type === "content_delta").map((e) => (e as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const usageIdx = events.findIndex((e) => e.type === "usage");
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(usageIdx !== -1 && finishIdx !== -1 && usageIdx < finishIdx); // usage before finish
  const finish = events[finishIdx] as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello");
});
