import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { emptyUsage, type Conversation, type Usage } from "@jarvis/core";
import { makeMemoryStores, type StoreBundle } from "@jarvis/store";
import {
  newProject,
  newRequirement,
  newRequirementRun,
  type Requirement,
  type RequirementRun,
  type RequirementStatus,
  type VerificationResult,
} from "@jarvis/project";

import {
  AutoModeRuntime,
  Semaphore,
  TimeoutError,
  autoModeFromWire,
  autoModeTick,
  completedRequirementTargetStatus,
  consecutiveFailedSinceLastSuccess,
  cycleBlockedRequirementIds,
  defaultAutoModeConfig,
  driveOne,
  failureBackoffMs,
  failureBackoffRemainingMs,
  mostRecentFailedRun,
  registerAutoModeRoutes,
  seedPrompt,
  withTimeout,
  type AutoModeConfig,
  type AutoModeDeps,
} from "./auto-mode.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures --------------------------------------------------------

/** A drive seam that records every requirement it drove + a canned reply. */
function cannedAgent(reply: string) {
  const driven: string[] = [];
  const createAgent: AutoModeDeps["createAgent"] = () => ({
    model: "canned-model",
    async runWithUsage(conversation: Conversation): Promise<[unknown, Usage]> {
      conversation.messages.push({ role: "assistant", content: reply });
      return [{ kind: "stopped", iterations: 1 }, emptyUsage()];
    },
  });
  return { createAgent, driven };
}

/** Build AutoModeDeps over fresh in-memory stores with sane defaults. */
function makeDeps(
  overrides: Partial<AutoModeDeps> = {},
): AutoModeDeps & { stores: StoreBundle; runtime: AutoModeRuntime } {
  const stores = makeMemoryStores();
  const runtime = new AutoModeRuntime("auto", 2);
  const { createAgent } = cannedAgent("done.");
  const deps: AutoModeDeps & { stores: StoreBundle; runtime: AutoModeRuntime } = {
    projects: stores.projects,
    requirements: stores.requirements,
    requirementRuns: stores.requirementRuns,
    activities: stores.activities,
    projectMemory: stores.projectMemory,
    createAgent,
    runtime,
    stores,
    ...overrides,
  };
  return deps;
}

function cfg(overrides: Partial<AutoModeConfig> = {}): AutoModeConfig {
  return { ...defaultAutoModeConfig(), mode: "auto", maxRetries: 1, tickSeconds: 30, ...overrides };
}

/** Seed an approved project + requirement, return the requirement. */
async function seedApproved(
  deps: AutoModeDeps,
  patch: Partial<Requirement> = {},
): Promise<Requirement> {
  const project = newProject("Auto Project", "instructions");
  project.slug = "auto-project";
  await deps.projects.save(project);
  const req = newRequirement(project.id, patch.title ?? "do the thing");
  Object.assign(req, patch);
  await deps.requirements.upsert(req);
  return req;
}

/** Poll a predicate until true or timeout. */
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- wire parsing ----------------------------------------------------

test("autoModeFromWire parses off/auto, undefined otherwise", () => {
  assert.equal(autoModeFromWire(""), "off");
  assert.equal(autoModeFromWire("off"), "off");
  assert.equal(autoModeFromWire(" auto "), "auto");
  assert.equal(autoModeFromWire("nope"), undefined);
});

// ---------- guard 1: status -------------------------------------------------

test("tick skips ineligible statuses (done)", async () => {
  const deps = makeDeps();
  await seedApproved(deps, { status: "done" });
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 0);
});

test("tick picks backlog/in_progress/review (eligible)", async () => {
  for (const status of ["backlog", "in_progress"] as RequirementStatus[]) {
    const deps = makeDeps();
    await seedApproved(deps, { status });
    const picked = await autoModeTick(deps, cfg());
    assert.equal(picked, 1, `status=${status} should be eligible`);
  }
});

// ---------- guard 2: triage gate --------------------------------------------

test("tick skips non-approved triage states", async () => {
  for (const triage of ["proposed_by_agent", "proposed_by_scan"] as const) {
    const deps = makeDeps();
    await seedApproved(deps, { triage_state: triage });
    const picked = await autoModeTick(deps, cfg());
    assert.equal(picked, 0, `triage=${triage} must not run unattended`);
  }
});

