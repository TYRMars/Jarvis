// Synchronous in-process event fan-out — the Node stand-in for Rust's
// `tokio::sync::broadcast`. The `*Store` traits in @jarvis/project extend
// `EventSource<E>` (a `subscribe(listener) -> Unsubscribe`); on every
// successful mutation a backend calls `emit(event)` to fan the frame out to
// every registered listener synchronously (no lag, no async receiver).
//
// This is an internal helper for the project-store family backends; it is not
// part of the package's public surface (index.ts does not re-export it).
import type { EventListener, EventSource, Unsubscribe } from "@jarvis/project";

/**
 * A re-usable listener registry. Backends compose one of these and delegate
 * their `subscribe` to it, calling `emit` after each successful write.
 *
 * Delivery is synchronous fan-out in registration order. `emit` is called only
 * after the durable write has succeeded (mirroring Rust's "broadcast after
 * commit" ordering), so each listener is isolated in its own try/catch: a
 * throwing subscriber must neither reject the already-committed mutation nor
 * starve listeners registered after it. Matches the `Listeners` copies in the
 * doc/activity/comment/label backends.
 */
export class Fanout<E> implements EventSource<E> {
  // Snapshot-on-emit so a listener that (un)subscribes during delivery does
  // not perturb the in-flight iteration.
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
      try {
        listener(event);
      } catch {
        // Swallow listener faults; the store mutation already succeeded.
      }
    }
  }
}
