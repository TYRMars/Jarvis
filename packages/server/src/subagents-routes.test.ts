import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { JsonValue } from "@jarvis/core";
import {
  MemorySubAgentRunStore,
  SubAgentRegistry,
  type SubAgent,
  type SubAgentFrame,
  type SubAgentInput,
  type SubAgentOutput,
  type SubAgentRunStore,
} from "@jarvis/subagents";
import { registerSubagentsRoutes } from "./subagents-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** Minimal SubAgent for the catalogue tests — never actually invoked here. */
class FakeSubAgent implements SubAgent {
  readonly name: string;
  readonly description: string;
  readonly #approval: boolean;
  constructor(name: string, approval: boolean, description = "fake subagent for tests") {
    this.name = name;
    this.#approval = approval;
    this.description = description;
  }
  inputSchema(): JsonValue {
    return { type: "object" };
  }
  requiresApproval(): boolean {
    return this.#approval;
  }
  invoke(_input: SubAgentInput): Promise<SubAgentOutput> {
    return Promise.resolve({ message: "ok" });
  }
}

function makeState(opts: { subagents?: SubAgentRegistry; subagentRuns?: SubAgentRunStore } = {}): AppState {
  return {
    createAgent: agentUnused,
    subagents: opts.subagents,
    subagentRuns: opts.subagentRuns,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerSubagentsRoutes(app, state);
  await app.ready();
  return app;
}

function frame(id: string, name: string, event: SubAgentFrame["event"]): SubAgentFrame {
  return { subagent_id: id, subagent_name: name, event };
}

// ---------------------------------------------------------------------------
// /v1/subagents — catalogue (always 200)
// ---------------------------------------------------------------------------

test("GET /v1/subagents returns empty array when no registry is wired", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/subagents" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { items: [] });
  await app.close();
});

test("GET /v1/subagents returns empty array when the registry is empty", async () => {
  const app = await buildApp(makeState({ subagents: new SubAgentRegistry() }));
  const res = await app.inject({ method: "GET", url: "/v1/subagents" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { items: [] });
  await app.close();
});

test("GET /v1/subagents lists registered subagents sorted by name with tool_name + approval", async () => {
  const reg = new SubAgentRegistry();
  reg.register(new FakeSubAgent("review", false));
  reg.register(new FakeSubAgent("codex", true));
  const app = await buildApp(makeState({ subagents: reg }));

  const res = await app.inject({ method: "GET", url: "/v1/subagents" });
  assert.equal(res.statusCode, 200);
  const items = res.json().items;
  assert.equal(items.length, 2);
  // Sorted by bare name ascending: codex < review.
  assert.equal(items[0].name, "codex");
  assert.equal(items[0].tool_name, "subagent.codex");
  assert.equal(items[0].requires_approval, true);
  assert.deepEqual(items[0].parameters, { type: "object" });
  assert.equal(items[1].name, "review");
  assert.equal(items[1].tool_name, "subagent.review");
  assert.equal(items[1].requires_approval, false);
  await app.close();
});

// ---------------------------------------------------------------------------
// /v1/subagents/runs* — runs ledger (503 when store absent)
// ---------------------------------------------------------------------------

test("runs endpoints 503 when no runs store is configured", async () => {
  const app = await buildApp(makeState());
  assert.equal((await app.inject({ method: "GET", url: "/v1/subagents/runs" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/subagents/runs/run-1" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/subagents/runs/run-1/cancel" })).statusCode,
    503,
  );
  await app.close();
});

test("GET /v1/subagents/runs lists recorded runs newest-first", async () => {
  const runs = new MemorySubAgentRunStore();
  await runs.recordFrame(undefined, frame("run-1", "review", { kind: "started", task: "verify", model: "claude-3-5" }));
  const app = await buildApp(makeState({ subagentRuns: runs }));

  const res = await app.inject({ method: "GET", url: "/v1/subagents/runs" });
  assert.equal(res.statusCode, 200);
  const items = res.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "run-1");
  assert.equal(items[0].name, "review");
  assert.equal(items[0].task, "verify");
  assert.equal(items[0].model, "claude-3-5");
  assert.equal(items[0].status, "running");
  await app.close();
});

test("GET /v1/subagents/runs/:id returns the run plus its recorded events", async () => {
  const runs = new MemorySubAgentRunStore();
  await runs.recordFrame(undefined, frame("run-1", "review", { kind: "started", task: "verify" }));
  await runs.recordFrame(undefined, frame("run-1", "review", { kind: "tool_start", name: "fs.read", arguments: {} }));
  const app = await buildApp(makeState({ subagentRuns: runs }));

  const res = await app.inject({ method: "GET", url: "/v1/subagents/runs/run-1" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.run.id, "run-1");
  assert.equal(body.run.tool_call_count, 1);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].frame.event.kind, "started");
  assert.equal(body.events[1].frame.event.kind, "tool_start");
  await app.close();
});

test("GET /v1/subagents/runs/:id 404s for an unknown run", async () => {
  const app = await buildApp(makeState({ subagentRuns: new MemorySubAgentRunStore() }));
  const res = await app.inject({ method: "GET", url: "/v1/subagents/runs/nope" });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /not found/);
  await app.close();
});

test("POST /v1/subagents/runs/:id/cancel marks a running run cancelled", async () => {
  const runs = new MemorySubAgentRunStore();
  await runs.recordFrame(undefined, frame("run-2", "codex", { kind: "started", task: "x" }));
  const app = await buildApp(makeState({ subagentRuns: runs }));

  const res = await app.inject({ method: "POST", url: "/v1/subagents/runs/run-2/cancel" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cancelled: true });
  assert.equal((await runs.get("run-2"))?.status, "cancelled");
  await app.close();
});

test("POST /v1/subagents/runs/:id/cancel 404s for an unknown / already-terminal run", async () => {
  const runs = new MemorySubAgentRunStore();
  const app = await buildApp(makeState({ subagentRuns: runs }));

  // unknown run
  const missing = await app.inject({ method: "POST", url: "/v1/subagents/runs/missing/cancel" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().cancelled, false);

  // a run that already finished can't be cancelled either
  await runs.recordFrame(undefined, frame("run-3", "review", { kind: "started", task: "y" }));
  await runs.recordFrame(undefined, frame("run-3", "review", { kind: "done", final_message: "done" }));
  const terminal = await app.inject({ method: "POST", url: "/v1/subagents/runs/run-3/cancel" });
  assert.equal(terminal.statusCode, 404);
  await app.close();
});