test("tick picks an approved requirement", async () => {
  const deps = makeDeps();
  await seedApproved(deps, { triage_state: "approved" });
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 1);
});

// ---------- guard 3: depends_on / topo / self-dep / cycle -------------------

test("cycleBlockedRequirementIds detects self-loop and mutual cycle", () => {
  const a = newRequirement("p", "A");
  const b = newRequirement("p", "B");
  const c = newRequirement("p", "C");
  a.depends_on = [a.id]; // self loop
  b.depends_on = [c.id];
  c.depends_on = [b.id]; // mutual cycle B<->C
  const blocked = cycleBlockedRequirementIds([a, b, c]);
  assert.equal(blocked.has(a.id), true);
  assert.equal(blocked.has(b.id), true);
  assert.equal(blocked.has(c.id), true);
});

test("cycleBlockedRequirementIds settles a clean DAG and ignores cross-project deps", () => {
  const a = newRequirement("p", "A");
  const b = newRequirement("p", "B");
  b.depends_on = [a.id, "unknown-external-id"]; // unknown id is dropped
  const blocked = cycleBlockedRequirementIds([a, b]);
  assert.equal(blocked.size, 0);
});

test("tick skips when a dependency is not done (topo gate)", async () => {
  const deps = makeDeps();
  const project = newProject("P", "i");
  project.slug = "p";
  await deps.projects.save(project);
  const dep = newRequirement(project.id, "dep");
  dep.status = "in_progress"; // NOT done
  const child = newRequirement(project.id, "child");
  child.depends_on = [dep.id];
  await deps.requirements.upsert(dep);
  await deps.requirements.upsert(child);
  // Only the dep itself is eligible (child is blocked); cap to 1 to assert no double-pick.
  const picked = await autoModeTick(deps, cfg({ maxUnitsPerTick: 5 }));
  // dep runs; child is blocked behind it.
  assert.equal(picked, 1);
  // The child was never claimed.
  const childRuns = await deps.requirementRuns.listForRequirement(child.id);
  assert.equal(childRuns.length, 0);
});

test("tick runs a requirement once its dependency reaches done", async () => {
  const deps = makeDeps();
  const project = newProject("P", "i");
  project.slug = "p";
  await deps.projects.save(project);
  const dep = newRequirement(project.id, "dep");
  dep.status = "done";
  const child = newRequirement(project.id, "child");
  child.depends_on = [dep.id];
  await deps.requirements.upsert(dep);
  await deps.requirements.upsert(child);
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 1);
  const childRuns = await deps.requirementRuns.listForRequirement(child.id);
  assert.equal(childRuns.length, 1);
});

test("tick surfaces a self_dependency Blocked activity ONCE (deduped)", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "backlog" });
  req.depends_on = [req.id];
  await deps.requirements.upsert(req);

  await autoModeTick(deps, cfg());
  await autoModeTick(deps, cfg());

  const rows = await deps.activities!.listForRequirement(req.id);
  const blocked = rows.filter(
    (r) => r.kind === "blocked" && (r.body as { reason?: string }).reason === "self_dependency",
  );
  assert.equal(blocked.length, 1, "self_dependency block must be recorded exactly once");
  // Never picked.
  assert.equal((await deps.requirementRuns.listForRequirement(req.id)).length, 0);
});

test("tick surfaces a dependency_cycle Blocked activity ONCE (deduped)", async () => {
  const deps = makeDeps();
  const project = newProject("P", "i");
  project.slug = "p";
  await deps.projects.save(project);
  const a = newRequirement(project.id, "A");
  const b = newRequirement(project.id, "B");
  a.depends_on = [b.id];
  b.depends_on = [a.id];
  await deps.requirements.upsert(a);
  await deps.requirements.upsert(b);

  await autoModeTick(deps, cfg({ maxUnitsPerTick: 5 }));
  await autoModeTick(deps, cfg({ maxUnitsPerTick: 5 }));

  for (const id of [a.id, b.id]) {
    const rows = await deps.activities!.listForRequirement(id);
    const blocked = rows.filter(
      (r) => r.kind === "blocked" && (r.body as { reason?: string }).reason === "dependency_cycle",
    );
    assert.equal(blocked.length, 1, `cycle block for ${id} must be recorded exactly once`);
  }
});

