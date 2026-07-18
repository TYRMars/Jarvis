// ActivityStore backends — append-only per-Requirement audit timeline.
//
// Ported from crates/harness-store/src/{json_file.rs,memory.rs} (the
// `*ActivityStore` impls). One row per "thing that happened" against a kanban
// Requirement. Append-only by design: no update, no delete.
//
// `listForRequirement` returns newest-first by `created_at` (RFC-3339 strings
// sort lexicographically), soft-capped at 500. `append` writes one row then
// synchronously fans out an `{ type: "appended", ...activity }` event to every
// subscriber — the Node stand-in for Rust's `tokio::sync::broadcast`.
//
// On-disk layout (partitioned by requirement, mirrors Rust):
//   <base>/activities/<encodeId(requirement_id)>/<encodeId(id)>.json
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  Activity,
  ActivityEvent,
  ActivityStore,
  EventListener,
  Unsubscribe,
} from "@jarvis/project";
import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";

/** Newest-installed-first soft cap shared by both backends (matches Rust). */
const LIST_CAP = 500;

// ---------- shared listener fan-out ----------

/**
 * Synchronous in-process listener registry — the Node mirror of Rust's
 * `broadcast::Sender`. `subscribe` appends a listener and returns an
 * idempotent detach fn; `emit` notifies every current listener. Delivery is
 * synchronous so listeners can never lag.
 */
class Listeners<E> {
  #fns: EventListener<E>[] = [];

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
    // Iterate a snapshot so a listener that unsubscribes during delivery
    // doesn't perturb the loop.
    for (const fn of [...this.#fns]) {
      try {
        fn(event);
      } catch {
        // Isolate listener faults; the mutation already succeeded. A throwing
        // subscriber must not reject the already-committed write or starve
        // listeners registered after it.
      }
    }
  }
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Newest-first by `created_at`, soft-capped at {@link LIST_CAP}. */
function sortNewestFirstCapped(rows: Activity[]): Activity[] {
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  if (rows.length > LIST_CAP) rows.length = LIST_CAP;
  return rows;
}

// ---------- JSON-file backend ----------

export class JsonFileActivityStore implements ActivityStore {
  readonly #base: string;
  readonly #listeners = new Listeners<ActivityEvent>();

  private constructor(base: string) {
    this.#base = base;
  }

  /** Open or create a store rooted at `base` (the `activities/` subdir is created lazily). */
  static async open(base: string): Promise<JsonFileActivityStore> {
    await ensureDir(base);
    return new JsonFileActivityStore(base);
  }

  #requirementDir(requirementId: string): string {
    return path.join(this.#base, "activities", encodeId(requirementId));
  }

  #pathFor(requirementId: string, id: string): string {
    return path.join(this.#requirementDir(requirementId), `${encodeId(id)}.json`);
  }

  async listForRequirement(requirementId: string): Promise<Activity[]> {
    const dir = this.#requirementDir(requirementId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: Activity[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      let bytes: string;
      try {
        bytes = await readFile(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        rows.push(JSON.parse(bytes) as Activity);
      } catch {
        // Unparseable row → skip, matching Rust's `if let Ok(..)`.
      }
    }
    return sortNewestFirstCapped(rows);
  }

  async append(activity: Activity): Promise<void> {
    const dir = this.#requirementDir(activity.requirement_id);
    await ensureDir(dir);
    await atomicWrite(this.#pathFor(activity.requirement_id, activity.id), JSON.stringify(activity, null, 2));
    this.#listeners.emit({ type: "appended", ...activity });
  }

  subscribe(listener: EventListener<ActivityEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}

// ---------- in-memory backend ----------

export class MemoryActivityStore implements ActivityStore {
  readonly #byRequirement = new Map<string, Activity[]>();
  readonly #listeners = new Listeners<ActivityEvent>();

  listForRequirement(requirementId: string): Promise<Activity[]> {
    const rows = (this.#byRequirement.get(requirementId) ?? []).map((a) => ({ ...a }));
    return Promise.resolve(sortNewestFirstCapped(rows));
  }

  append(activity: Activity): Promise<void> {
    const list = this.#byRequirement.get(activity.requirement_id) ?? [];
    list.push({ ...activity });
    this.#byRequirement.set(activity.requirement_id, list);
    this.#listeners.emit({ type: "appended", ...activity });
    return Promise.resolve();
  }

  subscribe(listener: EventListener<ActivityEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}
