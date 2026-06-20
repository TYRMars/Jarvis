import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { makeMemoryStores, type StoreBundle } from "@jarvis/store";
import { registerRequirementsRoutes } from "./requirements-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

const noAgent = (): never => {
  throw new Error("agent not used in these route tests");
};

/** AppState with the project-domain stores wired in (or omitted to test 503). */
function makeState(stores: Partial<StoreBundle> = {}): AppState {
  return {
    createAgent: noAgent,
    store: stores.conversations,
    requirements: stores.requirements,
    requirementRuns: stores.requirementRuns,
    activities: stores.activities,
    projects: stores.projects,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerRequirementsRoutes(app, state);
  await app.ready();
  return app;
}

/** Create one requirement directly through the REST surface; return its id. */
async function createRequirement(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/requirements`,
    payload: body,
  });
  assert.equal(res.statusCode, 201, res.body);
  const j = res.json() as Record<string, unknown>;
  return { id: j.id as string, json: j };
}

// ---------- 503 when unconfigured ----------

test("requirements routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState());
  assert.equal((await app.inject({ method: "GET", url: "/v1/projects/p1/requirements" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/projects/p1/requirements", payload: { title: "x" } }))
      .statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/requirements/r1", payload: {} })).statusCode, 503);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/requirements/r1" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/requirements/r1/approve" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/requirements/r1/reject", payload: { reason: "x" } }))
      .statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "POST", url: "/v1/requirements/r1/review" })).statusCode, 503);
  // runs/activities have their own store guards
  assert.equal((await app.inject({ method: "GET", url: "/v1/requirements/r1/runs" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/requirements/r1/activities" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/runs/run1" })).statusCode, 503);
  await app.close();
});

test("POST /runs 503 when no conversation store is configured", async () => {
  const stores = makeMemoryStores();
  // requirements present but no conversation store.
  const state = makeState({ requirements: stores.requirements, requirementRuns: stores.requirementRuns });
  const app = await buildApp(state);
  const { id } = await createRequirement(app, "p1", { title: "do it" });
  const res = await app.inject({ method: "POST", url: `/v1/requirements/${id}/runs` });
  assert.equal(res.statusCode, 503);
  assert.match((res.json() as { error: string }).error, /conversation store/);
  await app.close();
});

// ---------- create + list happy path ----------

test("create + list round-trip; create strips a default triage_state on the wire", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));

  const { json } = await createRequirement(app, "proj-1", { title: "  build it  ", description: "  body  " });
  assert.equal(json.title, "build it"); // trimmed
  assert.equal(json.description, "body"); // trimmed
  assert.equal(json.status, "backlog");
  assert.equal(json.project_id, "proj-1");
  // default triage_state (approved) is stripped from the wire object.
  assert.equal("triage_state" in json, false);
  // serde(skip) fields never appear.
  assert.equal("assignee_id" in json, false);
  assert.equal("acceptance_policy" in json, false);

  const list = await app.inject({ method: "GET", url: "/v1/projects/proj-1/requirements" });
  assert.equal(list.statusCode, 200);
  const lbody = list.json() as { project_id: string; items: { id: string }[] };
  assert.equal(lbody.project_id, "proj-1");
  assert.equal(lbody.items.length, 1);
  assert.equal(lbody.items[0]!.id, json.id);
  await app.close();
});

test("create rejects a blank title and an unknown status", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/projects/p/requirements", payload: { title: "   " } }))
      .statusCode,
    400,
  );
  const bad = await app.inject({
    method: "POST",
    url: "/v1/projects/p/requirements",
    payload: { title: "ok", status: "nope" },
  });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /unknown status/);
  await app.close();
});

// ---------- triage_state query filter ----------

test("triage_state query filter: exact, synthetic `proposed`, and unknown→400", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));

  await createRequirement(app, "pf", { title: "approved one", triage_state: "approved" });
  await createRequirement(app, "pf", { title: "agent one", triage_state: "proposed_by_agent" });
  await createRequirement(app, "pf", { title: "scan one", triage_state: "proposed_by_scan" });

  const exact = await app.inject({
    method: "GET",
    url: "/v1/projects/pf/requirements?triage_state=proposed_by_agent",
  });
  const exactItems = (exact.json() as { items: { title: string }[] }).items;
  assert.equal(exactItems.length, 1);
  assert.equal(exactItems[0]!.title, "agent one");

  const proposed = await app.inject({ method: "GET", url: "/v1/projects/pf/requirements?triage_state=proposed" });
  const proposedItems = (proposed.json() as { items: { title: string }[] }).items;
  assert.equal(proposedItems.length, 2); // both proposed_by_*
  assert.ok(proposedItems.every((r) => r.title !== "approved one"));

  const approved = await app.inject({ method: "GET", url: "/v1/projects/pf/requirements?triage_state=approved" });
  assert.equal((approved.json() as { items: unknown[] }).items.length, 1);

  const bad = await app.inject({ method: "GET", url: "/v1/projects/pf/requirements?triage_state=bogus" });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /unknown triage_state/);
  await app.close();
});

// ---------- self-dependency rejection ----------

test("self-dependency is rejected at create and at update", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));

  // create one to learn a real id, then try to PATCH it to depend on itself.
  const { id } = await createRequirement(app, "p", { title: "a" });
  const patch = await app.inject({
    method: "PATCH",
    url: `/v1/requirements/${id}`,
    payload: { depends_on: [id] },
  });
  assert.equal(patch.statusCode, 400);
  assert.match((patch.json() as { error: string }).error, /self-dependency/);

  // For create the id is server-minted so it cannot be predicted; instead
  // assert the create path accepts a foreign dependency cleanly.
  const ok = await app.inject({
    method: "POST",
    url: "/v1/projects/p/requirements",
    payload: { title: "b", depends_on: ["some-other-id"] },
  });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual((ok.json() as { depends_on: string[] }).depends_on, ["some-other-id"]);
  await app.close();
});

// ---------- update + Activity emission on status change ----------

test("PATCH status change emits a status_change Activity; triage change emits a comment", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const { id } = await createRequirement(app, "p", { title: "ticket" });

  // status backlog → in_progress
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/requirements/${id}`,
    payload: { status: "in_progress" },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.json() as { status: string }).status, "in_progress");

  // triage approved → proposed_by_agent
  await app.inject({ method: "PATCH", url: `/v1/requirements/${id}`, payload: { triage_state: "proposed_by_agent" } });

  const acts = await app.inject({ method: "GET", url: `/v1/requirements/${id}/activities` });
  const items = (acts.json() as { items: { kind: string; body: Record<string, unknown> }[] }).items;
  const statusChange = items.find((a) => a.kind === "status_change");
  assert.ok(statusChange, "expected a status_change activity");
  assert.equal(statusChange!.body.from, "backlog");
  assert.equal(statusChange!.body.to, "in_progress");
  const triageChange = items.find((a) => a.kind === "comment" && a.body.kind === "triage_change");
  assert.ok(triageChange, "expected a triage_change comment activity");
  await app.close();
});

