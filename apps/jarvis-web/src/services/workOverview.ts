// Service for the Work-mode dashboard. Fetches the two aggregation
// endpoints (`/v1/work/overview` and `/v1/work/quality`) and surfaces
// typed payloads. 503 on either is mapped to `null` so the UI can
// render a "store unavailable" state instead of throwing.

import { apiUrl } from "./api";

export type RequirementStatusCounts = {
  backlog: number;
  in_progress: number;
  review: number;
  done: number;
};

export type RunStatusCounts = {
  completed: number;
  failed: number;
  cancelled: number;
};

export interface RunningRunRow {
  id: string;
  requirement_id: string;
  requirement_title: string | null;
  project_id: string | null;
  project_name: string | null;
  started_at: string;
  conversation_id: string;
  duration_ms: number | null;
}

export interface RecentFailureRow {
  id: string;
  requirement_id: string;
  requirement_title: string | null;
  project_id: string | null;
  project_name: string | null;
  error: string | null;
  finished_at: string | null;
  conversation_id: string;
}

export interface BlockedRequirementRow {
  id: string;
  project_id: string;
  project_name: string | null;
  title: string;
  blocked_since: string;
  reason: string | null;
}

export interface ThroughputBucket {
  date: string;
  runs_started: number;
  runs_completed: number;
  runs_failed: number;
  requirements_completed: number;
}

export interface ProjectLeaderboardRow {
  project_id: string;
  project_name: string;
  runs_in_window: number;
  completion_rate: number;
}

export interface WorkOverview {
  as_of: string;
  since: string;
  window_days: number;
  missing_stores: string[];
  truncated: boolean;
  blocked_truncated: boolean;
  requirement_status_counts: RequirementStatusCounts | null;
  running_now: RunningRunRow[];
  blocked_requirements: BlockedRequirementRow[] | null;
  run_status_counts: RunStatusCounts;
  verification_pass_rate: number | null;
  recent_failures: RecentFailureRow[];
  throughput_by_day: ThroughputBucket[];
  project_leaderboard: ProjectLeaderboardRow[] | null;
  /// Reserved for a future cross-project actor breakdown. Always
  /// `null` on the v1 endpoint.
  actor_breakdown: null;
}

export interface FailingCommandRow {
  command_normalized: string;
  fail_count: number;
  sample_stderr: string;
  last_seen: string | null;
}

export interface VerificationDayBucket {
  date: string;
  passed: number;
  failed: number;
  needs_review: number;
}

export interface WorkQuality {
  as_of: string;
  since: string;
  window_days: number;
  truncated: boolean;
  top_failing_commands: FailingCommandRow[];
  verification_pass_rate_by_day: VerificationDayBucket[];
}

export type WindowDays = 7 | 30 | 90;

/// Fetch the dashboard overview. Returns `null` on 503 so the UI can
/// render "feature unavailable" without conflating with real errors.
export async function fetchWorkOverview(
  windowDays: WindowDays,
): Promise<WorkOverview | null> {
  const r = await fetch(apiUrl(`/v1/work/overview?window_days=${windowDays}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`work overview ${r.status}`);
  return (await r.json()) as WorkOverview;
}

export async function fetchWorkQuality(
  windowDays: WindowDays,
): Promise<WorkQuality | null> {
  const r = await fetch(apiUrl(`/v1/work/quality?window_days=${windowDays}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`work quality ${r.status}`);
  return (await r.json()) as WorkQuality;
}
