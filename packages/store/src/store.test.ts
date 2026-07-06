import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newConversation, userMessage, type Conversation } from "@jarvis/core";
import { JsonFileConversationStore, atomicWrite, encodeId } from "./json-file.ts";
import { readFile } from "node:fs/promises";
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

// ---------- atomicWrite ----------

test("atomicWrite: concurrent writes to one target don't corrupt each other (#359)", async () => {
  // A fixed `<path>.tmp` name let two concurrent writers truncate & interleave
  // the same temp file, then race their renames into ENOENT. Each write now
  // uses a unique temp name, so the target must always end as one writer's
  // whole, valid payload — never mixed bytes, never a thrown ENOENT.
  await withTempDir(async (dir) => {
    const target = path.join(dir, "target.json");
    const payloads = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ writer: i, blob: String(i).repeat(1000) }),
    );
    await Promise.all(payloads.map((p) => atomicWrite(target, p)));
    const finalBytes = await readFile(target, "utf8");
    // The surviving content must be exactly one writer's payload (valid JSON),
    // proving no interleaving of two writers into one temp file.
    const parsed = JSON.parse(finalBytes) as { writer: number };
    assert.ok(payloads.includes(finalBytes), "final file is exactly one writer's whole payload");
    assert.ok(parsed.writer >= 0 && parsed.writer < 20);
    // No temp files should be left behind after all writes settle.
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no leftover temp files");
  });
});
