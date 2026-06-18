// Unit tests for the `todo.*` tool family. Ported from the
// `#[cfg(test)] mod tests` block in crates/harness-tools/src/todo.rs.
//
// Uses MemoryTodoStore from @jarvis/todo as the fixture (the in-process
// TodoStore backend) in place of the Rust inline TestStore. Deterministic —
// no clocks/ids are asserted directly except for non-emptiness.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@jarvis/core";
import { MAX_MUTATIONS_PER_TURN, MemoryTodoStore, withTurnBudget } from "@jarvis/todo";
import type { TodoStore } from "@jarvis/todo";

import { TodoAddTool, TodoDeleteTool, TodoListTool, TodoUpdateTool } from "./todo-tools.ts";

function store(): TodoStore {
  return new MemoryTodoStore();
}

function parse(out: string): { [k: string]: JsonValue } {
  return JSON.parse(out) as { [k: string]: JsonValue };
}

test("add creates item with default status", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  const out = await add.invoke({ title: "fix parser", workspace: "/r" });
  const v = parse(out);
  assert.equal(v["status"], "pending");
  assert.equal(v["title"], "fix parser");
  assert.equal(typeof v["id"], "string");

  const listed = await new TodoListTool(s, "/tmp").invoke({ workspace: "/r" });
  const l = parse(listed);
  assert.equal((l["items"] as JsonValue[]).length, 1);
});

test("add rejects blank title", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  await assert.rejects(
    add.invoke({ title: "   ", workspace: "/r" }),
    (err: Error) => err.message.includes("blank"),
  );
});

test("update changes only provided fields", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  const out = await add.invoke({ title: "x", workspace: "/r", notes: "first" });
  const id = parse(out)["id"] as string;

  const upd = new TodoUpdateTool(s);
  const after = await upd.invoke({ id, status: "completed" });
  const v = parse(after);
  assert.equal(v["status"], "completed");
  assert.equal(v["title"], "x");
  assert.equal(v["notes"], "first");
});

test("update clears notes with empty string", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  const out = await add.invoke({ title: "x", workspace: "/r", notes: "stale" });
  const id = parse(out)["id"] as string;

  const upd = new TodoUpdateTool(s);
  const after = await upd.invoke({ id, notes: "" });
  const v = parse(after);
  assert.ok(v["notes"] === undefined || v["notes"] === null);
});

test("update clears priority with empty string", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  const out = await add.invoke({ title: "x", workspace: "/r", priority: "high" });
  const id = parse(out)["id"] as string;
  assert.equal(parse(out)["priority"], "high");

  const upd = new TodoUpdateTool(s);
  const after = await upd.invoke({ id, priority: "" });
  const v = parse(after);
  assert.ok(v["priority"] === undefined || v["priority"] === null);
});

test("update unknown id errors", async () => {
  const s = store();
  const upd = new TodoUpdateTool(s);
  await assert.rejects(
    upd.invoke({ id: "no-such", title: "y" }),
    (err: Error) => err.message.includes("not found"),
  );
});

test("delete rejects empty ids", async () => {
  const s = store();
  const del = new TodoDeleteTool(s);
  await assert.rejects(
    del.invoke({ ids: [] }),
    (err: Error) => err.message.includes("must not be empty"),
  );
});

test("delete rejects more than cap", async () => {
  const s = store();
  const del = new TodoDeleteTool(s);
  const many = Array.from({ length: MAX_MUTATIONS_PER_TURN + 1 }, (_, i) => `id-${i}`);
  await assert.rejects(
    del.invoke({ ids: many }),
    (err: Error) => err.message.includes("too many"),
  );
});

test("delete returns count", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  const out = await add.invoke({ title: "x", workspace: "/r" });
  const id = parse(out)["id"] as string;

  const del = new TodoDeleteTool(s);
  const res = await del.invoke({ ids: [id, "ghost"] });
  const v = parse(res);
  assert.equal(v["deleted_count"], 1);
});

// The per-turn mutation budget kicks in once the agent loop has scoped
// `withTurnBudget`. Each `todo.add` consumes one slot; after the cap, further
// calls error out (and the model gets a readable error string).
test("add respects per-turn budget", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  await withTurnBudget(async () => {
    // First MAX adds succeed.
    for (let i = 0; i < MAX_MUTATIONS_PER_TURN; i += 1) {
      await add.invoke({ title: `step ${i}`, workspace: "/r" });
    }
    // The next one trips the cap.
    await assert.rejects(
      add.invoke({ title: "one too many", workspace: "/r" }),
      (err: Error) => err.message.includes("per-turn mutation cap"),
    );
  });
});

// Outside `withTurnBudget` scope (e.g. tools driven by REST or tests) the
// budget is a no-op so existing flows aren't broken.
test("add outside budget scope is unbounded", async () => {
  const s = store();
  const add = new TodoAddTool(s, "/tmp");
  // Far past the cap.
  for (let i = 0; i < MAX_MUTATIONS_PER_TURN + 5; i += 1) {
    await add.invoke({ title: `step ${i}`, workspace: "/r" });
  }
});
