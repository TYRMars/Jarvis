// Plan channel. Ported from harness-core/src/plan.rs.
//
// Per-invocation sink scoped via `withPlan`, implemented with
// AsyncLocalStorage in place of Rust's tokio task_local. Tools (in practice
// `plan.update`) call `emitPlan` with the FULL latest snapshot (replace, not
// patch). Outside a scope the sink is absent so emits are no-ops, keeping
// tool unit tests trivial. The agent loop relays each snapshot as a
// `plan_update` event.
import { AsyncLocalStorage } from "node:async_hooks";

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanStatus;
  note?: string;
}

const store = new AsyncLocalStorage<(items: PlanItem[]) => void>();

/** Publish the latest plan snapshot. No-op outside a `withPlan` scope. */
export function emitPlan(items: PlanItem[]): void {
  store.getStore()?.(items);
}

/** Whether a plan sink is installed for the current async context. */
export function planActive(): boolean {
  return store.getStore() !== undefined;
}

/** Run `fn` with `sink` installed as the active plan sink. */
export function withPlan<T>(sink: (items: PlanItem[]) => void, fn: () => Promise<T>): Promise<T> {
  return store.run(sink, fn);
}