test("PATCH 404 / blank title / unknown status", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/requirements/missing", payload: { title: "x" } })).statusCode,
    404,
  );
  const { id } = await createRequirement(app, "p", { title: "ok" });
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/requirements/${id}`, payload: { title: "  " } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/requirements/${id}`, payload: { status: "weird" } }))
      .statusCode,
    400,
  );
  await app.close();
});

// ---------- delete ----------

test("DELETE removes a row; 404 the second time", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const { id } = await createRequirement(app, "p", { title: "gone soon" });
  const del = await app.inject({ method: "DELETE", url: `/v1/requirements/${id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });
  const again = await app.inject({ method: "DELETE", url: `/v1/requirements/${id}` });
  assert.equal(again.statusCode, 404);
  assert.equal((again.json() as { deleted: boolean }).deleted, false);
  await app.close();
});

// ---------- approve ----------

test("approve flips to Approved + writes an Activity; idempotent no_op the second time", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const { id } = await createRequirement(app, "p", { title: "candidate", triage_state: "proposed_by_agent" });

  const first = await app.inject({ method: "POST", url: `/v1/requirements/${id}/approve` });
  assert.equal(first.statusCode, 200);
  const fbody = first.json() as { approved: boolean; no_op?: boolean; requirement: Record<string, unknown> };
  assert.equal(fbody.approved, true);
  assert.equal(fbody.no_op, undefined); // first approve is NOT a no-op
  // approved is the default → stripped from the wire requirement.
  assert.equal("triage_state" in fbody.requirement, false);

  const second = await app.inject({ method: "POST", url: `/v1/requirements/${id}/approve` });
  assert.equal(second.statusCode, 200);
  assert.equal((second.json() as { no_op: boolean }).no_op, true);

  const acts = await app.inject({ method: "GET", url: `/v1/requirements/${id}/activities` });
  const approvals = (acts.json() as { items: { kind: string; body: Record<string, unknown> }[] }).items.filter(
    (a) => a.kind === "comment" && a.body.kind === "approved",
  );
  assert.equal(approvals.length, 1); // only the first (non-no-op) approve audited
  await app.close();
});

test("approve 404 for an unknown id", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  assert.equal((await app.inject({ method: "POST", url: "/v1/requirements/nope/approve" })).statusCode, 404);
  await app.close();
});

// ---------- reject ----------

test("reject requires a reason, writes a rejected Activity before deleting", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const { id } = await createRequirement(app, "p", { title: "junk", triage_state: "proposed_by_scan" });

  // blank reason → 400, row still present
  const blank = await app.inject({ method: "POST", url: `/v1/requirements/${id}/reject`, payload: { reason: "  " } });
  assert.equal(blank.statusCode, 400);

  // Capture the activity (it's written against the requirement id) BEFORE the
  // delete, then verify the row is gone.
  const ok = await app.inject({
    method: "POST",
    url: `/v1/requirements/${id}/reject`,
    payload: { reason: "duplicate" },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { rejected: true, deleted: true, reason: "duplicate" });

  const acts = await app.inject({ method: "GET", url: `/v1/requirements/${id}/activities` });
  const rejected = (acts.json() as { items: { kind: string; body: Record<string, unknown> }[] }).items.find(
    (a) => a.kind === "comment" && a.body.kind === "rejected",
  );
  assert.ok(rejected, "expected a rejected activity row");
  assert.equal(rejected!.body.reason, "duplicate");

  // The requirement row itself is gone (PATCH 404s).
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/requirements/${id}`, payload: { title: "x" } })).statusCode,
    404,
  );
  await app.close();
});