test("a Blocked activity re-emits after an intervening (non-blocked) row", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "backlog" });
  req.depends_on = [req.id];
  await deps.requirements.upsert(req);

  await autoModeTick(deps, cfg());
  // An intervening status_change row pushes the blocked row off "newest". Use a
  // strictly-future timestamp so the newest-first sort places it ahead of the
  // blocked row regardless of same-millisecond ties.
  await deps.activities!.append({
    id: crypto.randomUUID(),
    requirement_id: req.id,
    kind: "status_change",
    actor: { type: "human" },
    body: { from: "backlog", to: "backlog" },
    created_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await autoModeTick(deps, cfg());

  const rows = await deps.activities!.listForRequirement(req.id);
  const blocked = rows.filter(
    (r) => r.kind === "blocked" && (r.body as { reason?: string }).reason === "self_dependency",
  );
  assert.equal(blocked.length, 2, "block re-emits once the newest row is no longer the same block");
});

// ---------- guard 4: in-flight run ------------------------------------------

test("tick skips a requirement with an in-flight (running) run", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "in_progress" });
  const run = newRequirementRun(req.id, "conv-x");
  run.status = "running";
  await deps.requirementRuns.upsert(run);
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 0);
});

test("tick skips a requirement with a pending run", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "in_progress" });
  const run = newRequirementRun(req.id, "conv-x"); // pending by default
  await deps.requirementRuns.upsert(run);
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 0);
});

// ---------- guard 5: retries ------------------------------------------------

test("consecutiveFailedSinceLastSuccess counts only failures after the last success", () => {
  const r = (status: RequirementRun["status"], startedAt: string): RequirementRun => {
    const run = newRequirementRun("req", "conv");
    run.status = status;
    run.started_at = startedAt;
    return run;
  };
  // newest-first order, as the store returns.
  const history = [
    r("failed", "2026-01-05T00:00:00Z"),
    r("failed", "2026-01-04T00:00:00Z"),
    r("cancelled", "2026-01-03T00:00:00Z"), // skipped, not counted
    r("completed", "2026-01-02T00:00:00Z"), // stops the count
    r("failed", "2026-01-01T00:00:00Z"), // before the success — not counted
  ];
  assert.equal(consecutiveFailedSinceLastSuccess(history), 2);
  assert.equal(mostRecentFailedRun(history)!.started_at, "2026-01-05T00:00:00Z");
});

test("tick skips when consecutive failures reach maxRetries", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "in_progress" });
  // One terminal failure, maxRetries=1 → locked out. Backdate it past any backoff.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const failed = newRequirementRun(req.id, "conv-f");
  failed.status = "failed";
  failed.started_at = old;
  failed.finished_at = old;
  await deps.requirementRuns.upsert(failed);

  const picked = await autoModeTick(deps, cfg({ maxRetries: 1 }));
  assert.equal(picked, 0, "1 failure with maxRetries=1 locks the row out");
});

test("a later success resets the consecutive-failure budget", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "in_progress" });
  const failed = newRequirementRun(req.id, "conv-f");
  failed.status = "failed";
  failed.started_at = "2026-01-01T00:00:00Z";
  failed.finished_at = "2026-01-01T00:00:00Z";
  const completed = newRequirementRun(req.id, "conv-c");
  completed.status = "completed";
  completed.started_at = "2026-01-02T00:00:00Z"; // newer than the failure
  completed.finished_at = "2026-01-02T00:00:00Z";
  await deps.requirementRuns.upsert(failed);
  await deps.requirementRuns.upsert(completed);

  // in_progress + completed-in-history is eligible (not Review), so it re-picks.
  const picked = await autoModeTick(deps, cfg({ maxRetries: 1 }));
  assert.equal(picked, 1, "the success since the failure clears the retry lockout");
});

test("failure backoff blocks an immediate retry within the window", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "in_progress" });
  const justNow = new Date().toISOString();
  const failed = newRequirementRun(req.id, "conv-f");
  failed.status = "failed";
  failed.started_at = justNow;
  failed.finished_at = justNow;
  await deps.requirementRuns.upsert(failed);
  // maxRetries=3 so the retry cap doesn't fire; the backoff window should.
  const picked = await autoModeTick(deps, cfg({ maxRetries: 3, tickSeconds: 30 }));
  assert.equal(picked, 0, "fresh failure is inside the 30s+ backoff window");
});

