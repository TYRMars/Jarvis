import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { makeMemoryStores } from "@jarvis/store";
import type { Activity } from "@jarvis/project";
import { registerCommentsRoutes } from "./comments-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** AppState with the comment + activity stores wired (or selectively absent). */
function makeState(opts: { comments?: boolean; activities?: boolean } = {}): AppState {
  const stores = makeMemoryStores();
  return {
    createAgent: agentUnused,
    comments: opts.comments === false ? undefined : stores.comments,
    activities: opts.activities === false ? undefined : stores.activities,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerCommentsRoutes(app, state);
  await app.ready();
  return app;
}

test("comments routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ comments: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/requirements/r1/comments" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "hi" } }))
      .statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/comments/c1?requirement_id=r1", payload: { body: "x" } }))
      .statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/comments/c1?requirement_id=r1" })).statusCode,
    503,
  );
  await app.close();
});

test("POST creates a top-level comment, lists oldest-first, emits Activity", async () => {
  const state = makeState();
  const app = await buildApp(state);

  const created = await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "  first comment  " },
  });
  assert.equal(created.statusCode, 201);
  const c = created.json();
  assert.equal(c.body, "first comment"); // trimmed
  assert.equal(c.requirement_id, "r1");
  assert.deepEqual(c.author, { type: "human" });
  assert.ok(!("parent_id" in c)); // top-level: no parent

  const list = await app.inject({ method: "GET", url: "/v1/requirements/r1/comments" });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.requirement_id, "r1");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, c.id);

  // Activity emitted for the post
  const acts: Activity[] = await state.activities!.listForRequirement("r1");
  assert.equal(acts.length, 1);
  assert.equal(acts[0]!.kind, "comment");
  assert.equal((acts[0]!.body as { action: string }).action, "posted");
  assert.equal((acts[0]!.body as { preview: string }).preview, "first comment");
  await app.close();
});

test("POST a reply threads under the parent", async () => {
  const app = await buildApp(makeState());
  const parent = (
    await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "parent" } })
  ).json();
  const reply = await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "child", parent_id: parent.id },
  });
  assert.equal(reply.statusCode, 201);
  assert.equal(reply.json().parent_id, parent.id);
  await app.close();
});

test("POST rejects empty body (400) and over-cap body (400)", async () => {
  const app = await buildApp(makeState());
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "   " } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: {} })).statusCode,
    400,
  );
  const huge = "a".repeat(32 * 1024 + 1);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: huge } }))
      .statusCode,
    400,
  );
  await app.close();
});

test("POST a reply to a non-existent parent → 400 (store depth/not-found check)", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "child", parent_id: "missing" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /not found/);
  await app.close();
});

test("POST a reply to a reply → 400 (depth 1 limit)", async () => {
  const app = await buildApp(makeState());
  const parent = (
    await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "p" } })
  ).json();
  const child = (
    await app.inject({
      method: "POST",
      url: "/v1/requirements/r1/comments",
      payload: { body: "c", parent_id: parent.id },
    })
  ).json();
  const grand = await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "g", parent_id: child.id },
  });
  assert.equal(grand.statusCode, 400);
  assert.match(grand.json().error, /depth 1/);
  await app.close();
});

test("PATCH edits body, bumps updated_at, emits Activity", async () => {
  const state = makeState();
  const app = await buildApp(state);
  const created = (
    await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "before" } })
  ).json();

  const edited = await app.inject({
    method: "PATCH",
    url: `/v1/comments/${created.id}?requirement_id=r1`,
    payload: { body: "after" },
  });
  assert.equal(edited.statusCode, 200);
  const body = edited.json();
  assert.equal(body.body, "after");
  assert.equal(body.id, created.id);
  // author preserved from the stored row (not the placeholder)
  assert.deepEqual(body.author, { type: "human" });

  const acts = await state.activities!.listForRequirement("r1");
  assert.ok(acts.some((a) => (a.body as { action: string }).action === "edited"));
  await app.close();
});

test("PATCH 400 without requirement_id query, 400 on empty body, 404 on missing id", async () => {
  const app = await buildApp(makeState());
  // missing requirement_id
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/comments/c1", payload: { body: "x" } })).statusCode,
    400,
  );
  // empty body
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/v1/comments/c1?requirement_id=r1",
        payload: { body: "   " },
      })
    ).statusCode,
    400,
  );
  // unknown comment id
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/comments/nope?requirement_id=r1",
    payload: { body: "x" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("DELETE removes a comment (+ replies), 404 when absent, requires requirement_id", async () => {
  const state = makeState();
  const app = await buildApp(state);
  const parent = (
    await app.inject({ method: "POST", url: "/v1/requirements/r1/comments", payload: { body: "p" } })
  ).json();
  await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "c", parent_id: parent.id },
  });

  // missing requirement_id query → 400
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/comments/${parent.id}` })).statusCode, 400);

  const del = await app.inject({ method: "DELETE", url: `/v1/comments/${parent.id}?requirement_id=r1` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  // cascade: both gone
  const list = await app.inject({ method: "GET", url: "/v1/requirements/r1/comments" });
  assert.equal(list.json().items.length, 0);

  // delete-activity emitted
  const acts = await state.activities!.listForRequirement("r1");
  assert.ok(acts.some((a) => (a.body as { action: string }).action === "deleted"));

  // second delete → 404
  const again = await app.inject({ method: "DELETE", url: `/v1/comments/${parent.id}?requirement_id=r1` });
  assert.equal(again.statusCode, 404);
  await app.close();
});

test("mutations succeed without an ActivityStore (best-effort emit is a no-op)", async () => {
  const app = await buildApp(makeState({ activities: false }));
  const created = await app.inject({
    method: "POST",
    url: "/v1/requirements/r1/comments",
    payload: { body: "hi" },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  const del = await app.inject({ method: "DELETE", url: `/v1/comments/${id}?requirement_id=r1` });
  assert.equal(del.statusCode, 200);
  await app.close();
});