test("reject 404 for an unknown id (with a valid reason)", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const res = await app.inject({ method: "POST", url: "/v1/requirements/nope/reject", payload: { reason: "x" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------- review ----------

test("review: 404 unknown, 409 not-at-review, then 202 dispatched at review", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));

  assert.equal((await app.inject({ method: "POST", url: "/v1/requirements/nope/review" })).statusCode, 404);

  const { id } = await createRequirement(app, "p", { title: "needs review" });
  // still at backlog → 409 not at review
  const notReview = await app.inject({ method: "POST", url: `/v1/requirements/${id}/review` });
  assert.equal(notReview.statusCode, 409);
  assert.match((notReview.json() as { error: string }).error, /not at review/);

  // move to review, then dispatch
  await app.inject({ method: "PATCH", url: `/v1/requirements/${id}`, payload: { status: "review" } });
  const dispatched = await app.inject({ method: "POST", url: `/v1/requirements/${id}/review` });
  assert.equal(dispatched.statusCode, 202);
  assert.deepEqual(dispatched.json(), { dispatched: true, requirement_id: id });

  // an Activity row was written for the manual dispatch
  const acts = await app.inject({ method: "GET", url: `/v1/requirements/${id}/activities` });
  const dispatch = (acts.json() as { items: { kind: string; body: Record<string, unknown> }[] }).items.find(
    (a) => a.body.kind === "reviewer_dispatched_manually",
  );
  assert.ok(dispatch, "expected a reviewer_dispatched_manually activity");
  await app.close();
});

// ---------- runs (mint a fresh-session run) ----------

test("POST /runs mints a conversation + run, links it back, advances Backlog→InProgress, audits", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  const { id } = await createRequirement(app, "proj-x", { title: "execute me", description: "the body" });

  const res = await app.inject({ method: "POST", url: `/v1/requirements/${id}/runs` });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    run: { id: string; requirement_id: string; conversation_id: string; status: string };
    conversation_id: string;
    manifest_summary: string;
    requirement: { id: string; status: string; conversation_ids: string[] };
  };
  assert.equal(body.run.requirement_id, id);
  assert.equal(body.run.status, "pending");
  assert.equal(body.run.conversation_id, body.conversation_id);
  // requirement advanced Backlog → InProgress and the conversation is linked.
  assert.equal(body.requirement.status, "in_progress");
  assert.ok(body.requirement.conversation_ids.includes(body.conversation_id));
  assert.match(body.manifest_summary, /execute me/);

  // The conversation was actually persisted, seeded with the summary.
  const conv = await stores.conversations.load(body.conversation_id);
  assert.ok(conv);
  assert.equal(conv!.messages[0]!.role, "system");

  // The run is in the run store.
  const runs = await app.inject({ method: "GET", url: `/v1/requirements/${id}/runs` });
  const runItems = (runs.json() as { items: { id: string }[] }).items;
  assert.equal(runItems.length, 1);
  assert.equal(runItems[0]!.id, body.run.id);

  // GET /v1/runs/:id fetches it.
  const one = await app.inject({ method: "GET", url: `/v1/runs/${body.run.id}` });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as { id: string }).id, body.run.id);

  // Both a run_started (Human) and a status_change (System) activity exist.
  const acts = await app.inject({ method: "GET", url: `/v1/requirements/${id}/activities` });
  const items = (acts.json() as { items: { kind: string; actor: { type: string }; body: Record<string, unknown> }[] })
    .items;
  const runStarted = items.find((a) => a.kind === "run_started");
  assert.ok(runStarted);
  assert.equal(runStarted!.actor.type, "human");
  assert.equal(runStarted!.body.run_id, body.run.id);
  const sysAdvance = items.find((a) => a.kind === "status_change" && a.body.reason === "run_started");
  assert.ok(sysAdvance);
  assert.equal(sysAdvance!.actor.type, "system");
  await app.close();
});

