import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  MemorySubAgentRunStore,
  type SubAgentEvent,
  type SubAgentFrame,
  type SubAgentRunStore,
} from "@jarvis/subagents";
import { MemoryRequirementRunStore } from "@jarvis/store";
import {
  newRequirementRun,
  type RequirementRun,
  type RequirementRunStore,
} from "@jarvis/project";
import {
  MemoryAutomationStore,
  newAutomationTask,
  scheduleInterval,
  markRunning,
  type AutomationStore,
} from "@jarvis/automation";
import { registerTasksRoutes } from "./tasks-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

function makeState(
  opts: {
    subagentRuns?: SubAgentRunStore;
    requirementRuns?: RequirementRunStore;
    automations?: AutomationStore;
  } = {},
): AppState {
  return {
    createAgent: agentUnused,
    subagentRuns: opts.subagentRuns,
    requirementRuns: opts.requirementRuns,
    automations: opts.automations,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerTasksRoutes(app, state);
  await app.ready();
  return app;
}

function frame(id: string, name: string, event: SubAgentEvent, conversationId?: string): { conversationId: string | undefined; frame: SubAgentFrame } {
  return { conversationId, frame: { subagent_id: id, subagent_name: name, event } };
}

// ---------------------------------------------------------------------------
// All sources absent → empty list (200, not 503)
// ---------------------------------------------------------------------------

test("GET /v1/tasks returns empty items + a generated_at clock with no sources wired", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: unknown[]; generated_at: number };
  assert.deepEqual(body.items, []);
  assert.equal(typeof body.generated_at, "number");
  assert.ok(body.generated_at > 0);
  await app.close();
});

// ---------------------------------------------------------------------------
// Subagent runs
// ---------------------------------------------------------------------------

