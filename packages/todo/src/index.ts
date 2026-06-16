// @jarvis/todo — the persistent workspace TODO board.
//
// Value types + the TodoStore trait + a JsonFile + Memory backend. Distinct
// from @jarvis/core's per-turn `plan` channel: this is the long-lived backlog
// (items survive across turns/conversations/restarts), fanned out from the
// store on every mutation. Ported from harness-core/src/todo.rs (value types +
// budget), store.rs (TodoStore trait), and harness-store (backends).

// Value types, events, and the per-turn mutation budget.
export {
  type TodoItem,
  type TodoStatus,
  type TodoPriority,
  type TodoEvent,
  newTodoItem,
  touchTodoItem,
  todoStatusFromWire,
  todoPriorityFromWire,
  todoUpsertedEvent,
  todoDeletedEvent,
  todoEventWorkspace,
  withTurnBudget,
  countMutation,
  budgetActive,
  MAX_MUTATIONS_PER_TURN,
} from "./todo.ts";

// Event-source surface (the broadcast stand-in).
export {
  type EventSource,
  type EventListener,
  type Unsubscribe,
  Fanout,
} from "./event-source.ts";

// The store trait + the per-workspace soft cap.
export { type TodoStore, TODO_LIST_CAP } from "./store.ts";

// Concrete backends.
export { JsonFileTodoStore } from "./json-store.ts";
export { MemoryTodoStore } from "./memory-store.ts";
