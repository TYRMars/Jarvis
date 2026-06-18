// The TodoStore trait. Ported from crates/harness-core/src/store.rs
// (`#[async_trait] trait TodoStore`).
//
// The store is the *only* fanout point: `subscribe()` registers a listener that
// receives a `TodoEvent` for every successful mutation, regardless of whether
// the mutator was a `todo.*` tool call or a REST request. WS sessions filter by
// `todoEventWorkspace()` against their pinned root.
//
// All methods are workspace-scoped at the *row* level; there is no "global"
// listing (`get` is the exception — id is globally unique and the row carries
// its own workspace field). Concrete backends live in this package
// (json-store.ts + memory-store.ts).
import type { TodoEvent, TodoItem } from "./todo.ts";
import type { EventSource } from "./event-source.ts";

/**
 * Persistence operations on {@link TodoItem} rows — the long-lived workspace
 * backlog. An `EventSource<TodoEvent>`: every successful mutation fans out a
 * frame to subscribers (the mirror of Rust's `broadcast::Sender::send`).
 */
export interface TodoStore extends EventSource<TodoEvent> {
  /**
   * Return up to ~500 TODOs for `workspace`, sorted by `updated_at`
   * descending (newest first). The 500-item soft cap mirrors Rust.
   */
  list(workspace: string): Promise<TodoItem[]>;
  /**
   * Look up by id. Resolves `undefined` if absent. NOT workspace-scoped — id
   * is globally unique (UUID v4) and the row carries its own workspace field.
   */
  get(id: string): Promise<TodoItem | undefined>;
  /**
   * Insert or overwrite a TODO. Implementations must broadcast
   * `{ type: "upserted", ...item }` after a successful write.
   */
  upsert(item: TodoItem): Promise<void>;
  /**
   * Delete by id. Resolves `true` if a row was removed; `false` if it was
   * already absent (idempotent). Implementations must broadcast
   * `{ type: "deleted", workspace, id }` after a successful delete (skip the
   * broadcast on the no-op `false` path so listeners don't see ghost events).
   */
  delete(id: string): Promise<boolean>;
}

/** Soft cap on the number of TODOs returned per workspace. Mirrors Rust's 500. */
export const TODO_LIST_CAP = 500;
