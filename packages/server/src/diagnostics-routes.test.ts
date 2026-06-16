// Tests for the diagnostics routes. Ported from the `tests` modules in
// crates/harness-server/src/diagnostics_routes.rs + diagnostics.rs.
//
// Deterministic, no network. Worktree tests `git init` a fresh temp repo and
// skip cleanly when `git` isn't on PATH. Run-detector tests use the in-memory
// RequirementRunStore from @jarvis/store.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryRequirementRunStore } from "@jarvis/store";
import {
  newRequirementRun,
  finishRequirementRun,
  type RequirementRun,
  type RequirementRunStatus,
} from "@jarvis/project";
import { registerDiagnosticsRoutes, type MemoryStatsProvider } from "./diagnostics-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

const noAgent = (): never => {
  throw new Error("agent not used in these route tests");
};

/** AppState with diagnostics-relevant fields. `worktreeRoot`/`memoryStats` are
 *  not declared on AppState yet, so they're attached via a cast (matching the
 *  defensive read in the route module). */
function makeState(
  extras: {
    runStore?: MemoryRequirementRunStore;
    worktreeRoot?: string;
    workspaceRoot?: string;
    memoryStats?: MemoryStatsProvider;
  } = {},
): AppState {
  const base: AppState = { createAgent: noAgent };
  if (extras.runStore) base.requirementRuns = extras.runStore;
  if (extras.workspaceRoot !== undefined) base.workspaceRoot = extras.workspaceRoot;
  const withExtras = base as AppState & {
    worktreeRoot?: string;
    memoryStats?: MemoryStatsProvider;
  };
  if (extras.worktreeRoot !== undefined) withExtras.worktreeRoot = extras.worktreeRoot;
  if (extras.memoryStats !== undefined) withExtras.memoryStats = extras.memoryStats;
  return base;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerDiagnosticsRoutes(app, state);
  await app.ready();
  return app;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // realpath so canonicalisation inside removeWorktree matches on macOS.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jarvis-diag-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

function initRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed", "--allow-empty"], { stdio: "ignore" });
}

function tsSecondsAgo(secs: number): string {
  return new Date(Date.now() - secs * 1000).toISOString();
}

/**
 * Build a run row with explicit id / status / timestamps. Terminal statuses
 * (`completed`/`failed`/`cancelled`) set `finished_at`; in-flight ones
 * (`pending`/`running`) leave it unset. `finishedSecondsAgo` overrides the
 * finish timestamp for deterministic ordering.
 */
function makeRun(opts: {
  id: string;
  status: RequirementRunStatus;
  startedSecondsAgo: number;
  finishedSecondsAgo?: number;
}): RequirementRun {
  const r = newRequirementRun("req-x", `conv-${opts.id}`);
  r.id = opts.id;
  r.started_at = tsSecondsAgo(opts.startedSecondsAgo);
  if (opts.status === "running") {
    r.status = "running";
  } else if (opts.status !== "pending") {
    finishRequirementRun(r, opts.status);
    r.finished_at =
      opts.finishedSecondsAgo !== undefined ? tsSecondsAgo(opts.finishedSecondsAgo) : r.finished_at;
  }
  return r;
}

// ---------- 503 when unconfigured ----------

test("run-detector routes 503 when no run store is configured", async () => {
  const app = await buildApp(makeState());
  for (const url of [
    "/v1/diagnostics/runs/stuck",
    "/v1/diagnostics/runs/failed",
    "/v1/diagnostics/runs/recent",
  ]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503, url);
    assert.match((res.json() as { error: string }).error, /not configured/);
  }
});

