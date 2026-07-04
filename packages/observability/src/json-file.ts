// JSON-file ObservabilityStore + EvalStore backends. Ported from
// harness-store/src/json_file.rs (`JsonFileObservabilityStore`,
// `JsonFileEvalStore` + the `prune_oldest_files` / `read_json_records` /
// `read_json_optional` helpers).
//
// Disk layout:
//   observability: <base>/runs/<encodeId(id)>.json
//                  <base>/spans/<encodeId(id)>.json
//                  <base>/metrics/<encodeId(id)>.json
//                  <base>/dashboards/   (created for parity; unused by us)
//   eval:          <base>/suites/<encodeId(id)>.json
//                  <base>/cases/<encodeId(id)>.json
//                  <base>/baselines/<encodeId(id)>.json
//
// All writes go through @jarvis/store's atomic tmp+rename `atomicWrite`; ids
// are percent-encoded into filenames via `encodeId`. RFC-3339 timestamps live
// in the file body (never derived from mtime), except the prune heuristic,
// which uses mtime to pick the oldest `runs/*.json` to evict.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
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

/**
 * Default ceiling on `runs/*.json` files kept on disk. Mirrors Rust's
 * `DEFAULT_MAX_OBSERVED_RUNS`: without a cap the directory grows without bound
 * and the full-rescan `listRuns` / `dashboard` slow down linearly.
 */
export const DEFAULT_MAX_OBSERVED_RUNS = 2000;

const DASHBOARD_SCAN_LIMIT = 10_000;

// ---------- private fs helpers (local; @jarvis/store keeps these private) ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read every `<id>.json` under `dir` (skipping `.json.tmp` + unparseable). */
async function readJsonRecords<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
    let bytes: string;
    try {
      bytes = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    try {
      out.push(JSON.parse(bytes) as T);
    } catch {
      // unparseable → skip (matches Rust's silent `from_slice` discard)
    }
  }
  return out;
}

/** Read + parse one JSON file; undefined when missing (ENOENT). */
async function readJsonOptional<T>(filePath: string): Promise<T | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
  return JSON.parse(bytes) as T;
}

/** Newest-first comparator over an RFC-3339 string field (lexicographic). */
function byDescString(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Prune `dir` down to `max` files, deleting the oldest by mtime first.
 * Best-effort: any I/O error short-circuits silently so a flaky prune never
 * breaks the append that triggered it. Carries Rust's 10% slack so steady
 * state doesn't re-stat the whole directory on every append.
 */
async function pruneOldestFiles(dir: string, max: number): Promise<void> {
  // Clamp the effective cap to a floor of 1. A cap below 1 (e.g. a `maxRuns: 0`
  // misconfig, distinct from `null`-disables-pruning) would otherwise delete
  // every file — including the run that was just appended — since `slack`
  // becomes 0 and `toRemove` reaches `stamped.length`. Pruning to empty is
  // never the intent, so always retain at least the newest run. See #322.
  const cap = Math.max(1, Math.floor(max));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const candidates = names.filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"));
  const slack = Math.floor(cap / 10);
  if (candidates.length <= cap + slack) return;

  const stamped: Array<{ mtime: number; file: string }> = [];
  for (const name of candidates) {
    const file = path.join(dir, name);
    let mtime = 0;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      mtime = 0; // UNIX_EPOCH equivalent — sorts oldest
    }
    stamped.push({ mtime, file });
  }
  stamped.sort((a, b) => a.mtime - b.mtime);

  const toRemove = stamped.length - cap;
  for (let i = 0; i < toRemove; i += 1) {
    try {
      await rm(stamped[i].file);
    } catch {
      // best-effort
    }
  }
}

// ---------- ObservabilityStore ----------

export class JsonFileObservabilityStore implements ObservabilityStore {
  readonly #dir: string;
  /** Number caps `runs/` (oldest pruned on append); `null` disables pruning. */
  #maxRuns: number | null;

  private constructor(dir: string, maxRuns: number | null) {
    this.#dir = dir;
    this.#maxRuns = maxRuns;
  }

  /**
   * Open or create a store rooted at `dir`. Creates the `runs/` / `spans/` /
   * `metrics/` / `dashboards/` subdirectories. Defaults `runs/` retention to
   * {@link DEFAULT_MAX_OBSERVED_RUNS}.
   */
  static async open(dir: string): Promise<JsonFileObservabilityStore> {
    await ensureDir(dir);
    await ensureDir(path.join(dir, "runs"));
    await ensureDir(path.join(dir, "spans"));
    await ensureDir(path.join(dir, "metrics"));
    await ensureDir(path.join(dir, "dashboards"));
    return new JsonFileObservabilityStore(dir, DEFAULT_MAX_OBSERVED_RUNS);
  }

