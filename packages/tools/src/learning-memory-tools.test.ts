// Unit tests for the `learning.memory.*` tool family. Ported from the
// `#[cfg(test)] mod tests` block in crates/harness-tools/src/learning_memory.rs.
//
// Uses MemoryMemoryStore from @jarvis/learning as the fixture (the row-based
// MemoryStore in-memory backend). Deterministic — no clocks/IDs are asserted
// directly except for non-emptiness and round-trip identity.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue, Tool } from "@jarvis/core";
import { MemoryMemoryStore } from "@jarvis/learning";
import type { MemoryStore } from "@jarvis/learning";

import {
  LearningMemoryAddTool,
  LearningMemoryDeleteTool,
  LearningMemoryListTool,
  LearningMemoryUpdateTool,
} from "./learning-memory-tools.ts";

function store(): MemoryStore {
  return new MemoryMemoryStore();
}

function parse(out: string): { [k: string]: JsonValue } {
  return JSON.parse(out) as { [k: string]: JsonValue };
}

function items(out: string): JsonValue[] {
  const v = parse(out);
  return v["items"] as JsonValue[];
}

function item(out: string): { [k: string]: JsonValue } {
  const v = parse(out);
  return v["item"] as { [k: string]: JsonValue };
}

test("add_then_list_then_delete_roundtrip", async () => {
  const s = store();
  const add = new LearningMemoryAddTool(s);
  const list = new LearningMemoryListTool(s);
  const del = new LearningMemoryDeleteTool(s);

  const addOut = await add.invoke({
    title: "Be terse",
    body: "answer in ≤3 sentences",
    kind: "preference",
    tags: ["style"],
    pinned: true,
  });
  const added = item(addOut);
  const id = added["id"] as string;
  assert.ok(typeof id === "string" && id !== "");
  // Tools write agent-source rows.
  assert.equal((added["source"] as { kind: string }).kind, "agent");
  assert.equal(added["pinned"], true);

  // List returns the single row.
  const listed = items(await list.invoke({}));
  assert.equal(listed.length, 1);

  // Filter by pinned=false → empty.
  const unpinned = items(await list.invoke({ pinned: false }));
  assert.equal(unpinned.length, 0);

  // Delete idempotency.
  const del1 = parse(await del.invoke({ id }));
  assert.equal(del1["deleted"], true);
  const del2 = parse(await del.invoke({ id }));
  assert.equal(del2["deleted"], false);
});

test("update_patches_title_and_pin", async () => {
  const s = store();
  const add = new LearningMemoryAddTool(s);
  const upd = new LearningMemoryUpdateTool(s);

  const added = item(await add.invoke({ title: "old", body: "b", kind: "fact" }));
  const id = added["id"] as string;

  const updated = item(await upd.invoke({ id, title: "new", pinned: true }));
  assert.equal(updated["title"], "new");
  assert.equal(updated["pinned"], true);
  // Unchanged.
  assert.equal(updated["body"], "b");
  assert.equal(updated["kind"], "fact");
});

test("add_rejects_empty_title", async () => {
  const s = store();
  const add = new LearningMemoryAddTool(s);
  await assert.rejects(
    () => add.invoke({ title: "   ", body: "b" }),
    (e: Error) => e.message.toLowerCase().includes("title"),
  );
});

test("update_rejects_empty_body", async () => {
  const s = store();
  const add = new LearningMemoryAddTool(s);
  const upd = new LearningMemoryUpdateTool(s);

  const added = item(await add.invoke({ title: "t", body: "b" }));
  const id = added["id"] as string;

  await assert.rejects(
    () => upd.invoke({ id, body: "   " }),
    (e: Error) => e.message.toLowerCase().includes("body"),
  );
});

test("update_loses_to_concurrent_delete", async () => {
  // A row deleted between the agent reading it and patching it must NOT be
  // resurrected — `update` reports the id is gone and the store stays empty.
  const s = store();
  const add = new LearningMemoryAddTool(s);
  const upd = new LearningMemoryUpdateTool(s);
  const del = new LearningMemoryDeleteTool(s);
  const list = new LearningMemoryListTool(s);

  const added = item(await add.invoke({ title: "t", body: "b" }));
  const id = added["id"] as string;

  assert.equal(parse(await del.invoke({ id }))["deleted"], true);

  await assert.rejects(
    () => upd.invoke({ id, title: "zombie" }),
    (e: Error) => e.message.includes(id),
  );

  const listed = items(await list.invoke({}));
  assert.equal(listed.length, 0, "deleted row not resurrected by the racing update");
});

test("update_errors_on_unknown_id", async () => {
  const s = store();
  const upd = new LearningMemoryUpdateTool(s);
  await assert.rejects(
    () => upd.invoke({ id: "ghost", title: "x" }),
    (e: Error) => e.message.includes("ghost"),
  );
});

test("delete_requires_approval", () => {
  const s = store();
  assert.equal(new LearningMemoryDeleteTool(s).requiresApproval, true);
});

test("list_does_not_require_approval", () => {
  const s = store();
  // `requiresApproval` is an optional Tool member that defaults to false; the
  // list tool leaves it unset (falsy).
  const tool: Tool = new LearningMemoryListTool(s);
  assert.ok(!tool.requiresApproval);
});

test("add_rejects_unknown_kind", async () => {
  // Mirrors the Rust `serde_json::from_value` error path on an invalid enum.
  const s = store();
  const add = new LearningMemoryAddTool(s);
  await assert.rejects(
    () => add.invoke({ title: "t", body: "b", kind: "bogus" }),
    (e: Error) => e.message.toLowerCase().includes("kind"),
  );
});

test("list_caps_limit_at_200", async () => {
  // An over-cap `limit` is clamped to 200, not passed through verbatim.
  const s = store();
  const add = new LearningMemoryAddTool(s);
  const list = new LearningMemoryListTool(s);
  await add.invoke({ title: "t", body: "b" });
  // 1 row regardless; the assertion is that the call succeeds with a huge
  // limit (the clamp keeps the filter well-formed).
  const listed = items(await list.invoke({ limit: 100000 }));
  assert.equal(listed.length, 1);
});
