import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent, defaultAgentConfig, ensureSystemPrompt, type AgentEvent } from "./agent.ts";
import { ToolRegistry, type Tool } from "./tool.ts";
import { AlwaysApprove, AlwaysDeny } from "./approval.ts";
import { assistantText, systemMessage, userMessage } from "./message.ts";
import { lastAssistantText, type Conversation } from "./conversation.ts";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "./llm.ts";
import { emitPlan } from "./plan.ts";
import { emitProgress } from "./progress.ts";
import { MaxIterationsError } from "./error.ts";
import type { JsonValue } from "./json.ts";

// --- fakes -----------------------------------------------------------------

function toolCallResponse(id: string, name: string, args: JsonValue): ChatResponse {
  return { message: { role: "assistant", tool_calls: [{ id, name, arguments: args }] }, finish_reason: "tool_calls" };
}

function stopResponse(text: string): ChatResponse {
  return { message: assistantText(text), finish_reason: "stop" };
}

/** Replays a fixed script of responses, one per LLM call. */
class ScriptedProvider implements LlmProvider {
  #responses: ChatResponse[];
  #i = 0;
  lastRequest: ChatRequest | undefined;

  constructor(responses: ChatResponse[]) {
    this.#responses = responses;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = req;
    const r = this.#responses[this.#i];
    if (!r) throw new Error("ScriptedProvider ran out of responses");
    this.#i++;
    return r;
  }

  async *completeStream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    const r = await this.complete(req);
    if (r.message.role === "assistant" && typeof r.message.content === "string") {
      yield { type: "content_delta", content: r.message.content };
    }
    yield { type: "finish", message: r.message, finish_reason: r.finish_reason, response_id: r.response_id ?? null };
  }
}

class EchoTool implements Tool {
  readonly name = "echo";
  readonly description = "echo text";
  readonly parameters = { type: "object", properties: { text: { type: "string" } } };
  readonly category = "read" as const;
  calls = 0;
  async invoke(args: JsonValue): Promise<string> {
    this.calls++;
    const text = args && typeof args === "object" && !Array.isArray(args) && typeof args.text === "string" ? args.text : "";
    return `echo: ${text}`;
  }
}

class GatedTool implements Tool {
  readonly name = "fs.write";
  readonly description = "write a file";
  readonly parameters = { type: "object" };
  readonly requiresApproval = true;
  readonly category = "write" as const;
  calls = 0;
  async invoke(): Promise<string> {
    this.calls++;
    return "wrote";
  }
}

class ThrowingTool implements Tool {
  readonly name = "boom";
  readonly description = "always throws";
  readonly parameters = { type: "object" };
  async invoke(): Promise<string> {
    throw new Error("kaboom");
  }
}

class PlanningTool implements Tool {
  readonly name = "plan.update";
  readonly description = "emits a plan + progress while running";
  readonly parameters = { type: "object" };
  readonly category = "read" as const;
  async invoke(): Promise<string> {
    emitPlan([{ id: "a", title: "Step A", status: "in_progress" }]);
    emitProgress("log", "working");
    return "plan set";
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// --- blocking run ----------------------------------------------------------

test("run: tool call then stop — full history + outcome", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "echo", { text: "hi" }), stopResponse("done")]);
  const tools = new ToolRegistry().register(new EchoTool());
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools });
  const conv: Conversation = { messages: [userMessage("hello")] };

  const outcome = await agent.run(conv);

  assert.deepEqual(outcome, { kind: "stopped", iterations: 2 });
  assert.equal(conv.messages.length, 4); // user, assistant(toolcall), tool, assistant(done)
  assert.equal(conv.messages[2]?.role, "tool");
  assert.equal((conv.messages[2] as { content: string }).content, "echo: hi");
  assert.equal(lastAssistantText(conv), "done");
});

test("run: inserts system prompt when missing", async () => {
  const provider = new ScriptedProvider([stopResponse("ok")]);
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), systemPrompt: "RULES" });
  const conv: Conversation = { messages: [userMessage("hi")] };

  await agent.run(conv);

  assert.equal(conv.messages[0]?.role, "system");
  assert.equal((conv.messages[0] as { content: string }).content, "RULES");
});

test("ensureSystemPrompt: refresh replaces stale, no-refresh keeps, in-sync no-ops", () => {
  const refreshed: Conversation = { messages: [systemMessage("OLD"), userMessage("x")] };
  ensureSystemPrompt(refreshed, "NEW", true);
  assert.equal((refreshed.messages[0] as { content: string }).content, "NEW");

  const kept: Conversation = { messages: [systemMessage("OLD"), userMessage("x")] };
  ensureSystemPrompt(kept, "NEW", false);
  assert.equal((kept.messages[0] as { content: string }).content, "OLD");

  const synced: Conversation = { messages: [systemMessage("SAME")] };
  ensureSystemPrompt(synced, "SAME", true);
  assert.equal(synced.messages.length, 1);
});

test("run: tool error surfaces as text and the loop continues", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "boom", {}), stopResponse("after")]);
  const tools = new ToolRegistry().register(new ThrowingTool());
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools });
  const conv: Conversation = { messages: [userMessage("go")] };

  await agent.run(conv);

  assert.match((conv.messages[2] as { content: string }).content, /^tool error: kaboom/);
  assert.equal(lastAssistantText(conv), "after");
});