test("worktree routes 503 when no worktree root is configured", async () => {
  // Run store present, but no worktree root → 503 worktree, not run store.
  const app = await buildApp(makeState({ runStore: new MemoryRequirementRunStore() }));
  const list = await app.inject({ method: "GET", url: "/v1/diagnostics/worktrees/orphans" });
  assert.equal(list.statusCode, 503);
  assert.match((list.json() as { error: string }).error, /worktree feature not configured/);
  const cleanup = await app.inject({ method: "POST", url: "/v1/diagnostics/worktrees/orphans/cleanup" });
  assert.equal(cleanup.statusCode, 503);
});

test("worktree routes 503 when worktree root present but no run store", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState({ worktreeRoot: dir }));
    const res = await app.inject({ method: "GET", url: "/v1/diagnostics/worktrees/orphans" });
    assert.equal(res.statusCode, 503);
    assert.match((res.json() as { error: string }).error, /requirement run store not configured/);
  });
});

// ---------- orphan detection ----------

test("orphans: missing root returns empty list", async () => {
  const app = await buildApp(
    makeState({ runStore: new MemoryRequirementRunStore(), worktreeRoot: "/no/such/dir" }),
  );
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/worktrees/orphans" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { items: unknown[] }).items, []);
});

test("orphans: detects directory with no matching run row", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "known-id"));
    await mkdir(join(dir, "orphan-id"));
    await writeFile(join(dir, "orphan-id", "a.txt"), "data"); // 4 bytes
    // A loose file at the root must NOT count (only dirs).
    await writeFile(join(dir, "stray.txt"), "hi");

    const store = new MemoryRequirementRunStore();
    const known = newRequirementRun("req-x", "conv-x");
    known.id = "known-id";
    finishRequirementRun(known, "completed");
    await store.upsert(known);

    const app = await buildApp(makeState({ runStore: store, worktreeRoot: dir }));
    const res = await app.inject({ method: "GET", url: "/v1/diagnostics/worktrees/orphans" });
    assert.equal(res.statusCode, 200);
    const items = (res.json() as { items: { run_id: string; size_bytes: number; modified_at: string }[] }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.run_id, "orphan-id");
    assert.equal(items[0]!.size_bytes, 4);
    assert.notEqual(items[0]!.modified_at, "");
  });
});

test("cleanup: removes a real orphan worktree and reports", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (repo) => {
    initRepo(repo);
    await withTempDir(async (wtRoot) => {
      const wtPath = join(wtRoot, "orphan-1");
      execFileSync("git", ["-C", repo, "worktree", "add", "--detach", wtPath], { stdio: "ignore" });
      assert.ok(existsSync(wtPath));

      const store = new MemoryRequirementRunStore(); // empty → orphan
      const app = await buildApp(makeState({ runStore: store, worktreeRoot: wtRoot, workspaceRoot: repo }));

      // sanity: the orphan is listed first
      const list = await app.inject({ method: "GET", url: "/v1/diagnostics/worktrees/orphans" });
      assert.equal((list.json() as { items: unknown[] }).items.length, 1);

      const res = await app.inject({ method: "POST", url: "/v1/diagnostics/worktrees/orphans/cleanup" });
      assert.equal(res.statusCode, 200);
      const report = res.json() as { attempted: number; removed: number; errors: unknown[] };
      assert.equal(report.attempted, 1);
      assert.equal(report.removed, 1);
      assert.deepEqual(report.errors, []);
      assert.ok(!existsSync(wtPath));
    });
  });
});

// ---------- run detectors ----------

test("stuck runs: filtered by status + age, sorted oldest-first", async () => {
  const store = new MemoryRequirementRunStore();
  await store.upsert(makeRun({ id: "old-pending", status: "pending", startedSecondsAgo: 600 }));
  await store.upsert(makeRun({ id: "old-running", status: "running", startedSecondsAgo: 1200 }));
  await store.upsert(makeRun({ id: "old-completed", status: "completed", startedSecondsAgo: 900 }));
  await store.upsert(makeRun({ id: "recent-pending", status: "pending", startedSecondsAgo: 10 }));

  const app = await buildApp(makeState({ runStore: store }));
  const res = await app.inject({
    method: "GET",
    url: "/v1/diagnostics/runs/stuck?threshold_seconds=60&limit=100",
  });
  assert.equal(res.statusCode, 200);
  const items = (res.json() as { items: { id: string; age_seconds: number }[] }).items;
  assert.deepEqual(items.map((i) => i.id), ["old-running", "old-pending"]);
  assert.ok(items[0]!.age_seconds >= 1200);
});

