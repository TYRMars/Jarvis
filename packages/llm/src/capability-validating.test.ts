import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider, Message } from "@jarvis/core";
import { assistantText } from "@jarvis/core";
import { CapabilityValidatingProvider } from "./capability-validating.ts";
import type { ModelCapability } from "./profile.ts";

// ---------- Tiny fake inner provider ----------

/** Records the last request it saw and returns a fixed "ok" assistant turn. */
class StubProvider implements LlmProvider {
  lastReq: ChatRequest | undefined;

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.lastReq = req;
    return Promise.resolve({
      message: assistantText("ok"),
      finish_reason: "stop",
      response_id: null,
    });
  }

  async *completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    this.lastReq = req;
    yield { type: "finish", message: assistantText("ok"), finish_reason: "stop", response_id: null };
  }
}

// ---------- Builders ----------

function cap(model: string, extra: Partial<ModelCapability> = {}): ModelCapability {
  return { provider: "test", model, ...extra };
}

function req(model: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return { model, messages: [{ role: "user", content: "hi" }], ...extra };
}

const echoTool = { name: "echo", description: "", parameters: {} };

// ---------- Tool-support gating ----------

test("unknown model passes through even with tools + a no-tools row in catalog", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("known", { supportsToolCalls: false })]);
  const res = await wrapped.complete(req("unknown", { tools: [echoTool] }));
  assert.equal((res.message as Extract<Message, { role: "assistant" }>).content, "ok");
  assert.equal(stub.lastReq?.model, "unknown");
});

test("rejects tool request when the model definitively lacks support", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("no-tools", { supportsToolCalls: false })]);
  await assert.rejects(
    () => wrapped.complete(req("no-tools", { tools: [echoTool] })),
    (e: unknown) => {
      const msg = String((e as Error).message);
      assert.match(msg, /does not support tool calls/);
      assert.match(msg, /no-tools/);
      return true;
    },
  );
  assert.equal(stub.lastReq, undefined, "inner provider must not be called on rejection");
});

test("allows tool request when the model supports it", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("tools-ok", { supportsToolCalls: true })]);
  await wrapped.complete(req("tools-ok", { tools: [echoTool] }));
  assert.equal(stub.lastReq?.model, "tools-ok");
});

test("allows tool request when capability is unknown (absent flag)", async () => {
  const stub = new StubProvider();
  // supportsToolCalls omitted — best-effort: don't gate.
  const wrapped = new CapabilityValidatingProvider(stub, [cap("dunno")]);
  await wrapped.complete(req("dunno", { tools: [echoTool] }));
  assert.equal(stub.lastReq?.model, "dunno");
});

test("allows tool request when capability is explicitly undefined (unknown)", async () => {
  const stub = new StubProvider();
  // An explicit `undefined` flag is indistinguishable from absent — Rust
  // `Option<bool>::None` — and must never gate.
  const wrapped = new CapabilityValidatingProvider(stub, [cap("undef-flag", { supportsToolCalls: undefined })]);
  await wrapped.complete(req("undef-flag", { tools: [echoTool] }));
  assert.equal(stub.lastReq?.model, "undef-flag");
});

test("no tools in request never gates even when model lacks tool support", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("no-tools", { supportsToolCalls: false })]);
  await wrapped.complete(req("no-tools")); // no tools array at all
  assert.equal(stub.lastReq?.model, "no-tools");
});

// ---------- Parallel-tool-call downgrade ----------

test("downgrades parallel_tool_calls=true to undefined when model says no", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [
    cap("serial-only", { supportsParallelToolCalls: false }),
  ]);
  await wrapped.complete(req("serial-only", { parallel_tool_calls: true }));
  assert.equal(stub.lastReq?.parallel_tool_calls, undefined);
  assert.equal("parallel_tool_calls" in (stub.lastReq ?? {}), false, "field is dropped, not falsified");
});

test("keeps parallel_tool_calls=true when model supports it", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [
    cap("parallel-ok", { supportsParallelToolCalls: true }),
  ]);
  await wrapped.complete(req("parallel-ok", { parallel_tool_calls: true }));
  assert.equal(stub.lastReq?.parallel_tool_calls, true);
});

test("keeps parallel_tool_calls=true when capability unknown", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("parallel-dunno")]);
  await wrapped.complete(req("parallel-dunno", { parallel_tool_calls: true }));
  assert.equal(stub.lastReq?.parallel_tool_calls, true);
});

// ---------- Stream path shares the same validation ----------

test("completeStream rejects tool request when model lacks support", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [cap("no-tools", { supportsToolCalls: false })]);
  await assert.rejects(
    async () => {
      const stream = await wrapped.completeStream(req("no-tools", { tools: [echoTool] }));
      for await (const _ of stream) {
        // drain — should never get here
      }
    },
    /does not support tool calls/,
  );
});

test("completeStream downgrades parallel_tool_calls then forwards to inner", async () => {
  const stub = new StubProvider();
  const wrapped = new CapabilityValidatingProvider(stub, [
    cap("serial-only", { supportsParallelToolCalls: false }),
  ]);
  const stream = await wrapped.completeStream(req("serial-only", { parallel_tool_calls: true }));
  const chunks: LlmChunk[] = [];
  for await (const c of stream) chunks.push(c);
  assert.equal(chunks.at(-1)?.type, "finish");
  assert.equal(stub.lastReq?.parallel_tool_calls, undefined);
});
