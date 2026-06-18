// SkillUsageStore backends — JSON-file + in-memory.
//
// Ports the `SkillUsageStore` trait's recording / listing / report behaviour.
// Append-only: `recordEvent` allocates `id` (UUID) + stamps `created_at`
// (ISO-8601) when the caller left them empty, then persists. `listEvents`
// returns newest-first (by `created_at` descending), filtered + capped.
// `report` folds the (already-filtered, already-capped) events into rows.
//
// Disk layout: `<base>/skill-usage/<encodeId(id)>.json`, one file per event,
// atomic tmp+rename writes (reusing @jarvis/store's helpers). A missing
// directory yields an empty list (graceful ENOENT).
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import {
  foldEventsIntoRows,
  skillUsageEventMatches,
  type SkillUsageEvent,
  type SkillUsageFilter,
  type SkillUsageRow,
} from "./skill-usage.ts";
import type { SkillUsageStore } from "./store.ts";

// ---------- local fs helpers (mirrors @jarvis/store/fs-util) ----------

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

/** Newest-first by `created_at` (RFC-3339 strings sort lexicographically). */
function byCreatedDesc(a: SkillUsageEvent, b: SkillUsageEvent): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/**
 * Stamp `id` + `created_at` on a freshly-recorded event when the caller left
 * them empty, returning a new event object (never mutates the input).
 */
function stamp(event: SkillUsageEvent): SkillUsageEvent {
  const stamped = { ...event };
  if (stamped.id === "") stamped.id = crypto.randomUUID();
  if (stamped.created_at === "") stamped.created_at = new Date().toISOString();
  return stamped;
}

/** Filter → newest-first → cap. Shared by both backends. */
function listFrom(events: readonly SkillUsageEvent[], filter: SkillUsageFilter): SkillUsageEvent[] {
  const rows = events.filter((e) => skillUsageEventMatches(e, filter)).sort(byCreatedDesc);
  return filter.limit !== undefined ? rows.slice(0, filter.limit) : rows;
}

// ---------- JSON-file backend ----------

export class JsonFileSkillUsageStore implements SkillUsageStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Open or create a store at `<baseDir>/skill-usage/` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileSkillUsageStore> {
    const dir = path.join(baseDir, "skill-usage");
    await ensureDir(dir);
    return new JsonFileSkillUsageStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async recordEvent(event: SkillUsageEvent): Promise<SkillUsageEvent> {
    const stamped = stamp(event);
    await atomicWrite(this.#pathFor(stamped.id), JSON.stringify(stamped, null, 2));
    return stamped;
  }

  async listEvents(filter: SkillUsageFilter): Promise<SkillUsageEvent[]> {
    const events = await readJsonDir<SkillUsageEvent>(this.#dir);
    return listFrom(events, filter);
  }

  async report(filter: SkillUsageFilter): Promise<SkillUsageRow[]> {
    // Widen the filter (drop `limit`) before folding so the report reflects
    // every matching event, not just the first page. Mirrors Rust's `report`.
    const { limit: _limit, ...wide } = filter;
    return foldEventsIntoRows(await this.listEvents(wide));
  }
}

// ---------- in-memory backend ----------

/**
 * In-process SkillUsageStore. Backs tests + the server's no-DB fallback. Same
 * stamping / ordering / fold semantics as the JSON-file backend.
 */
export class MemorySkillUsageStore implements SkillUsageStore {
  readonly #events: SkillUsageEvent[] = [];

  recordEvent(event: SkillUsageEvent): Promise<SkillUsageEvent> {
    const stamped = stamp(event);
    this.#events.push(stamped);
    return Promise.resolve({ ...stamped });
  }

  listEvents(filter: SkillUsageFilter): Promise<SkillUsageEvent[]> {
    return Promise.resolve(listFrom(this.#events, filter).map((e) => ({ ...e })));
  }

  async report(filter: SkillUsageFilter): Promise<SkillUsageRow[]> {
    // Widen the filter (drop `limit`) before folding so the report reflects
    // every matching event, not just the first page. Mirrors Rust's `report`.
    const { limit: _limit, ...wide } = filter;
    return foldEventsIntoRows(await this.listEvents(wide));
  }
}
