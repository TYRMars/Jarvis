// SkillLifecycleStore backends — JSON-file + in-memory.
//
// Ports the `SkillLifecycleStore` trait. Rows are keyed by `skill_name`.
// `upsert` stamps `created_at` (only if empty — preserved across overwrites)
// and always refreshes `updated_at`. `delete` is idempotent. `list` returns
// rows newest-updated first.
//
// Disk layout: `<base>/skill-lifecycle/<encodeId(skill_name)>.json`, one file
// per skill, atomic tmp+rename writes.
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type { SkillLifecycle } from "./skill-lifecycle.ts";
import type { SkillLifecycleStore } from "./store.ts";

// ---------- local fs helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

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

async function readJsonDir<T>(dir: string): Promise<T[]> {
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
    const row = await readJsonFile<T>(path.join(dir, name));
    if (row !== undefined) out.push(row);
  }
  return out;
}

/** Ascending by `skill_name` (matches Rust `SkillLifecycleStore::list`). */
function bySkillNameAsc(a: SkillLifecycle, b: SkillLifecycle): number {
  return a.skill_name < b.skill_name ? -1 : a.skill_name > b.skill_name ? 1 : 0;
}

/**
 * Stamp timestamps on an upserted row. `created_at` is preserved when a prior
 * row exists (or already set); `updated_at` is always refreshed. Returns a new
 * object (never mutates the input).
 */
function stamp(row: SkillLifecycle, prior: SkillLifecycle | undefined): SkillLifecycle {
  const now = new Date().toISOString();
  const createdAt = row.created_at !== "" ? row.created_at : (prior?.created_at ?? now);
  return { ...row, created_at: createdAt, updated_at: now };
}

// ---------- JSON-file backend ----------

export class JsonFileSkillLifecycleStore implements SkillLifecycleStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Open or create a store at `<baseDir>/skill-lifecycle/`. */
  static async open(baseDir: string): Promise<JsonFileSkillLifecycleStore> {
    const dir = path.join(baseDir, "skill-lifecycle");
    await ensureDir(dir);
    return new JsonFileSkillLifecycleStore(dir);
  }

  #pathFor(skillName: string): string {
    return path.join(this.#dir, `${encodeId(skillName)}.json`);
  }

  async list(): Promise<SkillLifecycle[]> {
    const rows = await readJsonDir<SkillLifecycle>(this.#dir);
    rows.sort(bySkillNameAsc);
    return rows;
  }

  async get(skillName: string): Promise<SkillLifecycle | undefined> {
    return readJsonFile<SkillLifecycle>(this.#pathFor(skillName));
  }

  async upsert(row: SkillLifecycle): Promise<SkillLifecycle> {
    const prior = await this.get(row.skill_name);
    const stamped = stamp(row, prior);
    await atomicWrite(this.#pathFor(stamped.skill_name), JSON.stringify(stamped, null, 2));
    return stamped;
  }

  async delete(skillName: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(skillName));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
}

// ---------- in-memory backend ----------

/** In-process SkillLifecycleStore. Same stamping / ordering as JSON-file. */
export class MemorySkillLifecycleStore implements SkillLifecycleStore {
  readonly #rows = new Map<string, SkillLifecycle>();

  list(): Promise<SkillLifecycle[]> {
    const rows = [...this.#rows.values()].sort(bySkillNameAsc).map((r) => ({ ...r }));
    return Promise.resolve(rows);
  }

  get(skillName: string): Promise<SkillLifecycle | undefined> {
    const row = this.#rows.get(skillName);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  upsert(row: SkillLifecycle): Promise<SkillLifecycle> {
    const prior = this.#rows.get(row.skill_name);
    const stamped = stamp(row, prior);
    this.#rows.set(stamped.skill_name, { ...stamped });
    return Promise.resolve({ ...stamped });
  }

  delete(skillName: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(skillName));
  }
}
