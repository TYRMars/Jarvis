import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newChannelInstance } from "./instance.ts";
import type { ChannelInstance } from "./instance.ts";
import type { ChannelInstanceStore } from "./store.ts";
import { JsonFileChannelInstanceStore, MemoryChannelInstanceStore } from "./instance-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-chan-instance-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Instance with a forced id + `updated_at` for deterministic ordering. */
function inst(id: string, displayName: string, updatedAt: string): ChannelInstance {
  const i = newChannelInstance("wecom_webhook", displayName, {});
  i.id = id;
  i.updated_at = updatedAt;
  return i;
}

function contract(name: string, make: (dir: string) => Promise<ChannelInstanceStore>): void {
  test(`${name}: upsert then get by id`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "prod-alerts", "2026-06-16T10:00:00.000Z"));
      assert.equal((await store.get("i1"))?.display_name, "prod-alerts");
      assert.equal(await store.get("nope"), undefined);
    });
  });

  test(`${name}: upsert overwrites the same id in place`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "old-name", "2026-06-16T10:00:00.000Z"));
      await store.upsert(inst("i1", "new-name", "2026-06-16T11:00:00.000Z"));
      assert.equal((await store.get("i1"))?.display_name, "new-name");
      assert.equal((await store.list()).length, 1);
    });
  });

  test(`${name}: list returns every row newest-first by updated_at`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "a", "2026-06-16T10:00:00.000Z"));
      await store.upsert(inst("i2", "b", "2026-06-16T12:00:00.000Z"));
      await store.upsert(inst("i3", "c", "2026-06-16T11:00:00.000Z"));
      const rows = await store.list();
      assert.deepEqual(
        rows.map((r) => r.id),
        ["i2", "i3", "i1"],
      );
    });
  });

  test(`${name}: duplicate display_name is allowed (no uniqueness on label)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "alerts", "2026-06-16T10:00:00.000Z"));
      await store.upsert(inst("i2", "alerts", "2026-06-16T11:00:00.000Z"));
      assert.equal((await store.list()).length, 2);
    });
  });

  test(`${name}: delete removes by id, returns whether a row went`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "a", "2026-06-16T10:00:00.000Z"));
      assert.equal(await store.delete("i1"), true);
      assert.equal(await store.get("i1"), undefined);
      assert.equal(await store.delete("i1"), false);
    });
  });

  test(`${name}: get returns a defensive copy`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(inst("i1", "a", "2026-06-16T10:00:00.000Z"));
      const got = await store.get("i1");
      assert.ok(got);
      got.display_name = "mutated";
      assert.equal((await store.get("i1"))?.display_name, "a");
    });
  });
}

contract("json-file", (dir) => JsonFileChannelInstanceStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryChannelInstanceStore()));

// ---------- JSON-file-specific ----------

test("json-file: instances persist in channel_instances.json and survive reopen", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileChannelInstanceStore.open(dir);
    await store.upsert(inst("i1", "prod-alerts", "2026-06-16T10:00:00.000Z"));

    const raw = await readFile(path.join(dir, "channel_instances.json"), "utf8");
    const arr = JSON.parse(raw) as ChannelInstance[];
    assert.equal(arr.length, 1);
    assert.equal(arr[0]?.id, "i1");

    const reopened = await JsonFileChannelInstanceStore.open(dir);
    assert.equal((await reopened.get("i1"))?.display_name, "prod-alerts");
  });
});

test("json-file: a corrupt file starts the store empty but writable", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "channel_instances.json"), "not json at all", "utf8");
    const store = await JsonFileChannelInstanceStore.open(dir);
    assert.deepEqual(await store.list(), []);
    await store.upsert(inst("i1", "a", "2026-06-16T10:00:00.000Z"));
    assert.equal((await store.get("i1"))?.display_name, "a");
  });
});
