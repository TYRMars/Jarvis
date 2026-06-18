// Persistent project TODO board — value types + store-broadcast event.
// Ported from crates/harness-core/src/todo.rs (TodoItem + TodoStatus +
// TodoPriority + TodoEvent + the per-turn mutation budget).
//
// Distinct from the per-turn plan channel (@jarvis/core's plan.ts): `plan` is
// the working checklist a model maintains as a snapshot replaced on every
// emit. This module is the *long-lived backlog* — items survive across turns,
// conversations, and process restarts. Mutations come from either the agent
// (via `todo.*` tools) or the human (via REST / UI) and are fanned out to all
// subscribers from the store, not the agent loop.
//
// Wire model:
// - `TodoItem` is the row shape — flat, JSON-serialisable, small. New fields
//   are added as optional/absent (Rust's `skip_serializing_if = Option::is_none`)
//   so v2 extensions don't break existing clients.
// - `TodoEvent` is the broadcast envelope: `{ type: "upserted", ...item }` or
//   `{ type: "deleted", workspace, id }`. WS sessions filter by `workspace` to
//   avoid cross-talk between multi-window UIs pinned to different roots.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lifecycle of a {@link TodoItem}. Serialised as the lowercase / snake_case
 * wire form (`"pending"` / `"in_progress"` / `"completed"` / `"cancelled"` /
 * `"blocked"`) to match the JSON payload the model produces and the UI
 * consumes.
 *
 * `blocked` is intentionally separate from `cancelled`: blocked items expect to
 * be picked up later (note the unblocker in `notes`); cancelled items are
 * abandoned.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "blocked",
];

/**
 * Parse a wire string into a {@link TodoStatus}. Returns `undefined` for
 * unrecognised values — REST handlers convert that to a 400 with the bad value
 * echoed. Mirrors Rust's `TodoStatus::from_wire`.
 */
export function todoStatusFromWire(s: string): TodoStatus | undefined {
  return (TODO_STATUSES as readonly string[]).includes(s) ? (s as TodoStatus) : undefined;
}

/**
 * Optional priority hint on a {@link TodoItem}. Three buckets keep the model's
 * choice-space small. Wire format: lowercase strings `"low"` / `"medium"` /
 * `"high"`.
 */
export type TodoPriority = "low" | "medium" | "high";

const TODO_PRIORITIES: readonly TodoPriority[] = ["low", "medium", "high"];

/** Parse a wire string into a {@link TodoPriority}. Mirrors `TodoPriority::from_wire`. */
export function todoPriorityFromWire(s: string): TodoPriority | undefined {
  return (TODO_PRIORITIES as readonly string[]).includes(s) ? (s as TodoPriority) : undefined;
}

/**
 * One persistent TODO entry, scoped to a single workspace. The wire shape
 * matches the JSON serialisation of the Rust `TodoItem` struct. Renderers
 * should treat unknown statuses as `"pending"` for forward compat.
 */
export interface TodoItem {
  /**
   * Stable identifier (UUID v4 string). Server-allocated on `todo.add` /
   * `POST /v1/todos` so clients can't pick colliding ids.
   */
  id: string;
  /**
   * Canonicalised absolute path of the workspace this TODO belongs to. Callers
   * (REST, tool, UI) must agree on the key (canonicalise at every entry point).
   */
  workspace: string;
  /** Human-readable headline. One sentence; avoid markdown. */
  title: string;
  /** State machine. */
  status: TodoStatus;
  /**
   * Optional priority. Absent = unprioritised — most TODOs are. (Rust:
   * `#[serde(skip_serializing_if = Option::is_none)]`.)
   */
  priority?: TodoPriority;
  /**
   * Optional free-form note. Useful for "blocked by X" or a link to a
   * discussion. Absent when unset.
   */
  notes?: string;
  /** RFC-3339 / ISO-8601 timestamp. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp; bumped on every mutation. */
  updated_at: string;
}

/**
 * Mint a new TODO with a fresh UUID and current ISO-8601 timestamps. Status
 * defaults to `"pending"`. Mirrors Rust's `TodoItem::new`.
 */
export function newTodoItem(workspace: string, title: string): TodoItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    workspace,
    title,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
}