test("failed runs: only failed, newest-first by finished_at, respects limit", async () => {
  const store = new MemoryRequirementRunStore();
  await store.upsert(makeRun({ id: "ok", status: "completed", startedSecondsAgo: 300, finishedSecondsAgo: 250 }));
  await store.upsert(makeRun({ id: "early-fail", status: "failed", startedSecondsAgo: 900, finishedSecondsAgo: 800 }));
  await store.upsert(makeRun({ id: "late-fail", status: "failed", startedSecondsAgo: 120, finishedSecondsAgo: 60 }));

  const app = await buildApp(makeState({ runStore: store }));
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/runs/failed?limit=10" });
  assert.equal(res.statusCode, 200);
  const ids = (res.json() as { items: { id: string }[] }).items.map((r) => r.id);
  assert.deepEqual(ids, ["late-fail", "early-fail"]);

  const limited = await app.inject({ method: "GET", url: "/v1/diagnostics/runs/failed?limit=1" });
  assert.equal((limited.json() as { items: unknown[] }).items.length, 1);
});

test("recent runs: status-agnostic, newest-first, in-flight uses started_at", async () => {
  const store = new MemoryRequirementRunStore();
  await store.upsert(makeRun({ id: "early", status: "completed", startedSecondsAgo: 1200, finishedSecondsAgo: 900 }));
  await store.upsert(makeRun({ id: "middle", status: "failed", startedSecondsAgo: 600, finishedSecondsAgo: 300 }));
  await store.upsert(makeRun({ id: "late", status: "cancelled", startedSecondsAgo: 120, finishedSecondsAgo: 30 }));
  await store.upsert(makeRun({ id: "running", status: "running", startedSecondsAgo: 10 }));

  const app = await buildApp(makeState({ runStore: store }));
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/runs/recent?limit=10" });
  assert.equal(res.statusCode, 200);
  const ids = (res.json() as { items: { id: string }[] }).items.map((r) => r.id);
  assert.deepEqual(ids, ["running", "late", "middle", "early"]);

  const two = await app.inject({ method: "GET", url: "/v1/diagnostics/runs/recent?limit=2" });
  assert.deepEqual((two.json() as { items: { id: string }[] }).items.map((r) => r.id), ["running", "late"]);
});

test("recent runs: default limit applies when query absent", async () => {
  const store = new MemoryRequirementRunStore();
  await store.upsert(makeRun({ id: "a", status: "completed", startedSecondsAgo: 10, finishedSecondsAgo: 5 }));
  const app = await buildApp(makeState({ runStore: store }));
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/runs/recent" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { items: unknown[] }).items.length, 1);
});

// ---------- memory ----------

test("memory: minimal snapshot when no stats provider is configured", async () => {
  const app = await buildApp(makeState({ runStore: new MemoryRequirementRunStore() }));
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/memory" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { backend: string; stats_available: boolean };
  assert.equal(body.backend, "unknown");
  assert.equal(body.stats_available, false);
});

test("memory: returns the provider snapshot when configured", async () => {
  const provider: MemoryStatsProvider = {
    snapshot: () => ({ backend: "summarizing", compactions_total: 42 }),
  };
  const app = await buildApp(makeState({ memoryStats: provider }));
  const res = await app.inject({ method: "GET", url: "/v1/diagnostics/memory" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { backend: string; compactions_total: number };
  assert.equal(body.backend, "summarizing");
  assert.equal(body.compactions_total, 42);
});
