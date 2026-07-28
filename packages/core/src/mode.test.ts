// Plan Mode: the tool filter (catalogue + dispatch), terminal tools, and the
// mode-signal channel. These three are what turn Plan Mode from a label into a
// guard, so each is asserted on both the blocking and the streaming path.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent, defaultAgentConfig, type AgentEvent } from "./agent.ts";
import { ToolRegistry, toolCategory, type Tool } from "./tool.ts";
import { assistantText } from "./message.ts";
import { newConversation, type Conversation } from "./conversation.ts";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "./llm.ts";
import { AlwaysDeny } from "./approval.ts";
import { emitModeSignal, isAgentMode, modeSignalActive, withModeSignal } from "./mode.ts";
import type { JsonValue } from "./json.ts";

// --- fakes -----------------------------------------------------------------

function toolCallResponse(...calls: Array<[string, string]>): ChatResponse {
  return {
    message: {
      role: "assistant",
      tool_calls: calls.map(([id, name]) => ({ id, name, arguments: {} })),
    },
    finish_reason: "tool_calls",
  };
}

class ScriptedProvider implements LlmProvider {
  #responses: ChatResponse[];
  #i = 0;
  readonly requests: ChatRequest[] = [];

  constructor(responses: ChatResponse[]) {
    this.#responses = responses;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const r = this.#responses[this.#i];
    if (!r) throw new Error("ScriptedProvider ran out of responses");
    this.#i++;
    return r;
  }

  async *completeStream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    const r = await this.complete(req);
    yield { type: "finish", message: r.message, finish_reason: r.finish_reason, response_id: null };
  }
}

class CountingTool implements Tool {
  calls = 0;
  readonly parameters = { type: "object", properties: {} };
  readonly name: string;
  readonly category: "read" | "write";
  readonly isTerminal: boolean;

  // Explicit field assignment, not constructor parameter properties: the
  // packages run under `node --experimental-strip-types`, which rejects those.
  constructor(name: string, category: "read" | "write", isTerminal = false) {
    this.name = name;
    this.category = category;
    this.isTerminal = isTerminal;
  }

  get description(): string {
    return `${this.name} test tool`;
  }

  async invoke(): Promise<string> {
    this.calls++;
    return `${this.name} ran`;
  }
}

/** The canonical Plan Mode predicate. */
const readOnly = (t: Tool): boolean => toolCategory(t) === "read";

function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

async function collect(agent: Agent, conv: Conversation): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of agent.runStream(conv)) out.push(ev);
  return out;
}

// --- catalogue filtering ---------------------------------------------------

test("toolFilter: write tools are omitted from the request catalogue", async () => {
  const read = new CountingTool("fs.read", "read");
  const write = new CountingTool("fs.write", "write");
  const provider = new ScriptedProvider([{ message: assistantText("done"), finish_reason: "stop" }]);

  const config = defaultAgentConfig("m");
  config.tools = registry(read, write);
  config.toolFilter = readOnly;
  await new Agent(provider, config).run(newConversation());

  const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
  assert.deepEqual(names, ["fs.read"]);
});

test("toolFilter: absent filter leaves the catalogue untouched", async () => {
  const provider = new ScriptedProvider([{ message: assistantText("done"), finish_reason: "stop" }]);
  const config = defaultAgentConfig("m");
  config.tools = registry(new CountingTool("fs.read", "read"), new CountingTool("fs.write", "write"));
  await new Agent(provider, config).run(newConversation());

  const names = (provider.requests[0]?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, ["fs.read", "fs.write"]);
});

// --- dispatch enforcement --------------------------------------------------
//
// Hiding a tool from the catalogue is a hint; refusing it at dispatch is the
// guard. A model can name a filtered tool from conversation history, so these
// are the load-bearing assertions.

test("toolFilter: a filtered tool named anyway is refused, not invoked (blocking)", async () => {
  const write = new CountingTool("fs.write", "write");
  const provider = new ScriptedProvider([
    toolCallResponse(["c1", "fs.write"]),
    { message: assistantText("ok"), finish_reason: "stop" },
  ]);

  const config = defaultAgentConfig("m");
  config.tools = registry(write);
  config.toolFilter = readOnly;
  const conv = newConversation();
  await new Agent(provider, config).run(conv);

  assert.equal(write.calls, 0);
  const result = conv.messages.find((m) => m.role === "tool");
  assert.ok(result && result.role === "tool");
  assert.match(result.content, /not available in the current mode/);
});

test("toolFilter: a filtered tool named anyway is refused, not invoked (streaming)", async () => {
  const write = new CountingTool("fs.write", "write");
  const provider = new ScriptedProvider([
    toolCallResponse(["c1", "fs.write"]),
    { message: assistantText("ok"), finish_reason: "stop" },
  ]);

  const config = defaultAgentConfig("m");
  config.tools = registry(write);
  config.toolFilter = readOnly;
  const events = await collect(new Agent(provider, config), newConversation());

  assert.equal(write.calls, 0);
  const end = events.find((e) => e.type === "tool_end");
  assert.ok(end && end.type === "tool_end");
  assert.match(end.content, /not available in the current mode/);
});