test("failureBackoffMs doubles and caps; remaining respects the clock", () => {
  assert.equal(failureBackoffMs(0, 30), 0);
  assert.equal(failureBackoffMs(1, 30), 30_000); // floor
  assert.equal(failureBackoffMs(2, 30), 60_000);
  assert.equal(failureBackoffMs(3, 30), 120_000);
  assert.equal(failureBackoffMs(99, 30), 60 * 60 * 1000); // capped
  const run = newRequirementRun("r", "c");
  run.finished_at = new Date(1_000_000).toISOString();
  // 100s after the failure, backoff window 30s → elapsed → undefined.
  assert.equal(failureBackoffRemainingMs(run, 30_000, 1_100_000), undefined);
  // 10s after, window 30s → 20s remaining.
  assert.equal(failureBackoffRemainingMs(run, 30_000, 1_010_000), 20_000);
  // future timestamp (clock skew) → undefined (don't pin forever).
  assert.equal(failureBackoffRemainingMs(run, 30_000, 999_000), undefined);
});

// ---------- guard 6: Review under Human acceptance --------------------------

test("tick skips a Review row under Human acceptance policy", async () => {
  const deps = makeDeps();
  await seedApproved(deps, { status: "review", acceptance_policy: "human" });
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 0, "Human policy holds the row at Review");
});

test("tick skips a Review row (Subagent) once a run has completed and reviewer off", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "review", acceptance_policy: "subagent" });
  const completed = newRequirementRun(req.id, "conv-c");
  completed.status = "completed";
  await deps.requirementRuns.upsert(completed);
  const picked = await autoModeTick(deps, cfg({ reviewerAutoAccept: false }));
  assert.equal(picked, 0, "no autonomous path to Done under default acceptance");
});

test("tick re-picks a Review row (Subagent) when reviewerAutoAccept is on", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "review", acceptance_policy: "subagent" });
  const completed = newRequirementRun(req.id, "conv-c");
  completed.status = "completed";
  await deps.requirementRuns.upsert(completed);
  const picked = await autoModeTick(deps, cfg({ reviewerAutoAccept: true }));
  assert.equal(picked, 1, "reviewerAutoAccept re-picks so the reviewer can dispatch");
});

// ---------- completedRequirementTargetStatus (pure) -------------------------

test("completedRequirementTargetStatus honours checklist + verification + policy", () => {
  const run = (verification?: VerificationResult["status"]): RequirementRun => {
    const r = newRequirementRun("req", "conv");
    r.status = "completed";
    if (verification) {
      r.verification = { status: verification, command_results: [] };
    }
    return r;
  };
  const req = (status: RequirementStatus, todoStatuses: RequirementRun["status"][] | string[]): Requirement => {
    const r = newRequirement("p", "t");
    r.status = status;
    r.todos = (todoStatuses as string[]).map((s, i) => ({
      id: `t${i}`,
      title: `step ${i}`,
      kind: "check",
      status: s as never,
      created_by: "workflow",
      created_at: "x",
      updated_at: "x",
    }));
    return r;
  };

  // in_progress + all passed + subagent → done
  assert.equal(
    completedRequirementTargetStatus(req("in_progress", ["passed"]), run(), "subagent"),
    "done",
  );
  // in_progress + all passed + human → review (never auto-Done)
  assert.equal(
    completedRequirementTargetStatus(req("in_progress", ["passed"]), run(), "human"),
    "review",
  );
  // in_progress + pending todo → review
  assert.equal(
    completedRequirementTargetStatus(req("in_progress", ["pending"]), run(), "subagent"),
    "review",
  );
  // failed todo → back to in_progress
  assert.equal(
    completedRequirementTargetStatus(req("in_progress", ["failed"]), run(), "subagent"),
    "in_progress",
  );
  // in_progress + needs_review verification → review
  assert.equal(
    completedRequirementTargetStatus(req("in_progress", ["passed"]), run("needs_review"), "subagent"),
    "review",
  );
  // review + passed + subagent → done
  assert.equal(
    completedRequirementTargetStatus(req("review", ["passed"]), run(), "subagent"),
    "done",
  );
  // non-terminal run → no transition
  const pending = newRequirementRun("req", "conv");
  assert.equal(completedRequirementTargetStatus(req("in_progress", ["passed"]), pending, "subagent"), undefined);
});

