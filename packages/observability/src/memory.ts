// In-memory ObservabilityStore + EvalStore backends. Back tests + the
// server's no-DB fallback. Same filter / ordering / dashboard semantics as the
// JSON-file backends, with no on-disk parity beyond that.
//
// Rust ships only the JSON-file backend for these stores; the Node port adds
// memory backends for symmetry with the rest of the store family. Rows are
// defensively cloned on the way in and out so a caller mutating its copy can't
// reach into the store.
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
import type { EvalStore, ObservabilityStore } from "./store.ts";
import { buildDashboard, runMatchesFilter } from "./dashboard.ts";
import { DEFAULT_MAX_OBSERVED_RUNS } from "./json-file.ts";

const DASHBOARD_SCAN_LIMIT = 10_000;

/** Newest-first comparator over an RFC-3339 string field (lexicographic). */
function byDescString(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export class MemoryObservabilityStore implements ObservabilityStore {
  // Insertion-ordered (Map preserves insertion order) so pruning the front
  // evicts the oldest-appended runs — the memory analogue of mtime pruning.
  readonly #runs = new Map<string, ObservedRun>();
  readonly #spans = new Map<string, ObservedSpanSummary>();
  readonly #metrics = new Map<string, MetricPoint>();
  #maxRuns: number | null;

  constructor(maxRuns: number | null = DEFAULT_MAX_OBSERVED_RUNS) {
    this.#maxRuns = maxRuns;
  }

  /** Override the runs retention cap; `null` disables pruning. */
  withMaxRuns(maxRuns: number | null): this {
    this.#maxRuns = maxRuns;
    return this;
  }

  appendRun(run: ObservedRun): Promise<void> {
    // Re-insert at the tail on overwrite so "newest appended" tracks the last
    // write (delete-then-set moves the key to the end of the Map's order).
    this.#runs.delete(run.id);
    this.#runs.set(run.id, structuredClone(run));
    // Clamp the effective cap to a floor of 1: a `maxRuns: 0` (or negative)
    // misconfig — distinct from `null`, which disables pruning — would
    // otherwise evict every run including the one just appended. See #322.
    const cap = this.#maxRuns === null ? null : Math.max(1, Math.floor(this.#maxRuns));
    if (cap !== null && this.#runs.size > cap) {
      const overflow = this.#runs.size - cap;
      const keys = this.#runs.keys();
      for (let i = 0; i < overflow; i += 1) {
        const next = keys.next();
        if (next.done) break;
        this.#runs.delete(next.value);
      }
    }
    return Promise.resolve();
  }

  appendSpanSummary(span: ObservedSpanSummary): Promise<void> {
    this.#spans.set(span.id, structuredClone(span));
    return Promise.resolve();
  }

  appendMetricPoint(point: MetricPoint): Promise<void> {
    this.#metrics.set(point.id, structuredClone(point));
    return Promise.resolve();
  }

  listRuns(filter: ObservabilityFilter): Promise<ObservedRun[]> {
    let rows = [...this.#runs.values()].filter((r) => runMatchesFilter(r, filter));
    rows.sort((a, b) => byDescString(a.started_at, b.started_at));
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return Promise.resolve(rows.map((r) => structuredClone(r)));
  }

  async dashboard(window: TimeWindow): Promise<DashboardSnapshot> {
    const rows = await this.listRuns({ limit: DASHBOARD_SCAN_LIMIT });
    return buildDashboard(rows, window, new Date().toISOString());
  }
}

export class MemoryEvalStore implements EvalStore {
  readonly #suites = new Map<string, EvalSuiteRun>();
  readonly #cases = new Map<string, EvalCaseResult>();
  readonly #baselines = new Map<string, EvalBaseline>();

  saveSuiteRun(run: EvalSuiteRun): Promise<void> {
    this.#suites.set(run.id, structuredClone(run));
    return Promise.resolve();
  }

  saveCaseResult(result: EvalCaseResult): Promise<void> {
    this.#cases.set(result.id, structuredClone(result));
    return Promise.resolve();
  }

  saveBaseline(baseline: EvalBaseline): Promise<void> {
    this.#baselines.set(baseline.id, structuredClone(baseline));
    return Promise.resolve();
  }

  loadBaseline(id: string): Promise<EvalBaseline | undefined> {
    const row = this.#baselines.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  listCaseResults(filter: EvalFilter): Promise<EvalCaseResult[]> {
    let rows = [...this.#cases.values()].filter(
      (r) =>
        (filter.suite === undefined || r.suite === filter.suite) &&
        (filter.suite_kind === undefined || r.suite_kind === filter.suite_kind) &&
        (filter.case_id === undefined || r.case_id === filter.case_id) &&
        (filter.outcome === undefined || r.outcome === filter.outcome),
    );
    rows.sort((a, b) => byDescString(a.id, b.id));
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return Promise.resolve(rows.map((r) => structuredClone(r)));
  }
}
