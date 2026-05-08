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

export interface ObservabilityWindow {
  label: string;
  since: string | null;
  until: string | null;
}

export interface HarnessObservabilityDashboard {
  window: ObservabilityWindow;
  generated_at: string;
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  run_success_rate: number | null;
  p95_latency_ms: number | null;
  by_kind: Record<string, number>;
  by_name: Record<string, number>;
}

export interface ObservedRunSummary {
  name: string;
  runs: number;
  success: number;
  errors: number;
  unknown: number;
  success_rate: number | null;
  median_duration_ms: number | null;
  p95_duration_ms: number | null;
  avg_duration_ms: number | null;
  avg_output_bytes: number | null;
  avg_frames: number | null;
  avg_tool_calls: number | null;
}

export interface EvalCaseResult {
  id: string;
  suite_run_id: string;
  case_id: string;
  suite: string;
  suite_kind: string;
  scenario: string;
  trial_index: number;
  trial_count: number | null;
  outcome: string;
  trace_id: string | null;
  transcript_artifact_id: string | null;
  failure_class: string | null;
  grader_results: Array<{
    id: string;
    kind: string;
    verdict: string;
    score: number | null;
    explanation: string | null;
    attributes: Record<string, unknown>;
    artifact_ids: string[];
  }>;
  scores: Record<string, unknown>;
  attributes: Record<string, unknown>;
  artifact_ids: string[];
}

export interface EvalTrialReliability {
  task_groups: number;
  pass_at_k: number | null;
  pass_all: number | null;
}

export interface EvalSummarySnapshot {
  generated_at: string;
  total_cases: number;
  passed_cases: number;
  pass_rate: number | null;
  capability_pass_rate: number | null;
  regression_pass_rate: number | null;
  trial_reliability: EvalTrialReliability;
  by_suite_kind: Record<string, number>;
  by_grader_kind: Record<string, number>;
  by_failure_class: Record<string, number>;
  transcript_cases: number;
}

export interface HarnessDirectionComponent {
  key: string;
  label: string;
  score: number;
  value: number | null;
  detail: string;
}

export interface HarnessDirectionRecommendation {
  key: string;
  priority: number;
  tone: string;
  title: string;
  detail: string;
  metric: string | null;
}

export interface HarnessDirectionSnapshot {
  generated_at: string;
  score: number;
  primary_focus: string;
  components: HarnessDirectionComponent[];
  recommendations: HarnessDirectionRecommendation[];
  sample: Record<string, unknown>;
}

export interface HarnessCapabilityDriver {
  key: string;
  label: string;
  value: number | null;
  weight: number;
  score: number;
  detail: string;
}

export interface HarnessCapabilityEvidence {
  kind: string;
  id: string;
  title: string;
  detail: string;
  metric: string | null;
  tone: string;
}

export interface HarnessCapabilityDimension {
  key: string;
  label: string;
  score: number;
  confidence: number;
  summary: string;
  drivers: HarnessCapabilityDriver[];
  evidence: HarnessCapabilityEvidence[];
}

export interface HarnessCapabilityScoreSnapshot {
  generated_at: string;
  overall_score: number;
  confidence: number;
  sample_count: number;
  dimensions: HarnessCapabilityDimension[];
  rules: Record<string, unknown>;
}

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

export async function fetchObservabilityDashboard(
  windowDays: WindowDays,
): Promise<HarnessObservabilityDashboard | null> {
  const r = await fetch(apiUrl(`/v1/observability/dashboard?window=${windowDays}d`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`observability dashboard ${r.status}`);
  return (await r.json()) as HarnessObservabilityDashboard;
}

export async function fetchToolSummary(
  limit = 8,
): Promise<ObservedRunSummary[] | null> {
  const r = await fetch(apiUrl(`/v1/observability/tools?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`tool summary ${r.status}`);
  const body = (await r.json()) as { tools: ObservedRunSummary[] };
  return body.tools;
}

export async function fetchSubagentSummary(
  limit = 8,
): Promise<ObservedRunSummary[] | null> {
  const r = await fetch(apiUrl(`/v1/observability/subagents?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`subagent summary ${r.status}`);
  const body = (await r.json()) as { subagents: ObservedRunSummary[] };
  return body.subagents;
}

export async function fetchEvalCases(
  limit = 100,
): Promise<EvalCaseResult[] | null> {
  const r = await fetch(apiUrl(`/v1/evals/cases?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`eval cases ${r.status}`);
  const body = (await r.json()) as { cases: EvalCaseResult[] };
  return body.cases;
}

export async function fetchEvalSummary(
  limit = 2000,
): Promise<EvalSummarySnapshot | null> {
  const r = await fetch(apiUrl(`/v1/evals/summary?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`eval summary ${r.status}`);
  return (await r.json()) as EvalSummarySnapshot;
}

export async function fetchHarnessDirection(
  limit = 2000,
): Promise<HarnessDirectionSnapshot | null> {
  const r = await fetch(apiUrl(`/v1/observability/direction?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`harness direction ${r.status}`);
  return (await r.json()) as HarnessDirectionSnapshot;
}

export async function fetchHarnessCapabilityScore(
  limit = 2000,
): Promise<HarnessCapabilityScoreSnapshot | null> {
  const r = await fetch(apiUrl(`/v1/observability/capability-score?limit=${limit}`));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`harness capability score ${r.status}`);
  return (await r.json()) as HarnessCapabilityScoreSnapshot;
}

export interface TelemetryExporterStatus {
  enabled: boolean;
  endpoint: string | null;
  protocol: string | null;
  service_name: string;
  service_env: string;
  sample_ratio: number;
}

export async function fetchTelemetryExporter(): Promise<TelemetryExporterStatus | null> {
  const r = await fetch(apiUrl('/v1/observability/exporter'));
  if (!r.ok) return null;
  return (await r.json()) as TelemetryExporterStatus;
}
