// Persistent project TODO board panel.
//
// Distinct from `PlanList.tsx` (per-turn ephemeral checklist):
// `TodosRail` shows the workspace's long-lived backlog. State is
// hydrated on mount via `GET /v1/todos` and stays current via
// `todo_upserted` / `todo_deleted` WS frames the chat socket
// already streams.
//
// Visual conventions: see `docs/conventions/rail-panels.md`. The
// row layout, empty-state, composer-form, status-color vocabulary,
// and i18n discipline here are the reference impl any future
// rail panel should mirror.
//
// Two named exports follow the rail's convention:
// `TodosCountSpan` for the header, `TodosList` for the body.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { TodoItem } from "../../store/appStore";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
  type TodoStatus,
} from "../../services/todos";
import { t } from "../../utils/i18n";

/// Local fallback when an i18n key isn't translated yet — keeps
/// English rendered instead of leaking the raw key into the UI.
function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const STATUS_LABEL_KEY: Record<TodoStatus, [string, string]> = {
  pending: ["todoStatusPending", "todo"],
  in_progress: ["todoStatusInProgress", "doing"],
  completed: ["todoStatusCompleted", "done"],
  cancelled: ["todoStatusCancelled", "skip"],
  blocked: ["todoStatusBlocked", "blocked"],
};

function statusLabel(status: TodoStatus): string {
  const [key, fallback] = STATUS_LABEL_KEY[status];
  return tx(key, fallback);
}

export function TodosCountSpan() {
  const todos = useAppStore((s) => s.todos);
  return <span id="todos-count">{String(todos.length)}</span>;
}

export function TodosList() {
  const todos = useAppStore((s) => s.todos);
  const setTodos = useAppStore((s) => s.setTodos);
  const [draft, setDraft] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hydrate on mount. The server is the source of truth; live frames
  // keep us current after this initial fetch.
  useEffect(() => {
    let cancelled = false;
    void listTodos().then((res) => {
      if (cancelled) return;
      if (res === null) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setTodos(res.items);
    });
    return () => {
      cancelled = true;
    };
  }, [setTodos]);

  const onAdd = async () => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    const created = await createTodo({ title });
    setBusy(false);
    if (created) {
      // Optimistic update — the WS broadcast would also do this,
      // but we may not be subscribed to a chat socket on this view.
      useAppStore.getState().upsertTodo(created);
      setDraft("");
    }
  };

  if (unavailable) {
    return (
      <div className="rail-empty">
        <strong>{tx("todosUnavailable", "TODOs unavailable")}</strong>
        <span>
          {tx(
            "todosUnavailableHint",
            "Set JARVIS_DB_URL (or rely on the default JSON store) to enable the persistent TODO board.",
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="todos-panel">
      <form
        className="todos-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onAdd();
        }}
      >
        <input
          type="text"
          placeholder={tx("todosAddPlaceholder", "Add a TODO and press enter…")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={tx("todosAddInputAria", "New TODO title")}
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          className="ghost-button"
        >
          {tx("todosAdd", "Add")}
        </button>
      </form>
      {todos.length === 0 ? (
        <div className="rail-empty">
          <span>
            {tx(
              "todosEmpty",
              "No TODOs yet. Add one above or let the agent surface follow-ups via todo.add.",
            )}
          </span>
        </div>
      ) : (
        <ol className="todos-list" aria-label={tx("todosListAria", "Project TODOs")}>
          {todos.map((item) => (
            <TodoRow key={item.id} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const status = item.status;
  const onCycle = async () => {
    const next = nextStatus(status);
    const updated = await updateTodo(item.id, { status: next });
    if (updated) useAppStore.getState().upsertTodo(updated);
  };
  const onDelete = async () => {
    const tmpl = tx("todosDeleteConfirm", "Delete TODO {title}?");
    const msg = tmpl.includes("{title}") ? tmpl.replace("{title}", item.title) : `${tmpl} (${item.title})`;
    if (!confirm(msg)) return;
    const ok = await deleteTodo(item.id);
    if (ok) useAppStore.getState().removeTodo(item.id);
  };
  return (
    <li className={`todo-item todo-item-${status}`}>
      <button
        type="button"
        className="todo-status-button"
        onClick={() => void onCycle()}
        aria-label={tx("todosCycleStatusAria", "Cycle status")}
        title={tx("todosCycleStatus", "Cycle status")}
      >
        <StatusIcon status={status} />
      </button>
      <div className="todo-item-body">
        <div className="todo-item-title">
          <span>{item.title}</span>
          {item.priority ? (
            <span className={`todo-priority todo-priority-${item.priority}`}>
              {item.priority}
            </span>
          ) : null}
        </div>
        {item.notes ? <div className="todo-item-note">{item.notes}</div> : null}
      </div>
      <span className="todo-status-label">{statusLabel(status)}</span>
      <button
        type="button"
        className="ghost-icon todo-delete"
        title={tx("todosDelete", "Delete")}
        aria-label={tx("todosDeleteAria", "Delete TODO")}
        onClick={() => void onDelete()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </li>
  );
}

function nextStatus(status: TodoStatus): TodoStatus {
  switch (status) {
    case "pending":
      return "in_progress";
    case "in_progress":
      return "completed";
    case "completed":
      return "pending";
    case "blocked":
      return "in_progress";
    case "cancelled":
      return "pending";
  }
}

function StatusIcon({ status }: { status: TodoStatus }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (status) {
    case "completed":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m7 12 3 3 7-7" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5" />
          <path d="M12 16h.01" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12h8" />
        </svg>
      );
    case "pending":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
