// ChannelInstanceStore backends — JsonFile + Memory.
//
// Ported from crates/harness-store/src/json_file.rs (JsonFileChannelInstanceStore)
// + memory.rs (MemoryChannelInstanceStore). Same single flat-array-file pattern
// as the binding store — stored at `<baseDir>/channel_instances.json`. Volume
// is bounded by what the operator configures in Settings (typically <20 rows),
// so the whole-file rewrite on every mutation is cheap.
//
// Keyed by `id`. `upsert` overwrites the row with the matching id in place
// (else appends); `get` finds by id; `list` returns every row newest-first by
// `updated_at`; `delete` removes by id.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDir } from "@jarvis/store";
import type { ChannelInstance } from "./instance.ts";
import type { ChannelInstanceStore } from "./store.ts";

const FILE_NAME = "channel_instances.json";

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Newest-first by `updated_at` (RFC-3339 strings sort lexicographically). */
function byUpdatedDesc(a: ChannelInstance, b: ChannelInstance): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

/**
 * On-disk {@link ChannelInstanceStore}. Single flat-array JSON file at
 * `<baseDir>/channel_instances.json`, held in memory and rewritten atomically
 * on every mutation (load-once on `open`); missing / empty / corrupt files
 * start empty.
 */
export class JsonFileChannelInstanceStore implements ChannelInstanceStore {
  readonly #path: string;
  #state: ChannelInstance[];
  // Serialises every read-modify-write so each mutation reads `this.#state`
  // only after the prior one has committed — without it the `read #state` →
  // `await #flush` → `assign #state` window lets concurrent mutations
  // lost-update each other on disk and in memory. Mirrors
  // `JsonFileMemoryStore.#writeChain`.
  #writeChain: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, initial: ChannelInstance[]) {
    this.#path = filePath;
    this.#state = initial;
  }

  /** Run `fn` after all previously-enqueued guarded ops settle (serial). */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#writeChain.then(fn, fn);
    // Keep the chain alive on rejection, but don't let the stored promise carry
    // a rejection (which would surface as an unhandled rejection downstream).
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Open or create the store under `baseDir` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileChannelInstanceStore> {
    await ensureDir(baseDir);
    const filePath = path.join(baseDir, FILE_NAME);
    let initial: ChannelInstance[] = [];
    try {
      const bytes = await readFile(filePath, "utf8");
      if (bytes.length > 0) {
        try {
          const parsed = JSON.parse(bytes) as ChannelInstance[];
          if (Array.isArray(parsed)) initial = parsed;
        } catch {
          // Corrupt file → start empty (matches Rust's warn-and-continue).
        }
      }
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    return new JsonFileChannelInstanceStore(filePath, initial);
  }

  async #flush(snapshot: ChannelInstance[]): Promise<void> {
    await atomicWrite(this.#path, JSON.stringify(snapshot, null, 2));
  }

  upsert(instance: ChannelInstance): Promise<void> {
    return this.#withLock(async () => {
      const next = this.#state.map((i) => ({ ...i }));
      const slot = next.findIndex((i) => i.id === instance.id);
      if (slot !== -1) {
        next[slot] = { ...instance };
      } else {
        next.push({ ...instance });
      }
      await this.#flush(next);
      this.#state = next;
    });
  }

  get(id: string): Promise<ChannelInstance | undefined> {
    const row = this.#state.find((i) => i.id === id);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  list(): Promise<ChannelInstance[]> {
    const rows = this.#state.map((i) => ({ ...i })).sort(byUpdatedDesc);
    return Promise.resolve(rows);
  }

  delete(id: string): Promise<boolean> {
    return this.#withLock(async () => {
      const next = this.#state.filter((i) => i.id !== id);
      if (next.length === this.#state.length) return false;
      await this.#flush(next);
      this.#state = next;
      return true;
    });
  }
}

/**
 * In-memory {@link ChannelInstanceStore}. Backs tests + the server's no-DB
 * fallback. Same id key + newest-first ordering as the JSON-file backend.
 */
export class MemoryChannelInstanceStore implements ChannelInstanceStore {
  #rows: ChannelInstance[] = [];

  upsert(instance: ChannelInstance): Promise<void> {
    const slot = this.#rows.findIndex((i) => i.id === instance.id);
    if (slot !== -1) {
      this.#rows[slot] = { ...instance };
    } else {
      this.#rows.push({ ...instance });
    }
    return Promise.resolve();
  }

  get(id: string): Promise<ChannelInstance | undefined> {
    const row = this.#rows.find((i) => i.id === id);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  list(): Promise<ChannelInstance[]> {
    const rows = this.#rows.map((i) => ({ ...i })).sort(byUpdatedDesc);
    return Promise.resolve(rows);
  }

  delete(id: string): Promise<boolean> {
    const next = this.#rows.filter((i) => i.id !== id);
    if (next.length === this.#rows.length) return Promise.resolve(false);
    this.#rows = next;
    return Promise.resolve(true);
  }
}
