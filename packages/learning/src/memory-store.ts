// MemoryStore backends — JSON-file + in-memory.
//
// Ports the raw `MemoryMemoryStore` semantics PLUS the `GuardedMemoryStore`
// wrapper (crates/harness-store/src/learning_guard.rs) folded into one type:
// in Rust the validator + clamp + broadcast live in a wrapper around the raw
// store; here they live directly in the backend, since our `MemoryStore`
// interface already extends `EventSource<MemoryEvent>`.
//
// Write-path invariants (every backend):
//   - `upsert`: clamp title/body → validateMemorySafe (reject = throw, NO
//     persist) → allocate id if empty → set created_at if empty → ALWAYS
//     refresh updated_at → persist → emit `upserted`.
//   - `patch`: get → apply → validate (throw on fail) → refresh updated_at →
//     persist → emit `upserted`. A missing id resolves `undefined` WITHOUT
//     writing (a `delete` that landed first wins — no zombie row).
//   - `delete`: remove → emit `deleted` only when a row was removed.
//   - `list`: filter → sort pinned-first, then `updated_at` descending → cap.
//
// Disk layout: `<base>/memories/<encodeId(id)>.json`, one file per row.
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import { Fanout, type EventListener, type Unsubscribe } from "./event-source.ts";
import {
  applyMemoryPatch,
  clampMemoryFields,
  memoryDeletedEvent,
  memoryItemMatches,
  memoryUpsertedEvent,
  type MemoryEvent,
  type MemoryFilter,
  type MemoryItem,
  type MemoryPatch,
} from "./memory.ts";
import { MemoryRejectionError, validateMemorySafe } from "./validate.ts";
import type { MemoryStore } from "./store.ts";

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

// ---------- shared write-path logic ----------

/**
 * Pinned-first, then newest-updated. Mirrors Rust's
 * `b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at))`.
 */