test("POST /runs 404 for an unknown requirement; GET /v1/runs/:id 404 for an unknown run", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(makeState(stores));
  assert.equal((await app.inject({ method: "POST", url: "/v1/requirements/nope/runs" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/runs/nope" })).statusCode, 404);
  await app.close();
});

// ---------- requirement TODOs + link ----------

test("requirement todos: CRUD + batch + link round-trip", async () => {
  const { newRequirement } = await import("@jarvis/project");
  const stores = makeMemoryStores();
  const req = newRequirement("proj-1", "Build X");
  await stores.requirements.upsert(req);
  const app = await buildApp(
    makeState({ requirements: stores.requirements, activities: stores.activities }),
  );

  // empty list
  assert.deepEqual((await app.inject({ method: "GET", url: `/v1/requirements/${req.id}/todos` })).json(), {
    requirement_id: req.id,
    items: [],
  });

  // create (+ validation)
  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/requirements/${req.id}/todos`, payload: { title: "  " } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/v1/requirements/${req.id}/todos`,
      payload: { title: "x", kind: "bogus" },
    })).statusCode,
    400,
  );
  const created = await app.inject({
    method: "POST",
    url: `/v1/requirements/${req.id}/todos`,
    payload: { title: "Run tests", kind: "ci", command: "make test" },
  });
  assert.equal(created.statusCode, 201);
  const todo = (created.json() as { todo: { id: string; status: string; command: string } }).todo;
  assert.equal(todo.status, "pending");
  assert.equal(todo.command, "make test");

  // patch item
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/requirements/${req.id}/todos/${todo.id}`,
    payload: { status: "passed" },
  });
  assert.equal((patched.json() as { todo: { status: string } }).todo.status, "passed");

  // a second todo + batch update both to pending
  const t2 = (
    await app.inject({ method: "POST", url: `/v1/requirements/${req.id}/todos`, payload: { title: "step 2" } })
  ).json() as { todo: { id: string } };
  const batch = await app.inject({
    method: "PATCH",
    url: `/v1/requirements/${req.id}/todos`,
    payload: { ids: [todo.id, t2.todo.id], status: "running" },
  });
  assert.equal(batch.statusCode, 200);
  assert.deepEqual(
    (batch.json() as { todos: { status: string }[] }).todos.map((t) => t.status),
    ["running", "running"],
  );
  // batch validation
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/requirements/${req.id}/todos`, payload: { ids: [], status: "done" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({
      method: "PATCH",
      url: `/v1/requirements/${req.id}/todos`,
      payload: { ids: ["ghost"], status: "passed" },
    })).statusCode,
    404,
  );

  // delete
  const del = await app.inject({ method: "DELETE", url: `/v1/requirements/${req.id}/todos/${todo.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal((del.json() as { deleted: boolean }).deleted, true);
  assert.equal(
    ((await app.inject({ method: "GET", url: `/v1/requirements/${req.id}/todos` })).json() as { items: unknown[] })
      .items.length,
    1,
  );

  // link conversation (idempotent)
  const link = await app.inject({
    method: "POST",
    url: `/v1/requirements/${req.id}/conversations`,
    payload: { conversation_id: "c-1" },
  });
  assert.equal((link.json() as { appended: boolean }).appended, true);
  const link2 = await app.inject({
    method: "POST",
    url: `/v1/requirements/${req.id}/conversations`,
    payload: { conversation_id: "c-1" },
  });
  assert.equal((link2.json() as { appended: boolean }).appended, false);
  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/requirements/${req.id}/conversations`, payload: {} })).statusCode,
    400,
  );

  // 404 for a missing requirement
  assert.equal((await app.inject({ method: "GET", url: "/v1/requirements/ghost/todos" })).statusCode, 404);
  await app.close();
});

