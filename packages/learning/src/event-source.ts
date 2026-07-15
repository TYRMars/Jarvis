// Synchronous in-process event fan-out — the Node stand-in for Rust's
// `tokio::sync::broadcast`. The `MemoryStore` trait extends `EventSource<E>`
// (a `subscribe(listener) -> Unsubscribe`); on every successful mutation a
// backend calls `emit(event)` to fan the frame out to every registered
// listener synchronously (no lag, no async receiver).
//
// This package can't reuse @jarvis/store's `Fanout` because that one imports
// its event-source types from @jarvis/project (which @jarvis/learning does
// not depend on). We mirror the same shape locally — the contract is
// identical: subscribe returns an idempotent Unsubscribe, delivery is
// synchronous fan-out in registration order, snapshotted so a listener that
// (un)subscribes mid-delivery doesn't perturb the in-flight iteration.

/** Removes a previously-registered listener. Idempotent. */
export type Unsubscribe = () => void;

/** A listener for events of type `E`. */
export type EventListener<E> = (event: E) => void;

/**
 * Typed event-source — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener (mirrors Rust's `subscribe()` returning a
 * fresh receiver) and returns a function that detaches it. Listeners cannot
 * lag — delivery is synchronous fan-out.
 */
export interface EventSource<E> {
  subscribe(listener: EventListener<E>): Unsubscribe;
}

/**
 * A re-usable listener registry. Backends compose one of these and delegate
 * their `subscribe` to it, calling `emit` after each successful write.
 *
 * Delivery is synchronous fan-out in registration order. Backends call `emit`
 * only after the durable write has succeeded, mirroring Rust's "broadcast
 * after commit" ordering. A listener that throws is isolated so it neither
 * rejects the already-committed mutation nor starves the listeners registered
 * after it — the mirror of broadcast's per-receiver isolation.
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
        // Isolate listener faults; the mutation already succeeded, so a
        // throwing subscriber must neither reject the caller nor starve the
        // listeners after it.
      }
    }
  }
}
