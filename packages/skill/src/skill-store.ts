// SkillStore backends — per-scope skill activation state.
//
// Modelled on the @jarvis/store project-store family: a `JsonFile*` backend
// (static async `open(baseDir)`, atomic tmp+rename writes, percent-encoded id
// filenames, ENOENT → empty/undefined, newest-first list ordering) and a
// `Memory*` backend, both wired through a synchronous listener fan-out for the
// `SkillStore` EventSource.
//
// On-disk layout: `<base>/skill-activations/<encodeId(scope)>.json`, one file
// per scope, RFC-3339 timestamps in the body.
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type {
  EventListener,
  SkillActivationRecord,
  SkillActivationEvent,
  SkillStore,
  Unsubscribe,
} from "./store.ts";

// ---------- shared listener fan-out ----------

class Listeners<E> {
  #fns: Array<EventListener<E>> = [];

  subscribe(listener: EventListener<E>): Unsubscribe {
    this.#fns.push(listener);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.#fns.indexOf(listener);
      if (i !== -1) this.#fns.splice(i, 1);
    };
  }

  emit(event: E): void {
    for (const fn of [...this.#fns]) fn(event);
  }
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function byDescString(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Sorted, de-duplicated copy of `names` (deterministic on-disk form). */
function normaliseNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------- JSON-file backend ----------

export class JsonFileSkillStore implements SkillStore {
  readonly #dir: string;
  readonly #listeners = new Listeners<SkillActivationEvent>();
  // Per-scope write chains. activate/deactivate/clear do an unlocked
  // read-modify-write across an `await`; two concurrent same-scope
  // mutations would both read the same base record and the later
  // `atomicWrite` rename would clobber the earlier one (lost update).
  // Serialising per scope closes that window without blocking distinct
  // scopes against each other.
  readonly #locks = new Map<string, Promise<unknown>>();

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Run `fn` after all previously-enqueued ops for `scope` settle (serial). */
  #withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(scope) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Store a rejection-swallowing tail so a failing op doesn't surface as
    // an unhandled rejection when the next op chains off it.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(scope, tail);
    // Best-effort cleanup so the map doesn't grow unbounded once a scope
    // goes idle (skip if a newer op has already replaced the tail).
    void tail.then(() => {
      if (this.#locks.get(scope) === tail) this.#locks.delete(scope);
    });
    return run;
  }

  /** Open or create a store at `<baseDir>/skill-activations/` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileSkillStore> {
    const dir = path.join(baseDir, "skill-activations");
    await ensureDir(dir);
    return new JsonFileSkillStore(dir);
  }

  #pathFor(scope: string): string {
    return path.join(this.#dir, `${encodeId(scope)}.json`);
  }

  async #read(scope: string): Promise<SkillActivationRecord | undefined> {
    let bytes: string;
    try {
      bytes = await readFile(this.#pathFor(scope), "utf8");
    } catch (e) {
      if (isNotFound(e) || (e as { code?: string }).code === "EISDIR") return undefined;
      throw e;
    }
    try {
      return JSON.parse(bytes) as SkillActivationRecord;
    } catch {
      return undefined;
    }
  }

  async #write(record: SkillActivationRecord): Promise<void> {
    await atomicWrite(this.#pathFor(record.scope), JSON.stringify(record, null, 2));
  }

  async activeNames(scope: string): Promise<string[]> {
    const rec = await this.#read(scope);
    return rec ? [...rec.names] : [];
  }

  get(scope: string): Promise<SkillActivationRecord | undefined> {
    return this.#read(scope);
  }

  async list(limit: number): Promise<SkillActivationRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: SkillActivationRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      let bytes: string;
      try {
        bytes = await readFile(path.join(this.#dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        rows.push(JSON.parse(bytes) as SkillActivationRecord);
      } catch {
        // skip unparseable
      }
    }
    rows.sort((a, b) => byDescString(a.updated_at, b.updated_at));
    return rows.slice(0, limit);
  }

  activate(scope: string, name: string): Promise<boolean> {
    return this.#withLock(scope, async () => {
      const existing = await this.#read(scope);
      const now = new Date().toISOString();
      if (existing) {
        if (existing.names.includes(name)) return false;
        const next: SkillActivationRecord = {
          scope,
          names: normaliseNames([...existing.names, name]),
          created_at: existing.created_at,
          updated_at: now,
        };
        await this.#write(next);
      } else {
        await this.#write({ scope, names: [name], created_at: now, updated_at: now });
      }
      this.#listeners.emit({ type: "activated", scope, name });
      return true;
    });
  }

  deactivate(scope: string, name: string): Promise<boolean> {
    return this.#withLock(scope, async () => {
      const existing = await this.#read(scope);
      if (!existing || !existing.names.includes(name)) return false;
      const next: SkillActivationRecord = {
        scope,
        names: existing.names.filter((n) => n !== name),
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      await this.#write(next);
      this.#listeners.emit({ type: "deactivated", scope, name });
      return true;
    });
  }

  clear(scope: string): Promise<boolean> {
    return this.#withLock(scope, async () => {
      try {
        await rm(this.#pathFor(scope));
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
      this.#listeners.emit({ type: "cleared", scope });
      return true;
    });
  }

  subscribe(listener: EventListener<SkillActivationEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}

// ---------- in-memory backend ----------

export class MemorySkillStore implements SkillStore {
  readonly #rows = new Map<string, SkillActivationRecord>();
  readonly #listeners = new Listeners<SkillActivationEvent>();

  activeNames(scope: string): Promise<string[]> {
    const rec = this.#rows.get(scope);
    return Promise.resolve(rec ? [...rec.names] : []);
  }

  get(scope: string): Promise<SkillActivationRecord | undefined> {
    const rec = this.#rows.get(scope);
    return Promise.resolve(rec ? structuredClone(rec) : undefined);
  }

  list(limit: number): Promise<SkillActivationRecord[]> {
    const rows = [...this.#rows.values()]
      .sort((a, b) => byDescString(a.updated_at, b.updated_at))
      .slice(0, limit)
      .map((r) => structuredClone(r));
    return Promise.resolve(rows);
  }

  activate(scope: string, name: string): Promise<boolean> {
    const existing = this.#rows.get(scope);
    const now = new Date().toISOString();
    if (existing) {
      if (existing.names.includes(name)) return Promise.resolve(false);
      existing.names = normaliseNames([...existing.names, name]);
      existing.updated_at = now;
    } else {
      this.#rows.set(scope, { scope, names: [name], created_at: now, updated_at: now });
    }
    this.#listeners.emit({ type: "activated", scope, name });
    return Promise.resolve(true);
  }

  deactivate(scope: string, name: string): Promise<boolean> {
    const existing = this.#rows.get(scope);
    if (!existing || !existing.names.includes(name)) return Promise.resolve(false);
    existing.names = existing.names.filter((n) => n !== name);
    existing.updated_at = new Date().toISOString();
    this.#listeners.emit({ type: "deactivated", scope, name });
    return Promise.resolve(true);
  }

  clear(scope: string): Promise<boolean> {
    if (!this.#rows.delete(scope)) return Promise.resolve(false);
    this.#listeners.emit({ type: "cleared", scope });
    return Promise.resolve(true);
  }

  subscribe(listener: EventListener<SkillActivationEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}