test("an active subagent run surfaces as a subagent_run task", async () => {
  const runs = new MemorySubAgentRunStore();
  const f = frame("sub-1", "review", { kind: "started", task: "check the diff" }, "conv-9");
  await runs.recordFrame(f.conversationId, f.frame);
  const app = await buildApp(makeState({ subagentRuns: runs }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  assert.equal(res.statusCode, 200);
  const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "subagent_run");
  assert.equal(items[0]!.id, "sub-1");
  assert.equal(items[0]!.status, "running");
  assert.equal(items[0]!.label, "review: check the diff");
  await app.close();
});

test("a completed subagent run does not surface", async () => {
  const runs = new MemorySubAgentRunStore();
  const start = frame("sub-done", "review", { kind: "started", task: "t" });
  await runs.recordFrame(start.conversationId, start.frame);
  const done = frame("sub-done", "review", { kind: "done", final_message: "ok" });
  await runs.recordFrame(done.conversationId, done.frame);
  const app = await buildApp(makeState({ subagentRuns: runs }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  const items = (res.json() as { items: unknown[] }).items;
  assert.deepEqual(items, []);
  await app.close();
});

test("a multibyte subagent task label truncates on a char boundary (no panic)", async () => {
  const runs = new MemorySubAgentRunStore();
  // 60 CJK chars; a byte slice would split mid-character.
  const task = "验证代码变更并运行测试套件确保一切正常工作完成质量检查任务".repeat(2);
  const f = frame("sub-cjk", "review", { kind: "started", task });
  await runs.recordFrame(f.conversationId, f.frame);
  const app = await buildApp(makeState({ subagentRuns: runs }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  const items = (res.json() as { items: Array<{ kind: string; label: string }> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "subagent_run");
  assert.ok(items[0]!.label.endsWith("…"), `expected ellipsis, got: ${items[0]!.label}`);
  await app.close();
});

// ---------------------------------------------------------------------------
// Requirement runs
// ---------------------------------------------------------------------------

test("a running requirement run surfaces; a completed one does not", async () => {
  const store = new MemoryRequirementRunStore();
  const running: RequirementRun = { ...newRequirementRun("req-1", "conv-r"), status: "running" };
  await store.upsert(running);
  const completed: RequirementRun = { ...newRequirementRun("req-2", "conv-c"), status: "completed" };
  await store.upsert(completed);
  const app = await buildApp(makeState({ requirementRuns: store }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "requirement_run");
  assert.equal(items[0]!.id, running.id);
  assert.equal(items[0]!.status, "running");
  assert.equal(items[0]!.label, "Requirement req-1 · running");
  assert.equal(typeof items[0]!.started_at, "number");
  await app.close();
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

test("a running automation surfaces; an enabled-but-idle one does not", async () => {
  const store = new MemoryAutomationStore();
  const now = "2026-06-15T00:00:00.000Z";
  const running = newAutomationTask({ title: "Nightly sync", prompt: "p", schedule: scheduleInterval(3600) }, now);
  markRunning(running, now); // flips last_run_status to "running"
  await store.upsert(running);
  const idle = newAutomationTask({ title: "Idle", prompt: "p", schedule: scheduleInterval(3600) }, now);
  await store.upsert(idle);
  const app = await buildApp(makeState({ automations: store }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "automation_run");
  assert.equal(items[0]!.id, running.id);
  assert.equal(items[0]!.status, "running");
  assert.equal(items[0]!.label, "Automation · Nightly sync");
  await app.close();
});

// ---------------------------------------------------------------------------
// Aggregation + sort + the ?conversation filter
// ---------------------------------------------------------------------------

test("multiple sources aggregate, sorted newest-first by started_at", async () => {
  const subRuns = new MemorySubAgentRunStore();
  const reqRuns = new MemoryRequirementRunStore();
  const autos = new MemoryAutomationStore();

  // Requirement run started long ago (oldest).
  const oldReq: RequirementRun = {
    ...newRequirementRun("req-old", "conv-r"),
    status: "running",
    started_at: "2020-01-01T00:00:00.000Z",
  };
  await reqRuns.upsert(oldReq);

  // Automation running "now-ish" — newest.
  const auto = newAutomationTask({ title: "A", prompt: "p", schedule: scheduleInterval(3600) }, new Date().toISOString());
  markRunning(auto, new Date().toISOString());
  await autos.upsert(auto);

  // Subagent run — started_at is Date.now() at record time (between the two).
  const f = frame("sub-mid", "review", { kind: "started", task: "t" });
  await subRuns.recordFrame(f.conversationId, f.frame);

  const app = await buildApp(makeState({ subagentRuns: subRuns, requirementRuns: reqRuns, automations: autos }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  const items = (res.json() as { items: Array<{ kind: string; started_at: number }> }).items;
  assert.equal(items.length, 3);
  // Newest first: monotonically non-increasing started_at, and the oldest
  // requirement run lands last.
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1]!.started_at >= items[i]!.started_at);
  }
  assert.equal(items[items.length - 1]!.kind, "requirement_run");
  await app.close();
});

test("?conversation filter keeps matching subagent/requirement runs and drops automations + non-matches", async () => {
  const subRuns = new MemorySubAgentRunStore();
  const reqRuns = new MemoryRequirementRunStore();
  const autos = new MemoryAutomationStore();

  // Subagent run owned by conv-keep (records conversation_id on the record).
  const keep = frame("sub-keep", "review", { kind: "started", task: "t" }, "conv-keep");
  await subRuns.recordFrame(keep.conversationId, keep.frame);
  // Subagent run for a different conversation — dropped.
  const other = frame("sub-other", "review", { kind: "started", task: "t" }, "conv-other");
  await subRuns.recordFrame(other.conversationId, other.frame);

  // Requirement run on conv-keep — kept (detail.conversation_id matches).
  const req: RequirementRun = { ...newRequirementRun("req-1", "conv-keep"), status: "running" };
  await reqRuns.upsert(req);

  // A running automation — never conversation-scoped, always dropped by the filter.
  const auto = newAutomationTask({ title: "A", prompt: "p", schedule: scheduleInterval(3600) }, new Date().toISOString());
  markRunning(auto, new Date().toISOString());
  await autos.upsert(auto);

  const app = await buildApp(makeState({ subagentRuns: subRuns, requirementRuns: reqRuns, automations: autos }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks?conversation=conv-keep" });
  const items = (res.json() as { items: Array<{ kind: string; id: string }> }).items;
  // The subagent run matches by id (sub-keep); the requirement run matches via
  // detail.conversation_id (its TaskEntry.id is the run UUID, not "req-1").
  assert.equal(items.length, 2);
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, [req.id, "sub-keep"].sort());
  assert.ok(items.every((i) => i.kind === "subagent_run" || i.kind === "requirement_run"));
  await app.close();
});

test("?conversation filter returns empty when nothing matches", async () => {
  const subRuns = new MemorySubAgentRunStore();
  const f = frame("sub-a", "review", { kind: "started", task: "t" }, "conv-a");
  await subRuns.recordFrame(f.conversationId, f.frame);
  const app = await buildApp(makeState({ subagentRuns: subRuns }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks?conversation=conv-zzz" });
  assert.deepEqual((res.json() as { items: unknown[] }).items, []);
  await app.close();
});

test("a failed requirement run with no listAll support degrades to skip (still 200)", async () => {
  // A store whose listAll rejects must not 500 the endpoint — collectTasks
  // swallows the error and skips the source.
  const broken: RequirementRunStore = {
    listForRequirement: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    listAll: () => Promise.reject(new Error("boom")),
    upsert: () => Promise.resolve(),
    broadcast: () => {},
    subscribe: () => () => {},
  };
  const app = await buildApp(makeState({ requirementRuns: broken }));
  const res = await app.inject({ method: "GET", url: "/v1/tasks" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { items: unknown[] }).items, []);
  await app.close();
});
