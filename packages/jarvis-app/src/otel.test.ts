// OTel: gating + an end-to-end span-emission check.
//
// node:test runs each file in its own process, so registering a global
// TracerProvider here doesn't leak into other test files.
import { test } from "node:test";
import assert from "node:assert/strict";

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  Agent,
  ToolRegistry,
  defaultAgentConfig,
  defaultCompleteStream,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
  type Tool,
  type JsonValue,
} from "@jarvis/core";

import { otelEnabled } from "./otel.ts";

test("otelEnabled gates on the documented env knobs", () => {
  assert.equal(otelEnabled({}), false);
  assert.equal(otelEnabled({ JARVIS_OTEL_ENABLED: "0" }), false);
  assert.equal(otelEnabled({ JARVIS_OTEL_ENABLED: "1" }), true);
  assert.equal(otelEnabled({ JARVIS_OTEL_CONSOLE: "true" }), true);
  assert.equal(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }), true);
  assert.equal(otelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }), false);
});

/** Provider: one tool-call turn, then a stop. */
class ToolThenStop implements LlmProvider {
  calls = 0;
  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.resolve({
        message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "echo", arguments: {} }] },
        finish_reason: "tool_calls",
      });
    }
    return Promise.resolve({ message: { role: "assistant", content: "done" }, finish_reason: "stop" });
  }
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    return defaultCompleteStream(this, req);
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  category: "read",
  requiresApproval: false,
  parameters: { type: "object" } as JsonValue,
  invoke: () => Promise.resolve("ok"),
};

test("Agent.run emits jarvis.agent.run + gen_ai.tool.call spans when an SDK is registered", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  try {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const agent = new Agent(new ToolThenStop(), { ...defaultAgentConfig("test-model"), tools });
    await agent.run({ messages: [{ role: "user", content: "hi" }] });

    const spans = exporter.getFinishedSpans();
    const byName = (n: string) => spans.filter((s) => s.name === n);

    const agentSpans = byName("jarvis.agent.run");
    assert.equal(agentSpans.length, 1, "one agent-run span");
    assert.equal(agentSpans[0]!.attributes["jarvis.agent.model"], "test-model");
    assert.equal(agentSpans[0]!.attributes["jarvis.agent.iterations"], 2);

    const toolSpans = byName("gen_ai.tool.call");
    assert.equal(toolSpans.length, 1, "one tool-call span");
    assert.equal(toolSpans[0]!.attributes["gen_ai.tool.name"], "echo");
    assert.equal(toolSpans[0]!.attributes["gen_ai.tool.call.id"], "c1");
  } finally {
    await provider.shutdown();
    trace.disable();
  }
});