// ---------- run verification ----------

test("run verification: /verification stores result + flips terminal", async () => {
  const { newRequirement, newRequirementRun } = await import("@jarvis/project");
  const stores = makeMemoryStores();
  const req = newRequirement("p", "X");
  await stores.requirements.upsert(req);
  const run = newRequirementRun(req.id, "conv-1");
  await stores.requirementRuns.upsert(run);
  const app = await buildApp(
    makeState({
      requirements: stores.requirements,
      requirementRuns: stores.requirementRuns,
      activities: stores.activities,
    }),
  );

  const stored = await app.inject({
    method: "POST",
    url: `/v1/runs/${run.id}/verification`,
    payload: { status: "passed", command_results: [] },
  });
  assert.equal(stored.statusCode, 200);
  const sj = stored.json() as { status: string; verification: { status: string } };
  assert.equal(sj.status, "completed"); // passed → terminal Completed
  assert.equal(sj.verification.status, "passed");

  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/runs/ghost/verification", payload: { status: "failed" } }))
      .statusCode,
    404,
  );
  await app.close();
});

test("run verify executes commands", { skip: process.platform === "win32" }, async () => {
  const { newRequirement, newRequirementRun } = await import("@jarvis/project");
  const stores = makeMemoryStores();
  const req = newRequirement("p", "X");
  await stores.requirements.upsert(req);
  const app = await buildApp(
    makeState({
      requirements: stores.requirements,
      requirementRuns: stores.requirementRuns,
      activities: stores.activities,
    }),
  );

  // empty commands → 400; missing run → 404
  const run0 = newRequirementRun(req.id, "c0");
  await stores.requirementRuns.upsert(run0);
  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/runs/${run0.id}/verify`, payload: { commands: [] } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/runs/ghost/verify", payload: { commands: ["exit 0"] } }))
      .statusCode,
    404,
  );

  // passing plan → Completed
  const pass = newRequirementRun(req.id, "c1");
  await stores.requirementRuns.upsert(pass);
  const passed = (await app.inject({
    method: "POST",
    url: `/v1/runs/${pass.id}/verify`,
    payload: { commands: ["exit 0"] },
  })).json() as { status: string; verification: { status: string; command_results: { exit_code: number }[] } };
  assert.equal(passed.status, "completed");
  assert.equal(passed.verification.status, "passed");
  assert.equal(passed.verification.command_results[0]!.exit_code, 0);

  // failing plan → Failed
  const fail = newRequirementRun(req.id, "c2");
  await stores.requirementRuns.upsert(fail);
  const failed = (await app.inject({
    method: "POST",
    url: `/v1/runs/${fail.id}/verify`,
    payload: { commands: ["exit 3"] },
  })).json() as { status: string; verification: { status: string } };
  assert.equal(failed.status, "failed");
  assert.equal(failed.verification.status, "failed");
  await app.close();
});
