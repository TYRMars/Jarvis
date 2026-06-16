import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryTodoStore } from "@jarvis/todo";
import type { TodoStore } from "@jarvis/todo";
import { registerTodosRoutes } from "./todos-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** A non-existent root so canonicalizeWorkspace falls back to the literal. */
const ROOT = "/tmp/todos-routes-test-ws";

/** AppState with the todo store wired (or absent) + a pinned workspace root. */
function makeState(opts: { todos?: boolean; root?: boolean } = {}): AppState {
  const todos: TodoStore | undefined = opts.todos === false ? undefined : new MemoryTodoStore();
  return {
    createAgent: agentUnused,
    todos,
    workspaceRoot: opts.root === false ? undefined : ROOT,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerTodosRoutes(app, state);
  await app.ready();
  return app;
}

test("todo routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ todos: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/todos" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "x" } })).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/todos/t1", payload: { title: "y" } })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/todos/t1" })).statusCode, 503);
  await app.close();
});

test("GET 400 when no workspace pinned and none passed", async () => {
  const app = await buildApp(makeState({ root: false }));
  const res = await app.inject({ method: "GET", url: "/v1/todos" });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("POST 400 when no workspace pinned and none in body", async () => {
  const app = await buildApp(makeState({ root: false }));
  const res = await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "x" } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("create then list round-trip; patch; delete; second delete 404", async () => {
  const app = await buildApp(makeState());

  // Create.
  const created = await app.inject({
    method: "POST",
    url: "/v1/todos",
    payload: { title: "refactor parser" },
  });
  assert.equal(created.statusCode, 201);
  const item = created.json() as { id: string; title: string; status: string };
  assert.equal(item.title, "refactor parser");
  assert.equal(item.status, "pending");
  const id = item.id;
  assert.ok(id.length > 0);

  // List (default workspace = pinned root).
  const listed = await app.inject({ method: "GET", url: "/v1/todos" });
  assert.equal(listed.statusCode, 200);
  const list = listed.json() as { workspace: string; items: unknown[] };
  assert.equal(list.items.length, 1);
  assert.equal(list.workspace, ROOT);

  // Patch (mark completed + set priority + add a note).
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/todos/${id}`,
    payload: { status: "completed", priority: "high", notes: "  done  " },
  });
  assert.equal(patched.statusCode, 200);
  const updated = patched.json() as { status: string; priority: string; notes: string };
  assert.equal(updated.status, "completed");
  assert.equal(updated.priority, "high");
  assert.equal(updated.notes, "done");

  // Patch clears priority + notes with blank strings.
  const cleared = await app.inject({
    method: "PATCH",
    url: `/v1/todos/${id}`,
    payload: { priority: "", notes: "" },
  });
  assert.equal(cleared.statusCode, 200);
  const clearedItem = cleared.json() as { priority?: string; notes?: string };
  assert.equal(clearedItem.priority, undefined);
  assert.equal(clearedItem.notes, undefined);

  // Delete.
  const deleted = await app.inject({ method: "DELETE", url: `/v1/todos/${id}` });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { deleted: true });

  // Second delete → 404.
  const again = await app.inject({ method: "DELETE", url: `/v1/todos/${id}` });
  assert.equal(again.statusCode, 404);
  assert.equal((again.json() as { deleted: boolean }).deleted, false);
});

test("create rejects blank title", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "   " } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("create rejects unknown status / priority", async () => {
  const app = await buildApp(makeState());
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "x", status: "nope" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "x", priority: "urgent" } }))
      .statusCode,
    400,
  );
  await app.close();
});

test("patch unknown id returns 404", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/todos/no-such-id",
    payload: { title: "x" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("patch rejects blank title + unknown status", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({ method: "POST", url: "/v1/todos", payload: { title: "keep" } });
  const id = (created.json() as { id: string }).id;
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/todos/${id}`, payload: { title: "  " } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/todos/${id}`, payload: { status: "bogus" } }))
      .statusCode,
    400,
  );
  await app.close();
});

test("create honours explicit workspace override in body", async () => {
  const app = await buildApp(makeState({ root: false }));
  const created = await app.inject({
    method: "POST",
    url: "/v1/todos",
    payload: { title: "scoped", workspace: "/tmp/other-ws" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal((created.json() as { workspace: string }).workspace, "/tmp/other-ws");

  // List scoped to that workspace returns it; the default (no root) is a 400.
  const listed = await app.inject({ method: "GET", url: "/v1/todos?workspace=/tmp/other-ws" });
  assert.equal(listed.statusCode, 200);
  assert.equal((listed.json() as { items: unknown[] }).items.length, 1);
  await app.close();
});
