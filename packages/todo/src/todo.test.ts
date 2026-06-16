import { test } from "node:test";
import assert from "node:assert/strict";

import {
  budgetActive,
  countMutation,
  MAX_MUTATIONS_PER_TURN,
  newTodoItem,
  todoDeletedEvent,
  todoEventWorkspace,
  todoPriorityFromWire,
  todoStatusFromWire,
  todoUpsertedEvent,
  touchTodoItem,
  withTurnBudget,
  type TodoEvent,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "./index.ts";

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

// ---------- value types ----------

test("todoStatusFromWire round-trips every status; rejects garbage", () => {
  const all: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled", "blocked"];
  for (const s of all) assert.equal(todoStatusFromWire(s), s);
  assert.equal(todoStatusFromWire("nonsense"), undefined);
  assert.equal(todoStatusFromWire("Pending"), undefined, "case-sensitive: matches the snake_case wire form only");
});

test("todoPriorityFromWire round-trips; rejects garbage", () => {
  const all: TodoPriority[] = ["low", "medium", "high"];
  for (const p of all) assert.equal(todoPriorityFromWire(p), p);
  assert.equal(todoPriorityFromWire("urgent"), undefined);
});

test("newTodoItem mints a UUID, defaults status, equal timestamps", () => {
  const t = newTodoItem("/repo", "fix parser");
  assert.equal(t.id.length, 36);
  assert.equal(t.workspace, "/repo");
  assert.equal(t.title, "fix parser");
  assert.equal(t.status, "pending");
  assert.equal(t.priority, undefined);
  assert.equal(t.notes, undefined);
  assert.equal(t.created_at, t.updated_at);
});

test("touchTodoItem bumps updated_at (and only updated_at)", async () => {
  const t = newTodoItem("/repo", "x");
  const created = t.created_at;
  const before = t.updated_at;
  await tick();
  touchTodoItem(t);
  assert.ok(t.updated_at > before, `${t.updated_at} > ${before}`);
  assert.equal(t.created_at, created, "created_at is left alone");
});

test("optional fields are absent (not present-as-undefined) when unset", () => {
  const t = newTodoItem("/r", "x");
  const json = JSON.stringify(t);
  assert.ok(!json.includes("priority"), `priority leaked: ${json}`);
  assert.ok(!json.includes("notes"), `notes leaked: ${json}`);
});

test("a fully-populated TodoItem round-trips through JSON", () => {
  const t = newTodoItem("/r", "x");
  t.notes = "blocked by ticket #5";
  t.status = "blocked";
  t.priority = "high";
  const back = JSON.parse(JSON.stringify(t)) as TodoItem;
  assert.deepEqual(back, t);
});

// ---------- TodoEvent wire shape ----------

test("upserted event inlines the item fields alongside the tag", () => {
  const item = newTodoItem("/repo", "x");
  item.priority = "low";
  const ev = todoUpsertedEvent(item);
  assert.equal(ev.type, "upserted");
  // The item's fields are flattened next to `type` (serde tuple-variant shape).
  assert.equal(todoEventWorkspace(ev), "/repo");
  const obj = JSON.parse(JSON.stringify(ev)) as Record<string, unknown>;
  assert.equal(obj["type"], "upserted");
  assert.equal(obj["id"], item.id);
  assert.equal(obj["title"], "x");
  assert.equal(obj["priority"], "low");
});

test("deleted event carries the workspace key + id", () => {
  const ev: TodoEvent = todoDeletedEvent("/other", "abc-123");
  assert.equal(ev.type, "deleted");
  assert.equal(todoEventWorkspace(ev), "/other");
  assert.deepEqual(JSON.parse(JSON.stringify(ev)), {
    type: "deleted",
    workspace: "/other",
    id: "abc-123",
  });
});

// ---------- per-turn mutation budget ----------

test("budget is inactive outside a scope and never throws", () => {
  assert.equal(budgetActive(), false);
  for (let i = 0; i < MAX_MUTATIONS_PER_TURN + 5; i++) {
    assert.doesNotThrow(() => countMutation());
  }
});

test("budget counts mutations inside a scope; (cap+1)-th throws", async () => {
  await withTurnBudget(async () => {
    assert.equal(budgetActive(), true);
    for (let i = 0; i < MAX_MUTATIONS_PER_TURN; i++) {
      assert.doesNotThrow(() => countMutation());
    }
    assert.throws(() => countMutation(), /per-turn mutation cap/);
  });
});

test("budget resets per scope — siblings don't bleed", async () => {
  // First scope blows the cap.
  await withTurnBudget(async () => {
    for (let i = 0; i < MAX_MUTATIONS_PER_TURN + 1; i++) {
      try {
        countMutation();
      } catch {
        // expected once the cap is hit
      }
    }
  });
  // Second scope is independent — the first call is fine again.
  await withTurnBudget(async () => {
    assert.doesNotThrow(() => countMutation());
  });
  // And we're back outside any scope.
  assert.equal(budgetActive(), false);
});

test("concurrent budget scopes don't share a counter", async () => {
  // Two scopes running interleaved must each get their own count.
  await Promise.all([
    withTurnBudget(async () => {
      await tick();
      assert.doesNotThrow(() => countMutation());
    }),
    withTurnBudget(async () => {
      for (let i = 0; i < MAX_MUTATIONS_PER_TURN; i++) countMutation();
      assert.throws(() => countMutation(), /per-turn mutation cap/);
    }),
  ]);
});
