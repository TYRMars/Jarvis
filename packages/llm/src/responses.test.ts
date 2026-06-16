import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, LlmChunk, Message } from "@jarvis/core";
import {
  ResponsesProvider,
  StreamAccumulator,
  buildResponsesRequest,
  intoChatResponse,
  responsesCodexConfig,
  responsesOpenAiConfig,
  sanitizeToolName,
  type ResponsesConfig,
} from "./responses.ts";
import { CodexAuth } from "./codex-auth.ts";

// ---------- Helpers ----------

function req(partial: Partial<ChatRequest> & { messages: Message[] }): ChatRequest {
  return { model: "gpt-5-codex-mini", ...partial };
}

function codexCfg(): ResponsesConfig {
  return responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "test-token" }));
}

function build(r: ChatRequest, cfg: ResponsesConfig, stream = false): Record<string, unknown> {
  return buildResponsesRequest(r, cfg, stream).request;
}

type AsstMsg = Extract<Message, { role: "assistant" }>;

// ---------- Message → wire conversion ----------

test("convert: pulls system into top-level instructions", () => {
  const v = build(req({ messages: [{ role: "system", content: "you are jarvis" }, { role: "user", content: "hi" }] }), codexCfg());
  assert.equal(v.instructions, "you are jarvis");
  const input = v.input as Record<string, unknown>[];
  assert.equal(input.length, 1);
  assert.equal(input[0]?.type, "message");
  assert.equal(input[0]?.role, "user");
  const content = input[0]?.content as Record<string, unknown>[];
  assert.equal(content[0]?.type, "input_text");
  assert.equal(content[0]?.text, "hi");
});

test("convert: concatenates multiple system messages with \\n\\n", () => {
  const v = build(
    req({ messages: [{ role: "system", content: "first" }, { role: "system", content: "second" }, { role: "user", content: "hi" }] }),
    codexCfg(),
  );
  assert.equal(v.instructions, "first\n\nsecond");
});

test("convert: assistant text + tool_calls split into separate items", () => {
  const v = build(
    req({
      messages: [
        { role: "user", content: "ask" },
        { role: "assistant", content: "sure", tool_calls: [{ id: "fc_1", name: "echo", arguments: { text: "hi" } }] },
      ],
    }),
    codexCfg(),
  );
  const items = v.input as Record<string, unknown>[];
  assert.equal(items.length, 3);
  assert.equal(items[1]?.type, "message");
  assert.equal(items[1]?.role, "assistant");
  const c = items[1]?.content as Record<string, unknown>[];
  assert.equal(c[0]?.type, "output_text");
  assert.equal(c[0]?.text, "sure");
  assert.equal(items[2]?.type, "function_call");
  assert.equal(items[2]?.call_id, "fc_1");
  assert.equal(items[2]?.name, "echo");
  // arguments go out as a JSON-encoded string
  assert.equal(items[2]?.arguments, '{"text":"hi"}');
});

test("convert: assistant with only tool_calls skips the message item", () => {
  const v = build(
    req({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "fc_1", name: "echo", arguments: {} }] },
      ],
    }),
    codexCfg(),
  );
  const items = v.input as Record<string, unknown>[];
  assert.equal(items.length, 2);
  assert.equal(items[0]?.type, "message");
  assert.equal(items[1]?.type, "function_call");
});

test("convert: tool reply becomes function_call_output", () => {
  const v = build(
    req({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "fc_1", name: "echo", arguments: {} }] },
        { role: "tool", tool_call_id: "fc_1", content: "the output" },
      ],
    }),
    codexCfg(),
  );
  const items = v.input as Record<string, unknown>[];
  assert.equal(items.length, 3);
  assert.equal(items[2]?.type, "function_call_output");
  assert.equal(items[2]?.call_id, "fc_1");
  assert.equal(items[2]?.output, "the output");
});

test("convert: tool spec serialised as a flat function shape", () => {
  const v = build(
    req({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "echo", description: "echo it", parameters: { type: "object" } }] }),
    codexCfg(),
  );
  const tools = v.tools as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.name, "echo");
  assert.equal(tools[0]?.description, "echo it");
  assert.equal(typeof tools[0]?.parameters, "object");
  assert.equal("function" in (tools[0] as object), false);
});

