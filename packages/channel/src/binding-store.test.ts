import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newChannelBinding } from "./binding.ts";
import type { ChannelBinding } from "./binding.ts";
import type { ChannelBindingStore } from "./store.ts";
import { JsonFileChannelBindingStore, MemoryChannelBindingStore } from "./binding-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-chan-binding-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Binding with a forced `updated_at` so newest-first ordering is deterministic. */
function bind(
  channel: string,
  chatId: string,
  convId: string,
  updatedAt: string,
): ChannelBinding {
  const b = newChannelBinding(channel, chatId, convId);
  b.updated_at = updatedAt;
  return b;
}

function contract(name: string, make: (dir: string) => Promise<ChannelBindingStore>): void {
  test(`${name}: upsert then lookup by (channel, chat_id)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "conv-1", "2026-06-16T10:00:00.000Z"));
      const found = await store.lookup("wecom", "g1");
      assert.equal(found?.conversation_id, "conv-1");
      assert.equal(await store.lookup("wecom", "nope"), undefined);
      assert.equal(await store.lookup("feishu", "g1"), undefined);
    });
  });

  test(`${name}: upsert overwrites the same (channel, chat_id) key in place`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "conv-old", "2026-06-16T10:00:00.000Z"));
      await store.upsert(bind("wecom", "g1", "conv-new", "2026-06-16T11:00:00.000Z"));
      const found = await store.lookup("wecom", "g1");
      assert.equal(found?.conversation_id, "conv-new");
      assert.equal((await store.listForChannel("wecom")).length, 1);
    });
  });

  test(`${name}: listForChannel scopes by channel, newest-first by updated_at`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "c1", "2026-06-16T10:00:00.000Z"));
      await store.upsert(bind("wecom", "g2", "c2", "2026-06-16T12:00:00.000Z"));
      await store.upsert(bind("wecom", "g3", "c3", "2026-06-16T11:00:00.000Z"));
      await store.upsert(bind("feishu", "f1", "c4", "2026-06-16T13:00:00.000Z"));
      const rows = await store.listForChannel("wecom");
      assert.deepEqual(
        rows.map((r) => r.channel_chat_id),
        ["g2", "g3", "g1"],
      );
      assert.equal((await store.listForChannel("feishu")).length, 1);
      assert.deepEqual(await store.listForChannel("dingtalk"), []);
    });
  });

  test(`${name}: delete removes one key, returns whether a row went`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "c1", "2026-06-16T10:00:00.000Z"));
      assert.equal(await store.delete("wecom", "g1"), true);
      assert.equal(await store.lookup("wecom", "g1"), undefined);
      // Idempotent: second delete is a no-op.
      assert.equal(await store.delete("wecom", "g1"), false);
    });
  });

  test(`${name}: deleteForConversation removes every binding for a conversation`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "shared", "2026-06-16T10:00:00.000Z"));
      await store.upsert(bind("feishu", "f1", "shared", "2026-06-16T10:00:00.000Z"));
      await store.upsert(bind("wecom", "g2", "other", "2026-06-16T10:00:00.000Z"));
      const removed = await store.deleteForConversation("shared");
      assert.equal(removed, 2);
      assert.equal(await store.lookup("wecom", "g1"), undefined);
      assert.equal(await store.lookup("feishu", "f1"), undefined);
      assert.equal((await store.lookup("wecom", "g2"))?.conversation_id, "other");
      // No-op when nothing matches.
      assert.equal(await store.deleteForConversation("shared"), 0);
    });
  });

  test(`${name}: lookup returns a defensive copy, not the live row`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.upsert(bind("wecom", "g1", "c1", "2026-06-16T10:00:00.000Z"));
      const found = await store.lookup("wecom", "g1");
      assert.ok(found);
      found.conversation_id = "mutated";
      const again = await store.lookup("wecom", "g1");
      assert.equal(again?.conversation_id, "c1");
    });
  });
}

contract("json-file", (dir) => JsonFileChannelBindingStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryChannelBindingStore()));

// ---------- JSON-file-specific ----------

test("json-file: bindings persist in channel_bindings.json and survive reopen", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileChannelBindingStore.open(dir);
    await store.upsert(bind("wecom", "g1", "conv-1", "2026-06-16T10:00:00.000Z"));
    await store.upsert(bind("feishu", "f1", "conv-2", "2026-06-16T11:00:00.000Z"));

    // File on disk is a flat array under the fixed filename.
    const raw = await readFile(path.join(dir, "channel_bindings.json"), "utf8");
    const arr = JSON.parse(raw) as ChannelBinding[];
    assert.equal(arr.length, 2);

    const reopened = await JsonFileChannelBindingStore.open(dir);
    assert.equal((await reopened.lookup("wecom", "g1"))?.conversation_id, "conv-1");
    assert.equal((await reopened.lookup("feishu", "f1"))?.conversation_id, "conv-2");
  });
});

test("json-file: concurrent mutations do not lost-update each other (#273)", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileChannelBindingStore.open(dir);
    // Fire many upserts of DISTINCT keys without awaiting between them, so each
    // read-modify-write interleaves across its flush `await`. Pre-fix, the
    // stale-snapshot commit dropped every mutation but the last; the #writeChain
    // serialises them so all survive — in memory and on disk.
    const n = 25;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.upsert(bind("wecom", `g${i}`, `c${i}`, "2026-06-16T10:00:00.000Z")),
      ),
    );
    assert.equal((await store.listForChannel("wecom")).length, n, "no in-memory lost update");
    const reopened = await JsonFileChannelBindingStore.open(dir);
    assert.equal((await reopened.listForChannel("wecom")).length, n, "no on-disk lost update");

    // A delete racing the upserts is serialised too: remove half concurrently.
    await Promise.all(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? store.delete("wecom", `g${i}`) : Promise.resolve(false))));
    const remaining = await store.listForChannel("wecom");
    assert.equal(remaining.length, Math.floor(n / 2));
  });
});

test("json-file: a corrupt file starts the store empty", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "channel_bindings.json"), "{ not json", "utf8");
    const store = await JsonFileChannelBindingStore.open(dir);
    assert.deepEqual(await store.listForChannel("wecom"), []);
    // And it remains writable afterwards.
    await store.upsert(bind("wecom", "g1", "c1", "2026-06-16T10:00:00.000Z"));
    assert.equal((await store.lookup("wecom", "g1"))?.conversation_id, "c1");
  });
});
