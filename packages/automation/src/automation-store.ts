// AutomationStore backends — JSON-file (default) + in-memory (tests / no-DB).
//
// Ported from the AutomationStore impls in crates/harness-store. Follows the
// structure of packages/store/src/project-memory-store.ts: a flat directory of
// one `<encodeId(id)>.json` file per task, atomic tmp+rename writes,
// percent-encoded id filenames, ENOENT → empty/undefined, and newest-first
// (`updated_at`-descending) list ordering. Reuses @jarvis/store's fs helpers.
//
// On-disk layout: one flat directory of files keyed by task id:
//
//   <base>/automations/<encodeId(id)>.json
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type { AutomationStore } from "./store.ts";
import type { AutomationTask } from "./task.ts";

// ---------- helpers --------------------------------------------------------

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
function byUpdatedDesc(a: AutomationTask, b: AutomationTask): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

// ---------- JSON-file backend ---------------------------------------------

export class JsonFileAutomationStore implements AutomationStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Open or create a store at `<base>/automations/` (created recursively if
   * missing).
   */
  static async open(base: string): Promise<JsonFileAutomationStore> {
    const dir = path.join(base, "automations");
    await ensureDir(dir);
    return new JsonFileAutomationStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async list(): Promise<AutomationTask[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: AutomationTask[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const task = await readJsonFile<AutomationTask>(path.join(this.#dir, name));
      if (task) rows.push(task);
    }
    rows.sort(byUpdatedDesc);
    return rows;
  }

  async get(id: string): Promise<AutomationTask | undefined> {
    return await readJsonFile<AutomationTask>(this.#pathFor(id));
  }

  async upsert(task: AutomationTask): Promise<void> {
    await atomicWrite(this.#pathFor(task.id), JSON.stringify(task, null, 2));
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

// ---------- in-memory backend ---------------------------------------------

/**
 * In-process AutomationStore. Tasks keyed by id. Backs tests and the server's
 * no-DB fallback. Returns deep copies (`structuredClone`) so callers can't
 * mutate stored rows in place — matching the JSON-file backend's
 * fresh-parse-per-read semantics and the `MemoryProjectStore` precedent. A
 * shallow spread would leave the nested `schedule` object shared by reference,
 * so a caller editing `loaded.schedule` would corrupt the stored row.
 */
export class MemoryAutomationStore implements AutomationStore {
  #rows = new Map<string, AutomationTask>();

  list(): Promise<AutomationTask[]> {
    const rows = [...this.#rows.values()].map((t) => structuredClone(t));
    rows.sort(byUpdatedDesc);
    return Promise.resolve(rows);
  }

  get(id: string): Promise<AutomationTask | undefined> {
    const t = this.#rows.get(id);
    return Promise.resolve(t ? structuredClone(t) : undefined);
  }

  upsert(task: AutomationTask): Promise<void> {
    this.#rows.set(task.id, structuredClone(task));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}