test("convert: sanitises dotted tool names in tools + inline calls; name map round-trips", () => {
  const { request, nameMap } = buildResponsesRequest(
    req({
      model: "gpt-5.4-mini",
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", tool_calls: [{ id: "fc_1", name: "fs.read", arguments: { path: "x" } }] },
      ],
      tools: [
        { name: "fs.read", description: "read a file", parameters: { type: "object" } },
        { name: "code.grep", description: "grep", parameters: { type: "object" } },
      ],
    }),
    codexCfg(),
    false,
  );
  const tools = request.tools as Record<string, unknown>[];
  assert.equal(tools[0]?.name, "fs_read");
  assert.equal(tools[1]?.name, "code_grep");
  const items = request.input as Record<string, unknown>[];
  const fc = items.find((i) => i.type === "function_call")!;
  assert.equal(fc.name, "fs_read");
  assert.equal(nameMap.get("fs_read"), "fs.read");
  assert.equal(nameMap.get("code_grep"), "code.grep");
});

test("sanitizeToolName: dots → underscores, idempotent for clean names", () => {
  assert.equal(sanitizeToolName("fs.read"), "fs_read");
  assert.equal(sanitizeToolName("code.grep"), "code_grep");
  assert.equal(sanitizeToolName("echo"), "echo");
  assert.equal(sanitizeToolName("a-b_c"), "a-b_c");
});

test("convert: defaults omit optional fields", () => {
  const v = build(req({ messages: [{ role: "user", content: "hi" }] }), codexCfg());
  assert.equal(v.store, false);
  assert.equal(v.tool_choice, "auto");
  assert.equal(v.parallel_tool_calls, false);
  assert.equal("service_tier" in v, false);
  assert.equal("include" in v, false);
  assert.equal("reasoning" in v, false);
  assert.equal("tools" in v, false); // empty tools omitted
});

// ---------- prompt_cache_key ----------

test("prompt_cache_key: auto-derived jarvis-prefixed, 23 chars", () => {
  const v = build(req({ messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] }), codexCfg());
  const key = v.prompt_cache_key as string;
  assert.ok(key.startsWith("jarvis-"));
  assert.equal(key.length, 23);
});

test("prompt_cache_key: stable across identical requests; differs on system / tools", () => {
  const make = () => build(req({ messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] }), codexCfg());
  assert.equal(make().prompt_cache_key, make().prompt_cache_key);

  const a = build(req({ messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] }), codexCfg());
  const b = build(req({ messages: [{ role: "system", content: "be verbose" }, { role: "user", content: "hi" }] }), codexCfg());
  assert.notEqual(a.prompt_cache_key, b.prompt_cache_key);

  const withTool = (name: string) => build(req({ messages: [{ role: "user", content: "hi" }], tools: [{ name, description: "t", parameters: { type: "object" } }] }), codexCfg());
  assert.notEqual(withTool("fs.read").prompt_cache_key, withTool("fs.write").prompt_cache_key);
});

test("prompt_cache_key: explicit override wins over auto", () => {
  const v = build(req({ messages: [{ role: "user", content: "hi" }] }), responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { promptCacheKey: "custom-key" }));
  assert.equal(v.prompt_cache_key, "custom-key");
});

// ---------- previous_response_id chaining ----------

function chainedReq(messages: Message[], prevId: string, origin: number): ChatRequest {
  return { model: "gpt-5-codex-mini", messages, previous_response_id: prevId, chain_origin: origin };
}

test("chaining: off by default for the openai_responses flavour", () => {
  const cfg = responsesOpenAiConfig("sk-abc");
  const v = build(chainedReq([{ role: "system", content: "sys" }, { role: "user", content: "u1" }, { role: "user", content: "u2" }], "resp_prior", 2), cfg);
  assert.equal("previous_response_id" in v, false);
  assert.equal(v.store, false);
  assert.equal(v.instructions, "sys");
  assert.equal((v.input as unknown[]).length, 2);
});

test("chaining: on for codex emits previous_response_id + store:true + post-anchor delta only", () => {
  const cfg = responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { chainResponses: true });
  const v = build(
    chainedReq(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second turn" },
      ],
      "resp_prior",
      3,
    ),
    cfg,
  );
  assert.equal(v.previous_response_id, "resp_prior");
  assert.equal(v.store, true);
  const input = v.input as Record<string, unknown>[];
  assert.equal(input.length, 1);
  assert.equal(input[0]?.role, "user");
  assert.equal((input[0]?.content as Record<string, unknown>[])[0]?.text, "second turn");
  assert.equal(v.instructions, "sys"); // instructions still ride
});

