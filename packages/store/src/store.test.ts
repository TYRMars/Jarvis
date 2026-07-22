import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newConversation, userMessage, type Conversation } from "@jarvis/core";
import { JsonFileConversationStore, encodeDirComponent, encodeId } from "./json-file.ts";
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

// #501: a foreign-but-parseable JSON file in the base dir must not kill list().
test("json-file: list skips a foreign JSON file instead of throwing", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileConversationStore.open(dir);
    await store.save("real-convo", convo("hi"));
    // e.g. JsonFileWorkspaceStore flushing workspaces.json into the same dir:
    // well-formed JSON, no `messages` array.
    await writeFile(path.join(dir, "workspaces.json"), JSON.stringify({ recent: [], by_conversation: {} }));
    // A row with a non-array `messages` (truncated/foreign) must also be skipped.
    await writeFile(path.join(dir, "junk.json"), JSON.stringify({ id: "junk", messages: null }));
    const rows = await store.list(50);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["real-convo"],
    );
  });
});

// #502: two concurrent writers of the same id must both survive (no ENOENT from
// a shared .tmp losing the rename race); last write wins.
test("json-file: concurrent saves to one id don't ENOENT (last-writer-wins)", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileConversationStore.open(dir);
    const big = (n: number): Conversation => {
      const c = newConversation();
      for (let i = 0; i < n; i++) c.messages.push(userMessage(`m${i}`));
      return c;
    };
    // Rejects (not resolves) here would be the bug — an ENOENT from rename.
    await Promise.all([
      store.saveEnvelope("c1", big(3000), { lifecycle: "active" }),
      store.saveEnvelope("c1", big(10), { lifecycle: "active" }),
    ]);
    const loaded = await store.load("c1");
    // One of the two writes won cleanly; the row is intact, not torn/missing.
    assert.ok(loaded);
    assert.ok(loaded.messages.length === 3000 || loaded.messages.length === 10);
    // No stray staging files left behind.
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
  });
});

// #499: an id that encodeId leaves as `.`/`..`/empty must be rejected before it
// can be joined as a directory component and escape its store partition.
test("encodeDirComponent rejects partition-escaping ids", () => {
  assert.throws(() => encodeDirComponent(".."), StoreError);
  assert.throws(() => encodeDirComponent("."), StoreError);
  assert.throws(() => encodeDirComponent(""), StoreError);
  // Normal ids still pass through exactly like encodeId.
  assert.equal(encodeDirComponent("proj-42"), "proj-42");
  assert.equal(encodeDirComponent("a/b"), encodeId("a/b"));
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
