// Persistence traits for the observability + eval domains. Ported from
// crates/harness-observability/src/lib.rs (`ObservabilityStore`, `EvalStore`).
//
// In Rust these are `#[async_trait]` traits with async methods. In the Node
// port the async methods become `Promise`-returning interface methods. Neither
// trait carries an event-broadcast channel, so there is no EventSource here.
//
// Concrete backends (JSON-file + in-memory) live alongside this file in the
// same package — `./json-file.ts` and `./memory.ts`.
import type {
  DashboardSnapshot,
  EvalBaseline,
  EvalCaseResult,
  EvalFilter,
  EvalSuiteRun,
  MetricPoint,
  ObservabilityFilter,
  ObservedRun,
  ObservedSpanSummary,
  TimeWindow,
} from "./types.ts";

/**
 * Append-mostly store for ingested run / span / metric facts plus a derived
 * dashboard rollup. Appends are idempotent on id (last write wins).
 */
export interface ObservabilityStore {
  /** Persist (or overwrite) a single run fact. */
  appendRun(run: ObservedRun): Promise<void>;
  /** Persist (or overwrite) a single span summary. */
  appendSpanSummary(span: ObservedSpanSummary): Promise<void>;
  /** Persist (or overwrite) a single metric point. */
  appendMetricPoint(point: MetricPoint): Promise<void>;
  /**
   * Return runs matching `filter`, newest-first by `started_at`, bounded by
   * `filter.limit` when set.
   */
  listRuns(filter: ObservabilityFilter): Promise<ObservedRun[]>;
  /**
   * Aggregate a {@link DashboardSnapshot} over `window`: total / successful /
   * failed counts, success rate, p95 latency, and `by_kind` / `by_name`
   * histograms.
   */
  dashboard(window: TimeWindow): Promise<DashboardSnapshot>;
}

/**
 * Store for grader-driven evaluation runs, per-case results, and baselines.
 * Suite runs / case results / baselines are each keyed by their own id;
 * `save*` is upsert (last write wins). There is intentionally no delete —
 * eval history is append-only.
 */
export interface EvalStore {
  /** Persist (or overwrite) a suite run row. */
  saveSuiteRun(run: EvalSuiteRun): Promise<void>;
  /** Persist (or overwrite) a single case result. */
  saveCaseResult(result: EvalCaseResult): Promise<void>;
  /** Persist (or overwrite) a baseline snapshot. */
  saveBaseline(baseline: EvalBaseline): Promise<void>;
  /** Load a baseline by id. Resolves `undefined` when absent. */
  loadBaseline(id: string): Promise<EvalBaseline | undefined>;
  /**
   * Return case results matching `filter`, sorted by `id` descending, bounded
   * by `filter.limit` when set.
   */
  listCaseResults(filter: EvalFilter): Promise<EvalCaseResult[]>;
}
