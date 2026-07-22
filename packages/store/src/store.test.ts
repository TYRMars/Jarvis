import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newConversation, userMessage, type Conversation } from "@jarvis/core";
import { JsonFileConversationStore, encodeId } from "./json-file.ts";
import { MemoryConversationStore } from "./memory.ts";
import { connect } from "./connect.ts";
import { StoreError, type ConversationStore } from "./types.ts";

function convo(content: string): Conversation {
  const c = newConversation();
  c.messages.push(userMessage(content));
  return c;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A shared contract every backend must satisfy. Exported so the SQLite
// backend (sqlite.test.ts) can run the IDENTICAL suite against itself.
export function contractTests(name: string, make: (dir: string) => Promise<ConversationStore>): void {
  test(`${name}: save/load round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.save("c1", convo("hello"));
      const loaded = await store.load("c1");
      assert.equal(loaded?.messages.length, 1);
      assert.equal(await store.load("missing"), undefined);
    });
  });

  test(`${name}: envelope persists project_id + lifecycle`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveEnvelope("c1", convo("hi"), { project_id: "p-1", lifecycle: "archived" });
      const env = await store.loadEnvelope("c1");
      assert.equal(env?.[1].project_id, "p-1");
      assert.equal(env?.[1].lifecycle, "archived");
      const rows = await store.list(10);
      assert.equal(rows[0]?.project_id, "p-1");
      assert.equal(rows[0]?.lifecycle, "archived");
      assert.equal(rows[0]?.message_count, 1);
    });
  });

  test(`${name}: list is newest-first and respects limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      // Stagger updated_at: ISO strings sort lexicographically.
      await store.save("a", convo("a"));
      await new Promise((r) => setTimeout(r, 5));
      await store.save("b", convo("b"));
      await new Promise((r) => setTimeout(r, 5));
      await store.save("c", convo("c"));
      const rows = await store.list(2);
      assert.deepEqual(rows.map((r) => r.id), ["c", "b"]);
    });
  });

  test(`${name}: listByProject filters`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveEnvelope("a", convo("a"), { project_id: "p1", lifecycle: "active" });
      await store.saveEnvelope("b", convo("b"), { project_id: "p2", lifecycle: "active" });
      const rows = await store.listByProject("p1", 10);
      assert.deepEqual(rows.map((r) => r.id), ["a"]);
    });
  });

  test(`${name}: delete returns true then false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.save("c1", convo("x"));
      assert.equal(await store.delete("c1"), true);
      assert.equal(await store.delete("c1"), false);
      assert.equal(await store.load("c1"), undefined);
    });
  });

  test(`${name}: created_at preserved across overwrite, updated_at advances`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.save("c1", convo("v1"));
      const first = (await store.list(1))[0]!;
      await new Promise((r) => setTimeout(r, 5));
      await store.save("c1", convo("v2"));
      const second = (await store.list(1))[0]!;
      assert.equal(second.created_at, first.created_at);
      assert.ok(second.updated_at >= first.updated_at);
    });
  });

  test(`${name}: internal __memory__ ids with ':' round-trip`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const id = "__memory__.summary:abcdef0123456789";
      await store.save(id, convo("summary"));
      assert.equal((await store.load(id))?.messages.length, 1);
      assert.ok((await store.list(10)).some((r) => r.id === id));
    });
  });
}

contractTests("json-file", (dir) => JsonFileConversationStore.open(dir));
contractTests("memory", () => Promise.resolve(new MemoryConversationStore()));

// ---------- JSON-file-specific ----------

test("encodeId percent-encodes ':' as %3A, leaves UUIDs intact", () => {
  assert.equal(encodeId("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(encodeId("__memory__.summary:abc"), "__memory__.summary%3Aabc");
});

test("json-file: ':' id writes a %3A filename on disk", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileConversationStore.open(dir);
    await store.save("__memory__.summary:deadbeef", convo("s"));
    const files = await readdir(dir);
    assert.ok(files.includes("__memory__.summary%3Adeadbeef.json"));
  });
});

// #501: a foreign-but-well-formed JSON file in the base dir (e.g. workspaces.json
// flushed there) must not throw and permanently break the whole listing.
test("json-file: list survives a foreign JSON file of the wrong shape", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileConversationStore.open(dir);
    await store.save("real-convo", convo("hi"));
    // No `messages` array — the old code did `stored.messages.length` and threw.
    await writeFile(path.join(dir, "workspaces.json"), JSON.stringify({ recent: [], by_conversation: {} }));
    const rows = await store.list(50);
    assert.deepEqual(rows.map((r) => r.id), ["real-convo"]);
  });
});

// #502: concurrent writes to the same id must not deterministically ENOENT on
// rename (shared `.tmp`); last-writer-wins, both settle, neither is dropped.
test("json-file: concurrent saves to one id don't drop a write via a shared tmp", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileConversationStore.open(dir);
    await Promise.all([
      store.save("c1", convo("a".repeat(4000))),
      store.save("c1", convo("b")),
    ]);
    // Both resolved without ENOENT; the row is present and readable.
    assert.equal((await store.load("c1"))?.messages.length, 1);
    // No staging litter left behind.
    const leftover = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  });
});

// ---------- connect ----------

test("connect: json:// opens a JSON-file store", async () => {
  await withTempDir(async (dir) => {
    const store = await connect(`json://${dir}`);
    await store.save("c1", convo("via connect"));
    assert.equal((await store.load("c1"))?.messages.length, 1);
  });
});

test("connect: still-unsupported SQL schemes throw, unknown schemes throw", async () => {
  // `sqlite:` is supported now (see sqlite.test.ts); postgres/mysql remain P6.
  await assert.rejects(() => connect("postgres://localhost/db"), StoreError);
  await assert.rejects(() => connect("mysql://localhost/db"), StoreError);
  await assert.rejects(() => connect("redis://localhost"), StoreError);
});

test("connect: empty json path throws", async () => {
  await assert.rejects(() => connect("json:"), StoreError);
});