test("chaining: inactive when chain_origin is out of bounds (falls back to full history)", () => {
  const cfg = responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { chainResponses: true });
  const v = build(chainedReq([{ role: "system", content: "sys" }, { role: "user", content: "u" }], "resp_stale", 99), cfg);
  assert.equal("previous_response_id" in v, false);
  assert.equal(v.store, false);
  assert.equal((v.input as unknown[]).length, 1);
});

test("chaining: skips include encrypted-reasoning when active, keeps it when inactive", () => {
  const active = build(
    chainedReq([{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" }], "resp_prior", 3),
    responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { chainResponses: true, includeEncryptedReasoning: true }),
  );
  assert.equal(active.previous_response_id, "resp_prior");
  assert.equal("include" in active, false);

  const inactive = build(req({ messages: [{ role: "user", content: "hi" }] }), responsesOpenAiConfig("sk-abc", { includeEncryptedReasoning: true }));
  assert.deepEqual(inactive.include, ["reasoning.encrypted_content"]);
});

// ---------- reasoning / service_tier / store knobs ----------

test("knobs: reasoning summary+effort, service_tier, store, include all emitted", () => {
  const cfg = responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), {
    reasoningSummary: "auto",
    reasoningEffort: "high",
    includeEncryptedReasoning: true,
    serviceTier: "priority",
    store: true,
  });
  const v = build(req({ messages: [{ role: "user", content: "hi" }] }), cfg, true);
  assert.equal(v.store, true);
  assert.equal(v.service_tier, "priority");
  assert.deepEqual(v.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(v.reasoning, { summary: "auto", effort: "high" });
});

test("knobs: reasoning block emitted for effort alone (summary omitted)", () => {
  const cfg = responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { reasoningEffort: "medium" });
  const v = build(req({ messages: [{ role: "user", content: "hi" }] }), cfg);
  assert.deepEqual(v.reasoning, { effort: "medium" });
});

// ---------- Constructors ----------

test("config: codex sets codex defaults", () => {
  const cfg = responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "at", accountId: "acct" }));
  assert.equal(cfg.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(cfg.path, "/codex/responses");
  assert.equal(cfg.originator, "jarvis");
  assert.equal(cfg.openaiBeta, "responses=v1");
  assert.equal(cfg.auth.kind, "chatgpt_oauth");
});

test("config: openaiResponses sets public defaults", () => {
  const cfg = responsesOpenAiConfig("sk-abc");
  assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.path, "/responses");
  assert.equal(cfg.originator, null);
  assert.equal(cfg.openaiBeta, null);
  assert.equal(cfg.auth.kind, "api_key");
  if (cfg.auth.kind === "api_key") assert.equal(cfg.auth.apiKey, "sk-abc");
});

test("provider: endpoint joins baseUrl + path", () => {
  assert.equal(ResponsesProvider.openaiResponses("k").endpoint(), "https://api.openai.com/v1/responses");
  assert.equal(ResponsesProvider.codex(CodexAuth.fromStatic({ accessToken: "t" })).endpoint(), "https://chatgpt.com/backend-api/codex/responses");
});

// ---------- Pure response decoder ----------

test("decode: text + function call → assistant message, tool_calls finish", () => {
  const resp = intoChatResponse(
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello " }] },
        { type: "message", content: [{ type: "output_text", text: "world" }] },
        { type: "function_call", call_id: "fc_1", name: "echo", arguments: '{"text":"hi"}' },
      ],
    },
    new Map(),
  );
  const m = resp.message as AsstMsg;
  assert.equal(m.content, "hello world");
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0]?.id, "fc_1");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
  assert.equal(resp.finish_reason, "tool_calls");
});

test("decode: restores sanitised tool-call name from the map", () => {
  const resp = intoChatResponse(
    { status: "completed", output: [{ type: "function_call", call_id: "fc_1", name: "fs_read", arguments: '{"path":"a.txt"}' }] },
    new Map([["fs_read", "fs.read"]]),
  );
  const m = resp.message as AsstMsg;
  assert.equal(m.tool_calls?.[0]?.name, "fs.read");
});

test("decode: incomplete max_output_tokens → length", () => {
  const resp = intoChatResponse(
    { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "truncated" }] }] },
    new Map(),
  );
  assert.equal(resp.finish_reason, "length");
});

test("decode: completed + no tools → stop", () => {
  const resp = intoChatResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }, new Map());
  assert.equal(resp.finish_reason, "stop");
});

