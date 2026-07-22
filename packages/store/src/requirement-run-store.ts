// RequirementRunStore backends. Ported from harness-store/src/json_file.rs
// (`JsonFileRequirementRunStore`) + memory.rs (`MemoryRequirementRunStore`,
// `classify_run_event`).
//
// One row per execution attempt against a Requirement; runs are append-only
// history — there is intentionally NO delete. The store is an
// EventSource<RequirementRunEvent> AND exposes an out-of-band `broadcast`:
//
// - `upsert` classifies the prior→next transition (see `classifyRunEvent`):
//     absent → present, non-terminal     ⇒ `started`
//     (absent or present) → newly terminal ⇒ `finished`
//     otherwise (e.g. summary tweak in flight) ⇒ no event
// - `broadcast(event)` fans an event out WITHOUT writing — used by the
//   verification gate to emit a `verified` frame separately from the upsert
//   that persisted the verification result.
//
// `listForRequirement` returns the requirement's runs newest-first by
// `started_at`, capped at the 200-item soft cap. `listAll(limit)` walks every
// requirement partition for the diagnostics endpoints.
//
// Disk layout:
// `<base>/requirement_runs/<encodeId(requirementId)>/<encodeId(id)>.json`.
import path from "node:path";
import type {
  RequirementRun,
  RequirementRunEvent,
  RequirementRunStore,
  Unsubscribe,
  EventListener,
} from "@jarvis/project";
import { requirementRunStatusIsTerminal } from "@jarvis/project";
import { atomicWrite, encodeId, encodeIdSegment, ensureDir } from "./json-file.ts";
import { byDescString, listSubdirs, readJsonDir, readJsonFile } from "./fs-util.ts";
import { Fanout } from "./event-source.ts";

/** Soft cap on the number of runs returned per requirement. */
const RUN_LIST_CAP = 200;

/**
 * Derive the broadcast event for a prior→next run transition. Ported from
 * Rust's `classify_run_event`:
 *
 * - was-not-terminal → now-terminal ⇒ `finished`
 * - absent prior + non-terminal next ⇒ `started`
 * - otherwise ⇒ undefined (no event)
 */
export function classifyRunEvent(
  prior: RequirementRun | undefined,
  next: RequirementRun,
): RequirementRunEvent | undefined {
  const wasTerminal = prior !== undefined && requirementRunStatusIsTerminal(prior.status);
  const nowTerminal = requirementRunStatusIsTerminal(next.status);
  if (!wasTerminal && nowTerminal) {
    return { type: "finished", ...next };
  }
  if (prior === undefined && !nowTerminal) {
    return { type: "started", ...next };
  }
  return undefined;
}

export class JsonFileRequirementRunStore implements RequirementRunStore {
  readonly #root: string;
  readonly #fanout = new Fanout<RequirementRunEvent>();

  private constructor(root: string) {
    this.#root = root;
  }

  /**
   * Open or create a store at `<baseDir>/requirement_runs/`. Per-requirement
   * subdirectories are created lazily on first write.
   */
  static async open(baseDir: string): Promise<JsonFileRequirementRunStore> {
    const root = path.join(baseDir, "requirement_runs");
    await ensureDir(root);
    return new JsonFileRequirementRunStore(root);
  }

  subscribe(listener: EventListener<RequirementRunEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #requirementDir(requirementId: string): string {
    return path.join(this.#root, encodeIdSegment(requirementId));
  }

  #pathFor(requirementId: string, id: string): string {
    return path.join(this.#requirementDir(requirementId), `${encodeId(id)}.json`);
  }

  /** Walk every requirement subdir to find a run by its globally-unique id. */
  async #findById(id: string): Promise<RequirementRun | undefined> {
    const target = `${encodeId(id)}.json`;
    for (const sub of await listSubdirs(this.#root)) {
      const row = await readJsonFile<RequirementRun>(path.join(this.#root, sub, target));
      if (row !== undefined) return row;
    }
    return undefined;
  }

  async listForRequirement(requirementId: string): Promise<RequirementRun[]> {
    const rows = await readJsonDir<RequirementRun>(this.#requirementDir(requirementId));
    rows.sort((a, b) => byDescString(a.started_at, b.started_at));
    return rows.slice(0, RUN_LIST_CAP);
  }

  get(id: string): Promise<RequirementRun | undefined> {
    return this.#findById(id);
  }

  async listAll(limit: number): Promise<RequirementRun[]> {
    const rows: RequirementRun[] = [];
    for (const sub of await listSubdirs(this.#root)) {
      rows.push(...(await readJsonDir<RequirementRun>(path.join(this.#root, sub))));
    }
    rows.sort((a, b) => byDescString(a.started_at, b.started_at));
    return rows.slice(0, limit);
  }

  async upsert(run: RequirementRun): Promise<void> {
    const prior = await this.#findById(run.id);
    const dir = this.#requirementDir(run.requirement_id);
    await ensureDir(dir);
    await atomicWrite(this.#pathFor(run.requirement_id, run.id), JSON.stringify(run, null, 2));
    const event = classifyRunEvent(prior, run);
    if (event !== undefined) this.#fanout.emit(event);
  }

  broadcast(event: RequirementRunEvent): void {
    this.#fanout.emit(event);
  }
}

/**
 * In-memory RequirementRunStore. Backs tests + the server's no-DB fallback.
 * Same transition classification + ordering as the JSON-file backend.
 */
export class MemoryRequirementRunStore implements RequirementRunStore {
  readonly #rows = new Map<string, RequirementRun>();
  readonly #fanout = new Fanout<RequirementRunEvent>();

  subscribe(listener: EventListener<RequirementRunEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  listForRequirement(requirementId: string): Promise<RequirementRun[]> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.requirement_id === requirementId)
      .sort((a, b) => byDescString(a.started_at, b.started_at))
      .slice(0, RUN_LIST_CAP)
      .map((r) => structuredClone(r));
    return Promise.resolve(rows);
  }

  get(id: string): Promise<RequirementRun | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  listAll(limit: number): Promise<RequirementRun[]> {
    const rows = [...this.#rows.values()]
      .sort((a, b) => byDescString(a.started_at, b.started_at))
      .slice(0, limit)
      .map((r) => structuredClone(r));
    return Promise.resolve(rows);
  }

  upsert(run: RequirementRun): Promise<void> {
    const prior = this.#rows.get(run.id);
    this.#rows.set(run.id, structuredClone(run));
    const event = classifyRunEvent(prior, run);
    if (event !== undefined) this.#fanout.emit(event);
    return Promise.resolve();
  }

  broadcast(event: RequirementRunEvent): void {
    this.#fanout.emit(event);
  }
}
