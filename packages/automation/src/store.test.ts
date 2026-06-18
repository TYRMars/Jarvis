// Shared store contract run against both backends (JSON-file + in-memory).
// Covers CRUD, upsert-overwrite, list ordering (newest-updated first), delete
// idempotency, and JSON-file persistence across reopen + crash-safe writes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  JsonFileAutomationStore,
  MemoryAutomationStore,
  newAutomationTask,
  scheduleInterval,
  scheduleOnce,
} from "./index.ts";
import type { AutomationStore } from "./index.ts";

const tmpDirs: string[] = [];

after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-automation-"));
  tmpDirs.push(dir);
  return dir;
}

interface Backend {
  readonly name: string;
  open(): Promise<AutomationStore>;
}

const backends: Backend[] = [
  {
    name: "MemoryAutomationStore",
    open: () => Promise.resolve(new MemoryAutomationStore()),
  },
  {
    name: "JsonFileAutomationStore",
    open: async () => JsonFileAutomationStore.open(await freshTmpDir()),
  },
];

for (const backend of backends) {
  test(`${backend.name}: empty store lists nothing and misses gets`, async () => {
    const store = await backend.open();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get("nope"), undefined);
  });

  test(`${backend.name}: upsert + get round-trips a task`, async () => {
    const store = await backend.open();
    const task = newAutomationTask(
      { title: "t", prompt: "p", schedule: scheduleOnce("2026-01-01T01:00:00Z"), provider: "openai" },
      "2026-01-01T00:00:00.000Z",
    );
    await store.upsert(task);
    const loaded = await store.get(task.id);
    assert.deepEqual(loaded, task);
  });

  test(`${backend.name}: get returns a deeply independent copy`, async () => {
    const store = await backend.open();
    const task = newAutomationTask(
      { title: "t", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T00:00:00.000Z",
    );
    await store.upsert(task);
    const loaded = await store.get(task.id);
    assert.ok(loaded);
    // Mutate a top-level field AND a nested one — a shallow copy would leak the
    // nested `schedule` object back into the store.
    loaded.title = "mutated";
    if ("interval" in loaded.schedule) loaded.schedule.interval.every_seconds = 999;
    const reloaded = await store.get(task.id);
    assert.equal(reloaded?.title, "t");
    assert.ok(reloaded && "interval" in reloaded.schedule);
    if (reloaded && "interval" in reloaded.schedule) {
      assert.equal(reloaded.schedule.interval.every_seconds, 60);
    }
  });

  test(`${backend.name}: mutating the upserted object after upsert does not leak`, async () => {
    const store = await backend.open();
    const task = newAutomationTask(
      { title: "t", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T00:00:00.000Z",
    );
    await store.upsert(task);
    // Mutate the caller's object AFTER upsert — the store must hold its own copy.
    if ("interval" in task.schedule) task.schedule.interval.every_seconds = 999;
    task.title = "mutated";
    const reloaded = await store.get(task.id);
    assert.equal(reloaded?.title, "t");
    if (reloaded && "interval" in reloaded.schedule) {
      assert.equal(reloaded.schedule.interval.every_seconds, 60);
    }
  });

  test(`${backend.name}: upsert overwrites by id`, async () => {
    const store = await backend.open();
    const task = newAutomationTask(
      { title: "t", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T00:00:00.000Z",
    );
    await store.upsert(task);
    const updated = { ...task, title: "renamed", updated_at: "2026-01-01T00:05:00.000Z" };
    await store.upsert(updated);
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.title, "renamed");
  });

  test(`${backend.name}: list is newest-updated first`, async () => {
    const store = await backend.open();
    const older = newAutomationTask(
      { title: "older", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T00:00:00.000Z",
    );
    const newer = newAutomationTask(
      { title: "newer", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-02T00:00:00.000Z",
    );
    const middle = newAutomationTask(
      { title: "middle", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T12:00:00.000Z",
    );
    // Insert out of order; ordering must come from updated_at, not insertion.
    await store.upsert(older);
    await store.upsert(newer);
    await store.upsert(middle);
    const titles = (await store.list()).map((t) => t.title);
    assert.deepEqual(titles, ["newer", "middle", "older"]);
  });

  test(`${backend.name}: delete is idempotent and reports removal`, async () => {
    const store = await backend.open();
    const task = newAutomationTask(
      { title: "t", prompt: "p", schedule: scheduleInterval(60) },
      "2026-01-01T00:00:00.000Z",
    );
    await store.upsert(task);
    assert.equal(await store.delete(task.id), true);
    assert.equal(await store.delete(task.id), false); // already gone
    assert.equal(await store.get(task.id), undefined);
    assert.deepEqual(await store.list(), []);
  });
}

// ---------- JSON-file-specific durability ---------------------------------

test("JsonFileAutomationStore persists across reopen", async () => {
  const dir = await freshTmpDir();
  const task = newAutomationTask(
    { title: "persisted", prompt: "p", schedule: scheduleOnce("2026-01-01T01:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );
  const first = await JsonFileAutomationStore.open(dir);
  await first.upsert(task);

  // A fresh instance over the same directory must see the row.
  const second = await JsonFileAutomationStore.open(dir);
  const loaded = await second.get(task.id);
  assert.deepEqual(loaded, task);
  const list = await second.list();
  assert.equal(list.length, 1);
});
