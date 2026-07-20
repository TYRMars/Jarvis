import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  JsonFileWorkspaceStore,
  MAX_RECENT,
  MemoryWorkspaceStore,
  type WorkspaceStore,
} from "./workspace-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-ws-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Stagger `last_used_at` so the timestamps differ between touches. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

// A shared contract every backend must satisfy.
export function contract(name: string, make: (dir: string) => Promise<WorkspaceStore>): void {
  test(`${name}: touch inserts and promotes (newest-first)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.deepEqual(await store.listRecent(), []);

      const a = await store.touch("/work/alpha");
      await tick();
      const b = await store.touch("/work/beta");
      assert.equal(a, "/work/alpha");
      assert.equal(b, "/work/beta");

      let recent = await store.listRecent();
      assert.equal(recent.length, 2);
      assert.equal(recent[0]?.path, "/work/beta", "newest first");
      assert.equal(recent[1]?.path, "/work/alpha");
      // Name defaults to the basename.
      assert.equal(recent[0]?.name, "beta");

      // Re-touching alpha moves it back to the front (no dupe).
      await tick();
      await store.touch("/work/alpha");
      recent = await store.listRecent();
      assert.equal(recent.length, 2, "dedupes by path");
      assert.equal(recent[0]?.path, "/work/alpha");
      assert.equal(recent[1]?.path, "/work/beta");
    });
  });

  test(`${name}: touch accepts an explicit name`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.touch("/work/proj-1", "My Project");
      const e = await store.get("/work/proj-1");
      assert.equal(e?.name, "My Project");
    });
  });

  test(`${name}: get returns one entry or undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.touch("/work/alpha");
      assert.equal((await store.get("/work/alpha"))?.path, "/work/alpha");
      assert.equal(await store.get("/work/missing"), undefined);
    });
  });

  test(`${name}: forget drops the entry (idempotent)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.touch("/work/alpha");
      await store.forget("/work/alpha");
      assert.deepEqual(await store.listRecent(), []);
      // Idempotent: forgetting an absent path is a no-op.
      await store.forget("/work/alpha");
      assert.deepEqual(await store.listRecent(), []);
    });
  });

  test(`${name}: bind / lookup / unbind round-trip`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.equal(await store.lookup("conv-1"), undefined);
      await store.bind("conv-1", "/work/alpha");
      assert.equal(await store.lookup("conv-1"), "/work/alpha");
      // Re-bind overwrites.
      await store.bind("conv-1", "/work/beta");
      assert.equal(await store.lookup("conv-1"), "/work/beta");
      await store.unbind("conv-1");
      assert.equal(await store.lookup("conv-1"), undefined);
      // Unbinding an absent id is a no-op.
      await store.unbind("conv-1");
    });
  });

  test(`${name}: caps recent at MAX_RECENT`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      for (let i = 0; i < MAX_RECENT + 5; i++) {
        await store.touch(`/work/p${i}`);
      }
      const recent = await store.listRecent();
      assert.equal(recent.length, MAX_RECENT);
      // The newest touch (`/work/p${MAX_RECENT + 4}`) survives; the oldest are pruned.
      assert.equal(recent[0]?.path, `/work/p${MAX_RECENT + 4}`);
      assert.equal(await store.get("/work/p0"), undefined, "oldest pruned");
    });
  });
}

contract("json-file", (dir) => JsonFileWorkspaceStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryWorkspaceStore()));

// ---------- JSON-file-specific ----------

test("json-file: persists recent + bindings across reopen", async () => {
  await withTempDir(async (dir) => {
    {
      const s1 = await JsonFileWorkspaceStore.open(dir);
      await s1.touch("/work/alpha");
      await s1.bind("c-1", "/work/alpha");
    }
    const s2 = await JsonFileWorkspaceStore.open(dir);
    assert.deepEqual((await s2.listRecent()).map((e) => e.path), ["/work/alpha"]);
    assert.equal(await s2.lookup("c-1"), "/work/alpha");
  });
});

test("json-file: writes a single workspaces.json under the workspaces/ subdir", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileWorkspaceStore.open(dir);
    await store.touch("/work/alpha", "Alpha");
    await store.bind("c-1", "/work/alpha");
    // #469: the registry lives in its own subdir, NOT flat in `dir` where the
    // conversation store keeps its `<id>.json` rows.
    const raw = await readFile(path.join(dir, "workspaces", "workspaces.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      recent: { path: string; name: string }[];
      by_conversation: Record<string, string>;
    };
    assert.equal(parsed.recent[0]?.path, "/work/alpha");
    assert.equal(parsed.recent[0]?.name, "Alpha");
    assert.equal(parsed.by_conversation["c-1"], "/work/alpha");
    // Nothing is written flat into the base dir.
    await assert.rejects(readFile(path.join(dir, "workspaces.json"), "utf8"));
  });
});

test("json-file: missing file opens to an empty registry", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileWorkspaceStore.open(dir);
    assert.deepEqual(await store.listRecent(), []);
    assert.equal(await store.lookup("anything"), undefined);
  });
});

test("json-file: migrates a legacy flat workspaces.json and removes it (#469)", async () => {
  await withTempDir(async (dir) => {
    // Simulate a registry written by an older build directly into the base dir.
    await writeFile(
      path.join(dir, "workspaces.json"),
      JSON.stringify({ recent: [{ path: "/work/legacy", name: "legacy" }], by_conversation: { "c-1": "/work/legacy" } }),
    );

    const store = await JsonFileWorkspaceStore.open(dir);
    assert.deepEqual((await store.listRecent()).map((e) => e.path), ["/work/legacy"], "legacy recent migrated");
    assert.equal(await store.lookup("c-1"), "/work/legacy", "legacy binding migrated");

    // The colliding flat file is gone; the registry now lives in the subdir.
    await assert.rejects(readFile(path.join(dir, "workspaces.json"), "utf8"), "flat file removed");
    await readFile(path.join(dir, "workspaces", "workspaces.json"), "utf8");
  });
});
