import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { makeMemoryStores } from "@jarvis/store";
import { newRequirement, type RequirementStore } from "@jarvis/project";
import {
  Agent,
  defaultAgentConfig,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
} from "@jarvis/core";
import {
  newWorkflowRun,
  finishWorkflowRun,
  newWorkflowStep,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStore,
} from "@jarvis/workflow";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { WorkflowRunGate } from "./workflow-concurrency.ts";
import type { AppState } from "./state.ts";

/** A provider that replies with a fixed assistant message — enough to drive a
 *  workflow's agent step to completion in the route-level wiring tests. */
class CannedProvider implements LlmProvider {
  async complete(): Promise<ChatResponse> {
    return { message: { role: "assistant", content: "done" }, finish_reason: "stop", response_id: null };
  }
  async *completeStream(): AsyncGenerator<LlmChunk> {
    yield { type: "finish", message: { role: "assistant", content: "done" }, finish_reason: "stop", response_id: null };
  }
}

const TERMINAL: readonly WorkflowRunStatus[] = ["succeeded", "failed", "cancelled"];

/** Poll a run until it reaches a terminal status (or the attempts run out). */
async function waitForTerminal(store: WorkflowStore, runId: string): Promise<WorkflowRunStatus> {
  let status: WorkflowRunStatus = "running";
  for (let i = 0; i < 100 && !TERMINAL.includes(status); i++) {
    await new Promise((r) => setTimeout(r, 10));
    status = (await store.getRun(runId))?.status ?? status;
  }
  return status;
}

// ---------- fixtures ----------

function noAgent(): never {
  throw new Error("agent not used in these route tests");
}

/** AppState wired with an in-memory WorkflowStore (+ optional requirement store). */
function makeState(opts: { workflows?: WorkflowStore; requirements?: RequirementStore } = {}): AppState {
  const stores = makeMemoryStores();
  return {
    createAgent: noAgent,
    workflows: opts.workflows ?? stores.workflows,
    requirements: opts.requirements,
  };
}

/** AppState with NO workflow store (drives the 503 path). */
function makeStateNoStore(): AppState {
  return { createAgent: noAgent };
}

function agentStep(name: string, prompt: string): WorkflowStep {
  return newWorkflowStep(name, { type: "agent", prompt });
}

async function build(state: AppState) {
  const app = Fastify();
  registerWorkflowRoutes(app, state);
  await app.ready();
  return app;
}

async function createWorkflow(
  app: Awaited<ReturnType<typeof build>>,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: "/v1/workflows", payload });
}

// ---------- 503 when unconfigured ----------

test("every workflow route 503s when no store is configured", async () => {
  const app = await build(makeStateNoStore());
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflows" })).statusCode, 503);
    assert.equal((await createWorkflow(app, { name: "x" })).statusCode, 503);
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflows/abc" })).statusCode, 503);
    assert.equal((await app.inject({ method: "PUT", url: "/v1/workflows/abc", payload: {} })).statusCode, 503);
    assert.equal((await app.inject({ method: "DELETE", url: "/v1/workflows/abc" })).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/v1/workflows/abc/run", payload: {} })).statusCode, 503);
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflows/abc/runs" })).statusCode, 503);
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflow-runs/r1" })).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/v1/workflow-runs/r1/cancel" })).statusCode, 503);
  } finally {
    await app.close();
  }
});

// ---------- create + list ----------

