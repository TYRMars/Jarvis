import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryDocStore } from "@jarvis/store";
import type { DocStore } from "@jarvis/project";
import { registerDocRoutes } from "./doc-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** A non-existent root so canonicalizeWorkspace falls back to the literal. */
const ROOT = "/tmp/doc-routes-test-ws";

/** AppState with the doc store wired (or absent) + a pinned workspace root. */
function makeState(opts: { docs?: boolean; root?: boolean } = {}): AppState {
  const docs: DocStore | undefined = opts.docs === false ? undefined : new MemoryDocStore();
  return {
    createAgent: agentUnused,
    docs,
    workspaceRoot: opts.root === false ? undefined : ROOT,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerDocRoutes(app, state);
  await app.ready();
  return app;
}

test("doc routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ docs: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/doc-projects" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/doc-projects", payload: { title: "x" } })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "GET", url: "/v1/doc-projects/p1" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/doc-projects/p1", payload: {} })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/doc-projects/p1" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/doc-projects/p1/draft" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PUT", url: "/v1/doc-projects/p1/draft", payload: { content: "y" } }))
      .statusCode,
    503,
  );
  await app.close();
});

test("create then list round-trip; draft PUT/GET; delete cascades", async () => {
  const app = await buildApp(makeState());

  // Create.
  const created = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "weekly review", kind: "report" },
  });
  assert.equal(created.statusCode, 201);
  const cv = created.json();
  assert.equal(cv.title, "weekly review");
  assert.equal(cv.kind, "report");
  assert.equal(cv.workspace, ROOT);
  assert.deepEqual(cv.tags, []);
  assert.equal(cv.pinned, false);
  assert.equal(cv.archived, false);
  const id: string = cv.id;
  assert.ok(typeof id === "string" && id.length > 0);

  // List (workspace echoed back + one item).
  const list = await app.inject({ method: "GET", url: "/v1/doc-projects" });
  assert.equal(list.statusCode, 200);
  const lv = list.json();
  assert.equal(lv.workspace, ROOT);
  assert.equal(lv.items.length, 1);
  assert.equal(lv.items[0].id, id);

  // GET one.
  const got = await app.inject({ method: "GET", url: `/v1/doc-projects/${id}` });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().id, id);

  // No draft yet → null body.
  const empty = await app.inject({ method: "GET", url: `/v1/doc-projects/${id}/draft` });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json(), null);

  // PUT draft.
  const putDraft = await app.inject({
    method: "PUT",
    url: `/v1/doc-projects/${id}/draft`,
    payload: { content: "# Hello\n\nbody." },
  });
  assert.equal(putDraft.statusCode, 201);
  const dv = putDraft.json();
  assert.equal(dv.format, "markdown");
  assert.equal(dv.project_id, id);
  assert.ok(dv.content.includes("Hello"));

  // GET draft.
  const draft = await app.inject({ method: "GET", url: `/v1/doc-projects/${id}/draft` });
  assert.equal(draft.statusCode, 200);
  const drv = draft.json();
  assert.equal(drv.format, "markdown");
  assert.ok(drv.content.includes("Hello"));

  // Delete cascades.
  const del = await app.inject({ method: "DELETE", url: `/v1/doc-projects/${id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  // Subsequent draft GET returns null (drafts cascade-deleted).
  const after = await app.inject({ method: "GET", url: `/v1/doc-projects/${id}/draft` });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json(), null);

  // List now empty.
  const list2 = await app.inject({ method: "GET", url: "/v1/doc-projects" });
  assert.equal(list2.json().items.length, 0);

  await app.close();
});

test("list 400s when no workspace pinned and none passed", async () => {
  const app = await buildApp(makeState({ root: false }));
  const res = await app.inject({ method: "GET", url: "/v1/doc-projects" });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("list honours an explicit ?workspace override", async () => {
  const app = await buildApp(makeState({ root: false }));
  // Create under an explicit workspace.
  const created = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "scoped", workspace: "/tmp/doc-routes-test-other" },
  });
  assert.equal(created.statusCode, 201);
  // List under the same explicit workspace finds it.
  const hit = await app.inject({
    method: "GET",
    url: "/v1/doc-projects?workspace=/tmp/doc-routes-test-other",
  });
  assert.equal(hit.statusCode, 200);
  assert.equal(hit.json().items.length, 1);
  // List under a different workspace finds nothing.
  const miss = await app.inject({
    method: "GET",
    url: "/v1/doc-projects?workspace=/tmp/doc-routes-test-elsewhere",
  });
  assert.equal(miss.statusCode, 200);
  assert.equal(miss.json().items.length, 0);
  await app.close();
});

test("create rejects blank title", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "   " },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("create rejects unknown kind", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "t", kind: "novella" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("create 400s when no workspace pinned and none in body", async () => {
  const app = await buildApp(makeState({ root: false }));
  const res = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "t" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("GET unknown project 404s", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/doc-projects/no-such-id" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("PATCH persists tags (trimmed/deduped/order-preserved) + pinned + archived; partial doesn't clobber", async () => {
  const app = await buildApp(makeState());

  const created = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "design doc", kind: "design" },
  });
  const id: string = created.json().id;

  // Patch tags + pin + archive in one shot.
  const patch = await app.inject({
    method: "PATCH",
    url: `/v1/doc-projects/${id}`,
    payload: { tags: ["q3", " q3 ", "ship-ready", ""], pinned: true, archived: true },
  });
  assert.equal(patch.statusCode, 200);
  const pv = patch.json();
  assert.equal(pv.pinned, true);
  assert.equal(pv.archived, true);
  assert.deepEqual(pv.tags, ["q3", "ship-ready"]);

  // Patch with only one field doesn't clobber the others.
  const patch2 = await app.inject({
    method: "PATCH",
    url: `/v1/doc-projects/${id}`,
    payload: { pinned: false },
  });
  assert.equal(patch2.statusCode, 200);
  const p2 = patch2.json();
  assert.equal(p2.pinned, false);
  assert.equal(p2.archived, true);
  assert.deepEqual(p2.tags, ["q3", "ship-ready"]);

  await app.close();
});

test("PATCH rejects blank title and unknown kind", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "t" },
  });
  const id: string = created.json().id;

  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/doc-projects/${id}`, payload: { title: "  " } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/doc-projects/${id}`, payload: { kind: "bogus" } }))
      .statusCode,
    400,
  );
  await app.close();
});

test("PATCH unknown project 404s", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/doc-projects/no-such-id",
    payload: { pinned: true },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("DELETE unknown project 404s with {deleted:false}", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "DELETE", url: "/v1/doc-projects/no-such-id" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().deleted, false);
  await app.close();
});

test("PUT draft on unknown project 404s", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "PUT",
    url: "/v1/doc-projects/no-such-id/draft",
    payload: { content: "x" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("PUT draft rejects missing content", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({
    method: "POST",
    url: "/v1/doc-projects",
    payload: { title: "t" },
  });
  const id: string = created.json().id;
  const res = await app.inject({ method: "PUT", url: `/v1/doc-projects/${id}/draft`, payload: {} });
  assert.equal(res.statusCode, 400);
  await app.close();
});
