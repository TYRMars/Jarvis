import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, LlmChunk, Message } from "@jarvis/core";
import { AnthropicProvider, StreamAccumulator, buildAnthropicRequest, convertMessages } from "./anthropic.ts";

function req(partial: Partial<ChatRequest> & { model: string; messages: Message[] }): ChatRequest {
  return partial;
}

// Drive the accumulator over a sequence of raw SSE event objects, appending any
// trailing finish from an unterminated stream.
function ingestAll(acc: StreamAccumulator, events: unknown[]): LlmChunk[] {
  const out: LlmChunk[] = [];
  for (const e of events) out.push(...acc.ingest(e as never));
  const f = acc.finalize();
  if (f) out.push(f);
  return out;
}

// ---------- Message → wire conversion ----------

test("convertMessages: hoists a system message to top-level (plain string)", () => {
  const { system, messages } = convertMessages([
    { role: "system", content: "you are jarvis" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "you are jarvis");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content, "hi"); // plain string, not blocks
});

test("convertMessages: joins multiple systems with \\n\\n", () => {
  const { system } = convertMessages([
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "first\n\nsecond");
});

test("convertMessages: no system message → undefined", () => {
  const { system } = convertMessages([{ role: "user", content: "hi" }]);
  assert.equal(system, undefined);
});

test("convertMessages: assistant with tool_calls becomes text+tool_use blocks (input is parsed JSON)", () => {
  const { messages } = convertMessages([
    { role: "user", content: "call something" },
    {
      role: "assistant",
      content: "sure",
      tool_calls: [{ id: "tu_1", name: "echo", arguments: { text: "hi" } }],
    },
  ]);
  assert.equal(messages.length, 2);
  const blocks = messages[1]?.content;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "sure" });
  // `input` is the parsed object, NOT a stringified JSON.
  assert.deepEqual(blocks[1], { type: "tool_use", id: "tu_1", name: "echo", input: { text: "hi" } });
});

test("convertMessages: coalesces consecutive tool results into one user message", () => {
  const { messages } = convertMessages([
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
  ]);
  // user, assistant(blocks), user(2 tool_results)
  assert.equal(messages.length, 3);
  const blocks = messages[2]?.content;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "tool_result");
  assert.equal((blocks[0] as { tool_use_id: string }).tool_use_id, "a");
  assert.equal((blocks[1] as { tool_use_id: string }).tool_use_id, "b");
  assert.equal((blocks[0] as { content: string }).content, "first");
});

test("convertMessages: empty assistant message round-trips as an empty text block", () => {
  const { messages } = convertMessages([{ role: "assistant" }]);
  const blocks = messages[0]?.content;
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(blocks, [{ type: "text", text: "" }]);
});

// ---------- Cache hints ----------

test("convertMessages: user without hint stays plain text; with hint becomes a cached block", () => {
  const plain = convertMessages([{ role: "user", content: "hi" }]);
  assert.equal(plain.messages[0]?.content, "hi");

  const cached = convertMessages([{ role: "user", content: "long context", cache: "ephemeral" }]);
  const blocks = cached.messages[0]?.content;
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(blocks, [
    { type: "text", text: "long context", cache_control: { type: "ephemeral" } },
  ]);
});

test("buildAnthropicRequest: system without cache hint serialises as a string", () => {
  const body = buildAnthropicRequest(
    req({ model: "claude-3-5-sonnet-latest", messages: [{ role: "system", content: "plain" }, { role: "user", content: "hi" }] }),
    false,
  );
  assert.equal(body.system, "plain");
});

test("buildAnthropicRequest: ephemeral system → block array with cache_control", () => {
  const body = buildAnthropicRequest(
    req({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "system", content: "you are jarvis", cache: "ephemeral" }, { role: "user", content: "hi" }],
    }),
    false,
  );
  assert.ok(Array.isArray(body.system));
  assert.deepEqual(body.system, [{ type: "text", text: "you are jarvis", cache_control: { type: "ephemeral" } }]);
});

