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
