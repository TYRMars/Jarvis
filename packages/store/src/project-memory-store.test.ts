import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  newProjectMemory,
  touchProjectMemory,
  type ProjectMemory,
  type ProjectMemoryStore,
} from "@jarvis/project";
import { JsonFileProjectMemoryStore, MemoryProjectMemoryStore } from "./project-memory-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-pmem-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Stagger `updated_at` so RFC-3339 strings sort deterministically. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

// A shared contract both backends must satisfy.
export function contractTests(name: string, make: (dir: string) => Promise<ProjectMemoryStore>): void {
  test(`${name}: upsert/get round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const m = newProjectMemory("p1", "lesson", "title", "body");
      await store.upsert(m);
      assert.deepEqual(await store.get(m.id), m);
      assert.equal(await store.get("missing"), undefined);
    });
  });

  test(`${name}: list scopes by project, newest-first`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a1 = newProjectMemory("p1", "lesson", "a1", "x");
      await store.upsert(a1);
      await tick();
      const a2 = newProjectMemory("p1", "gotcha", "a2", "y");
      await store.upsert(a2);
      await tick();
      const b1 = newProjectMemory("p2", "context", "b1", "z");
      await store.upsert(b1);

      const p1 = await store.list("p1");
      assert.deepEqual(p1.map((m) => m.id), [a2.id, a1.id]);
      const p2 = await store.list("p2");
      assert.deepEqual(p2.map((m) => m.id), [b1.id]);
      assert.deepEqual(await store.list("none"), []);
    });
  });

  test(`${name}: upsert overwrites by id, does not bump updated_at on its own`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const m = newProjectMemory("p1", "lesson", "title", "v1");
      await store.upsert(m);
      const before = (await store.get(m.id))!;

      // Re-upsert the same row unchanged: store must NOT mutate updated_at.
      await store.upsert(m);
      assert.equal((await store.get(m.id))?.updated_at, before.updated_at);

      // Caller-driven edit: touch then upsert.
      await tick();
      m.body = "v2";
      touchProjectMemory(m);
      await store.upsert(m);
      const after = (await store.get(m.id))!;
      assert.equal(after.body, "v2");
      assert.ok(after.updated_at > before.updated_at);
      // Still one row for the project.
      assert.equal((await store.list("p1")).length, 1);
    });
  });

  test(`${name}: delete returns true then false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const m = newProjectMemory("p1", "lesson", "t", "b");
      await store.upsert(m);
      assert.equal(await store.delete(m.id), true);
      assert.equal(await store.delete(m.id), false);
      assert.equal(await store.get(m.id), undefined);
      assert.deepEqual(await store.list("p1"), []);
    });
  });

  test(`${name}: source + tags fields persist`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const m = newProjectMemory("p1", "lesson", "t", "b");
      m.tags = ["ci", "flaky"];
      m.source_run_id = "run-1";
      m.source_requirement_id = "req-1";
      await store.upsert(m);
      const got = (await store.get(m.id)) as ProjectMemory;
      assert.deepEqual(got.tags, ["ci", "flaky"]);
      assert.equal(got.source_run_id, "run-1");
      assert.equal(got.source_requirement_id, "req-1");
    });
  });
}

contractTests("json-file", (dir) => JsonFileProjectMemoryStore.open(dir));
contractTests("memory", () => Promise.resolve(new MemoryProjectMemoryStore()));

// ---------- JSON-file-specific ----------

test("json-file: one file per id under project-memories/", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileProjectMemoryStore.open(dir);
    const m = newProjectMemory("p1", "lesson", "t", "b");
    await store.upsert(m);
    const files = await readdir(path.join(dir, "project-memories"));
    assert.ok(files.includes(`${m.id}.json`));
  });
});

test("json-file: survives reopen (durable)", async () => {
  await withTempDir(async (dir) => {
    const s1 = await JsonFileProjectMemoryStore.open(dir);
    const m = newProjectMemory("p1", "lesson", "persisted", "b");
    await s1.upsert(m);
    const s2 = await JsonFileProjectMemoryStore.open(dir);
    assert.equal((await s2.get(m.id))?.title, "persisted");
    assert.deepEqual((await s2.list("p1")).map((x) => x.id), [m.id]);
  });
});
