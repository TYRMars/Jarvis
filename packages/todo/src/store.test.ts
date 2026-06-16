import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  JsonFileTodoStore,
  MemoryTodoStore,
  newTodoItem,
  type TodoEvent,
  type TodoItem,
  type TodoStore,
} from "./index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-todo-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function todo(workspace: string, title: string): TodoItem {
  return newTodoItem(workspace, title);
}

// Both backends are exercised through this shared contract.
type Backend = JsonFileTodoStore | MemoryTodoStore;

function contract(name: string, make: (dir: string) => Promise<Backend>): void {
  test(`${name}: upsert/get round-trips; missing → undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const t = todo("/repo", "do a thing");
      await store.upsert(t);
      assert.equal((await store.get(t.id))?.title, "do a thing");
      assert.equal(await store.get("missing"), undefined);
    });
  });

  test(`${name}: get is global (not workspace-scoped)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const t = todo("/somewhere/deep", "x");
      await store.upsert(t);
      // No workspace hint needed — id is globally unique.
      assert.equal((await store.get(t.id))?.workspace, "/somewhere/deep");
    });
  });

  test(`${name}: list scopes to a workspace, newest-updated first`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = todo("/r1", "a");
      await store.upsert(a);
      await tick();
      const b = todo("/r1", "b");
      await store.upsert(b);
      await tick();
      const other = todo("/r2", "other");
      await store.upsert(other);

      assert.deepEqual(
        (await store.list("/r1")).map((t) => t.title),
        ["b", "a"],
        "newest-first, scoped to /r1",
      );
      assert.deepEqual((await store.list("/r2")).map((t) => t.title), ["other"]);
      assert.deepEqual(await store.list("/empty"), []);
    });
  });

  test(`${name}: upsert overwrites in place (no duplicate row)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const t = todo("/r1", "v1");
      await store.upsert(t);
      const updated: TodoItem = { ...t, title: "v2", status: "in_progress" };
      await store.upsert(updated);
      const rows = await store.list("/r1");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, "v2");
      assert.equal(rows[0]!.status, "in_progress");
    });
  });

  test(`${name}: delete is hard + idempotent (false on absent)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const t = todo("/r1", "gone");
      await store.upsert(t);
      assert.equal(await store.delete("never-existed"), false);
      assert.equal(await store.delete(t.id), true);
      assert.equal(await store.get(t.id), undefined);
      assert.deepEqual(await store.list("/r1"), []);
      assert.equal(await store.delete(t.id), false, "second delete is a no-op");
    });
  });

  test(`${name}: subscribe sees upserted + deleted; deleted only on the true path`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: TodoEvent[] = [];
      const off = store.subscribe((ev) => seen.push(ev));

      const t = todo("/r1", "x");
      await store.upsert(t);
      assert.equal(await store.delete("never-existed"), false);
      assert.equal(await store.delete(t.id), true);

      assert.deepEqual(
        seen.map((e) => e.type),
        ["upserted", "deleted"],
        "no event for a no-op delete",
      );
      const del = seen[1]!;
      assert.equal(del.type === "deleted" && del.workspace, "/r1");
      assert.equal(del.type === "deleted" && del.id, t.id);

      off();
      await store.upsert(todo("/r1", "after-off"));
      assert.equal(seen.length, 2, "unsubscribed listener stops receiving");
    });
  });

  test(`${name}: upserted broadcast inlines the item fields`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: TodoEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      const t = todo("/r1", "headline");
      t.priority = "high";
      await store.upsert(t);
      const ev = seen[0]!;
      assert.equal(ev.type, "upserted");
      assert.equal(ev.type === "upserted" && ev.title, "headline");
      assert.equal(ev.type === "upserted" && ev.workspace, "/r1");
      assert.equal(ev.type === "upserted" && ev.priority, "high");
    });
  });
}

contract("json-file", (dir) => JsonFileTodoStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryTodoStore()));

// ---------- JSON-file-only behaviours ----------

test("json-file: workspace path with special chars round-trips (percent-encoded dir)", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileTodoStore.open(dir);
    const weird = "/Users/x/My Repo:v2/sub";
    const t = todo(weird, "x");
    await store.upsert(t);
    // Round-trips through list + get.
    assert.deepEqual((await store.list(weird)).map((r) => r.title), ["x"]);
    assert.equal((await store.get(t.id))?.workspace, weird);
    // On disk the workspace dir name is percent-encoded (no raw `:` or space).
    const subdirs = await readdir(path.join(dir, "todos"));
    assert.equal(subdirs.length, 1);
    const name = subdirs[0]!;
    assert.ok(!name.includes(":"), `raw colon leaked into dir name: ${name}`);
    assert.ok(!name.includes(" "), `raw space leaked into dir name: ${name}`);
  });
});

test("json-file: list ignores .tmp + unparseable files", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileTodoStore.open(dir);
    const t = todo("/r1", "real");
    await store.upsert(t);
    // Drop a stray .json.tmp and a junk file in the same workspace dir.
    const { writeFile } = await import("node:fs/promises");
    const wsDir = (await readdir(path.join(dir, "todos")))[0]!;
    const base = path.join(dir, "todos", wsDir);
    await writeFile(path.join(base, "stray.json.tmp"), "{}");
    await writeFile(path.join(base, "garbage.json"), "not json at all");
    const rows = await store.list("/r1");
    assert.deepEqual(rows.map((r) => r.title), ["real"]);
  });
});

test("json-file: survives a reopen (persistence)", async () => {
  await withTempDir(async (dir) => {
    const s1 = await JsonFileTodoStore.open(dir);
    const t = todo("/r1", "persisted");
    await s1.upsert(t);
    const s2 = await JsonFileTodoStore.open(dir);
    assert.equal((await s2.get(t.id))?.title, "persisted");
    assert.deepEqual((await s2.list("/r1")).map((r) => r.title), ["persisted"]);
  });
});

// ---------- trait surface ----------

test("TodoStore trait surface compiles for both backends", async () => {
  const mem: TodoStore = new MemoryTodoStore();
  const t = newTodoItem("/r1", "trait");
  await mem.upsert(t);
  assert.equal((await mem.get(t.id))?.title, "trait");
});
