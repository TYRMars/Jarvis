import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newActivity, type Activity, type ActivityEvent, type ActivityStore } from "@jarvis/project";
import { JsonFileActivityStore, MemoryActivityStore } from "./activity-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-activity-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `created_at` is wall-clock-derived in newActivity(); force a known value so
// the newest-first ordering assertion is deterministic.
function act(requirementId: string, createdAt: string, body: unknown = {}): Activity {
  const a = newActivity(requirementId, "status_change", { type: "human" }, body as Activity["body"]);
  a.created_at = createdAt;
  return a;
}

function contract(name: string, make: (dir: string) => Promise<ActivityStore>): void {
  test(`${name}: append then list (newest-first)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.append(act("r1", "2026-06-16T10:00:00.000Z"));
      await store.append(act("r1", "2026-06-16T12:00:00.000Z"));
      await store.append(act("r1", "2026-06-16T11:00:00.000Z"));
      const rows = await store.listForRequirement("r1");
      assert.deepEqual(
        rows.map((r) => r.created_at),
        ["2026-06-16T12:00:00.000Z", "2026-06-16T11:00:00.000Z", "2026-06-16T10:00:00.000Z"],
      );
    });
  });

  test(`${name}: list scopes by requirement; unknown is empty`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.append(act("r1", "2026-06-16T10:00:00.000Z"));
      await store.append(act("r2", "2026-06-16T10:00:00.000Z"));
      assert.equal((await store.listForRequirement("r1")).length, 1);
      assert.equal((await store.listForRequirement("r2")).length, 1);
      assert.deepEqual(await store.listForRequirement("nope"), []);
    });
  });

  test(`${name}: append emits an "appended" event with flattened fields`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: ActivityEvent[] = [];
      const unsub = store.subscribe((e) => seen.push(e));
      const a = act("r1", "2026-06-16T10:00:00.000Z", { foo: "bar" });
      await store.append(a);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.type, "appended");
      assert.equal(seen[0]?.id, a.id);
      assert.equal(seen[0]?.requirement_id, "r1");
      assert.deepEqual(seen[0]?.body, { foo: "bar" });
      // Unsubscribe stops delivery.
      unsub();
      await store.append(act("r1", "2026-06-16T11:00:00.000Z"));
      assert.equal(seen.length, 1);
    });
  });
}

contract("json-file", (dir) => JsonFileActivityStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryActivityStore()));

// ---------- JSON-file-specific ----------

test("json-file: rows persist under activities/<reqId>/ and survive reopen", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileActivityStore.open(dir);
    const a = act("r1", "2026-06-16T10:00:00.000Z");
    await store.append(a);
    const files = await readdir(path.join(dir, "activities", "r1"));
    assert.deepEqual(files, [`${a.id}.json`]);
    // Reopen: data is on disk, not just in memory.
    const reopened = await JsonFileActivityStore.open(dir);
    assert.equal((await reopened.listForRequirement("r1")).length, 1);
  });
});
