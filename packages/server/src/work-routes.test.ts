import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { makeMemoryStores } from "@jarvis/store";
import {
  newActivity,
  newProject,
  newRequirement,
  newRequirementRun,
  type Requirement,
  type RequirementRun,
  type VerificationResult,
} from "@jarvis/project";
import { registerWorkRoutes } from "./work-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

const NO_AGENT = (): never => {
  throw new Error("agent not used in these route tests");
};

/** A run with explicit timestamps so window membership is deterministic. */
function run(
  reqId: string,
  status: RequirementRun["status"],
  startedAt: string,
  extra: Partial<RequirementRun> = {},
): RequirementRun {
  const r = newRequirementRun(reqId, "conv-1");
  r.status = status;
  r.started_at = startedAt;
  return { ...r, ...extra };
}

function emptyState(overrides: Partial<AppState> = {}): AppState {
  return { createAgent: NO_AGENT, ...overrides };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerWorkRoutes(app, state);
  await app.ready();
  return app;
}

// ---------- 503 when unconfigured ----------

test("work routes 503 when no requirement-run store is configured", async () => {
  const app = await buildApp(emptyState());
  for (const url of ["/v1/work/overview", "/v1/work/quality"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503);
    assert.match(res.json().error as string, /requirement run store not configured/);
  }
  await app.close();
});

// ---------- overview happy path with full stores ----------