test("buildAnthropicRequest: persistent system → ttl 1h", () => {
  const body = buildAnthropicRequest(
    req({ model: "claude-3-5-sonnet-latest", messages: [{ role: "system", content: "long", cache: "persistent" }] }),
    false,
  );
  assert.ok(Array.isArray(body.system));
  assert.deepEqual(body.system[0]?.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("buildAnthropicRequest: mixed systems emit cache_control only on the hinted one", () => {
  const body = buildAnthropicRequest(
    req({
      model: "claude-3-5-sonnet-latest",
      messages: [
        { role: "system", content: "rules", cache: "ephemeral" },
        { role: "system", content: "dynamic header" },
      ],
    }),
    false,
  );
  assert.ok(Array.isArray(body.system));
  assert.equal(body.system.length, 2);
  assert.deepEqual(body.system[0]?.cache_control, { type: "ephemeral" });
  assert.equal(body.system[1]?.cache_control, undefined);
});

test("convertMessages: assistant cache hint lands on the last block (tool_use over text)", () => {
  const { messages } = convertMessages([
    {
      role: "assistant",
      content: "sure",
      tool_calls: [{ id: "tu_1", name: "echo", arguments: { text: "hi" } }],
      cache: "ephemeral",
    },
  ]);
  const blocks = messages[0]?.content;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0]?.cache_control, undefined);
  assert.equal(blocks[1]?.type, "tool_use");
  assert.deepEqual(blocks[1]?.cache_control, { type: "ephemeral" });
});

test("convertMessages: tool_result cache hint lands only on the tagged coalesced block", () => {
  const { messages } = convertMessages([
    { role: "tool", tool_call_id: "call_a", content: "first" },
    { role: "tool", tool_call_id: "call_b", content: "second", cache: "ephemeral" },
  ]);
  assert.equal(messages.length, 1, "tool results should coalesce");
  const blocks = messages[0]?.content;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.cache_control, undefined);
  assert.deepEqual(blocks[1]?.cache_control, { type: "ephemeral" });
});

// ---------- Tools / max_tokens ----------

test("buildAnthropicRequest: tools map to {name,description,input_schema}; max_tokens defaults to 4096", () => {
  const body = buildAnthropicRequest(
    req({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", description: "echo back", parameters: { type: "object" } }],
    }),
    false,
  );
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.tools?.length, 1);
  assert.equal(body.tools?.[0]?.name, "echo");
  assert.equal(body.tools?.[0]?.description, "echo back");
  assert.deepEqual(body.tools?.[0]?.input_schema, { type: "object" });
  assert.equal(body.tools?.[0]?.cache_control, undefined);
});

test("buildAnthropicRequest: caller max_tokens is honoured; empty tools omitted; stream flag", () => {
  const blocking = buildAnthropicRequest(req({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }), false);
  assert.equal(blocking.max_tokens, 100);
  assert.equal("tools" in blocking, false);
  assert.equal("stream" in blocking, false);

  const streaming = buildAnthropicRequest(req({ model: "m", messages: [{ role: "user", content: "hi" }] }), true);
  assert.equal(streaming.stream, true);
});

test("buildAnthropicRequest: cacheable opt-in attaches cache_control to the LAST tool only", () => {
  const body = buildAnthropicRequest(
    req({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "echo", description: "echo", parameters: { type: "object" }, cacheable: true },
        { name: "time.now", description: "time", parameters: { type: "object" } },
      ],
    }),
    false,
  );
  assert.equal(body.tools?.[0]?.cache_control, undefined);
  assert.deepEqual(body.tools?.[1]?.cache_control, { type: "ephemeral" });
});

// ---------- finish_reason mapping ----------

test("finish_reason: stop_reason maps via the non-stream response path", async () => {
  // end_turn → stop, tool_use → tool_calls, max_tokens → length, unknown → {other}
  const cases: { stop: string; expected: unknown }[] = [
    { stop: "end_turn", expected: "stop" },
    { stop: "stop_sequence", expected: "stop" },
    { stop: "max_tokens", expected: "length" },
    { stop: "weird", expected: { other: "weird" } },
  ];
  for (const c of cases) {
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: c.stop }), { status: 200 }),
    });
    // Drive complete() to exercise mapStopReason through the public surface.
    const resp = await provider.complete(req({ model: "m", messages: [{ role: "user", content: "x" }] }));
    assert.deepEqual(resp.finish_reason, c.expected);
  }
});

test("finish_reason: missing stop_reason with tool calls → tool_calls, else stop", async () => {
  const withTool = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "echo", input: {} }] }), { status: 200 }),
  });
  const r1 = await withTool.complete(req({ model: "m", messages: [{ role: "user", content: "x" }] }));
  assert.equal(r1.finish_reason, "tool_calls");

  const textOnly = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 }),
  });
  const r2 = await textOnly.complete(req({ model: "m", messages: [{ role: "user", content: "x" }] }));
  assert.equal(r2.finish_reason, "stop");
});

// ---------- Streaming reassembly ----------

test("stream: text deltas reassemble and finish on message_stop", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    { type: "message_start", message: {} },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
    { type: "message_stop" },
  ]);
  const deltas = out.filter((c) => c.type === "content_delta").map((c) => (c as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello");
});