test("decode: unknown item types are ignored", () => {
  const resp = intoChatResponse(
    { status: "completed", output: [{ type: "future_thing" }, { type: "message", content: [{ type: "output_text", text: "real" }] }] },
    new Map(),
  );
  assert.equal((resp.message as AsstMsg).content, "real");
});

// ---------- StreamAccumulator ----------

test("stream: accumulates text deltas, finalises to stop on completed", () => {
  const acc = new StreamAccumulator();
  assert.deepEqual(acc.ingest({ type: "response.output_text.delta", delta: "Hel" }), [{ type: "content_delta", content: "Hel" }]);
  assert.deepEqual(acc.ingest({ type: "response.output_text.delta", delta: "lo" }), [{ type: "content_delta", content: "lo" }]);
  const out = acc.ingest({ type: "response.completed", response: { status: "completed", output: [] } });
  const finish = out.find((c) => c.type === "finish") as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "stop");
  assert.equal((finish.message as AsstMsg).content, "Hello");
});

test("stream: function-call round trip → tool_call deltas + parsed args in finish", () => {
  const acc = new StreamAccumulator();
  const added = acc.ingest({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "echo", arguments: "" } });
  assert.equal(added.length, 1);
  const d0 = added[0] as Extract<LlmChunk, { type: "tool_call_delta" }>;
  assert.equal(d0.type, "tool_call_delta");
  assert.equal(d0.index, 0);
  assert.equal(d0.id, "fc_1");
  assert.equal(d0.name, "echo");
  assert.equal(d0.arguments_fragment, undefined);

  for (const frag of ['{"te', 'xt":', '"hi"', "}"]) {
    const r = acc.ingest({ type: "response.function_call_arguments.delta", output_index: 0, delta: frag });
    assert.equal((r[0] as Extract<LlmChunk, { type: "tool_call_delta" }>).arguments_fragment, frag);
  }

  acc.ingest({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "echo", arguments: '{"text":"hi"}' } });
  const final = acc.ingest({ type: "response.completed", response: { status: "completed", output: [] } });
  const finish = final.find((c) => c.type === "finish") as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "tool_calls");
  const m = finish.message as AsstMsg;
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0]?.id, "fc_1");
  assert.equal(m.tool_calls?.[0]?.name, "echo");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("stream: restores sanitised tool-call name in both added delta and finish", () => {
  const acc = new StreamAccumulator(new Map([["fs_read", "fs.read"]]));
  const added = acc.ingest({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "fs_read", arguments: "" } });
  assert.equal((added[0] as Extract<LlmChunk, { type: "tool_call_delta" }>).name, "fs.read");
  acc.ingest({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "fc_1", name: "fs_read", arguments: "{}" } });
  const final = acc.ingest({ type: "response.completed", response: { status: "completed", output: [] } });
  const finish = final.find((c) => c.type === "finish") as Extract<LlmChunk, { type: "finish" }>;
  assert.equal((finish.message as AsstMsg).tool_calls?.[0]?.name, "fs.read");
});

test("stream: unknown events are ignored", () => {
  const acc = new StreamAccumulator();
  assert.deepEqual(acc.ingest({ type: "response.in_progress", response: {} }), []);
  assert.deepEqual(acc.ingest({ type: "future_event" }), []);
});

test("stream: captures response id from completed (and is null when omitted)", () => {
  const a = new StreamAccumulator();
  const withId = a.ingest({ type: "response.completed", response: { id: "resp_abc123", status: "completed" } });
  assert.equal((withId.find((c) => c.type === "finish") as Extract<LlmChunk, { type: "finish" }>).response_id, "resp_abc123");

  const b = new StreamAccumulator();
  const noId = b.ingest({ type: "response.completed", response: { status: "completed" } });
  assert.equal((noId.find((c) => c.type === "finish") as Extract<LlmChunk, { type: "finish" }>).response_id, null);
});

test("stream: usage chunk emitted before finish on completed", () => {
  const acc = new StreamAccumulator();
  const out = acc.ingest({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } });
  assert.equal(out[0]?.type, "usage");
  assert.equal(out[1]?.type, "finish");
  assert.equal((out[0] as Extract<LlmChunk, { type: "usage" }>).usage.prompt_tokens, 10);
  assert.equal((out[0] as Extract<LlmChunk, { type: "usage" }>).usage.cached_prompt_tokens, 4);
});

