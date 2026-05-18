// Service layer for Phase 5b/5c diagnostics. Read-only on the
// listing side; the orphan cleanup POST returns a report.

import type { RequirementRun } from "../types/frames";
import { apiUrl } from "./api";

export interface OrphanWorktree {
  path: string;
  run_id: string;
  size_bytes: number;
  modified_at: string;
}

interface OrphansResponse {
  items: OrphanWorktree[];
}

export interface CleanupReport {
  attempted: number;
  removed: number;
  errors: { path: string; reason: string }[];
}

/// Returns 503 when the worktree feature isn't enabled. Caller
/// should treat that as "feature unavailable" rather than an
/// error.
export async function listOrphanWorktrees(): Promise<OrphanWorktree[] | null> {
  const r = await fetch(apiUrl("/v1/diagnostics/worktrees/orphans"));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`orphans list: ${r.status}`);
  const body = (await r.json()) as OrphansResponse;
  return body.items;
}

export async function cleanupOrphanWorktrees(): Promise<CleanupReport> {
  const r = await fetch(apiUrl("/v1/diagnostics/worktrees/orphans/cleanup"), {
    method: "POST",
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`orphans cleanup ${r.status}: ${text}`);
  }
  return (await r.json()) as CleanupReport;
}

// ---- Phase 5c: stuck + recent-failure detectors ----

/// `RequirementRun` extended with the server-computed
/// `age_seconds` (a row that's been Pending/Running too long).
export interface StuckRun extends RequirementRun {
  age_seconds: number;
}

interface StuckResponse {
  items: StuckRun[];
}

interface FailedResponse {
  items: RequirementRun[];
}

/// 503 = run store not configured.
export async function listStuckRuns(
  thresholdSeconds = 3600,
  limit = 500,
): Promise<StuckRun[] | null> {
  const r = await fetch(
    apiUrl(
      `/v1/diagnostics/runs/stuck?threshold_seconds=${thresholdSeconds}&limit=${limit}`,
    ),
  );
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`stuck list: ${r.status}`);
  const body = (await r.json()) as StuckResponse;
  return body.items;
}

export async function listFailedRuns(limit = 20): Promise<RequirementRun[] | null> {
  const r = await fetch(apiUrl(`/v1/diagnostics/runs/failed?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`failed list: ${r.status}`);
  const body = (await r.json()) as FailedResponse;
  return body.items;
}

interface RecentResponse {
  items: RequirementRun[];
}

/// Newest-first run history across every requirement (mixed status).
/// Sorted by `finished_at` desc, falling back to `started_at` for
/// rows still in flight. Returns `null` on 503 (run store absent).
export async function listRecentRuns(limit = 50): Promise<RequirementRun[] | null> {
  const r = await fetch(apiUrl(`/v1/diagnostics/runs/recent?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`recent runs: ${r.status}`);
  const body = (await r.json()) as RecentResponse;
  return body.items;
}

// ---- Memory / compaction counters (M1.2 + P8) ----

/// Snapshot returned by GET /v1/diagnostics/memory. All numeric
/// fields are monotonic counters since process start; consumers
/// compute ratios (cache hit rate, failure rate) over deltas if
/// they want windowed metrics.
///
/// `backend` is the only required field. `"summarizing"` ships the
/// full counter set; `"sliding"` only fills `compactions_total` +
/// `window_dropped` and leaves the LLM/cache/PTL fields undefined.
/// Future backends may add more labels — treat unknown values as
/// "render what's present, hide what's missing".
export interface MemoryStats {
  backend: string;
  compactions_total?: number;
  /// `sliding` backend only — calls that dropped ≥1 turn.
  window_dropped?: number;
  /// Summarizing-backend fields. All undefined under `sliding`.
  summary_required?: number;
  cache_hits_memory?: number;
  cache_hits_store?: number;
  llm_calls?: number;
  llm_failures?: number;
  circuit_skips?: number;
  circuit_opens?: number;
  ptl_round_one?: number;
  ptl_round_two?: number;
}

/// 503 = no memory stats provider configured (e.g. the binary is
/// running with `SlidingWindowMemory` or memory was disabled).
export async function getMemoryStats(): Promise<MemoryStats | null> {
  const r = await fetch(apiUrl("/v1/diagnostics/memory"));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`memory stats: ${r.status}`);
  return (await r.json()) as MemoryStats;
}

/// Fetch a single run by id. Used by the auto-mode dashboard's
/// run-detail drawer. Returns `null` on 404 / 503 / network error
/// so the drawer can render a friendly empty state.
export async function getRun(runId: string): Promise<RequirementRun | null> {
  try {
    const r = await fetch(apiUrl(`/v1/runs/${encodeURIComponent(runId)}`));
    if (!r.ok) return null;
    return (await r.json()) as RequirementRun;
  } catch (e) {
    console.warn(`get run ${runId} failed`, e);
    return null;
  }
}
