import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  newWorkflowDefinition,
  type WorkflowDefinition,
} from "./definition.ts";
import { newWorkflowRun, type WorkflowRun } from "./run.ts";
import { WorkflowError, type WorkflowStore } from "./store.ts";

// A minimal in-memory implementation, here only to prove the WorkflowStore
// interface is implementable as written (Promise-returning, undefined for
// absent rows, boolean delete). Concrete backends live in @jarvis/store.
class FakeStore implements WorkflowStore {
  private defs = new Map<string, WorkflowDefinition>();
  private runs = new Map<string, WorkflowRun>();

  async list(): Promise<WorkflowDefinition[]> {
    return [...this.defs.values()];
  }
  async get(id: string): Promise<WorkflowDefinition | undefined> {
    return this.defs.get(id);
  }
  async upsert(def: WorkflowDefinition): Promise<void> {
    this.defs.set(def.id, def);
  }
  async delete(id: string): Promise<boolean> {
    return this.defs.delete(id);
  }
  async listRuns(
    workflowId: string | undefined,
    requirementId: string | undefined,
  ): Promise<WorkflowRun[]> {
    return [...this.runs.values()].filter(
      (r) =>
        (workflowId === undefined || r.workflow_id === workflowId) &&
        (requirementId === undefined || r.requirement_id === requirementId),
    );
  }
  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    return this.runs.get(runId);
  }
  async upsertRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, run);
  }
}

test("WorkflowStore interface is implementable; CRUD round-trips", async () => {
  const store = new FakeStore();
  const def = newWorkflowDefinition("recipe");

  assert.deepEqual(await store.list(), []);
  await store.upsert(def);
  assert.deepEqual(await store.get(def.id), def);
  assert.equal((await store.list()).length, 1);

  const run = newWorkflowRun(def.id, "req-1");
  await store.upsertRun(run);
  assert.deepEqual(await store.getRun(run.id), run);
  assert.equal((await store.listRuns(def.id, undefined)).length, 1);
  assert.equal((await store.listRuns(undefined, "req-1")).length, 1);
  assert.equal((await store.listRuns("other", undefined)).length, 0);

  assert.equal(await store.delete(def.id), true);
  assert.equal(await store.delete(def.id), false);
  assert.equal(await store.get(def.id), undefined);
});

test("WorkflowError.empty matches the Rust #[error] text", () => {
  const e = WorkflowError.empty();
  assert.ok(e instanceof WorkflowError);
  assert.ok(e instanceof Error);
  assert.equal(e.kind, "empty");
  assert.equal(e.message, "workflow must contain at least one agent step");
  assert.equal(e.name, "WorkflowError");
});

test("WorkflowError.emptyPrompt interpolates the step name", () => {
  const e = WorkflowError.emptyPrompt("research");
  assert.equal(e.kind, "empty_prompt");
  assert.equal(e.message, "agent step 'research' has an empty prompt");
});