  /**
   * Override the `runs/` retention cap. A number keeps the newest `n` files;
   * `null` disables pruning entirely. Returns `this` for chaining (mirrors
   * Rust's `with_max_runs`).
   */
  withMaxRuns(maxRuns: number | null): this {
    this.#maxRuns = maxRuns;
    return this;
  }

  #runPath(id: string): string {
    return path.join(this.#dir, "runs", `${encodeId(id)}.json`);
  }

  #spanPath(id: string): string {
    return path.join(this.#dir, "spans", `${encodeId(id)}.json`);
  }

  #metricPath(id: string): string {
    return path.join(this.#dir, "metrics", `${encodeId(id)}.json`);
  }

  async appendRun(run: ObservedRun): Promise<void> {
    await atomicWrite(this.#runPath(run.id), JSON.stringify(run, null, 2));
    if (this.#maxRuns !== null) {
      await pruneOldestFiles(path.join(this.#dir, "runs"), this.#maxRuns);
    }
  }

  async appendSpanSummary(span: ObservedSpanSummary): Promise<void> {
    await atomicWrite(this.#spanPath(span.id), JSON.stringify(span, null, 2));
  }

  async appendMetricPoint(point: MetricPoint): Promise<void> {
    await atomicWrite(this.#metricPath(point.id), JSON.stringify(point, null, 2));
  }

  async listRuns(filter: ObservabilityFilter): Promise<ObservedRun[]> {
    let rows = await readJsonRecords<ObservedRun>(path.join(this.#dir, "runs"));
    rows = rows.filter((r) => runMatchesFilter(r, filter));
    rows.sort((a, b) => byDescString(a.started_at, b.started_at));
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows;
  }

  async dashboard(window: TimeWindow): Promise<DashboardSnapshot> {
    const rows = await this.listRuns({ limit: DASHBOARD_SCAN_LIMIT });
    return buildDashboard(rows, window, new Date().toISOString());
  }
}

// ---------- EvalStore ----------

export class JsonFileEvalStore implements EvalStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Open or create a store rooted at `dir`. Creates the `suites/` / `cases/`
   * / `baselines/` subdirectories.
   */
  static async open(dir: string): Promise<JsonFileEvalStore> {
    await ensureDir(dir);
    await ensureDir(path.join(dir, "suites"));
    await ensureDir(path.join(dir, "cases"));
    await ensureDir(path.join(dir, "baselines"));
    return new JsonFileEvalStore(dir);
  }

  #suitePath(id: string): string {
    return path.join(this.#dir, "suites", `${encodeId(id)}.json`);
  }

  #casePath(id: string): string {
    return path.join(this.#dir, "cases", `${encodeId(id)}.json`);
  }

  #baselinePath(id: string): string {
    return path.join(this.#dir, "baselines", `${encodeId(id)}.json`);
  }

  async saveSuiteRun(run: EvalSuiteRun): Promise<void> {
    await atomicWrite(this.#suitePath(run.id), JSON.stringify(run, null, 2));
  }

  async saveCaseResult(result: EvalCaseResult): Promise<void> {
    await atomicWrite(this.#casePath(result.id), JSON.stringify(result, null, 2));
  }

  async saveBaseline(baseline: EvalBaseline): Promise<void> {
    await atomicWrite(this.#baselinePath(baseline.id), JSON.stringify(baseline, null, 2));
  }

  loadBaseline(id: string): Promise<EvalBaseline | undefined> {
    return readJsonOptional<EvalBaseline>(this.#baselinePath(id));
  }

  async listCaseResults(filter: EvalFilter): Promise<EvalCaseResult[]> {
    let rows = await readJsonRecords<EvalCaseResult>(path.join(this.#dir, "cases"));
    rows = rows.filter(
      (r) =>
        (filter.suite === undefined || r.suite === filter.suite) &&
        (filter.suite_kind === undefined || r.suite_kind === filter.suite_kind) &&
        (filter.case_id === undefined || r.case_id === filter.case_id) &&
        (filter.outcome === undefined || r.outcome === filter.outcome),
    );
    // Sort by id descending (Rust `b.id.cmp(&a.id)`).
    rows.sort((a, b) => byDescString(a.id, b.id));
    if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows;
  }
}
