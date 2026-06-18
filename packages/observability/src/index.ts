// @jarvis/observability — Eval* + Observed* value types + ObservabilityStore /
// EvalStore traits + JSON-file + in-memory backends.
//
// Ported from crates/harness-observability/src/lib.rs (value types + traits)
// and harness-store/src/json_file.rs (`JsonFileObservabilityStore` /
// `JsonFileEvalStore`). A true leaf domain: OTel stays the transport for full
// traces, this is the compact local fact store behind product dashboards,
// eval history, and baseline comparisons.

// ---------- types.ts ----------
export {
  type ObservedRunKind,
  type ObservedOutcome,
  type ObservedRun,
  type ObservedSpanSummary,
  type MetricKind,
  type MetricPoint,
  type TimeWindow,
  type ObservabilityFilter,
  type DashboardSnapshot,
  type EvalSuiteKind,
  type EvalGraderKind,
  type EvalGraderVerdict,
  type EvalFailureClass,
  type EvalGraderResult,
  type EvalSuiteRun,
  type EvalCaseResult,
  type EvalBaseline,
  type EvalFilter,
  DEFAULT_EVAL_SUITE_KIND,
  DEFAULT_EVAL_GRADER_KIND,
  DEFAULT_EVAL_GRADER_VERDICT,
  DEFAULT_EVAL_FAILURE_CLASS,
  timeWindowLast24h,
} from "./types.ts";

// ---------- store.ts ----------
export { type ObservabilityStore, type EvalStore } from "./store.ts";

// ---------- dashboard.ts ----------
export { buildDashboard, percentileLatency, runMatchesFilter } from "./dashboard.ts";

// ---------- json-file.ts ----------
export {
  JsonFileObservabilityStore,
  JsonFileEvalStore,
  DEFAULT_MAX_OBSERVED_RUNS,
} from "./json-file.ts";

// ---------- memory.ts ----------
export { MemoryObservabilityStore, MemoryEvalStore } from "./memory.ts";