// ---------- driveOne end-to-end ---------------------------------------------

test("driveOne advances backlog → review and records a completed run", async () => {
  const deps = makeDeps();
  const req = await seedApproved(deps, { status: "backlog" });
  await driveOne(req, deps, cfg());

  const runs = await deps.requirementRuns.listForRequirement(req.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "completed");
  assert.equal(runs[0]!.summary, "done.");
  // Default-seeded checklist is pending → lands at Review (not Done).
  const saved = await deps.requirements.get(req.id);
  assert.equal(saved!.status, "review");
  // Audit rows: run_started + status_change(backlog→in_progress) + status_change(→review) + run_finished.
  const acts = await deps.activities!.listForRequirement(req.id);
  assert.ok(acts.some((a) => a.kind === "run_started"));
  assert.ok(acts.some((a) => a.kind === "run_finished"));
});

test("driveOne marks the run failed when the agent throws", async () => {
  const { createAgent } = {
    createAgent: (() => ({
      model: "boom",
      async runWithUsage(): Promise<[unknown, Usage]> {
        throw new Error("provider exploded");
      },
    })) as AutoModeDeps["createAgent"],
  };
  const deps = makeDeps({ createAgent });
  const req = await seedApproved(deps, { status: "in_progress" });
  await driveOne(req, deps, cfg());

  const runs = await deps.requirementRuns.listForRequirement(req.id);
  assert.equal(runs[0]!.status, "failed");
  assert.match(runs[0]!.error!, /provider exploded/);
});

test("driveOne dispatches the reviewer when reviewerAutoAccept + pass → done", async () => {
  let dispatched = 0;
  const deps = makeDeps({
    dispatchReviewer: async () => {
      dispatched += 1;
      return "pass";
    },
  });
  // Review row whose checklist passes → completedRequirementTargetStatus keeps
  // it at Review (it's already Review + passed → done under subagent). To force
  // the reviewer path we land it at Review via a pending checklist.
  const req = await seedApproved(deps, { status: "in_progress", acceptance_policy: "subagent" });
  // Seed a checklist that is all-passed so the row reaches Review→Done normally;
  // but we want it to STOP at Review for the reviewer. Use a pending todo so
  // advanceCompletedRequirement lands it at Review, then reviewer flips to Done.
  req.todos = [
    { id: "t0", title: "impl", kind: "work", status: "pending", created_by: "workflow", created_at: "x", updated_at: "x" },
  ];
  await deps.requirements.upsert(req);

  await driveOne(req, deps, cfg({ reviewerAutoAccept: true }));

  assert.equal(dispatched, 1, "reviewer seam dispatched once");
  const saved = await deps.requirements.get(req.id);
  assert.equal(saved!.status, "done", "pass verdict flips Review → Done");
});

test("driveOne reviewer fail verdict flips Review → in_progress", async () => {
  const deps = makeDeps({ dispatchReviewer: async () => "fail" });
  const req = await seedApproved(deps, { status: "in_progress", acceptance_policy: "subagent" });
  req.todos = [
    { id: "t0", title: "impl", kind: "work", status: "pending", created_by: "workflow", created_at: "x", updated_at: "x" },
  ];
  await deps.requirements.upsert(req);

  await driveOne(req, deps, cfg({ reviewerAutoAccept: true }));

  const saved = await deps.requirements.get(req.id);
  assert.equal(saved!.status, "in_progress", "fail verdict bounces back to in_progress");
});

test("seedPrompt includes title, description, and checklist", () => {
  const req = newRequirement("p", "Add a widget");
  req.description = "make it shiny";
  req.todos = [
    { id: "t", title: "build", kind: "work", status: "pending", command: "make", created_by: "agent", created_at: "x", updated_at: "x" },
  ];
  const prompt = seedPrompt(req);
  assert.match(prompt, /Add a widget/);
  assert.match(prompt, /make it shiny/);
  assert.match(prompt, /\[pending\] work: build — command: `make`/);
});

// ---------- per-tick burst budget + claims ----------------------------------