test("create then list round-trip; blank step id gets server-minted", async () => {
  const app = await build(makeState());
  try {
    const created = await createWorkflow(app, {
      name: "ship",
      description: "research then build",
      steps: [{ id: "", name: "research", kind: { type: "agent", prompt: "look around" } }],
    });
    assert.equal(created.statusCode, 201);
    const def = created.json();
    assert.equal(def.name, "ship");
    assert.equal(def.description, "research then build");
    assert.ok(typeof def.steps[0].id === "string" && def.steps[0].id.length > 0);

    const list = await app.inject({ method: "GET", url: "/v1/workflows" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 1);
  } finally {
    await app.close();
  }
});

test("create rejects a blank name", async () => {
  const app = await build(makeState());
  try {
    const res = await createWorkflow(app, { name: "   ", steps: [agentStep("a", "go")] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "name is required");
  } finally {
    await app.close();
  }
});

test("create rejects a workflow with no agent steps", async () => {
  const app = await build(makeState());
  try {
    const res = await createWorkflow(app, { name: "empty", steps: [] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "workflow must contain at least one agent step");
  } finally {
    await app.close();
  }
});

test("create rejects an agent step with a blank prompt (names the step)", async () => {
  const app = await build(makeState());
  try {
    const res = await createWorkflow(app, { name: "blank", steps: [agentStep("research", "   ")] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "agent step 'research' has an empty prompt");
  } finally {
    await app.close();
  }
});

test("create rejects a blank prompt nested inside a group", async () => {
  const app = await build(makeState());
  try {
    const res = await createWorkflow(app, {
      name: "nested",
      steps: [
        { id: "", name: "build", kind: { type: "pipeline", steps: [agentStep("write", "")] } },
      ],
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "agent step 'write' has an empty prompt");
  } finally {
    await app.close();
  }
});

// ---------- get / update / delete ----------

test("get 404s an unknown id; get returns the definition", async () => {
  const app = await build(makeState());
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflows/nope" })).statusCode, 404);
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const got = await app.inject({ method: "GET", url: `/v1/workflows/${def.id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().id, def.id);
  } finally {
    await app.close();
  }
});

test("PUT updates name + clears description; bumps updated_at", async () => {
  const app = await build(makeState());
  try {
    const def = (await createWorkflow(app, {
      name: "ship",
      description: "old",
      steps: [agentStep("a", "go")],
    })).json();

    const upd = await app.inject({
      method: "PUT",
      url: `/v1/workflows/${def.id}`,
      payload: { name: "renamed", description: "" },
    });
    assert.equal(upd.statusCode, 200);
    const body = upd.json();
    assert.equal(body.name, "renamed");
    assert.equal(body.description, undefined);
    assert.ok(body.updated_at >= def.updated_at);
  } finally {
    await app.close();
  }
});

test("PATCH is accepted as an update alias (mirrors the Rust verb)", async () => {
  const app = await build(makeState());
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const upd = await app.inject({
      method: "PATCH",
      url: `/v1/workflows/${def.id}`,
      payload: { name: "patched" },
    });
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.json().name, "patched");
  } finally {
    await app.close();
  }
});

test("update rejects an empty name and 404s an unknown id", async () => {
  const app = await build(makeState());
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const blank = await app.inject({
      method: "PUT",
      url: `/v1/workflows/${def.id}`,
      payload: { name: "  " },
    });
    assert.equal(blank.statusCode, 400);
    assert.equal(blank.json().error, "name cannot be empty");

    const missing = await app.inject({ method: "PUT", url: "/v1/workflows/nope", payload: {} });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("delete returns 204 then 404 on the second attempt", async () => {
  const app = await build(makeState());
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const del = await app.inject({ method: "DELETE", url: `/v1/workflows/${def.id}` });
    assert.equal(del.statusCode, 204);
    const again = await app.inject({ method: "DELETE", url: `/v1/workflows/${def.id}` });
    assert.equal(again.statusCode, 404);
  } finally {
    await app.close();
  }
});

// ---------- run dispatch (deferred runtime → Pending) ----------

test("POST /:id/run (no run gate) persists a Pending run and 202s; it shows in /runs", async () => {
  const state = makeState();
  const app = await build(state);
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();

    const run = await app.inject({ method: "POST", url: `/v1/workflows/${def.id}/run`, payload: {} });
    assert.equal(run.statusCode, 202);
    const body = run.json();
    assert.equal(body.workflow_id, def.id);
    assert.equal(body.status, "pending"); // runtime engine deferred → Pending, not Running
    assert.equal(body.requirement_id, undefined);

    // Persisted synchronously: fetchable by id + listed under the definition.
    const got = await app.inject({ method: "GET", url: `/v1/workflow-runs/${body.id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().status, "pending");

    const runs = await app.inject({ method: "GET", url: `/v1/workflows/${def.id}/runs` });
    assert.equal(runs.statusCode, 200);
    assert.equal(runs.json().items.length, 1);
  } finally {
    await app.close();
  }
});

test("POST /:id/run 404s an unknown workflow", async () => {
  const app = await build(makeState());
  try {
    const res = await app.inject({ method: "POST", url: "/v1/workflows/nope/run", payload: {} });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /:id/run with requirement_id 503s when no requirement store", async () => {
  const app = await build(makeState()); // requirements absent
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/workflows/${def.id}/run`,
      payload: { requirement_id: "r-1" },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "requirement store not configured");
  } finally {
    await app.close();
  }
});

test("POST /:id/run with an unknown requirement_id 400s", async () => {
  const stores = makeMemoryStores();
  const app = await build(makeState({ workflows: stores.workflows, requirements: stores.requirements }));
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/workflows/${def.id}/run`,
      payload: { requirement_id: "missing" },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /requirement `missing` not found/);
  } finally {
    await app.close();
  }
});

test("POST /:id/run binds an existing requirement onto the run", async () => {
  const stores = makeMemoryStores();
  const requirement = newRequirement("proj-1", "do the thing");
  await stores.requirements.upsert(requirement);
  const app = await build(makeState({ workflows: stores.workflows, requirements: stores.requirements }));
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/workflows/${def.id}/run`,
      payload: { requirement_id: requirement.id },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().requirement_id, requirement.id);
  } finally {
    await app.close();
  }
});

// ---------- run dispatch (governed: run gate wired) ----------

test("gated POST /:id/run mints a Running run and drives it to a terminal state", async () => {
  const stores = makeMemoryStores();
  const state: AppState = {
    createAgent: () => new Agent(new CannedProvider(), { ...defaultAgentConfig("test-model"), maxIterations: 3 }),
    workflows: stores.workflows,
    workflowRunGate: new WorkflowRunGate(2),
  };
  const app = await build(state);
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const res = await app.inject({ method: "POST", url: `/v1/workflows/${def.id}/run`, payload: {} });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().status, "running"); // gate wired → executes, not Pending

    // Execution runs in the background; poll the persisted row until it finishes.
    const status = await waitForTerminal(stores.workflows, res.json().id);
    assert.equal(status, "succeeded");
  } finally {
    await app.close();
  }
});

test("gated POST /:id/run 429s when the run gate is at capacity", async () => {
  const stores = makeMemoryStores();
  const gate = new WorkflowRunGate(1);
  gate.tryAcquire(); // exhaust the single slot so the route can't reserve one
  const state: AppState = {
    createAgent: noAgent, // never reached: 429 returns before executing
    workflows: stores.workflows,
    workflowRunGate: gate,
  };
  const app = await build(state);
  try {
    const def = (await createWorkflow(app, { name: "ship", steps: [agentStep("a", "go")] })).json();
    const res = await app.inject({ method: "POST", url: `/v1/workflows/${def.id}/run`, payload: {} });
    assert.equal(res.statusCode, 429);
    // No run was minted while at capacity.
    const runs = await app.inject({ method: "GET", url: `/v1/workflows/${def.id}/runs` });
    assert.equal(runs.json().items.length, 0);
  } finally {
    await app.close();
  }
});

// ---------- run fetch + cancel ----------

test("GET /v1/workflow-runs/:id 404s an unknown run", async () => {
  const app = await build(makeState());
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/workflow-runs/nope" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("cancel flips a non-terminal run to cancelled with finished_at + error", async () => {
  const stores = makeMemoryStores();
  const run = newWorkflowRun("wf-1", undefined); // status "running"
  await stores.workflows.upsertRun(run);
  const app = await build(makeState({ workflows: stores.workflows }));
  try {
    const res = await app.inject({ method: "POST", url: `/v1/workflow-runs/${run.id}/cancel` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "cancelled");
    assert.equal(typeof body.finished_at, "string");
    assert.equal(body.error, "run cancelled by operator");

    const persisted = await stores.workflows.getRun(run.id);
    assert.equal(persisted?.status, "cancelled");
  } finally {
    await app.close();
  }
});

test("cancel aborts the live in-process run via the run gate", async () => {
  const stores = makeMemoryStores();
  const gate = new WorkflowRunGate(2);
  const run = newWorkflowRun("wf-1", undefined); // status "running"
  await stores.workflows.upsertRun(run);
  const controller = new AbortController();
  gate.registerController(run.id, controller);
  const state: AppState = { createAgent: noAgent, workflows: stores.workflows, workflowRunGate: gate };
  const app = await build(state);
  try {
    const res = await app.inject({ method: "POST", url: `/v1/workflow-runs/${run.id}/cancel` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "cancelled");
    assert.ok(controller.signal.aborted, "gate.cancel() aborted the live task's controller");
  } finally {
    await app.close();
  }
});

test("cancel is idempotent on an already-terminal run (status preserved)", async () => {
  const stores = makeMemoryStores();
  const run = newWorkflowRun("wf-1", undefined);
  finishWorkflowRun(run, "succeeded");
  await stores.workflows.upsertRun(run);
  const app = await build(makeState({ workflows: stores.workflows }));
  try {
    const res = await app.inject({ method: "POST", url: `/v1/workflow-runs/${run.id}/cancel` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "succeeded");
    const persisted = await stores.workflows.getRun(run.id);
    assert.equal(persisted?.status, "succeeded");
  } finally {
    await app.close();
  }
});

test("cancel 404s an unknown run", async () => {
  const app = await build(makeState());
  try {
    assert.equal((await app.inject({ method: "POST", url: "/v1/workflow-runs/nope/cancel" })).statusCode, 404);
  } finally {
    await app.close();
  }
});