test("run: unknown tool surfaces tool-not-found text", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "missing", {}), stopResponse("ok")]);
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools: new ToolRegistry() });
  const conv: Conversation = { messages: [userMessage("go")] };

  await agent.run(conv);

  assert.equal((conv.messages[2] as { content: string }).content, "tool error: tool not found: missing");
});

test("run: approver deny blocks invoke and surfaces the sentinel", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "fs.write", {}), stopResponse("ok")]);
  const tool = new GatedTool();
  const agent = new Agent(provider, {
    ...defaultAgentConfig("m"),
    tools: new ToolRegistry().register(tool),
    approver: new AlwaysDeny(),
  });
  const conv: Conversation = { messages: [userMessage("go")] };

  await agent.run(conv);

  assert.equal(tool.calls, 0); // never invoked
  assert.equal((conv.messages[2] as { content: string }).content, "tool denied: default deny policy");
});

test("run: approver approve runs the gated tool", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "fs.write", {}), stopResponse("ok")]);
  const tool = new GatedTool();
  const agent = new Agent(provider, {
    ...defaultAgentConfig("m"),
    tools: new ToolRegistry().register(tool),
    approver: new AlwaysApprove(),
  });

  await agent.run({ messages: [userMessage("go")] });

  assert.equal(tool.calls, 1);
});

test("run: no approver runs the gated tool unconditionally (historical default)", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "fs.write", {}), stopResponse("ok")]);
  const tool = new GatedTool();
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools: new ToolRegistry().register(tool) });

  await agent.run({ messages: [userMessage("go")] });

  assert.equal(tool.calls, 1);
});

test("run: throws MaxIterationsError when the loop never terminates", async () => {
  const provider: LlmProvider = {
    async complete() {
      return toolCallResponse("c", "echo", { text: "x" });
    },
    async *completeStream(req) {
      const r = await this.complete(req);
      yield { type: "finish", message: r.message, finish_reason: r.finish_reason };
    },
  };
  const tools = new ToolRegistry().register(new EchoTool());
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools, maxIterations: 2 });

  await assert.rejects(() => agent.run({ messages: [userMessage("go")] }), MaxIterationsError);
});

// --- streaming run ---------------------------------------------------------

test("runStream: exactly one terminal `done` carrying the full conversation", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "echo", { text: "hi" }), stopResponse("final")]);
  const tools = new ToolRegistry().register(new EchoTool());
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools });

  const events = await collect(agent.runStream({ messages: [userMessage("hello")] }));

  const terminals = events.filter((e) => e.type === "done" || e.type === "error");
  assert.equal(terminals.length, 1);
  assert.equal(events.at(-1)?.type, "done"); // nothing after the terminal

  const done = terminals[0] as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done.outcome.kind, "stopped");
  assert.equal(lastAssistantText(done.conversation), "final");

  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "echo"));
  assert.equal((events.find((e) => e.type === "tool_end") as { content: string }).content, "echo: hi");
  assert.ok(events.some((e) => e.type === "delta" && e.content === "final"));
});

test("runStream: a stream without a Finish chunk yields one error", async () => {
  const provider: LlmProvider = {
    async complete() {
      return stopResponse("x");
    },
    async *completeStream() {
      yield { type: "content_delta", content: "partial" }; // no finish
    },
  };
  const agent = new Agent(provider, defaultAgentConfig("m"));

  const events = await collect(agent.runStream({ messages: [userMessage("go")] }));

  const terminals = events.filter((e) => e.type === "done" || e.type === "error");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, "error");
  assert.match((terminals[0] as { message: string }).message, /without a Finish/);
});

test("runStream: plan/progress emitted during invoke surface between tool_start and tool_end", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "plan.update", {}), stopResponse("ok")]);
  const tools = new ToolRegistry().register(new PlanningTool());
  const agent = new Agent(provider, { ...defaultAgentConfig("m"), tools });

  const events = await collect(agent.runStream({ messages: [userMessage("go")] }));
  const types = events.map((e) => e.type);
  const start = types.indexOf("tool_start");
  const end = types.indexOf("tool_end");
  const plan = types.indexOf("plan_update");
  const progress = types.indexOf("tool_progress");

  assert.ok(start >= 0 && end > start);
  assert.ok(plan > start && plan < end, "plan_update lands between tool_start and tool_end");
  assert.ok(progress > start && progress < end, "tool_progress lands between tool_start and tool_end");
});

test("runStream: deny emits approval_request → approval_decision → denied tool_end", async () => {
  const provider = new ScriptedProvider([toolCallResponse("c1", "fs.write", {}), stopResponse("ok")]);
  const tool = new GatedTool();
  const agent = new Agent(provider, {
    ...defaultAgentConfig("m"),
    tools: new ToolRegistry().register(tool),
    approver: new AlwaysDeny(),
  });

  const events = await collect(agent.runStream({ messages: [userMessage("go")] }));
  const types = events.map((e) => e.type);
  const req = types.indexOf("approval_request");
  const dec = types.indexOf("approval_decision");
  const start = types.indexOf("tool_start");
  const end = types.indexOf("tool_end");

  assert.ok(req >= 0 && dec === req + 1, "request immediately followed by decision");
  assert.ok(start > dec && end > start, "tool_start/tool_end wrap the call even on deny");
  assert.equal(tool.calls, 0);
  assert.equal((events.find((e) => e.type === "tool_end") as { content: string }).content, "tool denied: default deny policy");
});