test("toolFilter: a filtered tool never reaches the approver", async () => {
  // AlwaysDeny would produce `tool denied:`; the filter must win first so the
  // model gets the mode-specific message instead.
  class GatedWrite extends CountingTool {
    readonly requiresApproval = true;
  }
  const write = new GatedWrite("fs.write", "write");
  const provider = new ScriptedProvider([
    toolCallResponse(["c1", "fs.write"]),
    { message: assistantText("ok"), finish_reason: "stop" },
  ]);

  const config = defaultAgentConfig("m");
  config.tools = registry(write);
  config.toolFilter = readOnly;
  config.approver = new AlwaysDeny();
  const events = await collect(new Agent(provider, config), newConversation());

  assert.equal(events.some((e) => e.type === "approval_request"), false);
  const end = events.find((e) => e.type === "tool_end");
  assert.ok(end && end.type === "tool_end");
  assert.match(end.content, /not available in the current mode/);
});

// --- terminal tools --------------------------------------------------------

test("isTerminal: ends the turn and skips later calls in the batch (streaming)", async () => {
  const exit = new CountingTool("exit_plan", "read", true);
  const after = new CountingTool("fs.read", "read");
  // Only ONE response is scripted: a second LLM round-trip would throw.
  const provider = new ScriptedProvider([toolCallResponse(["c1", "exit_plan"], ["c2", "fs.read"])]);

  const config = defaultAgentConfig("m");
  config.tools = registry(exit, after);
  const events = await collect(new Agent(provider, config), newConversation());

  assert.equal(exit.calls, 1);
  assert.equal(after.calls, 0, "calls after a terminal tool are skipped");
  const last = events[events.length - 1];
  assert.ok(last && last.type === "done");
  assert.equal(last.outcome.kind, "stopped");
});

test("isTerminal: ends the turn on the blocking path too", async () => {
  const exit = new CountingTool("exit_plan", "read", true);
  const after = new CountingTool("fs.read", "read");
  const provider = new ScriptedProvider([toolCallResponse(["c1", "exit_plan"], ["c2", "fs.read"])]);

  const config = defaultAgentConfig("m");
  config.tools = registry(exit, after);
  const conv = newConversation();
  const outcome = await new Agent(provider, config).run(conv);

  assert.equal(outcome.kind, "stopped");
  assert.equal(exit.calls, 1);
  assert.equal(after.calls, 0);
  // The terminal tool's result is still recorded for the transcript.
  assert.equal(conv.messages.filter((m) => m.role === "tool").length, 1);
});

test("isTerminal: a denied terminal tool does not end the turn", async () => {
  class GatedExit extends CountingTool {
    readonly requiresApproval = true;
  }
  const exit = new GatedExit("exit_plan", "read", true);
  const provider = new ScriptedProvider([
    toolCallResponse(["c1", "exit_plan"]),
    { message: assistantText("ok"), finish_reason: "stop" },
  ]);

  const config = defaultAgentConfig("m");
  config.tools = registry(exit);
  config.approver = new AlwaysDeny();
  const events = await collect(new Agent(provider, config), newConversation());

  assert.equal(exit.calls, 0);
  // The loop went back to the model rather than stopping on the denied call.
  const last = events[events.length - 1];
  assert.ok(last && last.type === "done");
  assert.equal(last.outcome.iterations, 2);
});

// --- mode-signal channel ---------------------------------------------------

test("mode signal: emit is a no-op with no sink installed", () => {
  assert.equal(modeSignalActive(), false);
  assert.doesNotThrow(() => emitModeSignal("plan"));
});

test("mode signal: withModeSignal delivers to the sink", async () => {
  const seen: string[] = [];
  await withModeSignal(
    (m) => seen.push(m),
    async () => {
      assert.equal(modeSignalActive(), true);
      emitModeSignal("plan");
    },
  );
  assert.deepEqual(seen, ["plan"]);
});

test("mode signal: a tool emitting mid-run surfaces as mode_changed", async () => {
  class ModeTool extends CountingTool {
    async invoke(): Promise<string> {
      emitModeSignal("plan");
      return "armed";
    }
  }
  const provider = new ScriptedProvider([
    toolCallResponse(["c1", "enter_plan_mode"]),
    { message: assistantText("ok"), finish_reason: "stop" },
  ]);

  const config = defaultAgentConfig("m");
  config.tools = registry(new ModeTool("enter_plan_mode", "read"));
  const events = await collect(new Agent(provider, config), newConversation());

  const changed = events.find((e) => e.type === "mode_changed");
  assert.ok(changed && changed.type === "mode_changed");
  assert.equal(changed.mode, "plan");
  assert.equal(changed.via, "tool");
});

test("isAgentMode: accepts the five modes, rejects anything else", () => {
  for (const m of ["ask", "accept-edits", "plan", "auto", "bypass"]) {
    assert.equal(isAgentMode(m), true, m);
  }
  for (const bad of ["Plan", "accept_edits", "", null, 42, undefined]) {
    assert.equal(isAgentMode(bad as JsonValue), false, String(bad));
  }
});