test("overview aggregates runs, status counts, throughput, and failures", async () => {
  const stores = makeMemoryStores();
  const project = newProject("Alpha", "");
  project.slug = "alpha";
  await stores.projects.save(project);

  const reqDone = newRequirement(project.id, "Ship feature");
  reqDone.status = "done";
  reqDone.updated_at = new Date().toISOString();
  const reqOpen = newRequirement(project.id, "WIP");
  reqOpen.status = "in_progress";
  await stores.requirements.upsert(reqDone);
  await stores.requirements.upsert(reqOpen);

  const now = new Date().toISOString();
  const inWindow = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const verification: VerificationResult = { status: "passed", command_results: [] };

  await stores.requirementRuns.upsert(run(reqDone.id, "completed", inWindow, { verification }));
  await stores.requirementRuns.upsert(run(reqOpen.id, "running", now));
  await stores.requirementRuns.upsert(
    run(reqOpen.id, "failed", inWindow, { error: "boom", finished_at: inWindow }),
  );
  // A run whose requirement no longer exists — should be ignored (ghost row).
  await stores.requirementRuns.upsert(run("ghost-req", "completed", inWindow));

  const app = await buildApp(
    emptyState({
      projects: stores.projects,
      requirements: stores.requirements,
      requirementRuns: stores.requirementRuns,
      activities: stores.activities,
    }),
  );
  const res = await app.inject({ method: "GET", url: "/v1/work/overview" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(body.missing_stores, []);
  assert.equal(body.truncated, false);
  assert.equal(body.blocked_truncated, false);
  assert.deepEqual(body.requirement_status_counts, { backlog: 0, in_progress: 1, review: 0, done: 1 });
  // ghost-req run excluded → only completed (reqDone) + failed (reqOpen) counted
  assert.deepEqual(body.run_status_counts, { completed: 1, failed: 1, cancelled: 0 });
  assert.equal(body.verification_pass_rate, 1);

  assert.equal(body.running_now.length, 1);
  assert.equal(body.running_now[0].requirement_id, reqOpen.id);
  assert.equal(body.running_now[0].project_name, "Alpha");
  assert.ok((body.running_now[0].duration_ms as number) >= 0);

  assert.equal(body.recent_failures.length, 1);
  assert.equal(body.recent_failures[0].error, "boom");
  assert.equal(body.recent_failures[0].project_name, "Alpha");

  // blocked_requirements present (activities store wired) but empty.
  assert.deepEqual(body.blocked_requirements, []);
  // actor_breakdown is always present + null.
  assert.equal(body.actor_breakdown, null);

  // leaderboard: one project, 3 in-window runs (completed + running + failed),
  // 1 of them completed → completion_rate 1/3.
  assert.equal(body.project_leaderboard.length, 1);
  assert.equal(body.project_leaderboard[0].runs_in_window, 3);
  assert.equal(body.project_leaderboard[0].completion_rate, 1 / 3);

  // throughput buckets exist for every day of the default 7-day window.
  assert.ok(Array.isArray(body.throughput_by_day));
  const totalStarted = (body.throughput_by_day as { runs_started: number }[]).reduce(
    (s, b) => s + b.runs_started,
    0,
  );
  // runs_started counts every in-window non-ghost run regardless of status:
  // completed + running + failed = 3 (the ghost-req run is excluded).
  assert.equal(totalStarted, 3);
  await app.close();
});

// ---------- partial stores: only the run store present ----------

test("overview tolerates missing projects + requirements + activities stores", async () => {
  const stores = makeMemoryStores();
  await stores.requirementRuns.upsert(run("r1", "completed", new Date().toISOString()));

  const app = await buildApp(emptyState({ requirementRuns: stores.requirementRuns }));
  const res = await app.inject({ method: "GET", url: "/v1/work/overview" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual([...(body.missing_stores as string[])].sort(), ["activities", "projects", "requirements"]);
  assert.equal(body.requirement_status_counts, null);
  assert.equal(body.project_leaderboard, null);
  assert.equal(body.blocked_requirements, null);
  // Without a requirement index, no ghost-skip → the run still counts.
  assert.deepEqual(body.run_status_counts, { completed: 1, failed: 0, cancelled: 0 });
  await app.close();
});

// ---------- blocked requirements detection ----------

test("overview surfaces a requirement blocked without a later unblock", async () => {
  const stores = makeMemoryStores();
  const project = newProject("Beta", "");
  project.slug = "beta";
  await stores.projects.save(project);

  const blocked: Requirement = newRequirement(project.id, "Stuck");
  const unblocked: Requirement = newRequirement(project.id, "Recovered");
  await stores.requirements.upsert(blocked);
  await stores.requirements.upsert(unblocked);

  const earlier = "2026-06-01T00:00:00.000Z";
  const later = "2026-06-02T00:00:00.000Z";

  // "Stuck" is blocked and never unblocked.
  const a1 = newActivity(blocked.id, "blocked", { type: "system" }, { reason: "dependency_cycle" });
  a1.created_at = earlier;
  await stores.activities.append(a1);

  // "Recovered" was blocked then unblocked later → must NOT appear.
  const a2 = newActivity(unblocked.id, "blocked", { type: "system" }, { reason: "self_dependency" });
  a2.created_at = earlier;
  await stores.activities.append(a2);
  const a3 = newActivity(unblocked.id, "unblocked", { type: "system" }, {});
  a3.created_at = later;
  await stores.activities.append(a3);

  const app = await buildApp(
    emptyState({
      projects: stores.projects,
      requirements: stores.requirements,
      requirementRuns: stores.requirementRuns,
      activities: stores.activities,
    }),
  );
  const res = await app.inject({ method: "GET", url: "/v1/work/overview" });
  const body = res.json();

  assert.equal((body.blocked_requirements as unknown[]).length, 1);
  assert.equal(body.blocked_requirements[0].id, blocked.id);
  assert.equal(body.blocked_requirements[0].title, "Stuck");
  assert.equal(body.blocked_requirements[0].reason, "dependency_cycle");
  assert.equal(body.blocked_requirements[0].blocked_since, earlier);
  assert.equal(body.blocked_requirements[0].project_name, "Beta");
  await app.close();
});

// ---------- quality happy path ----------

test("quality aggregates top failing commands + pass rate by day", async () => {
  const stores = makeMemoryStores();
  const startedAt = new Date(Date.now() - 86_400_000).toISOString();

  const v1: VerificationResult = {
    status: "failed",
    command_results: [
      { command: "cargo test -p foo --lib", exit_code: 101, stderr: "panic at line 5", duration_ms: 10 },
      { command: "npm   run     build", exit_code: 1, stderr: "build error", duration_ms: 20 },
      { command: "cargo fmt --check", exit_code: 0, duration_ms: 5 }, // passed → not counted
    ],
  };
  const v2: VerificationResult = {
    status: "failed",
    command_results: [
      { command: "cargo test -p bar --features x", exit_code: 101, stderr: "another panic", duration_ms: 12 },
    ],
  };
  const v3: VerificationResult = { status: "passed", command_results: [] };

  await stores.requirementRuns.upsert(run("r1", "failed", startedAt, { verification: v1 }));
  await stores.requirementRuns.upsert(run("r2", "failed", startedAt, { verification: v2 }));
  await stores.requirementRuns.upsert(run("r3", "completed", startedAt, { verification: v3 }));

  const app = await buildApp(emptyState({ requirementRuns: stores.requirementRuns }));
  const res = await app.inject({ method: "GET", url: "/v1/work/quality" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // "cargo test" groups both -p foo and -p bar → fail_count 2 (top).
  const cargoTest = (body.top_failing_commands as { command_normalized: string; fail_count: number }[]).find(
    (c) => c.command_normalized === "cargo test",
  );
  assert.ok(cargoTest);
  assert.equal(cargoTest.fail_count, 2);
  // whitespace-collapsed "npm run"
  const npm = (body.top_failing_commands as { command_normalized: string }[]).find(
    (c) => c.command_normalized === "npm run",
  );
  assert.ok(npm);
  // passing command not in the failing list
  assert.ok(
    !(body.top_failing_commands as { command_normalized: string }[]).some(
      (c) => c.command_normalized === "cargo fmt",
    ),
  );

  // one bucket has passed:1 failed:2 across the window.
  const totals = (body.verification_pass_rate_by_day as { passed: number; failed: number }[]).reduce(
    (acc, b) => ({ passed: acc.passed + b.passed, failed: acc.failed + b.failed }),
    { passed: 0, failed: 0 },
  );
  assert.deepEqual(totals, { passed: 1, failed: 2 });
  await app.close();
});

// ---------- window query parsing ----------

test("overview rejects a malformed `since` with 400", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(emptyState({ requirementRuns: stores.requirementRuns }));
  const res = await app.inject({ method: "GET", url: "/v1/work/overview?since=not-a-date" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error as string, /invalid `since`/);
  await app.close();
});

test("window_days clamps to [1, 365] and echoes back", async () => {
  const stores = makeMemoryStores();
  const app = await buildApp(emptyState({ requirementRuns: stores.requirementRuns }));

  const lo = (await app.inject({ method: "GET", url: "/v1/work/overview?window_days=0" })).json();
  assert.equal(lo.window_days, 1);
  const hi = (await app.inject({ method: "GET", url: "/v1/work/overview?window_days=9999" })).json();
  assert.equal(hi.window_days, 365);
  const def = (await app.inject({ method: "GET", url: "/v1/work/overview" })).json();
  assert.equal(def.window_days, 7);
  await app.close();
});

test("explicit `since` is honoured and runs outside the window are excluded", async () => {
  const stores = makeMemoryStores();
  // One run well before the window, one inside.
  await stores.requirementRuns.upsert(run("r-old", "completed", "2020-01-01T00:00:00.000Z"));
  await stores.requirementRuns.upsert(run("r-new", "completed", new Date().toISOString()));

  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const app = await buildApp(emptyState({ requirementRuns: stores.requirementRuns }));
  const res = await app.inject({ method: "GET", url: `/v1/work/overview?since=${encodeURIComponent(since)}` });
  const body = res.json();
  // only the recent run is in the window
  assert.deepEqual(body.run_status_counts, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(body.since, since);
  await app.close();
});
