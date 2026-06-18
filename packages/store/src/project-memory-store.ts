// ProjectMemoryStore backends — JSON-file + in-memory.
//
// Ported from the ProjectMemoryStore impls in crates/harness-store/src/memory.rs
// (MemoryProjectMemoryStore). Rust ships only an in-memory backend here, but
// the Node port adds a JSON-file backend for parity with the other families.
//
// No event fanout: ProjectMemoryStore does NOT extend EventSource — memories
// don't drive real-time UI, clients re-list. Rows are keyed by id; project
// scoping is a runtime filter on `list`. `upsert` overwrites by id and does
// NOT mutate `updated_at` (callers own that via touchProjectMemory).
//
// On-disk layout: one flat directory of files keyed by memory id:
//
//   <base>/project-memories/<encodeId(id)>.json
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ProjectMemory, ProjectMemoryStore } from "@jarvis/project";
import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";

/** Soft cap on the number of rows returned by `list` for one project. */
const MEMORY_LIST_CAP = 200;

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read + parse a JSON file; undefined if missing, a directory, or unparseable. */
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

/** Newest-first by `updated_at` (RFC-3339 strings sort lexicographically). */
function byUpdatedDesc(a: ProjectMemory, b: ProjectMemory): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

// ---------- JSON-file backend ----------

export class JsonFileProjectMemoryStore implements ProjectMemoryStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Open or create a store at `<base>/project-memories/` (created recursively
   * if missing).
   */
  static async open(base: string): Promise<JsonFileProjectMemoryStore> {
    const dir = path.join(base, "project-memories");
    await ensureDir(dir);
    return new JsonFileProjectMemoryStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async list(projectId: string): Promise<ProjectMemory[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: ProjectMemory[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const item = await readJsonFile<ProjectMemory>(path.join(this.#dir, name));
      if (item && item.project_id === projectId) rows.push(item);
    }
    rows.sort(byUpdatedDesc);
    return rows.slice(0, MEMORY_LIST_CAP);
  }

  async get(id: string): Promise<ProjectMemory | undefined> {
    return await readJsonFile<ProjectMemory>(this.#pathFor(id));
  }

  async upsert(memory: ProjectMemory): Promise<void> {
    await atomicWrite(this.#pathFor(memory.id), JSON.stringify(memory, null, 2));
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(id));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
}

// ---------- in-memory backend ----------

/**
 * In-process ProjectMemoryStore. Memories keyed by id; project scoping is a
 * runtime filter on `list`. Backs tests and the server's no-DB fallback.
 */
export class MemoryProjectMemoryStore implements ProjectMemoryStore {
  #rows = new Map<string, ProjectMemory>();

  list(projectId: string): Promise<ProjectMemory[]> {
    const rows = [...this.#rows.values()].filter((m) => m.project_id === projectId);
    rows.sort(byUpdatedDesc);
    return Promise.resolve(rows.slice(0, MEMORY_LIST_CAP).map((m) => ({ ...m })));
  }

  get(id: string): Promise<ProjectMemory | undefined> {
    const m = this.#rows.get(id);
    return Promise.resolve(m ? { ...m } : undefined);
  }

  upsert(memory: ProjectMemory): Promise<void> {
    this.#rows.set(memory.id, { ...memory });
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}
