// RequirementStore backends. Ported from harness-store/src/json_file.rs
// (`JsonFileRequirementStore`) + memory.rs (`MemoryRequirementStore`).
//
// Requirements are the kanban backlog under each Project. The store is an
// EventSource<RequirementEvent>: `upsert` fans out an `upserted` frame after a
// successful write, `delete` fans out a `deleted` frame ONLY on the true path
// (a no-op delete of an absent id stays silent). There is intentionally NO
// soft-delete — Rust's `RequirementStore::delete` is a hard remove (the
// soft-delete lives on ProjectStore, not here).
//
// The fanned-out `upserted` frame carries the serde WIRE shape via
// `requirementUpsertedEvent` (drops the `#[serde(skip)]` `assignee_id` /
// `acceptance_policy` and a default `triage_state`), matching Rust exactly.
//
// `list(projectId)` returns the project's requirements sorted by `updated_at`
// descending, capped at the 500-item soft cap. The prompt's "filter by project
// + triage_state" is the project filter (the trait's `list`) plus the extra
// `listByTriageState` convenience below — REST mirrors this by filtering the
// `list` result on `triage_state`.
//
// Disk layout: `<base>/requirements/<encodeId(projectId)>/<encodeId(id)>.json`
// (partitioned by project so `list` is a single directory read).
import path from "node:path";
import { rm } from "node:fs/promises";
import type {
  Requirement,
  RequirementEvent,
  RequirementStore,
  TriageState,
  Unsubscribe,
  EventListener,
} from "@jarvis/project";
import {
  DEFAULT_TRIAGE_STATE,
  requirementDeletedEvent,
  requirementUpsertedEvent,
} from "@jarvis/project";
import { atomicWrite, encodeId, encodeSegment, ensureDir } from "./json-file.ts";
import { byDescString, isNotFound, listSubdirs, readJsonDir, readJsonFile } from "./fs-util.ts";
import { Fanout } from "./event-source.ts";

/** Soft cap on the number of requirements returned per project. */
const REQUIREMENT_LIST_CAP = 500;

/** A requirement's effective triage state (older rows default to `approved`). */
function effectiveTriage(req: Requirement): TriageState {
  return req.triage_state ?? DEFAULT_TRIAGE_STATE;
}

export class JsonFileRequirementStore implements RequirementStore {
  readonly #root: string;
  readonly #fanout = new Fanout<RequirementEvent>();

  private constructor(root: string) {
    this.#root = root;
  }

  /**
   * Open or create a store at `<baseDir>/requirements/`. Per-project
   * subdirectories are created lazily on first write.
   */
  static async open(baseDir: string): Promise<JsonFileRequirementStore> {
    const root = path.join(baseDir, "requirements");
    await ensureDir(root);
    return new JsonFileRequirementStore(root);
  }

  subscribe(listener: EventListener<RequirementEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #projectDir(projectId: string): string {
    return path.join(this.#root, encodeSegment(projectId));
  }

  #pathFor(projectId: string, id: string): string {
    return path.join(this.#projectDir(projectId), `${encodeId(id)}.json`);
  }

  /** Walk every project subdir to find a requirement by its globally-unique id. */
  async #findById(id: string): Promise<Requirement | undefined> {
    const target = `${encodeId(id)}.json`;
    for (const sub of await listSubdirs(this.#root)) {
      const row = await readJsonFile<Requirement>(path.join(this.#root, sub, target));
      if (row !== undefined) return row;
    }
    return undefined;
  }

  async list(projectId: string): Promise<Requirement[]> {
    const rows = await readJsonDir<Requirement>(this.#projectDir(projectId));
    rows.sort((a, b) => byDescString(a.updated_at, b.updated_at));
    return rows.slice(0, REQUIREMENT_LIST_CAP);
  }

  /**
   * Convenience: the project's requirements whose effective triage state
   * equals `triageState` (older rows without the field count as `approved`),
   * preserving the newest-first `list` ordering. Not part of the Rust trait —
   * mirrors the REST `?triage_state=` query filter applied over `list`.
   */
  async listByTriageState(projectId: string, triageState: TriageState): Promise<Requirement[]> {
    const rows = await this.list(projectId);
    return rows.filter((r) => effectiveTriage(r) === triageState);
  }

  get(id: string): Promise<Requirement | undefined> {
    return this.#findById(id);
  }

  async upsert(item: Requirement): Promise<void> {
    const dir = this.#projectDir(item.project_id);
    await ensureDir(dir);
    await atomicWrite(this.#pathFor(item.project_id, item.id), JSON.stringify(item, null, 2));
    this.#fanout.emit(requirementUpsertedEvent(item));
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.#findById(id);
    if (existing === undefined) return false;
    let removed: boolean;
    try {
      await rm(this.#pathFor(existing.project_id, existing.id));
      removed = true;
    } catch (e) {
      if (isNotFound(e)) removed = false;
      else throw e;
    }
    if (removed) {
      this.#fanout.emit(requirementDeletedEvent(existing.project_id, existing.id));
    }
    return removed;
  }
}

/**
 * In-memory RequirementStore. Backs tests + the server's no-DB fallback. Same
 * event semantics + ordering as the JSON-file backend.
 */
export class MemoryRequirementStore implements RequirementStore {
  readonly #rows = new Map<string, Requirement>();
  readonly #fanout = new Fanout<RequirementEvent>();

  subscribe(listener: EventListener<RequirementEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  list(projectId: string): Promise<Requirement[]> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.project_id === projectId)
      .sort((a, b) => byDescString(a.updated_at, b.updated_at))
      .slice(0, REQUIREMENT_LIST_CAP)
      .map((r) => structuredClone(r));
    return Promise.resolve(rows);
  }

  async listByTriageState(projectId: string, triageState: TriageState): Promise<Requirement[]> {
    const rows = await this.list(projectId);
    return rows.filter((r) => effectiveTriage(r) === triageState);
  }

  get(id: string): Promise<Requirement | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  upsert(item: Requirement): Promise<void> {
    this.#rows.set(item.id, structuredClone(item));
    this.#fanout.emit(requirementUpsertedEvent(item));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row) return Promise.resolve(false);
    this.#rows.delete(id);
    this.#fanout.emit(requirementDeletedEvent(row.project_id, id));
    return Promise.resolve(true);
  }
}
