// REST helpers for the persistent project TODO board.
//
// Wire shapes mirror `crates/harness-server/src/todos_routes.rs` and
// `crates/harness-core/src/todo.rs`. Endpoints return 503 when the
// server has no TODO store wired up — callers should treat that as
// "feature unavailable" and hide the panel rather than show an error.
//
// Live updates flow through the WS chat socket: `frames.ts` matches
// `todo_upserted` and `todo_deleted` frames and forwards into the
// store actions. REST mutations broadcast through the same store-side
// fanout so a UI-driven add immediately reaches every connected
// socket (including the initiator).

import { apiUrl } from "./api";
import { showError } from "./status";

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked";

export type TodoPriority = "low" | "medium" | "high";

export interface TodoItem {
  id: string;
  workspace: string;
  title: string;
  status: TodoStatus;
  priority?: TodoPriority | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListTodosResult {
  workspace: string;
  items: TodoItem[];
}

/// List todos for the active server workspace (or an explicit
/// override). Returns `null` when the server has no TODO store
/// configured (HTTP 503). Network errors surface a banner and return
/// `null` so the caller can render an "unavailable" state without a
/// noisy retry loop.
export async function listTodos(workspace?: string): Promise<ListTodosResult | null> {
  try {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await fetch(apiUrl(`/v1/todos${qs}`));
    if (r.status === 503) return null;
    if (!r.ok) throw new Error(`todos list: ${r.status}`);
    return (await r.json()) as ListTodosResult;
  } catch (e: any) {
    console.warn("todos fetch failed", e);
    return null;
  }
}

export interface CreateTodoInput {
  title: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  notes?: string;
  workspace?: string;
}

export async function createTodo(input: CreateTodoInput): Promise<TodoItem | null> {
  try {
    const r = await fetch(apiUrl("/v1/todos"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (r.status === 503) {
      showError("todo store not configured");
      return null;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not save todo: ${r.status} ${body}`);
      return null;
    }
    return (await r.json()) as TodoItem;
  } catch (e: any) {
    showError(`could not save todo: ${e?.message || e}`);
    return null;
  }
}

export interface UpdateTodoInput {
  title?: string;
  status?: TodoStatus;
  /// Empty string clears the priority; `undefined` leaves it as-is.
  priority?: TodoPriority | "";
  /// Empty string clears the note; `undefined` leaves it as-is.
  notes?: string;
}

export async function updateTodo(id: string, input: UpdateTodoInput): Promise<TodoItem | null> {
  try {
    const r = await fetch(apiUrl(`/v1/todos/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (r.status === 503) {
      showError("todo store not configured");
      return null;
    }
    if (r.status === 404) {
      // Stale client; treat as a no-op so the row clears on next refresh.
      return null;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not update todo: ${r.status} ${body}`);
      return null;
    }
    return (await r.json()) as TodoItem;
  } catch (e: any) {
    showError(`could not update todo: ${e?.message || e}`);
    return null;
  }
}

export async function deleteTodo(id: string): Promise<boolean> {
  try {
    const r = await fetch(apiUrl(`/v1/todos/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (r.status === 503) {
      showError("todo store not configured");
      return false;
    }
    if (r.status === 404) {
      // Already gone — treat as success so the UI clears the row.
      return true;
    }
    if (!r.ok) {
      showError(`could not delete todo: ${r.status}`);
      return false;
    }
    return true;
  } catch (e: any) {
    showError(`could not delete todo: ${e?.message || e}`);
    return false;
  }
}
