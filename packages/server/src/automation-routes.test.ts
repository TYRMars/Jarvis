import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  Agent,
  assistantText,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
} from "@jarvis/core";
import {
  MemoryAutomationStore,
  scheduleInterval,
  scheduleOnce,
  type AutomationStore,
  type AutomationTask,
} from "@jarvis/automation";
import { registerAutomationRoutes } from "./automation-routes.ts";
import {
  AutomationClaims,
  automationTick,
  isRunning,
  triggerAutomationNow,
  type AutomationDeps,
} from "./automation-runtime.ts";
import type { AppState } from "./state.ts";

// ---------- test scaffolding ------------------------------------------------

function agentUnused(): never {
  throw new Error("agent not used in this route test");
}

/** A stub provider that always returns one assistant turn then stops. */
class StubProvider implements LlmProvider {
  runs = 0;
  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.runs += 1;
    return Promise.resolve({ message: assistantText("done"), finish_reason: "stop" });
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    yield { type: "finish", message: assistantText("done"), finish_reason: "stop" };
  }
}

/** A provider whose `complete` never resolves — models a hung provider call. */
class HangingProvider implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return new Promise<ChatResponse>(() => {});
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    await new Promise<void>(() => {});
    yield { type: "finish", message: assistantText("unreachable"), finish_reason: "stop" };
  }
}

function makeAgent(provider: LlmProvider): Agent {
  return new Agent(provider, defaultAgentConfig("stub-model"));
}

function makeState(opts: { automations?: AutomationStore; agentProvider?: LlmProvider } = {}): AppState {
  const provider = opts.agentProvider;
  return {
    createAgent: provider ? () => makeAgent(provider) : agentUnused,
    automations: opts.automations,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerAutomationRoutes(app, state);
  await app.ready();
  return app;
}

const intervalSchedule = scheduleInterval(3600);

// ---------- 503 (store absent) ---------------------------------------------

test("automation routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ automations: undefined }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/automations" })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/automations",
        payload: { title: "x", prompt: "y", schedule: intervalSchedule },
      })
    ).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "GET", url: "/v1/automations/a1" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/automations/a1", payload: { title: "z" } })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/automations/a1" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/automations/a1/run" })).statusCode, 503);
  await app.close();
});

// ---------- create / list ---------------------------------------------------

test("POST creates a task, lists it; defaults status=enabled + run_count=0", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const created = await app.inject({
    method: "POST",
    url: "/v1/automations",
    payload: { title: "  Daily digest  ", prompt: "Summarise the project", schedule: intervalSchedule },
  });
  assert.equal(created.statusCode, 201);
  const t = created.json() as AutomationTask;
  assert.equal(t.title, "Daily digest"); // trimmed
  assert.equal(t.prompt, "Summarise the project");
  assert.equal(t.status, "enabled");
  assert.equal(t.run_count, 0);
  assert.ok(t.id);
  assert.ok(t.next_run_at, "interval schedule seeds next_run_at");
  // optional fields absent when unset (skip_serializing_if parity)
  assert.ok(!("provider" in t));
  assert.ok(!("last_run_status" in t));

  const list = await app.inject({ method: "GET", url: "/v1/automations" });
  assert.equal(list.statusCode, 200);
  const body = list.json() as { items: AutomationTask[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.id, t.id);
  await app.close();
});

test("POST honours status / provider / model / conversation_id overrides", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const created = await app.inject({
    method: "POST",
    url: "/v1/automations",
    payload: {
      title: "t",
      prompt: "p",
      schedule: intervalSchedule,
      status: "paused",
      provider: "anthropic",
      model: "claude",
      conversation_id: "conv-1",
    },
  });
  assert.equal(created.statusCode, 201);
  const t = created.json() as AutomationTask;
  assert.equal(t.status, "paused");
  assert.equal(t.provider, "anthropic");
  assert.equal(t.model, "claude");
  assert.equal(t.conversation_id, "conv-1");
  await app.close();
});

// ---------- create validation -----------------------------------------------

test("POST rejects an invalid `once` schedule date → 400", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const res = await app.inject({
    method: "POST",
    url: "/v1/automations",
    payload: { title: "Bad", prompt: "Run", schedule: scheduleOnce("not-a-date") },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /run_at must be RFC3339/);
  await app.close();
});

test("POST rejects a zero-second interval → 400", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const res = await app.inject({
    method: "POST",
    url: "/v1/automations",
    payload: { title: "Bad", prompt: "Run", schedule: { interval: { every_seconds: 0 } } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /every_seconds must be greater than zero/);
  await app.close();
});

test("POST rejects blank title or prompt → 400", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/automations",
        payload: { title: "   ", prompt: "p", schedule: intervalSchedule },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/automations",
        payload: { title: "t", prompt: "   ", schedule: intervalSchedule },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

// ---------- get one ---------------------------------------------------------

test("GET one returns the task; 404 when absent", async () => {
  const store = new MemoryAutomationStore();
  const app = await buildApp(makeState({ automations: store }));
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule },
    })
  ).json() as AutomationTask;

  const got = await app.inject({ method: "GET", url: `/v1/automations/${created.id}` });
  assert.equal(got.statusCode, 200);
  assert.equal((got.json() as AutomationTask).id, created.id);

  const miss = await app.inject({ method: "GET", url: "/v1/automations/nope" });
  assert.equal(miss.statusCode, 404);
  await app.close();
});

