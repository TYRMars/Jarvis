// In-memory AgentProfileStore. Ported from
// harness-store/src/memory.rs (`MemoryAgentProfileStore`).
//
// Backs tests + the server's no-DB fallback. Profiles keyed by id; `list`
// sorts by `name` ascending and soft-caps at 200. Same broadcast semantics as
// the JSON-file backend: `upsert` emits `upserted`, a real `delete` emits
// `deleted`, a no-op delete (already absent) emits nothing. Rows are
// defensively cloned in and out so a caller mutating its copy can't reach into
// the store.
import type { AgentProfile, AgentProfileEvent } from "./agent-profile.ts";
import {
  byName,
  Fanout,
  LIST_SOFT_CAP,
  type AgentProfileStore,
  type EventListener,
  type Unsubscribe,
} from "./store.ts";

export class MemoryAgentProfileStore implements AgentProfileStore {
  readonly #rows = new Map<string, AgentProfile>();
  readonly #fanout = new Fanout<AgentProfileEvent>();

  list(): Promise<AgentProfile[]> {
    const rows = [...this.#rows.values()]
      .map((p) => structuredClone(p))
      .sort(byName)
      .slice(0, LIST_SOFT_CAP);
    return Promise.resolve(rows);
  }

  get(id: string): Promise<AgentProfile | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  upsert(profile: AgentProfile): Promise<void> {
    this.#rows.set(profile.id, structuredClone(profile));
    this.#fanout.emit({ type: "upserted", ...structuredClone(profile) });
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const removed = this.#rows.delete(id);
    if (removed) this.#fanout.emit({ type: "deleted", id });
    return Promise.resolve(removed);
  }

  subscribe(listener: EventListener<AgentProfileEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }
}
