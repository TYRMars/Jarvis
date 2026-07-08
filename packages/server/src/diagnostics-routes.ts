// Phase 5b/5c diagnostics REST routes. Ported from
// crates/harness-server/src/diagnostics_routes.rs (+ the helper logic in
// diagnostics.rs, which has no standalone TS module — it lives here).
//
// Read-only health snapshots over the run / worktree state:
//
//   - GET  /v1/diagnostics/worktrees/orphans          — list orphan worktrees
//   - POST /v1/diagnostics/worktrees/orphans/cleanup  — remove all orphans
//   - GET  /v1/diagnostics/runs/stuck                 — Pending/Running too long
//   - GET  /v1/diagnostics/runs/failed                — recent Failed runs
//   - GET  /v1/diagnostics/runs/recent                — recent runs (any status)
//   - GET  /v1/diagnostics/memory                     — memory backend telemetry
//
// 503 handling (tolerate missing subsystems):
//   - Worktree endpoints need a worktree root AND a RequirementRunStore.
//   - Run endpoints need a RequirementRunStore.
//   - The memory endpoint needs a memory-stats provider, else a minimal snapshot.
//
// AppState gaps (deferred — not editing state.ts here):
//   - `worktreeRoot`: not yet a declared AppState field. Read defensively via a
//     narrow optional cast. Absent → 503 "worktree feature not configured",
//     matching the Rust `require_worktree_root`.
//   - `memoryStats`: no MemoryStatsProvider field on AppState yet. Read the same
//     way; absent → a minimal `{ backend: "unknown" }` snapshot rather than 503
//     (per the task: "minimal snapshot" fallback), distinct from the Rust route
//     which 503s. Once AppState carries the provider the cast resolves to it.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { RequirementRun, RequirementRunStore } from "@jarvis/project";
import { removeWorktree } from "./worktree.ts";
import type { AppState } from "./state.ts";

// ----------------------- AppState extension reads -----------------------
//
// These fields are not declared on AppState yet (see header). Reading them
// through a narrow structural type keeps this module compiling without editing
// state.ts; when the composition root starts populating them the values flow
// through unchanged.

/**
 * Minimal telemetry source for the active short-term-memory backend. Mirrors
 * Rust's `MemoryStatsProvider` (a single `snapshot()` returning a JSON object).
 */
export interface MemoryStatsProvider {
  snapshot(): unknown;
}

interface DiagnosticsStateExtras {
  /** Absolute path to the worktree root, when the worktree feature is wired. */
  worktreeRoot?: string;
  /** Active memory backend's telemetry provider, when one is installed. */
  memoryStats?: MemoryStatsProvider;
}

function worktreeRootOf(state: AppState): string | undefined {
  return (state as AppState & DiagnosticsStateExtras).worktreeRoot;
}

function memoryStatsOf(state: AppState): MemoryStatsProvider | undefined {
  return (state as AppState & DiagnosticsStateExtras).memoryStats;
}

// ----------------------- query defaults ---------------------------------

const DEFAULT_STUCK_SECONDS = 60 * 60; // 1h
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_FAILED_LIMIT = 20;
const DEFAULT_RECENT_LIMIT = 50;
/**
 * Hard upper bound on a caller-supplied `limit`. The runs routes multiply the
 * limit by 5 for the `listAll` scan window, so without a cap `?limit=1e8` would
 * request a 5e8-row store walk. Not applied to non-limit params like
 * `threshold_seconds`.
 */
const MAX_LIMIT = 500;

/**
 * Parse a positive integer query param, falling back to `def`, clamped to
 * `max` (default: no cap). Pass `max` for caller-supplied `limit` params to
 * bound the store scan.
 */
function intParam(raw: unknown, def: number, max = Infinity): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

// ----------------------- 503 guards -------------------------------------

function requireRunStore(state: AppState, reply: FastifyReply): RequirementRunStore | undefined {
  if (!state.requirementRuns) {
    reply.code(503).send({ error: "requirement run store not configured" });
    return undefined;
  }
  return state.requirementRuns;
}

function requireWorktreeRoot(state: AppState, reply: FastifyReply): string | undefined {
  const root = worktreeRootOf(state);
  if (!root) {
    reply.code(503).send({ error: "worktree feature not configured" });
    return undefined;
  }
  return root;
}

// ----------------------- orphan worktrees -------------------------------