// ---------- patch -----------------------------------------------------------

test("PATCH updates fields, clears optionals with null, bumps updated_at", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule, provider: "openai" },
    })
  ).json() as AutomationTask;

  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/automations/${created.id}`,
    payload: { title: "renamed", status: "paused", provider: null },
  });
  assert.equal(patched.statusCode, 200);
  const t = patched.json() as AutomationTask;
  assert.equal(t.title, "renamed");
  assert.equal(t.status, "paused");
  assert.ok(!("provider" in t), "null clears the provider override");
  assert.ok(t.updated_at >= created.updated_at);
  await app.close();
});

test("PATCH recomputes next_run_at when the schedule changes (and task is idle)", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule },
    })
  ).json() as AutomationTask;

  const newSchedule = scheduleOnce("2999-01-01T00:00:00.000Z");
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/automations/${created.id}`,
    payload: { schedule: newSchedule },
  });
  assert.equal(patched.statusCode, 200);
  const t = patched.json() as AutomationTask;
  assert.deepEqual(t.schedule, newSchedule);
  assert.equal(t.next_run_at, "2999-01-01T00:00:00.000Z");
  await app.close();
});

test("PATCH rejects blank title / prompt and an invalid schedule → 400", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const id = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule },
    })
  ).json().id as string;

  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/automations/${id}`, payload: { title: "  " } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/automations/${id}`, payload: { prompt: "" } })).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/v1/automations/${id}`,
        payload: { schedule: scheduleOnce("nope") },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

test("PATCH on a missing task → 404", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const res = await app.inject({ method: "PATCH", url: "/v1/automations/nope", payload: { title: "x" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------- delete ----------------------------------------------------------

test("DELETE removes a task → 204, then 404", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const id = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule },
    })
  ).json().id as string;

  const del = await app.inject({ method: "DELETE", url: `/v1/automations/${id}` });
  assert.equal(del.statusCode, 204);
  const again = await app.inject({ method: "DELETE", url: `/v1/automations/${id}` });
  assert.equal(again.statusCode, 404);
  await app.close();
});

// ---------- on-demand trigger ----------------------------------------------

test("POST /:id/run → 404 when the task is absent", async () => {
  const app = await buildApp(makeState({ automations: new MemoryAutomationStore() }));
  const res = await app.inject({ method: "POST", url: "/v1/automations/nope/run" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /:id/run → 409 when the task is already running", async () => {
  const store = new MemoryAutomationStore();
  const app = await buildApp(makeState({ automations: store, agentProvider: new StubProvider() }));
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "p", schedule: intervalSchedule },
    })
  ).json() as AutomationTask;
  // Force the durable running flag (the first 409 branch in the handler).
  created.last_run_status = "running";
  await store.upsert(created);

  const res = await app.inject({ method: "POST", url: `/v1/automations/${created.id}/run` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already running/);
  await app.close();
});

test("POST /:id/run → 202 and the agent is driven", async () => {
  const store = new MemoryAutomationStore();
  const provider = new StubProvider();
  const app = await buildApp(makeState({ automations: store, agentProvider: provider }));
  const created = (
    await app.inject({
      method: "POST",
      url: "/v1/automations",
      payload: { title: "t", prompt: "do work", schedule: intervalSchedule },
    })
  ).json() as AutomationTask;

  const res = await app.inject({ method: "POST", url: `/v1/automations/${created.id}/run` });
  assert.equal(res.statusCode, 202);
  assert.equal((res.json() as AutomationTask).id, created.id);

  // The spawned run is fire-and-forget; await its completion by polling for the
  // terminal status the runtime writes.
  for (let i = 0; i < 50 && (await store.get(created.id))?.last_run_status === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  for (let i = 0; i < 50 && (await store.get(created.id))?.last_run_status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const final = await store.get(created.id);
  assert.equal(final?.last_run_status, "succeeded");
  assert.equal(final?.run_count, 1);
  assert.equal(provider.runs, 1);
  await app.close();
});

// ---------- runtime: AutomationClaims --------------------------------------

test("AutomationClaims: a claim is exclusive per id and released on call", () => {
  const claims = new AutomationClaims();
  const first = claims.tryClaim("a1");
  assert.ok(first, "first claim wins");
  assert.equal(claims.tryClaim("a1"), undefined, "in-flight id cannot be re-claimed");
  const other = claims.tryClaim("a2");
  assert.ok(other, "a distinct id is independent");
  first!();
  assert.ok(claims.tryClaim("a1"), "releasing frees the id for the next pickup");
  // idempotent release: calling first() again must not drop the later a1 claim
  first!();
  assert.equal(claims.tryClaim("a1"), undefined);
});

// ---------- runtime: automationTick ----------------------------------------

function makeDeps(store: AutomationStore, provider: LlmProvider, claims: AutomationClaims): AutomationDeps {
  return {
    automations: store,
    buildAgent: () => makeAgent(provider),
    claims,
    logger: { info: () => {}, warn: () => {} },
  };
}

test("automationTick spawns a run for a due task, marks it succeeded", async () => {
  const store = new MemoryAutomationStore();
  const provider = new StubProvider();
  const claims = new AutomationClaims();
  const deps = makeDeps(store, provider, claims);

  // A task due in the past (next_run_at well before now).
  const due = await triggerSeed(store, scheduleInterval(3600), "2000-01-01T00:00:00.000Z");

  const spawned = await automationTick(deps, {}, { awaitRuns: true, now: "2100-01-01T00:00:00.000Z" });
  assert.equal(spawned, 1);
  const final = await store.get(due.id);
  assert.equal(final?.last_run_status, "succeeded");
  assert.equal(final?.run_count, 1);
});

test("automationTick bounds a hung run by runTimeoutMs and marks it failed", async () => {
  const store = new MemoryAutomationStore();
  const provider = new HangingProvider();
  const claims = new AutomationClaims();
  const deps = makeDeps(store, provider, claims);

  const due = await triggerSeed(store, scheduleInterval(3600), "2000-01-01T00:00:00.000Z");

  // Without a wall-clock bound this run would never settle; the short timeout
  // must surface a clean failure instead of pinning the slot forever.
  const spawned = await automationTick(
    deps,
    { runTimeoutMs: 25 },
    { awaitRuns: true, now: "2100-01-01T00:00:00.000Z" },
  );
  assert.equal(spawned, 1);
  const final = await store.get(due.id);
  assert.equal(final?.last_run_status, "failed");
  assert.match(final?.last_error ?? "", /wall-clock budget/);
});

test("automationTick skips a paused task and one with no due next_run_at", async () => {
  const store = new MemoryAutomationStore();
  const provider = new StubProvider();
  const deps = makeDeps(store, provider, new AutomationClaims());

  const paused = await triggerSeed(store, scheduleInterval(3600), "2000-01-01T00:00:00.000Z");
  paused.status = "paused";
  await store.upsert(paused);

  // future-due task
  await triggerSeed(store, scheduleInterval(3600), "2999-01-01T00:00:00.000Z");

  const spawned = await automationTick(deps, {}, { awaitRuns: true, now: "2100-01-01T00:00:00.000Z" });
  assert.equal(spawned, 0);
  assert.equal(provider.runs, 0);
});

test("triggerAutomationNow returns conflict when an isolated claim is held", async () => {
  const store = new MemoryAutomationStore();
  const provider = new StubProvider();
  const claims = new AutomationClaims();
  const deps = makeDeps(store, provider, claims);
  const seeded = await triggerSeed(store, scheduleInterval(3600), "2000-01-01T00:00:00.000Z");

  // Pre-claim the id → the manual trigger's try_claim fails → conflict.
  const held = claims.tryClaim(seeded.id);
  assert.ok(held);
  const outcome = await triggerAutomationNow(deps, seeded.id, { awaitRun: true });
  assert.equal(outcome.kind, "conflict");
  held!();

  // Once released, the trigger succeeds and drives the agent.
  const ok = await triggerAutomationNow(deps, seeded.id, { awaitRun: true });
  assert.equal(ok.kind, "accepted");
  assert.equal(provider.runs, 1);
  assert.equal((await store.get(seeded.id))?.last_run_status, "succeeded");
});

test("isRunning reflects the durable running flag", () => {
  const idle: AutomationTask = {
    id: "x",
    title: "t",
    prompt: "p",
    schedule: scheduleInterval(3600),
    status: "enabled",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    run_count: 0,
  };
  assert.equal(isRunning(idle), false);
  idle.last_run_status = "running";
  assert.equal(isRunning(idle), true);
});

// ---------- helpers ---------------------------------------------------------

/** Seed a task with a fixed `next_run_at` so due-ness is deterministic. */
async function triggerSeed(
  store: AutomationStore,
  schedule: ReturnType<typeof scheduleInterval>,
  nextRunAt: string,
): Promise<AutomationTask> {
  const task: AutomationTask = {
    id: crypto.randomUUID(),
    title: "t",
    prompt: "p",
    schedule,
    status: "enabled",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    next_run_at: nextRunAt,
    run_count: 0,
  };
  await store.upsert(task);
  return task;
}
