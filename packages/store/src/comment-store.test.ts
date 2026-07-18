import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  editComment,
  newComment,
  replyComment,
  type Comment,
  type CommentEvent,
  type CommentStore,
} from "@jarvis/project";
import { JsonFileCommentStore, MemoryCommentStore } from "./comment-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-comment-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function top(requirementId: string, createdAt: string, body = "hi"): Comment {
  const c = newComment(requirementId, { type: "human" }, body);
  c.created_at = createdAt;
  c.updated_at = createdAt;
  return c;
}

export function contract(name: string, make: (dir: string) => Promise<CommentStore>): void {
  test(`${name}: create then list (oldest-first / chat order)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.create(top("r1", "2026-06-16T12:00:00.000Z", "second"));
      await store.create(top("r1", "2026-06-16T10:00:00.000Z", "first"));
      const rows = await store.listForRequirement("r1");
      assert.deepEqual(
        rows.map((r) => r.body),
        ["first", "second"],
      );
      assert.deepEqual(await store.listForRequirement("other"), []);
    });
  });

  test(`${name}: create broadcasts "posted"`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: CommentEvent[] = [];
      store.subscribe((e) => seen.push(e));
      const c = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(c);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.type, "posted");
      assert.equal((seen[0] as Comment).id, c.id);
    });
  });

  test(`${name}: a throwing listener neither rejects create nor starves later listeners`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: CommentEvent[] = [];
      store.subscribe(() => {
        throw new Error("boom");
      });
      store.subscribe((e) => seen.push(e));
      await assert.doesNotReject(store.create(top("r1", "2026-06-16T10:00:00.000Z")));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.type, "posted");
    });
  });

  test(`${name}: reply to a top-level comment is allowed`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const parent = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(parent);
      const reply = replyComment("r1", { type: "human" }, "re", parent.id);
      reply.created_at = "2026-06-16T11:00:00.000Z";
      reply.updated_at = "2026-06-16T11:00:00.000Z";
      await store.create(reply);
      assert.equal((await store.listForRequirement("r1")).length, 2);
    });
  });

  test(`${name}: reply to a missing parent is rejected`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const reply = replyComment("r1", { type: "human" }, "re", "ghost");
      await assert.rejects(() => store.create(reply), /parent comment `ghost` not found/);
    });
  });

  test(`${name}: depth-1 invariant — reply to a reply is rejected`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const parent = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(parent);
      const reply = replyComment("r1", { type: "human" }, "re", parent.id);
      await store.create(reply);
      const nested = replyComment("r1", { type: "human" }, "nested", reply.id);
      await assert.rejects(() => store.create(nested), /threading is limited to depth 1/);
    });
  });

  test(`${name}: duplicate id on create is rejected`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const c = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(c);
      await assert.rejects(() => store.create(c), /already exists/);
    });
  });

  test(`${name}: update mutates body + updated_at, pins the rest; absent → false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const c = top("r1", "2026-06-16T10:00:00.000Z", "v1");
      await store.create(c);
      const seen: CommentEvent[] = [];
      store.subscribe((e) => seen.push(e));
      c.updated_at = "2026-06-16T13:00:00.000Z"; // caller-set; store writes it verbatim
      editComment(c, "v2"); // bumps body; would also touch updated_at — re-pin below
      c.updated_at = "2026-06-16T13:00:00.000Z";
      assert.equal(await store.update(c), true);
      const [row] = await store.listForRequirement("r1");
      assert.equal(row?.body, "v2");
      assert.equal(row?.created_at, "2026-06-16T10:00:00.000Z"); // pinned
      assert.equal(row?.updated_at, "2026-06-16T13:00:00.000Z"); // taken from patch
      assert.equal(seen.at(-1)?.type, "edited");

      const missing = top("r1", "2026-06-16T10:00:00.000Z");
      assert.equal(await store.update(missing), false);
    });
  });

  test(`${name}: update with a mismatched requirement_id is a no-op (false, row untouched)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const c = top("r1", "2026-06-16T10:00:00.000Z", "v1");
      await store.create(c);
      // Right id, wrong requirement_id — the store keys on (id, requirement_id),
      // so this must resolve to false and leave the row body intact.
      const patch: Comment = { ...c, requirement_id: "WRONG", body: "hacked" };
      assert.equal(await store.update(patch), false);
      const [row] = await store.listForRequirement("r1");
      assert.equal(row?.body, "v1", "body must not change on a mismatched-requirement update");
    });
  });

  test(`${name}: delete cascades a top-level comment's replies, broadcasting each`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const parent = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(parent);
      const reply = replyComment("r1", { type: "human" }, "re", parent.id);
      reply.created_at = "2026-06-16T11:00:00.000Z";
      reply.updated_at = "2026-06-16T11:00:00.000Z";
      await store.create(reply);
      const deleted: string[] = [];
      store.subscribe((e) => {
        if (e.type === "deleted") deleted.push(e.comment_id);
      });
      assert.equal(await store.delete("r1", parent.id), true);
      assert.deepEqual(await store.listForRequirement("r1"), []);
      assert.equal(deleted.length, 2);
      assert.ok(deleted.includes(parent.id) && deleted.includes(reply.id));
      // Idempotent: deleting again is false.
      assert.equal(await store.delete("r1", parent.id), false);
    });
  });

  test(`${name}: deleting a reply leaves the parent intact`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const parent = top("r1", "2026-06-16T10:00:00.000Z");
      await store.create(parent);
      const reply = replyComment("r1", { type: "human" }, "re", parent.id);
      await store.create(reply);
      assert.equal(await store.delete("r1", reply.id), true);
      const rows = await store.listForRequirement("r1");
      assert.deepEqual(rows.map((r) => r.id), [parent.id]);
    });
  });
}

contract("json-file", (dir) => JsonFileCommentStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryCommentStore()));
