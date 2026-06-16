// MemoryTodoStore. Ported from harness-store/src/memory.rs (`MemoryTodoStore`).
//
// In-process TodoStore backing tests + the server's no-DB fallback. Items keyed
// by id (globally unique); same workspace-scoped `list`, newest-first ordering,
// 500-item cap, and event semantics as the JSON-file backend. Rows are
// defensively cloned on the way in and out so a caller mutating its copy can't
// reach into the store.
import type { TodoEvent, TodoItem } from "./todo.ts";
import { todoDeletedEvent, todoUpsertedEvent } from "./todo.ts";
import type { TodoStore } from "./store.ts";
import { TODO_LIST_CAP } from "./store.ts";
import type { EventListener, Unsubscribe } from "./event-source.ts";
import { Fanout } from "./event-source.ts";

function byDescUpdatedAt(a: TodoItem, b: TodoItem): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

export class MemoryTodoStore implements TodoStore {
  readonly #rows = new Map<string, TodoItem>();
  readonly #fanout = new Fanout<TodoEvent>();

  subscribe(listener: EventListener<TodoEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  list(workspace: string): Promise<TodoItem[]> {
    const rows = [...this.#rows.values()]
      .filter((t) => t.workspace === workspace)
      .sort(byDescUpdatedAt)
      .slice(0, TODO_LIST_CAP)
      .map((t) => structuredClone(t));
    return Promise.resolve(rows);
  }

  get(id: string): Promise<TodoItem | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  upsert(item: TodoItem): Promise<void> {
    this.#rows.set(item.id, structuredClone(item));
    this.#fanout.emit(todoUpsertedEvent(item));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row) return Promise.resolve(false);
    this.#rows.delete(id);
    this.#fanout.emit(todoDeletedEvent(row.workspace, row.id));
    return Promise.resolve(true);
  }
}
