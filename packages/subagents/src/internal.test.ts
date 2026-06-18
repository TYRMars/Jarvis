// InternalSubAgent tests. Ported from harness-subagents/src/internal.rs::tests
// (model wiring) + the frame-relay behaviour the runner provides.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantText,
  newConversation,
  type AgentEvent,
  type Conversation,
} from "@jarvis/core";
import { InternalSubAgent, type CreateAgent, type SubAgentRunner } from "./internal.ts";
import { withSubagent, type SubAgentFrame } from "./subagent.ts";

/** A runner that records the model it was created with and emits one event seq. */
function cannedRunner(events: (conv: Conversation) => AgentEvent[]): SubAgentRunner {
  return {
    async *runStream(conv: Conversation): AsyncGenerator<AgentEvent> {
      for (const ev of events(conv)) yield ev;
    },
  };
}

test("configured model reaches the createAgent factory", async () => {
  const seenModels: string[] = [];
  const createAgent: CreateAgent = (opts) => {
    seenModels.push(opts.model);
    // Terminate after one turn: a done carrying an assistant "ok." message.
    return cannedRunner(() => {
      const conv = newConversation();
      conv.messages.push(assistantText("ok."));
      return [{ type: "done", outcome: { kind: "stopped", iterations: 1 }, conversation: conv }];
    });
  };

  const sub = new InternalSubAgent({
    name: "test-subagent",
    description: "model wiring test",
    systemPrompt: "you are a test stub",
    model: "inherited-haiku-test",
    maxIterations: 1,
    createAgent,
    requiresApproval: false,
  });

  const out = await sub.invoke({ task: "say hi", workspace_root: "/tmp" });
  assert.equal(out.message, "ok.");
  assert.ok(seenModels.length > 0, "factory was not called");
  assert.ok(
    seenModels.every((m) => m === "inherited-haiku-test"),
    `every inner run must use the configured model; got ${JSON.stringify(seenModels)}`,
  );
});

test("missing model falls back to 'default' on the wire", async () => {
  let seen = "";
  const createAgent: CreateAgent = (opts) => {
    seen = opts.model;
    return cannedRunner(() => {
      const conv = newConversation();
      conv.messages.push(assistantText("done"));
      return [{ type: "done", outcome: { kind: "stopped", iterations: 1 }, conversation: conv }];
    });
  };
  const sub = new InternalSubAgent({
    name: "no-model",
    description: "",
    systemPrompt: "x",
    maxIterations: 1,
    createAgent,
    requiresApproval: false,
  });
  await sub.invoke({ task: "x", workspace_root: "/tmp" });
  assert.equal(seen, "default");
});

test("runner relays delta / tool / done frames; started has no model when unset", async () => {
  const createAgent: CreateAgent = () =>
    cannedRunner(() => {
      const conv = newConversation();
      conv.messages.push(assistantText("final answer"));
      return [
        { type: "delta", content: "thinking..." },
        { type: "tool_start", id: "t1", name: "fs.read", arguments: { path: "a.ts" } },
        { type: "tool_end", id: "t1", name: "fs.read", content: "file body" },
        { type: "done", outcome: { kind: "stopped", iterations: 1 }, conversation: conv },
      ];
    });
  const sub = new InternalSubAgent({
    name: "relay",
    description: "",
    systemPrompt: "x",
    maxIterations: 4,
    createAgent,
    requiresApproval: false,
  });

  const frames: SubAgentFrame[] = [];
  const out = await withSubagent(
    (f) => frames.push(f),
    () => sub.invoke({ task: "do it", workspace_root: "/tmp" }),
  );
  assert.equal(out.message, "final answer");

  const kinds = frames.map((f) => f.event.kind);
  assert.deepEqual(kinds, ["started", "delta", "tool_start", "tool_end", "done"]);
  const started = frames[0]!.event;
  assert.equal(started.kind, "started");
  if (started.kind === "started") assert.equal(started.model, undefined);
  // All frames share one subagent_id.
  const id0 = frames[0]!.subagent_id;
  for (const f of frames) assert.equal(f.subagent_id, id0);
});

test("error event surfaces as a thrown 'subagent error' + emits an error frame", async () => {
  const createAgent: CreateAgent = () =>
    cannedRunner(() => [{ type: "error", message: "boom" }]);
  const sub = new InternalSubAgent({
    name: "fails",
    description: "",
    systemPrompt: "x",
    maxIterations: 1,
    createAgent,
    requiresApproval: false,
  });
  const frames: SubAgentFrame[] = [];
  await assert.rejects(
    () => withSubagent((f) => frames.push(f), () => sub.invoke({ task: "x", workspace_root: "/tmp" })),
    /subagent error: boom/,
  );
  assert.ok(frames.some((f) => f.event.kind === "error"));
  assert.ok(!frames.some((f) => f.event.kind === "done"));
});

test("inputSchema is object-shaped + requiresApproval honoured", () => {
  const sub = new InternalSubAgent({
    name: "gated",
    description: "",
    systemPrompt: "x",
    maxIterations: 1,
    createAgent: () => cannedRunner(() => []),
    requiresApproval: true,
  });
  const schema = sub.inputSchema() as Record<string, unknown>;
  assert.equal(schema["type"], "object");
  assert.ok(sub.requiresApproval());
});
