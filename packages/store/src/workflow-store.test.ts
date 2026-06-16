import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  newWorkflowDefinition,
  newWorkflowRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStore,
} from "@jarvis/workflow";
import { JsonFileWorkflowStore, MemoryWorkflowStore } from "./workflow-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-workflow-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function def(name: string): WorkflowDefinition {
  return newWorkflowDefinition(name);
}

// Stagger updated_at so newest-first ordering is observable (ISO strings sort
// lexicographically). Bumps to "now + ms" rather than sleeping.
function withUpdatedAt(d: WorkflowDefinition, iso: string): WorkflowDefinition {
  return { ...d, updated_at: iso };
}

function withStartedAt(r: WorkflowRun, iso: string): WorkflowRun {
  return { ...r, started_at: iso };
}

// A shared contract both backends must satisfy.
function contractTests(name: string, make: (dir: string) => Promise<WorkflowStore>): void {
  test(`${name}: definition CRUD round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const d = def("ship-feature");

      assert.deepEqual(await store.list(), []);
      assert.equal(await store.get(d.id), undefined);

      await store.upsert(d);
      assert.deepEqual(await store.get(d.id), d);
      assert.equal((await store.list()).length, 1);

      // Last-write-wins overwrite.
      const updated = { ...d, name: "renamed" };
      await store.upsert(updated);
      assert.equal((await store.get(d.id))?.name, "renamed");
      assert.equal((await store.list()).length, 1);
    });
  });

  test(`${name}: definition delete returns true then false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const d = def("x");
      await store.upsert(d);
      assert.equal(await store.delete(d.id), true);
      assert.equal(await store.delete(d.id), false);
      assert.equal(await store.get(d.id), undefined);
    });
  });

  test(`${name}: list is newest-first by updated_at`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(withUpdatedAt(def("a"), "2026-01-01T00:00:00.000Z"));
      await store.upsert(withUpdatedAt(def("b"), "2026-03-01T00:00:00.000Z"));
      await store.upsert(withUpdatedAt(def("c"), "2026-02-01T00:00:00.000Z"));
      const names = (await store.list()).map((d) => d.name);
      assert.deepEqual(names, ["b", "c", "a"]);
    });
  });

  test(`${name}: run CRUD round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const run = newWorkflowRun("wf-1", "req-1");

      assert.equal(await store.getRun(run.id), undefined);
      await store.upsertRun(run);
      assert.deepEqual(await store.getRun(run.id), run);

      // Overwrite (status transition).
      const finished = { ...run, status: "succeeded" as const };
      await store.upsertRun(finished);
      assert.equal((await store.getRun(run.id))?.status, "succeeded");
    });
  });

  test(`${name}: listRuns filters by workflow / requirement`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r1 = newWorkflowRun("wf-1", "req-1");
      const r2 = newWorkflowRun("wf-1", undefined);
      const r3 = newWorkflowRun("wf-2", "req-1");
      await store.upsertRun(r1);
      await store.upsertRun(r2);
      await store.upsertRun(r3);

      assert.equal((await store.listRuns(undefined, undefined)).length, 3);
      assert.equal((await store.listRuns("wf-1", undefined)).length, 2);
      assert.equal((await store.listRuns("wf-2", undefined)).length, 1);
      assert.equal((await store.listRuns(undefined, "req-1")).length, 2);
      assert.equal((await store.listRuns("wf-1", "req-1")).length, 1);
      assert.equal((await store.listRuns("nope", undefined)).length, 0);
      // ad-hoc run (no requirement_id) must not match a requirement filter.
      assert.equal((await store.listRuns("wf-1", "req-2")).length, 0);
    });
  });

  test(`${name}: listRuns is newest-first by started_at`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsertRun(withStartedAt(newWorkflowRun("wf-1", undefined), "2026-01-01T00:00:00.000Z"));
      await store.upsertRun(withStartedAt(newWorkflowRun("wf-1", undefined), "2026-03-01T00:00:00.000Z"));
      await store.upsertRun(withStartedAt(newWorkflowRun("wf-1", undefined), "2026-02-01T00:00:00.000Z"));
      const started = (await store.listRuns("wf-1", undefined)).map((r) => r.started_at);
      assert.deepEqual(started, [
        "2026-03-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ]);
    });
  });

  test(`${name}: definitions and runs are stored independently`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const d = def("recipe");
      const run = newWorkflowRun(d.id, undefined);
      await store.upsert(d);
      await store.upsertRun(run);
      // Deleting the definition leaves the run; getRun by a definition id is undefined.
      assert.equal(await store.delete(d.id), true);
      assert.equal(await store.getRun(run.id) !== undefined, true);
      assert.equal(await store.getRun(d.id), undefined);
      assert.equal(await store.get(run.id), undefined);
    });
  });
}

contractTests("json-file", (dir) => JsonFileWorkflowStore.open(dir));
contractTests("memory", () => Promise.resolve(new MemoryWorkflowStore()));

// ---------- JSON-file-specific ----------

test("json-file: definitions and runs land in separate subdirs", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileWorkflowStore.open(dir);
    const d = def("recipe");
    const run = newWorkflowRun(d.id, undefined);
    await store.upsert(d);
    await store.upsertRun(run);

    const defFiles = await readdir(path.join(dir, "workflows"));
    const runFiles = await readdir(path.join(dir, "workflow_runs"));
    assert.ok(defFiles.includes(`${d.id}.json`));
    assert.ok(runFiles.includes(`${run.id}.json`));
  });
});

test("json-file: survives reopen (persisted to disk)", async () => {
  await withTempDir(async (dir) => {
    const d = def("persisted");
    const run = newWorkflowRun(d.id, "req-7");
    {
      const store = await JsonFileWorkflowStore.open(dir);
      await store.upsert(d);
      await store.upsertRun(run);
    }
    const reopened = await JsonFileWorkflowStore.open(dir);
    assert.deepEqual(await reopened.get(d.id), d);
    assert.deepEqual(await reopened.getRun(run.id), run);
    assert.equal((await reopened.listRuns("nope", undefined)).length, 0);
  });
});

test("json-file: empty store lists empty (subdirs absent)", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileWorkflowStore.open(dir);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.listRuns(undefined, undefined), []);
  });
});

test("memory: stored rows are isolated from later caller mutation", async () => {
  const store = new MemoryWorkflowStore();
  const d = def("recipe");
  await store.upsert(d);
  d.name = "mutated-after-upsert";
  assert.equal((await store.get(d.id))?.name, "recipe");
});