/**
 * One on-disk worktree directory whose run id has no matching row in the
 * RequirementRunStore. Mirrors Rust `diagnostics::OrphanWorktree`.
 */
export interface OrphanWorktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Run id derived from the directory basename (hint only). */
  run_id: string;
  /** Sum of file sizes inside the worktree, in bytes (best-effort). */
  size_bytes: number;
  /** Directory mtime, RFC-3339. Empty string when the metadata read fails. */
  modified_at: string;
}

/**
 * Walk every immediate subdirectory of `worktreeRoot`, probe the matching id
 * against `runStore`, and return the ones with no row. Returns an empty list
 * when `worktreeRoot` doesn't exist. Mirrors `find_orphan_worktrees`.
 */
export async function findOrphanWorktrees(
  worktreeRoot: string,
  runStore: RequirementRunStore,
): Promise<OrphanWorktree[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(worktreeRoot, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const orphans: OrphanWorktree[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const path = join(worktreeRoot, runId);
    // Probe — store row present ⇒ not an orphan. Store errors are "skip and
    // continue" so a flaky backend doesn't fail the whole sweep.
    try {
      const row = await runStore.get(runId);
      if (row) continue;
    } catch {
      continue;
    }
    const sizeBytes = await walkSize(path);
    let modifiedAt = "";
    try {
      const meta = await stat(path);
      modifiedAt = meta.mtime.toISOString();
    } catch {
      /* leave empty on failure */
    }
    orphans.push({ path, run_id: runId, size_bytes: sizeBytes, modified_at: modifiedAt });
  }
  // Newest first.
  orphans.sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : 0));
  return orphans;
}

/** Result of a cleanup sweep. Mirrors Rust `CleanupReport`. */
export interface CleanupReport {
  attempted: number;
  removed: number;
  errors: { path: string; reason: string }[];
}

/**
 * Remove every orphan via `removeWorktree` (from ./worktree.ts), serially so two
 * `git worktree remove` calls don't race on `.git/worktrees/`. Per-orphan
 * failures are collected rather than aborting. Mirrors `remove_orphan_worktrees`.
 */
export async function removeOrphanWorktrees(
  repo: string,
  worktreeRoot: string,
  orphans: OrphanWorktree[],
): Promise<CleanupReport> {
  let removed = 0;
  const errors: { path: string; reason: string }[] = [];
  for (const o of orphans) {
    try {
      await removeWorktree(repo, worktreeRoot, o.path);
      removed += 1;
    } catch (e) {
      errors.push({ path: o.path, reason: errorText(e) });
    }
  }
  return { attempted: orphans.length, removed, errors };
}

/**
 * Iterative directory walk summing file sizes. IO / permission errors at any
 * descendant are swallowed (best-effort). Symlinks are not followed. Mirrors
 * Rust `walk_size`.
 */
async function walkSize(root: string): Promise<number> {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const meta = await stat(full);
          total += meta.size;
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }
  return total;
}

// ----------------------- run detectors ----------------------------------

/** One run in flight longer than the threshold, plus its computed age. */
export interface StuckRun extends RequirementRun {
  /** Wall-clock seconds between `started_at` and "now". */
  age_seconds: number;
}

/**
 * Runs whose status is `pending`/`running` and whose `started_at` is older than
 * `thresholdSeconds`. `limit` caps the upstream `listAll` scan. Sorted
 * oldest-first. Mirrors Rust `stuck_runs`.
 */
export async function stuckRuns(
  runStore: RequirementRunStore,
  thresholdSeconds: number,
  limit: number,
): Promise<StuckRun[]> {
  const now = Date.now();
  const rows = await runStore.listAll(limit);
  const out: StuckRun[] = [];
  for (const r of rows) {
    if (r.status !== "pending" && r.status !== "running") continue;
    const started = Date.parse(r.started_at);
    if (Number.isNaN(started)) continue;
    const age = Math.floor((now - started) / 1000);
    if (age >= thresholdSeconds) {
      out.push({ ...r, age_seconds: age });
    }
  }
  out.sort((a, b) => b.age_seconds - a.age_seconds);
  return out;
}

/** Ordering key: finished_at when present, else started_at. */
function runOrderKey(r: RequirementRun): string {
  return r.finished_at ?? r.started_at;
}

