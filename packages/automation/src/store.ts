// Persistence trait for scheduled-automation tasks.
//
// Ported from the `AutomationStore` trait in
// crates/harness-automation/src/lib.rs. In Rust this is an `#[async_trait]`
// trait returning `Result<_, BoxError>`; the Node port turns the methods into
// `Promise`-returning interface members. There is NO event fanout (unlike the
// project-domain stores) — the automation runtime polls on a tick, it doesn't
// react to push events — so this interface does NOT extend an EventSource.
//
// Concrete backends (JSON-file + in-memory) live in ./automation-store.ts.
import type { AutomationTask } from "./task.ts";

/**
 * Persistence operations on {@link AutomationTask} rows. Tasks are keyed by id
 * (UUID). `upsert` is insert-or-overwrite. Errors reject the Promise.
 */
export interface AutomationStore {
  /** Every task, newest-updated first. */
  list(): Promise<AutomationTask[]>;
  /** Look up by id. Resolves `undefined` if absent. */
  get(id: string): Promise<AutomationTask | undefined>;
  /** Insert or overwrite a task by its id. */
  upsert(task: AutomationTask): Promise<void>;
  /** Hard-delete by id. Resolves `true` if a row was removed, `false` if absent. */
  delete(id: string): Promise<boolean>;
}
