// Synchronous in-process event fan-out — the Node stand-in for Rust's
// `tokio::sync::broadcast` used by `TodoStore::subscribe`. The `@jarvis/store`
// package keeps an equivalent `Fanout` internal (it depends on @jarvis/project
// for the EventSource types); @jarvis/todo only depends on @jarvis/core +
// @jarvis/store, so it owns its own copy of the tiny event-source surface here.

/** Removes a previously-registered listener. Idempotent. */
export type Unsubscribe = () => void;

/** A listener for events of type `E`. */
export type EventListener<E> = (event: E) => void;

/**
 * Typed event-source — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener (mirrors Rust's `subscribe()` returning a
 * fresh receiver) and returns a function that detaches it. Unlike the Rust
 * receiver, listeners cannot lag — delivery is synchronous fan-out — so the
 * "refetch on RecvError::Lagged" advice from the Rust docs is moot here.
 */
export interface EventSource<E> {
  subscribe(listener: EventListener<E>): Unsubscribe;
}

/**
 * A re-usable listener registry. Backends compose one of these and delegate
 * their `subscribe` to it, calling `emit` after each successful write.
 *
 * Delivery is synchronous fan-out in registration order. Backends call `emit`
 * only after the durable write has succeeded, mirroring Rust's "broadcast after
 * commit" ordering.
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
    // Snapshot so a listener that (un)subscribes during delivery does not
    // perturb the in-flight iteration.
    for (const listener of [...this.#listeners]) {
      // Isolate listener faults: `emit` runs *after* the durable write has
      // committed, so a throwing subscriber must not reject the already-
      // succeeded mutation, nor starve listeners registered after it.
      try {
        listener(event);
      } catch {
        // Swallow — the mutation already succeeded; one bad subscriber cannot
        // break fan-out to the rest.
      }
    }
  }
}