/**
 * Recent runs across every requirement, newest-first by finished_at (falling
 * back to started_at). Scans 5x `limit` so terminal rows aren't crowded out by
 * in-flight ones. Mirrors Rust `recent_runs`.
 */
export async function recentRuns(
  runStore: RequirementRunStore,
  limit: number,
): Promise<RequirementRun[]> {
  const scan = Math.max(limit * 5, limit, 1);
  const rows = await runStore.listAll(scan);
  rows.sort((a, b) => {
    const ka = runOrderKey(a);
    const kb = runOrderKey(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return rows.slice(0, limit);
}

/**
 * Recent failed runs, newest-first by finished_at (falling back to started_at).
 * Scans 5x `limit` so failures aren't missed when interleaved with successes.
 * Mirrors Rust `recent_failures`.
 */
export async function recentFailures(
  runStore: RequirementRunStore,
  limit: number,
): Promise<RequirementRun[]> {
  const scan = Math.max(limit * 5, limit);
  const rows = await runStore.listAll(scan);
  const failed = rows.filter((r) => r.status === "failed");
  failed.sort((a, b) => {
    const ka = runOrderKey(a);
    const kb = runOrderKey(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return failed.slice(0, limit);
}

// ----------------------- registration -----------------------------------

export function registerDiagnosticsRoutes(app: FastifyInstance, state: AppState): void {
  // GET /v1/diagnostics/worktrees/orphans
  app.get("/v1/diagnostics/worktrees/orphans", async (_req, reply) => {
    const root = requireWorktreeRoot(state, reply);
    if (!root) return reply;
    const runs = requireRunStore(state, reply);
    if (!runs) return reply;
    try {
      const items = await findOrphanWorktrees(root, runs);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // POST /v1/diagnostics/worktrees/orphans/cleanup
  app.post("/v1/diagnostics/worktrees/orphans/cleanup", async (_req, reply) => {
    const root = requireWorktreeRoot(state, reply);
    if (!root) return reply;
    const runs = requireRunStore(state, reply);
    if (!runs) return reply;
    // Rust falls back to cwd when workspace_root is unset; we keep the same
    // behaviour (process.cwd() is a constant of the running server, not env).
    const workspace = state.workspaceRoot ?? process.cwd();
    try {
      const orphans = await findOrphanWorktrees(root, runs);
      const report = await removeOrphanWorktrees(workspace, root, orphans);
      return reply.send(report);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // GET /v1/diagnostics/runs/stuck?threshold_seconds=&limit=
  app.get("/v1/diagnostics/runs/stuck", async (req, reply) => {
    const runs = requireRunStore(state, reply);
    if (!runs) return reply;
    const q = req.query as { threshold_seconds?: string; limit?: string };
    const threshold = intParam(q.threshold_seconds, DEFAULT_STUCK_SECONDS);
    const limit = intParam(q.limit, DEFAULT_SCAN_LIMIT, MAX_LIMIT);
    try {
      const items = await stuckRuns(runs, threshold, limit);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // GET /v1/diagnostics/runs/failed?limit=
  app.get("/v1/diagnostics/runs/failed", async (req, reply) => {
    const runs = requireRunStore(state, reply);
    if (!runs) return reply;
    const limit = intParam((req.query as { limit?: string }).limit, DEFAULT_FAILED_LIMIT, MAX_LIMIT);
    try {
      const items = await recentFailures(runs, limit);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // GET /v1/diagnostics/runs/recent?limit=
  app.get("/v1/diagnostics/runs/recent", async (req, reply) => {
    const runs = requireRunStore(state, reply);
    if (!runs) return reply;
    const limit = intParam((req.query as { limit?: string }).limit, DEFAULT_RECENT_LIMIT, MAX_LIMIT);
    try {
      const items = await recentRuns(runs, limit);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // GET /v1/diagnostics/memory
  //
  // Rust 503s when no MemoryStatsProvider is wired. Per the task ("else a
  // minimal snapshot"), we instead return a minimal snapshot so the dashboard
  // always renders something. When a provider is present, return its snapshot.
  app.get("/v1/diagnostics/memory", async (_req, reply) => {
    const provider = memoryStatsOf(state);
    if (provider) {
      try {
        return reply.send(provider.snapshot());
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
    }
    // Minimal snapshot — no internal counters available (e.g. SlidingWindow or
    // memory disabled). `backend: "unknown"` signals "no telemetry source".
    return reply.send({ backend: "unknown", stats_available: false });
  });
}