function byPinnedThenUpdatedDesc(a: MemoryItem, b: MemoryItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

/** Filter → sort → cap. Shared by both backends. */
function listFrom(rows: readonly MemoryItem[], filter: MemoryFilter): MemoryItem[] {
  const out = rows.filter((m) => memoryItemMatches(m, filter)).sort(byPinnedThenUpdatedDesc);
  return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
}

/**
 * Clamp + validate + stamp a fresh upsert. Throws {@link MemoryRejectionError}
 * on a failed safety scan (caller must NOT persist). `prior` carries the
 * existing row's `created_at` (preserved across overwrites). Returns a new
 * item object — never mutates the input.
 */
function prepareUpsert(item: MemoryItem, prior: MemoryItem | undefined): MemoryItem {
  const prepared: MemoryItem = { ...item, tags: [...item.tags] };
  clampMemoryFields(prepared);
  const rejection = validateMemorySafe(prepared);
  if (rejection !== undefined) throw new MemoryRejectionError(rejection);

  const now = new Date().toISOString();
  if (prepared.created_at === "") {
    prepared.created_at = prior?.created_at ?? now;
  }
  prepared.updated_at = now;
  if (prepared.id === "") prepared.id = crypto.randomUUID();
  return prepared;
}

// ---------- JSON-file backend ----------

export class JsonFileMemoryStore implements MemoryStore {
  readonly #dir: string;
  readonly #fanout = new Fanout<MemoryEvent>();
  // Serialises the read-modify-write of `patch` against itself and against
  // `delete`, mirroring Rust's `write_lock: tokio::Mutex`. Without it the
  // `await get()` → `await atomicWrite()` window in `patch` could interleave
  // with a concurrent `delete`, resurrecting a just-removed row (a "zombie") —
  // exactly the race the MemoryStore trait doc says must not happen. Modelled
  // as a promise chain: each guarded op awaits the previous one before running.
  #writeChain: Promise<unknown> = Promise.resolve();

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Run `fn` after all previously-enqueued guarded ops settle (serial). */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#writeChain.then(fn, fn);
    // Keep the chain alive even if `fn` rejects, but don't let the stored
    // promise carry a rejection (which would surface as an unhandled rejection
    // when the next op chains off it).
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Open or create a store at `<baseDir>/memories/` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileMemoryStore> {
    const dir = path.join(baseDir, "memories");
    await ensureDir(dir);
    return new JsonFileMemoryStore(dir);
  }

  subscribe(listener: EventListener<MemoryEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async list(filter: MemoryFilter): Promise<MemoryItem[]> {
    const rows = await readJsonDir<MemoryItem>(this.#dir);
    return listFrom(rows, filter);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    return readJsonFile<MemoryItem>(this.#pathFor(id));
  }

  upsert(item: MemoryItem): Promise<MemoryItem> {
    // Serialise the get → atomicWrite read-modify-write on the same #writeChain
    // as `patch`/`delete`. Without the lock this window could interleave with a
    // concurrent `delete` (resurrecting a just-removed "zombie" row) or `patch`
    // (silently losing that update) — see issue #360.
    return this.#withLock(async () => {
      const prior = item.id !== "" ? await this.get(item.id) : undefined;
      const saved = prepareUpsert(item, prior);
      await atomicWrite(this.#pathFor(saved.id), JSON.stringify(saved, null, 2));
      this.#fanout.emit(memoryUpsertedEvent(saved));
      return saved;
    });
  }

  patch(id: string, patch: MemoryPatch): Promise<MemoryItem | undefined> {
    // The whole get → apply → validate → persist sequence runs under the
    // write lock, so a concurrent `delete` either lands before the get (we
    // observe the missing file → `undefined`, no resurrection) or after the
    // persist. Two `patch` calls serialise — neither loses the other's update.
    return this.#withLock(async () => {
      const existing = await this.get(id);
      if (existing === undefined) return undefined;
      const next: MemoryItem = { ...existing, tags: [...existing.tags] };
      applyMemoryPatch(patch, next);
      const rejection = validateMemorySafe(next);
      if (rejection !== undefined) throw new MemoryRejectionError(rejection);
      next.updated_at = new Date().toISOString();
      await atomicWrite(this.#pathFor(next.id), JSON.stringify(next, null, 2));
      this.#fanout.emit(memoryUpsertedEvent(next));
      return next;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.#withLock(async () => {
      let removed: boolean;
      try {
        await rm(this.#pathFor(id));
        removed = true;
      } catch (e) {
        if (isNotFound(e)) removed = false;
        else throw e;
      }
      if (removed) this.#fanout.emit(memoryDeletedEvent(id));
      return removed;
    });
  }
}

// ---------- in-memory backend ----------

/**
 * In-process MemoryStore. Rows keyed by id. Same clamp / validate / stamp /
 * fan-out / ordering semantics as the JSON-file backend.
 */
export class MemoryMemoryStore implements MemoryStore {
  readonly #rows = new Map<string, MemoryItem>();
  readonly #fanout = new Fanout<MemoryEvent>();

  subscribe(listener: EventListener<MemoryEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  list(filter: MemoryFilter): Promise<MemoryItem[]> {
    const rows = listFrom([...this.#rows.values()], filter).map((m) => structuredClone(m));
    return Promise.resolve(rows);
  }

  get(id: string): Promise<MemoryItem | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  // `async` (not bare `Promise.resolve`) so the validation throw inside
  // `prepareUpsert` surfaces as a rejected Promise — a synchronous throw here
  // would escape `await`.
  async upsert(item: MemoryItem): Promise<MemoryItem> {
    const prior = item.id !== "" ? this.#rows.get(item.id) : undefined;
    const saved = prepareUpsert(item, prior);
    this.#rows.set(saved.id, structuredClone(saved));
    this.#fanout.emit(memoryUpsertedEvent(saved));
    return saved;
  }

  // `async` for the same reason: the validation throw must become a rejection.
  async patch(id: string, patch: MemoryPatch): Promise<MemoryItem | undefined> {
    const existing = this.#rows.get(id);
    if (existing === undefined) return undefined;
    const next = structuredClone(existing);
    applyMemoryPatch(patch, next);
    const rejection = validateMemorySafe(next);
    if (rejection !== undefined) throw new MemoryRejectionError(rejection);
    next.updated_at = new Date().toISOString();
    this.#rows.set(next.id, structuredClone(next));
    this.#fanout.emit(memoryUpsertedEvent(next));
    return next;
  }

  delete(id: string): Promise<boolean> {
    const removed = this.#rows.delete(id);
    if (removed) this.#fanout.emit(memoryDeletedEvent(id));
    return Promise.resolve(removed);
  }
}
