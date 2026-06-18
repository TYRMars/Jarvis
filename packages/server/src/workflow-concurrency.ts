// Process-wide governance for manually-dispatched workflow runs. Ported from
// harness-server/src/workflow_concurrency.rs.
//
// `POST /v1/workflows/:id/run` fire-and-forgets a background execution. Left
// ungoverned that is three bugs at once (issue #78): unbounded concurrent runs
// (resource exhaustion), no way to cancel an in-flight run, and rows stuck
// `running` forever after a process restart.
//
// `WorkflowRunGate` is the single shared object that closes all three:
//
//   - Cap     — a counting semaphore sized from JARVIS_WORKFLOW_MAX_CONCURRENT
//     (mirroring the auto loop's JARVIS_WORK_MAX_CONCURRENT). The manual route
//     reserves a permit *before* minting a run; at capacity `tryAcquire`
//     returns undefined so the route can 429 instead of spawning, so a flood
//     of POSTs can't fan out unbounded.
//   - Cancel  — manual spawns register their AbortController keyed by run id;
//     `cancel` aborts it so an in-flight run can actually be stopped.
//   - Liveness — every run records its presence for the duration of execution
//     via an InflightGuard. The stale-run reaper consults `isActive` so it
//     never reclaims a run still alive *in this process* — only genuinely
//     orphaned rows (left `running` by a crashed prior process) get reaped by
//     age.
//
// Cheap to construct; lives on AppState. Rust uses `tokio::task::AbortHandle`
// + a tokio Semaphore; the Node port uses `AbortController` (handed to the
// spawned execution, which threads the signal into its step timeouts) and a
// permit-count semaphore — JS is single-threaded so a plain counter under the
// microtask model is race-free for the synchronous acquire/release here.

/**
 * Fallback global cap when the binary doesn't set one explicitly. Matches the
 * auto loop's `max_concurrent_units` default so the two schedulers behave the
 * same out of the box.
 */
export const DEFAULT_WORKFLOW_MAX_CONCURRENT = 2;

/**
 * A permit reserved from a {@link WorkflowRunGate}. Held (passed into the
 * spawned execution) for the lifetime of the run; {@link WorkflowRunPermit.release}
 * frees the slot. Idempotent — a double release is a no-op.
 */
export class WorkflowRunPermit {
  #release: (() => void) | null;

  constructor(release: () => void) {
    this.#release = release;
  }

  /** Release the slot back to the gate. Idempotent. */
  release(): void {
    const release = this.#release;
    if (release) {
      this.#release = null;
      release();
    }
  }
}

/**
 * Drop guard that clears a run's liveness record (and abort controller) when
 * the executing future ends — by completion or by abort. Returned from
 * {@link WorkflowRunGate.markInflight}. Idempotent.
 */
export class InflightGuard {
  #clear: (() => void) | null;

  constructor(clear: () => void) {
    this.#clear = clear;
  }

  /** Clear the liveness record. Idempotent — runs on completion *or* abort. */
  clear(): void {
    const clear = this.#clear;
    if (clear) {
      this.#clear = null;
      clear();
    }
  }
}

/**
 * Shared, process-wide governor for workflow runs. See module docs.
 *
 * Construct one in the composition root and hand it to {@link AppState}; the
 * manual `/run` route and the reaper both consult it.
 */
export class WorkflowRunGate {
  readonly #capacity: number;
  /** Remaining free slots. */
  #available: number;
  /** Run ids alive *in this process* (manual or auto path). */
  readonly #inflight = new Set<string>();
  /** Abort controllers for cancellable (manual-route) runs. */
  readonly #controllers = new Map<string, AbortController>();

  /**
   * Build a gate that admits at most `maxConcurrent` runs at once (clamped to
   * ≥1 so a misconfigured `0` doesn't deadlock the route).
   */
  constructor(maxConcurrent: number = DEFAULT_WORKFLOW_MAX_CONCURRENT) {
    this.#capacity = Math.max(1, Math.floor(maxConcurrent));
    this.#available = this.#capacity;
  }

  /**
   * Reserve a run slot, or `undefined` when already at capacity. The returned
   * permit must be held (moved into the spawned execution) for the lifetime of
   * the run; calling {@link WorkflowRunPermit.release} reopens the slot.
   */
  tryAcquire(): WorkflowRunPermit | undefined {
    if (this.#available <= 0) return undefined;
    this.#available -= 1;
    return new WorkflowRunPermit(() => {
      this.#available += 1;
    });
  }

  /**
   * Record that `runId` is executing in this process. The returned guard
   * clears the record (and any registered abort controller) on
   * {@link InflightGuard.clear} — which the executor calls on normal completion
   * *and* on abort, so the liveness set never leaks.
   */
  markInflight(runId: string): InflightGuard {
    this.#inflight.add(runId);
    return new InflightGuard(() => {
      this.#inflight.delete(runId);
      this.#controllers.delete(runId);
    });
  }

  /**
   * Register a manual run's {@link AbortController} so {@link cancel} can stop
   * it. Overwrites any prior controller for the same id.
   */
  registerController(runId: string, controller: AbortController): void {
    this.#controllers.set(runId, controller);
  }

  /**
   * Abort the in-flight run for `runId` if one is registered. Returns `true`
   * when a live run was aborted, `false` when nothing cancellable was found
   * (already finished, never registered, or orphaned by a prior process).
   */
  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId);
    if (!controller) return false;
    this.#controllers.delete(runId);
    controller.abort();
    return true;
  }

  /** Is `runId` executing in this process right now? */
  isActive(runId: string): boolean {
    return this.#inflight.has(runId);
  }

  /** Number of runs currently executing in this process. */
  activeCount(): number {
    return this.#inflight.size;
  }

  /** Configured global cap (post-clamp). */
  capacity(): number {
    return this.#capacity;
  }

  /** Free slots remaining right now. */
  available(): number {
    return this.#available;
  }
}
