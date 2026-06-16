// AgentProfileStore trait + the typed event-source it broadcasts on.
//
// Ported from crates/harness-core/src/store.rs (`AgentProfileStore`). In Rust
// these are `#[async_trait]` methods plus a `tokio::sync::broadcast` fanout.
// In the Node port:
//
// - Async methods become `Promise`-returning interface methods.
// - The Rust `subscribe() -> broadcast::Receiver<E>` fanout has no
//   tokio-broadcast equivalent. We model it as a simple typed event-source:
//   `subscribe(listener)` registers a callback and returns an `Unsubscribe`
//   function. Each successful mutation fans out to every registered listener
//   synchronously (the mirror of "broadcast on a channel"). Unlike the Rust
//   receiver, listeners cannot lag, so the "refetch on RecvError::Lagged"
//   advice from the Rust docs is moot here.
//
// Concrete implementations live in this same package (json-store.ts +
// memory-store.ts); this file is the surface only.
import type { AgentProfile, AgentProfileEvent } from "./agent-profile.ts";

/** Removes a previously-registered listener. Idempotent. */
export type Unsubscribe = () => void;

/** A listener for events of type `E`. */
export type EventListener<E> = (event: E) => void;

/**
 * Typed event-source — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener and returns a function that detaches it.
 */
export interface EventSource<E> {
  subscribe(listener: EventListener<E>): Unsubscribe;
}

/**
 * Persistence operations on named {@link AgentProfile} rows.
 *
 * Process-wide (not project- or workspace-scoped) — a profile is just a named
 * bundle of provider / model / system_prompt that any Requirement can be
 * assigned to. The set is small (dozens, not thousands) so the trait stays
 * plain CRUD with no pagination.
 *
 * Mutations broadcast {@link AgentProfileEvent} so WS sessions can render
 * `agent_profile_upserted` / `agent_profile_deleted` frames without polling.
 */
export interface AgentProfileStore extends EventSource<AgentProfileEvent> {
  /**
   * Return all profiles, sorted by `name` ascending. Soft-capped at 200 —
   * operators with that many named agents probably want filtering (a v2
   * concern), so the tail beyond 200 is dropped.
   */
  list(): Promise<AgentProfile[]>;

  /** Look up by id. Resolves `undefined` if absent. */
  get(id: string): Promise<AgentProfile | undefined>;

  /**
   * Insert or overwrite. Broadcasts `{ type: "upserted", ...profile }` after
   * a successful write.
   */
  upsert(profile: AgentProfile): Promise<void>;

  /**
   * Delete by id. Resolves `true` if a row was removed; `false` if it was
   * already absent (idempotent). Broadcasts `{ type: "deleted", id }` after a
   * successful delete; skips the broadcast on the no-op `false` path so
   * listeners don't see ghost events.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * A re-usable listener registry. Backends compose one of these and delegate
 * their `subscribe` to it, calling `emit` after each successful write.
 *
 * Delivery is synchronous fan-out in registration order. Backends call `emit`
 * only after the durable write has succeeded, mirroring Rust's "broadcast
 * after commit" ordering. Snapshot-on-emit so a listener that (un)subscribes
 * during delivery does not perturb the in-flight iteration.
 */
export class Fanout<E> implements EventSource<E> {
  readonly #listeners = new Set<EventListener<E>>();

  subscribe(listener: EventListener<E>): Unsubscribe {
    this.#listeners.add(listener);
    let live = true;
    return () => {
      if (live) {
        live = false;
        this.#listeners.delete(listener);
      }
    };
  }

  /** Fan `event` out to every currently-registered listener, synchronously. */
  emit(event: E): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

/** Soft cap on the number of rows {@link AgentProfileStore.list} returns. */
export const LIST_SOFT_CAP = 200;

/** Sort by `name` ascending, matching the Rust `a.name.cmp(&b.name)`. */
export function byName(a: AgentProfile, b: AgentProfile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
