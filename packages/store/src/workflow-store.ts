// On-disk + in-memory WorkflowStore backends. Ported from
// harness-store/src/json_file.rs (JsonFileWorkflowStore) and the
// MemoryWorkflowStore test helper.
//
// One trait (`WorkflowStore` from @jarvis/workflow) covers two row families
// because runs live beside the definition they belong to. On disk they go in
// separate subdirs under the base dir, mirroring the Rust layout:
//
//   <base>/workflows/<id>.json        — WorkflowDefinition rows
//   <base>/workflow_runs/<id>.json    — WorkflowRun rows
//
// Both use the same `.tmp`+rename atomic write and percent-encoded id
// filenames as the conversation store. The WorkflowStore trait has NO event
// fan-out (the Rust trait carries no `subscribe`/`broadcast`), so neither
// backend emits — they are pure CRUD.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkflowDefinition, WorkflowRun, WorkflowStore } from "@jarvis/workflow";

import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";

// ---------- JSON-file backend ----------------------------------------------

/**
 * On-disk {@link WorkflowStore}. Definitions live under `<base>/workflows/`
 * and runs under `<base>/workflow_runs/`, one `<id>.json` each, written
 * atomically (`.tmp`+rename) like every other JSON-file store. Ids that
 * aren't `[A-Za-z0-9._-]` are percent-encoded for the filename.
 */
export class JsonFileWorkflowStore implements WorkflowStore {
  readonly #base: string;

  private constructor(base: string) {
    this.#base = base;
  }

  /** Open or create a store at `base` (created recursively if missing). */
  static async open(base: string): Promise<JsonFileWorkflowStore> {
    await ensureDir(base);
    return new JsonFileWorkflowStore(base);
  }

  #defsDir(): string {
    return path.join(this.#base, "workflows");
  }

  #runsDir(): string {
    return path.join(this.#base, "workflow_runs");
  }

  #defPath(id: string): string {
    return path.join(this.#defsDir(), `${encodeId(id)}.json`);
  }

  #runPath(id: string): string {
    return path.join(this.#runsDir(), `${encodeId(id)}.json`);
  }

  // ----- definitions -----

  async list(): Promise<WorkflowDefinition[]> {
    const rows = await readJsonDir<WorkflowDefinition>(this.#defsDir());
    // Newest-first by updated_at (RFC-3339 strings sort lexicographically).
    // Not required by the trait, but matches the Rust impl + the rest of the
    // store family.
    rows.sort((a, b) => cmpDesc(a.updated_at, b.updated_at));
    return rows;
  }

  async get(id: string): Promise<WorkflowDefinition | undefined> {
    return readJsonFile<WorkflowDefinition>(this.#defPath(id));
  }

  async upsert(def: WorkflowDefinition): Promise<void> {
    await ensureDir(this.#defsDir());
    await atomicWrite(this.#defPath(def.id), JSON.stringify(def, null, 2));
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.#defPath(id));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  // ----- runs -----

  async listRuns(
    workflowId: string | undefined,
    requirementId: string | undefined,
  ): Promise<WorkflowRun[]> {
    const rows = await readJsonDir<WorkflowRun>(this.#runsDir());
    const filtered = rows.filter(
      (r) =>
        (workflowId === undefined || r.workflow_id === workflowId) &&
        (requirementId === undefined || r.requirement_id === requirementId),
    );
    // Newest-first by started_at.
    filtered.sort((a, b) => cmpDesc(a.started_at, b.started_at));
    return filtered;
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    return readJsonFile<WorkflowRun>(this.#runPath(runId));
  }

  async upsertRun(run: WorkflowRun): Promise<void> {
    await ensureDir(this.#runsDir());
    await atomicWrite(this.#runPath(run.id), JSON.stringify(run, null, 2));
  }
}

// ---------- in-memory backend -----------------------------------------------

/**
 * In-memory {@link WorkflowStore}. Backs tests and the server's
 * "no DB configured" fallback. Not selectable via `connect()` — no durable
 * URL scheme maps to it. Stores deep clones so callers can't mutate rows
 * after handing them over (matching the on-disk round-trip semantics).
 */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly #defs = new Map<string, WorkflowDefinition>();
  readonly #runs = new Map<string, WorkflowRun>();

  list(): Promise<WorkflowDefinition[]> {
    const rows = [...this.#defs.values()].map(clone);
    rows.sort((a, b) => cmpDesc(a.updated_at, b.updated_at));
    return Promise.resolve(rows);
  }

  get(id: string): Promise<WorkflowDefinition | undefined> {
    const def = this.#defs.get(id);
    return Promise.resolve(def ? clone(def) : undefined);
  }

  upsert(def: WorkflowDefinition): Promise<void> {
    this.#defs.set(def.id, clone(def));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#defs.delete(id));
  }

  listRuns(
    workflowId: string | undefined,
    requirementId: string | undefined,
  ): Promise<WorkflowRun[]> {
    const rows = [...this.#runs.values()]
      .filter(
        (r) =>
          (workflowId === undefined || r.workflow_id === workflowId) &&
          (requirementId === undefined || r.requirement_id === requirementId),
      )
      .map(clone);
    rows.sort((a, b) => cmpDesc(a.started_at, b.started_at));
    return Promise.resolve(rows);
  }

  getRun(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.#runs.get(runId);
    return Promise.resolve(run ? clone(run) : undefined);
  }

  upsertRun(run: WorkflowRun): Promise<void> {
    this.#runs.set(run.id, clone(run));
    return Promise.resolve();
  }
}

// ---------- helpers ----------------------------------------------------------

/** Descending compare for RFC-3339 strings (newest first). */
function cmpDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read + parse a JSON file; undefined if missing, parse error, or a directory. */
async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e) || (e as { code?: string }).code === "EISDIR") return undefined;
    throw e;
  }
  try {
    return JSON.parse(bytes) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read every `*.json` (excluding `*.json.tmp`) in `dir` into `T`, skipping
 * unreadable / undecodable files. Returns an empty array when the directory
 * doesn't exist yet. Mirrors Rust's `read_json_dir`.
 */
async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const rows: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
    const row = await readJsonFile<T>(path.join(dir, name));
    if (row !== undefined) rows.push(row);
  }
  return rows;
}