/** Bump `updated_at` to "now". Called by every mutator. Mirrors `TodoItem::touch`. */
export function touchTodoItem(item: TodoItem): void {
  item.updated_at = new Date().toISOString();
}

// ---------- TodoEvent ------------------------------------------------------

/**
 * Broadcast envelope sent on every successful mutation. WS transports filter by
 * `workspace` and forward to subscribed clients as `todo_upserted` /
 * `todo_deleted` frames.
 *
 * Rust's `TodoEvent` is `#[serde(tag = "type", rename_all = "snake_case")]`
 * with `Upserted(TodoItem)` (a tuple variant — serde inlines the item's fields
 * alongside the tag) and `Deleted { workspace, id }`. So the wire form is:
 * - `{ type: "upserted", id, workspace, title, status, ... }`
 * - `{ type: "deleted", workspace, id }`
 */
export type TodoEvent = ({ type: "upserted" } & TodoItem) | { type: "deleted"; workspace: string; id: string };

/** Build an `upserted` event from a {@link TodoItem} (item fields inlined). */
export function todoUpsertedEvent(item: TodoItem): TodoEvent {
  return { type: "upserted", ...item };
}

/** Build a `deleted` event carrying the workspace key + id. */
export function todoDeletedEvent(workspace: string, id: string): TodoEvent {
  return { type: "deleted", workspace, id };
}

/**
 * Workspace key the event targets — used by WS handlers to filter against the
 * socket's pinned workspace. Mirrors Rust's `TodoEvent::workspace()`.
 */
export function todoEventWorkspace(ev: TodoEvent): string {
  return ev.workspace;
}

// ---------- per-turn mutation budget ---------------------------------------
//
// The `todo.add` / `todo.update` / `todo.delete` tools each affect one (or, for
// delete, up to 50) row, but a model can call them many times in a single turn.
// We don't want a runaway loop to fan out hundreds of mutations and fill the
// backlog with junk. The agent loop scopes a `withTurnBudget` frame around each
// turn; mutation tools call `countMutation` before they touch the store, and
// the call throws cleanly once the cap is hit. The model sees the error and can
// recover (apologise, ask the user, stop spamming).
//
// Outside a budget scope (tests, REST handlers, code paths that drive tools
// directly) the call is a free pass — we don't want to punish out-of-band
// callers, and REST handlers already gate by HTTP shape. Implemented with
// AsyncLocalStorage in place of Rust's tokio `task_local`.

/**
 * Hard cap on `todo.*` mutations within a single agent turn. Generous enough
 * for real refactors (mark a dozen items completed, add a half-dozen
 * follow-ups) but small enough to stop a runaway loop early.
 */
export const MAX_MUTATIONS_PER_TURN = 50;

// Per-turn mutation counter, boxed in a single-field object so the scope shares
// one mutable count across all `countMutation` calls in the same async context.
const turnBudget = new AsyncLocalStorage<{ count: number }>();

/**
 * Run `fn` with a fresh mutation counter installed. Each call allocates its own
 * counter so siblings don't bleed across turns. Mirrors `with_turn_budget`.
 */
export function withTurnBudget<T>(fn: () => Promise<T>): Promise<T> {
  return turnBudget.run({ count: 0 }, fn);
}

/**
 * Increment the in-flight turn's mutation counter; throws once the cap is
 * exceeded. A no-op (no throw) when no budget is installed (out-of-band callers
 * — REST handlers, tests). The thrown message is intentionally model-readable
 * so the agent's recovery prose stays useful. Mirrors `count_mutation`.
 */
export function countMutation(): void {
  const counter = turnBudget.getStore();
  if (counter === undefined) return; // no budget scope → free pass
  counter.count += 1;
  if (counter.count > MAX_MUTATIONS_PER_TURN) {
    throw new Error(
      `todo mutation budget exhausted: per-turn mutation cap (${MAX_MUTATIONS_PER_TURN}) ` +
        `reached. This guard exists to prevent runaway loops. Stop calling todo.add / ` +
        `todo.update / todo.delete for this turn — summarise the remaining changes for ` +
        `the user instead.`,
    );
  }
}

/**
 * Whether a budget scope is installed for the current async context. Useful for
 * tests; production callers shouldn't gate behaviour on this. Mirrors
 * `budget_active`.
 */
export function budgetActive(): boolean {
  return turnBudget.getStore() !== undefined;
}