test("stream: empty accumulator finalises to stop with no content / tool calls", () => {
  const acc = new StreamAccumulator();
  const f = acc.finalise();
  assert.ok(f.type === "finish");
  assert.equal(f.finish_reason, "stop");
  const m = f.message as AsstMsg;
  assert.equal(m.content, undefined);
  assert.equal(m.tool_calls, undefined);
});

// ---------- End-to-end via injected fetch ----------

const SSE_TEXT_AND_TOOL =
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"fc_1","name":"echo","arguments":""}}\n\n' +
  'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
  'data: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"text\\":\\"hi\\"}"}\n\n' +
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"fc_1","name":"echo","arguments":"{\\"text\\":\\"hi\\"}"}}\n\n' +
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":12,"output_tokens":3}}}\n\n';

test("completeStream: end-to-end SSE → deltas, usage before finish, parsed tool call", async () => {
  const provider = new ResponsesProvider(responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { fetchImpl: async () => new Response(SSE_TEXT_AND_TOOL, { status: 200 }) }));
  const stream = await provider.completeStream(req({ messages: [{ role: "user", content: "hi" }] }));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);

  const deltas = events.filter((e) => e.type === "content_delta").map((e) => (e as { content: string }).content);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const usageIdx = events.findIndex((e) => e.type === "usage");
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(usageIdx !== -1 && finishIdx !== -1 && usageIdx < finishIdx);
  const finish = events[finishIdx] as Extract<LlmChunk, { type: "finish" }>;
  assert.equal(finish.finish_reason, "tool_calls");
  assert.equal(finish.response_id, "resp_1");
  const m = finish.message as AsstMsg;
  assert.equal(m.content, "Hello");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("complete: collapses the stream into a ChatResponse", async () => {
  const provider = new ResponsesProvider(responsesCodexConfig(CodexAuth.fromStatic({ accessToken: "t" }), { fetchImpl: async () => new Response(SSE_TEXT_AND_TOOL, { status: 200 }) }));
  const resp = await provider.complete(req({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(resp.finish_reason, "tool_calls");
  assert.equal(resp.response_id, "resp_1");
  assert.equal(resp.usage?.prompt_tokens, 12);
  const m = resp.message as AsstMsg;
  assert.equal(m.content, "Hello");
  assert.deepEqual(m.tool_calls?.[0]?.arguments, { text: "hi" });
});

test("complete: non-2xx surfaces status + body as ProviderError", async () => {
  const provider = new ResponsesProvider(responsesOpenAiConfig("sk-test", { fetchImpl: async () => new Response("nope", { status: 429 }) }));
  await assert.rejects(() => provider.complete(req({ messages: [{ role: "user", content: "hi" }] })), /status 429: nope/);
});

test("complete: api-key 401 surfaces (refresh not possible)", async () => {
  let calls = 0;
  const provider = new ResponsesProvider(
    responsesOpenAiConfig("sk-test", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
    }),
  );
  await assert.rejects(() => provider.complete(req({ messages: [{ role: "user", content: "hi" }] })), /API-key auth cannot refresh/);
  // Refresh attempted once (the loop tries refreshIfUnchanged, which throws).
  assert.equal(calls, 1);
});

test("completeStream: oauth 401 → refresh → retry once, then succeeds", async () => {
  // First POST 401s with stale token; refresh swaps it; retry POSTs with the
  // new token and succeeds. Refresh endpoint is overridden to the same stub.
  let postCalls = 0;
  let refreshCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: "fresh-token" }), { status: 200 });
    }
    postCalls += 1;
    const auth = (init?.headers as Record<string, string>)["authorization"];
    if (auth === "Bearer stale-token") return new Response("unauthorized", { status: 401 });
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { status: 200 });
  };
  const auth = CodexAuth.fromStatic({ accessToken: "stale-token" }, { fetchImpl });
  // fromStatic has no refresh token; force one in so refresh() can run.
  auth.refreshToken = "rt-1";
  const provider = ResponsesProvider.codex(auth, { fetchImpl });
  const stream = await provider.completeStream(req({ messages: [{ role: "user", content: "hi" }] }));
  const events: LlmChunk[] = [];
  for await (const c of stream) events.push(c);

  assert.equal(refreshCalls, 1);
  assert.equal(postCalls, 2); // first 401, retry 200
  assert.equal(auth.accessToken, "fresh-token");
  assert.equal(events.at(-1)?.type, "finish");
});