test("stream: tool_use input arrives as input_json_delta fragments, parsed at content_block_stop", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "echo", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"te' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'xt":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"hi"' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
    { type: "message_stop" },
  ]);

  // First tool_call_delta on block_start carries id+name; subsequent ones carry fragments.
  const tcDeltas = out.filter((c) => c.type === "tool_call_delta");
  assert.equal((tcDeltas[0] as { id?: string }).id, "tu_1");
  assert.equal((tcDeltas[0] as { name?: string }).name, "echo");
  assert.equal((tcDeltas[1] as { arguments_fragment?: string }).arguments_fragment, '{"te');

  const finish = out.at(-1)!;
  assert.ok(finish.type === "finish");
  assert.equal(finish.finish_reason, "tool_calls");
  const m = finish.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0]?.id, "tu_1");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("stream: usage surfaces before finish on message_stop", () => {
  const acc = new StreamAccumulator();
  const out = ingestAll(acc, [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
  const usageIdx = out.findIndex((c) => c.type === "usage");
  const finishIdx = out.findIndex((c) => c.type === "finish");
  assert.ok(usageIdx !== -1 && finishIdx !== -1 && usageIdx < finishIdx);
  const usage = (out[usageIdx] as Extract<LlmChunk, { type: "usage" }>).usage;
  // prompt = input(10) + cache_read(4); cached surfaced separately.
  assert.equal(usage.prompt_tokens, 14);
  assert.equal(usage.cached_prompt_tokens, 4);
  assert.equal(usage.completion_tokens, 5);
});

test("stream: unknown event type is ignored", () => {
  const acc = new StreamAccumulator();
  const r = acc.ingest({ type: "future_event", data: 42 } as never);
  assert.equal(r.length, 0);
});

// ---------- End-to-end via injected fetch ----------

test("complete: parses text + tool_use blocks, maps usage", async () => {
  const responseBody = {
    content: [
      { type: "text", text: "before " },
      { type: "text", text: "after" },
      { type: "tool_use", id: "tu_x", name: "echo", input: { text: "hi" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2 },
  };
  const provider = new AnthropicProvider({
    apiKey: "sk-ant-test",
    fetchImpl: async (url, init) => {
      // Verify required headers are set.
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-api-key"), "sk-ant-test");
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
      assert.match(String(url), /\/messages$/);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    },
  });
  const resp = await provider.complete(
    req({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "do it" }],
      tools: [{ name: "echo", description: "d", parameters: { type: "object" } }],
    }),
  );
  assert.equal(resp.finish_reason, "tool_calls");
  const m = resp.message as Extract<Message, { role: "assistant" }>;
  assert.equal(m.content, "before after");
  assert.equal(m.tool_calls?.[0]?.id, "tu_x");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
  assert.equal(resp.usage?.prompt_tokens, 14); // 12 + 2 cache_read
  assert.equal(resp.usage?.cached_prompt_tokens, 2);
  assert.equal(resp.usage?.completion_tokens, 3);
});

test("complete: honours custom anthropicVersion header", async () => {
  const provider = new AnthropicProvider({
    apiKey: "k",
    anthropicVersion: "2099-01-01",
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("anthropic-version"), "2099-01-01");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), { status: 200 });
    },
  });
  const resp = await provider.complete(req({ model: "m", messages: [{ role: "user", content: "x" }] }));
  assert.equal((resp.message as Extract<Message, { role: "assistant" }>).content, "ok");
});

test("complete: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async () => new Response("overloaded", { status: 529 }),
  });
  await assert.rejects(
    () => provider.complete(req({ model: "m", messages: [{ role: "user", content: "hi" }] })),
    /status 529: overloaded/,
  );
});

test("completeStream: end-to-end typed SSE → content deltas + finish", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const provider = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async () => new Response(sse, { status: 200 }),
  });
  const stream = await provider.completeStream(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);

  const deltas = events.filter((e) => e.type === "content_delta").map((e) => (e as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const usageIdx = events.findIndex((e) => e.type === "usage");
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(usageIdx !== -1 && finishIdx !== -1 && usageIdx < finishIdx);
  const finish = events[finishIdx] as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as Extract<Message, { role: "assistant" }>).content, "Hello");
});

test("completeStream: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async () => new Response("bad request", { status: 400 }),
  });
  await assert.rejects(
    async () => {
      const stream = await provider.completeStream(req({ model: "m", messages: [{ role: "user", content: "hi" }] }));
      for await (const _c of stream) void _c;
    },
    /status 400: bad request/,
  );
});
