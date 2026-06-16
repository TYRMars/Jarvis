// Observability + eval value types. Ported from
// crates/harness-observability/src/lib.rs.
//
// Two related fact families share this module because they share the same
// "is the system doing well?" audience:
//
//   - Observed* — ingested run / span / metric facts (OTel stays the transport
//     for full traces; these are the compact local rollups behind product
//     dashboards).
//   - Eval* — grader-driven evaluation runs + baselines.
//
// Both deliberately carry flexible JSON attribute bags (`attributes`,
// `metrics`, `summary`, `cases`, `scores`, `by_kind`, `by_name`) so evolving
// OTel / GenAI field names don't force a schema migration for every addition.
//
// Serde mapping notes:
//   - Rust `enum`s with `rename_all = "snake_case"` → string-literal unions.
//   - `#[serde(default)] field: Value` (no skip_serializing_if) defaults to
//     `Value::Null` and is ALWAYS serialized → here a required `JsonValue`
//     field that callers set to `null` when empty.
//   - `#[serde(default, skip_serializing_if = "Option::is_none")]` → optional
//     field, absent on the wire when undefined.
//   - `#[serde(default, skip_serializing_if = "Vec::is_empty")]` → optional
//     `string[]` field, absent on the wire when empty.
//   - `u64` / `u32` / `usize` / `f64` all map to `number`.
import type { JsonValue } from "@jarvis/core";

// ---------- ObservedRun / spans / metrics ----------

/** The kind of work an {@link ObservedRun} captures. */
export type ObservedRunKind = "agent" | "subagent" | "eval" | "tool" | "provider" | "other";

/** Terminal disposition of a run / span / suite. */
export type ObservedOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancelled"
  | "max_iterations"
  | "unknown";

/** A single ingested run fact — one agent / tool / provider / eval invocation. */
export interface ObservedRun {
  id: string;
  trace_id?: string;
  span_id?: string;
  parent_run_id?: string;
  kind: ObservedRunKind;
  name: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  outcome: ObservedOutcome;
  conversation_id?: string;
  project_id?: string;
  workspace_hash?: string;
  /** Flexible attribute bag; `null` when empty (serde default `Value::Null`). */
  attributes: JsonValue;
  /** Flexible numeric/metric bag; `null` when empty. */
  metrics: JsonValue;
  /** Absent on the wire when empty. */
  artifact_ids?: string[];
}

/** A compact rollup of a single OTel span. */
export interface ObservedSpanSummary {
  id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  run_id?: string;
  name: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  outcome: ObservedOutcome;
  attributes: JsonValue;
  artifact_ids?: string[];
}

/** OTel-style metric kind. */
export type MetricKind = "counter" | "gauge" | "histogram";

/** A single point on a metric series. */
export interface MetricPoint {
  id: string;
  name: string;
  kind: MetricKind;
  timestamp: string;
  value: number;
  attributes: JsonValue;
}

/**
 * A labelled time window for dashboards. `since` / `until` are optional
 * RFC-3339 bounds; absent means "open" on that side.
 */
export interface TimeWindow {
  label: string;
  since?: string;
  until?: string;
}

/** The last-24h preset window (Rust `TimeWindow::last_24h`). */
export function timeWindowLast24h(): TimeWindow {
  return { label: "24h" };
}

/**
 * Filter for {@link ObservabilityStore.listRuns}. Every field is optional; an
 * empty filter (the Rust `Default`) returns everything (bounded by `limit`).
 */
export interface ObservabilityFilter {
  kind?: ObservedRunKind;
  name?: string;
  outcome?: ObservedOutcome;
  project_id?: string;
  limit?: number;
}

/**
 * Aggregated dashboard view over a window. `run_success_rate` /
 * `p95_latency_ms` are absent when there are no runs (resp. no durations).
 * `by_kind` / `by_name` are `{ <key>: count }` objects (serde default
 * `Value::Null` would never appear in practice — they're always built).
 */
export interface DashboardSnapshot {
  window: TimeWindow;
  generated_at: string;
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  run_success_rate?: number;
  p95_latency_ms?: number;
  by_kind: JsonValue;
  by_name: JsonValue;
}

// ---------- Eval* ----------

/** Eval-suite category. Default (`#[default]`) is `capability`. */
export type EvalSuiteKind = "capability" | "regression" | "smoke" | "other";

/** Default {@link EvalSuiteKind} (Rust `#[default]`). */
export const DEFAULT_EVAL_SUITE_KIND: EvalSuiteKind = "capability";

/** How a case was graded. Default is `deterministic_test`. */
export type EvalGraderKind =
  | "deterministic_test"
  | "static_analysis"
  | "state_check"
  | "tool_call"
  | "transcript"
  | "llm_rubric"
  | "human_review"
  | "other";

/** Default {@link EvalGraderKind} (Rust `#[default]`). */
export const DEFAULT_EVAL_GRADER_KIND: EvalGraderKind = "deterministic_test";

/** A grader's verdict on a case. Default is `unknown`. */
export type EvalGraderVerdict = "pass" | "fail" | "needs_review" | "flaky" | "unknown";

/** Default {@link EvalGraderVerdict} (Rust `#[default]`). */
export const DEFAULT_EVAL_GRADER_VERDICT: EvalGraderVerdict = "unknown";

/** Why a case failed, for triage. Default is `unknown`. */
export type EvalFailureClass =
  | "agent_error"
  | "grader_bug"
  | "ambiguous_task"
  | "infra_flake"
  | "safety_refusal"
  | "unknown";

/** Default {@link EvalFailureClass} (Rust `#[default]`). */
export const DEFAULT_EVAL_FAILURE_CLASS: EvalFailureClass = "unknown";

/** One grader's result on one case. */
export interface EvalGraderResult {
  id: string;
  kind: EvalGraderKind;
  verdict: EvalGraderVerdict;
  score?: number;
  explanation?: string;
  attributes: JsonValue;
  artifact_ids?: string[];
}

/** A single run of an eval suite. */
export interface EvalSuiteRun {
  id: string;
  suite: string;
  /** Defaults to `capability`; serde default field (always present). */
  suite_kind: EvalSuiteKind;
  started_at: string;
  ended_at?: string;
  outcome: ObservedOutcome;
  baseline_id?: string;
  trials_requested?: number;
  attributes: JsonValue;
}

/** The result of a single case (one trial) within a suite run. */
export interface EvalCaseResult {
  id: string;
  suite_run_id: string;
  case_id: string;
  suite: string;
  suite_kind: EvalSuiteKind;
  scenario: string;
  /** Defaults to 0 (serde default field, always present). */
  trial_index: number;
  trial_count?: number;
  outcome: ObservedOutcome;
  trace_id?: string;
  transcript_artifact_id?: string;
  failure_class?: EvalFailureClass;
  /** Absent on the wire when empty. */
  grader_results?: EvalGraderResult[];
  scores: JsonValue;
  attributes: JsonValue;
  artifact_ids?: string[];
}

/** A frozen snapshot used as a comparison baseline for a suite. */
export interface EvalBaseline {
  id: string;
  suite: string;
  suite_kind: EvalSuiteKind;
  created_at: string;
  git_ref?: string;
  model?: string;
  summary: JsonValue;
  cases: JsonValue;
}

/**
 * Filter for {@link EvalStore.listCaseResults}. Every field optional; empty
 * filter returns everything (bounded by `limit`).
 */
export interface EvalFilter {
  suite?: string;
  suite_kind?: EvalSuiteKind;
  case_id?: string;
  outcome?: ObservedOutcome;
  limit?: number;
}
