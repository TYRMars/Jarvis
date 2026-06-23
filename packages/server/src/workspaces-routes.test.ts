import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryWorkspaceStore } from "@jarvis/store";
import type { WorkspaceStore } from "@jarvis/store";
import { registerWorkspacesRoutes } from "./workspaces-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** AppState with the workspaces registry wired (or absent). */
function makeState(opts: { workspaces?: boolean } = {}): AppState {
  const workspaces: WorkspaceStore | undefined =
    opts.workspaces === false ? undefined : new MemoryWorkspaceStore();
  return { createAgent: agentUnused, workspaces };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerWorkspacesRoutes(app, state);
  await app.ready();
  return app;
}

interface RecentResp {
  recent: { path: string; name: string; last_used_at: string }[];
}

test("workspaces routes 503 when no registry is configured", async () => {
  const app = await buildApp(makeState({ workspaces: false }));
  for (const url of ["/v1/workspaces", "/v1/workspaces/touch"]) {
    const res = await app.inject({ method: "POST", url, payload: { path: "/work/a" } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "workspaces registry not configured" });
  }
  assert.equal((await app.inject({ method: "GET", url: "/v1/workspaces" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/workspaces?path=/work/a" })).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/workspaces/forget?path=/work/a" })).statusCode,
    503,
  );
  await app.close();
});

test("empty list is []", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/workspaces" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { workspaces: [] });
  await app.close();
});

test("touch inserts + promotes; list is newest-first", async () => {
  const app = await buildApp(makeState());

  // Touch alpha, then beta — beta is newer so it sorts first.
  const a = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { path: "/work/alpha" } });
  assert.equal(a.statusCode, 200);
  const aBody = a.json() as { path: string } & RecentResp;
  assert.equal(aBody.path, "/work/alpha");
  assert.deepEqual(aBody.recent.map((e) => e.path), ["/work/alpha"]);
  assert.equal(aBody.recent[0]?.name, "alpha");

  await app.inject({ method: "POST", url: "/v1/workspaces/touch", payload: { path: "/work/beta" } });

  // Re-touch alpha → promoted back to front.
  const promoted = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { path: "/work/alpha" },
  });
  const promotedBody = promoted.json() as RecentResp;
  assert.deepEqual(promotedBody.recent.map((e) => e.path), ["/work/alpha", "/work/beta"]);

  // GET reflects the same order (note: list keys the array as `workspaces`,
  // matching the Rust `{ "workspaces": list_recent() }` shape).
  const listed = await app.inject({ method: "GET", url: "/v1/workspaces" });
  assert.deepEqual(
    (listed.json() as { workspaces: { path: string }[] }).workspaces.map((e) => e.path),
    ["/work/alpha", "/work/beta"],
  );

  await app.close();
});

test("touch rejects a non-string path with 400", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { path: 42 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("forget drops a recent path; idempotent; both aliases", async () => {
  const app = await buildApp(makeState());
  await app.inject({ method: "POST", url: "/v1/workspaces", payload: { path: "/work/alpha" } });
  await app.inject({ method: "POST", url: "/v1/workspaces", payload: { path: "/work/beta" } });

  // Forget alpha via the query form on the base path.
  const forgotten = await app.inject({
    method: "DELETE",
    url: "/v1/workspaces?path=/work/alpha",
  });
  assert.equal(forgotten.statusCode, 200);
  const body = forgotten.json() as { deleted: boolean } & RecentResp;
  assert.equal(body.deleted, true);
  assert.deepEqual(body.recent.map((e) => e.path), ["/work/beta"]);

  // Idempotent: forgetting again is still { deleted: true }.
  const again = await app.inject({ method: "DELETE", url: "/v1/workspaces?path=/work/alpha" });
  assert.equal(again.statusCode, 200);
  assert.equal((again.json() as { deleted: boolean }).deleted, true);

  // The /forget alias works the same way.
  const aliased = await app.inject({
    method: "DELETE",
    url: "/v1/workspaces/forget?path=/work/beta",
  });
  assert.equal(aliased.statusCode, 200);
  assert.deepEqual((aliased.json() as RecentResp).recent, []);

  await app.close();
});

test("forget requires a path query parameter (400)", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "DELETE", url: "/v1/workspaces" });
  assert.equal(res.statusCode, 400);
  await app.close();
});

/**
 * A backend whose `touch` always throws — stands in for a disk-write /
 * SQLite failure. Input validation has already passed by the time `touch`
 * is called, so the only thing left to fail is the store I/O.
 */
class FailingTouchStore extends MemoryWorkspaceStore {
  override touch(): Promise<string> {
    return Promise.reject(new Error("disk write failed"));
  }
}

test("touch surfaces a backend/I-O failure as 500, not 400", async () => {
  const app = await buildApp({ createAgent: agentUnused, workspaces: new FailingTouchStore() });
  const res = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { path: "/work/alpha" },
  });
  // A store fault is a server-side condition: it must map to 500 (matching
  // the sibling GET/DELETE handlers), not 400 — a 400 would mislabel an infra
  // failure as bad client input and confuse monitoring/alerting.
  assert.equal(res.statusCode, 500);
  assert.equal((res.json() as { error: string }).error, "disk write failed");
  await app.close();
});