test("maxUnitsPerTick caps how many requirements a single tick spawns", async () => {
  const deps = makeDeps();
  const project = newProject("P", "i");
  project.slug = "p";
  await deps.projects.save(project);
  for (let i = 0; i < 3; i++) {
    await deps.requirements.upsert(newRequirement(project.id, `req ${i}`));
  }
  const picked = await autoModeTick(deps, cfg({ maxUnitsPerTick: 2 }));
  assert.equal(picked, 2);
});

test("project automation auto_mode_enabled=false skips the whole project", async () => {
  const deps = makeDeps();
  const project = newProject("P", "i");
  project.slug = "p";
  project.automation = { auto_mode_enabled: false };
  await deps.projects.save(project);
  await deps.requirements.upsert(newRequirement(project.id, "req"));
  const picked = await autoModeTick(deps, cfg());
  assert.equal(picked, 0);
});

// ---------- AutoModeRuntime + Semaphore -------------------------------------

test("tryClaimRequirement is exclusive until released", () => {
  const rt = new AutoModeRuntime("auto", 2);
  const r1 = rt.tryClaimRequirement("x");
  assert.ok(r1);
  assert.equal(rt.tryClaimRequirement("x"), undefined, "second claim is refused");
  r1!();
  assert.ok(rt.tryClaimRequirement("x"), "claim is reusable after release");
});

test("effectiveMaxRetries prefers the override; 0 clears it", () => {
  const rt = new AutoModeRuntime("auto", 2);
  const config = cfg({ maxRetries: 3 });
  assert.equal(rt.effectiveMaxRetries(config), 3);
  rt.setMaxRetriesOverride(7);
  assert.equal(rt.effectiveMaxRetries(config), 7);
  assert.equal(rt.maxRetriesOverride(), 7);
  rt.setMaxRetriesOverride(undefined);
  assert.equal(rt.effectiveMaxRetries(config), 3);
  assert.equal(rt.maxRetriesOverride(), undefined);
});

test("Semaphore enforces the permit ceiling and queues waiters FIFO", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  const r1 = await sem.acquire();
  const p2 = sem.acquire().then((rel) => {
    order.push(2);
    return rel;
  });
  const p3 = sem.acquire().then((rel) => {
    order.push(3);
    return rel;
  });
  // Neither waiter resolves while the single permit is held.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, []);
  r1();
  const rel2 = await p2;
  assert.deepEqual(order, [2]);
  rel2();
  const rel3 = await p3;
  assert.deepEqual(order, [2, 3]);
  rel3();
  assert.equal(sem.availablePermits(), 1);
});

test("autoModeTick respects the global concurrency cap via the semaphore", async () => {
  // 3 requirements, maxConcurrent=1: with manual gating we observe at most 1
  // drive in flight at a time. Use a blocking agent to hold the permit.
  let concurrent = 0;
  let maxObserved = 0;
  let releaseAll: (() => void) | undefined;
  const blocker = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const createAgent: AutoModeDeps["createAgent"] = () => ({
    model: "m",
    async runWithUsage(conv: Conversation): Promise<[unknown, Usage]> {
      concurrent += 1;
      maxObserved = Math.max(maxObserved, concurrent);
      await blocker;
      concurrent -= 1;
      conv.messages.push({ role: "assistant", content: "ok" });
      return [{ kind: "stopped", iterations: 1 }, emptyUsage()];
    },
  });
  const runtime = new AutoModeRuntime("auto", 1);
  const deps = makeDeps({ createAgent, runtime });
  const project = newProject("P", "i");
  project.slug = "p";
  await deps.projects.save(project);
  for (let i = 0; i < 3; i++) {
    await deps.requirements.upsert(newRequirement(project.id, `req ${i}`));
  }
  // Don't await drives (they block on `blocker`); start the tick, let it spawn.
  const tickP = autoModeTick(deps, cfg({ maxUnitsPerTick: 3, maxConcurrent: 1 }), { awaitDrives: false });
  await tickP;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(maxObserved, 1, "concurrency cap of 1 must serialise the drives");
  releaseAll!();
  await new Promise((r) => setTimeout(r, 20));
});

// ---------- withTimeout -----------------------------------------------------

test("withTimeout rejects with TimeoutError when the budget elapses", async () => {
  const slow = new Promise((r) => setTimeout(r, 50));
  await assert.rejects(() => withTimeout(slow, 5), (e) => e instanceof TimeoutError);
});

test("withTimeout resolves a fast promise", async () => {
  const fast = Promise.resolve(42);
  assert.equal(await withTimeout(fast, 1000), 42);
});

// ---------- REST routes -----------------------------------------------------

function emptyState(overrides: Partial<AppState> = {}): AppState {
  return {
    createAgent: (() => {
      throw new Error("agent not used in route tests");
    }) as AppState["createAgent"],
    ...overrides,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerAutoModeRoutes(app, state);
  await app.ready();
  return app;
}

test("GET /v1/auto-mode reports configured:false when no runtime", async () => {
  const app = await buildApp(emptyState());
  const res = await app.inject({ method: "GET", url: "/v1/auto-mode" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, false);
  assert.equal(body.enabled, false);
  assert.equal(body.effective_mode, "off");
  await app.close();
});

test("POST /v1/auto-mode returns 503 when no runtime", async () => {
  const app = await buildApp(emptyState());
  const res = await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { enabled: true } });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("GET reflects the config snapshot + effective_mode round-trips POST", async () => {
  const runtime = new AutoModeRuntime("off", 3);
  const config = cfg({ tickSeconds: 7, maxUnitsPerTick: 4, maxConcurrent: 3, maxRetries: 2, runTimeoutMs: 60_000 });
  const state = emptyState({ autoModeRuntime: runtime, autoModeConfig: config });
  const app = await buildApp(state);

  let body = (await app.inject({ method: "GET", url: "/v1/auto-mode" })).json();
  assert.equal(body.configured, true);
  assert.equal(body.enabled, false);
  assert.equal(body.effective_mode, "off");
  assert.equal(body.tick_seconds, 7);
  assert.equal(body.max_units_per_tick, 4);
  assert.equal(body.max_concurrent_units, 3);
  assert.equal(body.max_retries, 2);
  assert.equal(body.run_timeout_ms, 60_000);
  assert.equal(body.available_permits, 3);

  // Flip on.
  body = (await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { enabled: true } })).json();
  assert.equal(body.enabled, true);
  assert.equal(runtime.isEnabled(), true);
  body = (await app.inject({ method: "GET", url: "/v1/auto-mode" })).json();
  assert.equal(body.effective_mode, "auto");

  await app.close();
});

test("POST max_retries sets/clears the override; GET surfaces it", async () => {
  const runtime = new AutoModeRuntime("auto", 2);
  const config = cfg({ maxRetries: 1 });
  const state = emptyState({ autoModeRuntime: runtime, autoModeConfig: config });
  const app = await buildApp(state);

  let body = (await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { max_retries: 5 } })).json();
  assert.equal(body.max_retries_override, 5);
  assert.equal(body.effective_max_retries, 5);
  assert.equal(runtime.isEnabled(), true, "enabled left untouched when omitted");

  body = (await app.inject({ method: "GET", url: "/v1/auto-mode" })).json();
  assert.equal(body.max_retries, 1, "static config remains visible");
  assert.equal(body.max_retries_override, 5);
  assert.equal(body.effective_max_retries, 5);

  body = (await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { max_retries: 0 } })).json();
  assert.equal(body.max_retries_override, undefined);
  assert.equal(body.effective_max_retries, 1);
  assert.equal(runtime.maxRetriesOverride(), undefined);

  await app.close();
});

test("POST max_retries rejects negatives with 400 (#298)", async () => {
  const runtime = new AutoModeRuntime("auto", 2);
  const config = cfg({ maxRetries: 1 });
  const state = emptyState({ autoModeRuntime: runtime, autoModeConfig: config });
  const app = await buildApp(state);

  // First set a valid override so we can prove the rejected request leaves it intact.
  await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { max_retries: 3 } });
  assert.equal(runtime.maxRetriesOverride(), 3);

  const res = await app.inject({ method: "POST", url: "/v1/auto-mode", payload: { max_retries: -1 } });
  assert.equal(res.statusCode, 400, "negative max_retries must be rejected, not silently disable the scheduler");
  assert.match(res.json().error, /max_retries/);
  assert.equal(runtime.maxRetriesOverride(), 3, "rejected request must not mutate the override");

  await app.close();
});
