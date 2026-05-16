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

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { TodoItem } from "../../store/appStore";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
  type TodoPriority,
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

const ALL_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled", "blocked"];
const ALL_PRIORITIES: (TodoPriority | "")[] = ["", "low", "medium", "high"];

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
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterStatus, setFilterStatus] = useState<TodoStatus | "">("");
  const [filterPriority, setFilterPriority] = useState<TodoPriority | "">("");

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const batchBarRef = useRef<HTMLDivElement>(null);

  // Hydrate on mount. The server is the source of truth; live frames
  // keep us current after this initial fetch.
  useEffect(() => {
    let cancelled = false;
    void listTodos().then((res) => {
      if (cancelled) return;
      setLoading(false);
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

  const filtered = useMemo(() => {
    return todos.filter((t) => {
      if (filterStatus && t.status !== filterStatus) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      return true;
    });
  }, [todos, filterStatus, filterPriority]);

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

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(new Set(filtered.map((t) => t.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const batchDelete = async () => {
    if (!selectedIds.size) return;
    const msg = tx("todosBatchDeleteConfirm", `Delete ${selectedIds.size} selected TODOs?`);
    if (!confirm(msg)) return;
    const ids = Array.from(selectedIds);
    setSelectedIds(new Set());
    await Promise.all(
      ids.map(async (id) => {
        const ok = await deleteTodo(id);
        if (ok) useAppStore.getState().removeTodo(id);
      }),
    );
  };

  const batchSetStatus = async (status: TodoStatus) => {
    if (!selectedIds.size) return;
    const ids = Array.from(selectedIds);
    setSelectedIds(new Set());
    await Promise.all(
      ids.map(async (id) => {
        const updated = await updateTodo(id, { status });
        if (updated) useAppStore.getState().upsertTodo(updated);
      }),
    );
  };

  const batchSetPriority = async (priority: TodoPriority | "") => {
    if (!selectedIds.size) return;
    const ids = Array.from(selectedIds);
    setSelectedIds(new Set());
    await Promise.all(
      ids.map(async (id) => {
        const updated = await updateTodo(id, { priority: priority || "" });
        if (updated) useAppStore.getState().upsertTodo(updated);
      }),
    );
  };

  const hasSelection = selectedIds.size > 0;

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

  if (loading) {
    return (
      <div className="todos-panel">
        <div className="todos-skeleton-form" />
        <div className="todos-skeleton-filters" />
        <div className="todos-skeleton-list">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="todo-skeleton-row" />
          ))}
        </div>
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

      {/* Filters */}
      {todos.length > 0 && (
        <div className="todos-filters">
          <div className="todos-filter-group">
            {ALL_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className={`todos-filter-chip ${filterStatus === s ? "is-active" : ""} status-${s}`}
                onClick={() => setFilterStatus((prev) => (prev === s ? "" : s))}
                aria-pressed={filterStatus === s}
              >
                {statusLabel(s)}
              </button>
            ))}
          </div>
          <select
            className="todos-filter-select"
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as TodoPriority | "")}
            aria-label={tx("todosFilterPriorityAria", "Filter by priority")}
          >
            <option value="">{tx("todosFilterAllPriorities", "All priorities")}</option>
            <option value="low">{tx("todosPriorityLow", "Low")}</option>
            <option value="medium">{tx("todosPriorityMedium", "Medium")}</option>
            <option value="high">{tx("todosPriorityHigh", "High")}</option>
          </select>
          {(filterStatus || filterPriority) && (
            <button
              type="button"
              className="todos-filter-clear"
              onClick={() => {
                setFilterStatus("");
                setFilterPriority("");
              }}
            >
              {tx("todosFilterClear", "Clear")}
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rail-empty todos-empty">
          {todos.length === 0 ? (
            <>
              <div className="todos-empty-icon" aria-hidden="true">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </div>
              <strong>{tx("todosEmptyTitle", "No TODOs yet")}</strong>
              <span>
                {tx(
                  "todosEmpty",
                  "Add one above or let the agent surface follow-ups via todo.add.",
                )}
              </span>
            </>
          ) : (
            <>
              <strong>{tx("todosNoMatches", "No matching TODOs")}</strong>
              <span>{tx("todosNoMatchesHint", "Try adjusting your filters.")}</span>
            </>
          )}
        </div>
      ) : (
        <>
          <ol className="todos-list" aria-label={tx("todosListAria", "Project TODOs")}>
            {filtered.map((item) => (
              <TodoRow
                key={item.id}
                item={item}
                selected={selectedIds.has(item.id)}
                onToggleSelect={() => toggleSelect(item.id)}
                anySelected={hasSelection}
              />
            ))}
          </ol>

          {/* Batch action bar */}
          {hasSelection && (
            <div ref={batchBarRef} className="todos-batch-bar">
              <div className="todos-batch-info">
                <button type="button" className="todos-batch-check" onClick={selectAllVisible}>
                  {tx("todosSelectAll", "Select all")}
                </button>
                <button type="button" className="todos-batch-check" onClick={clearSelection}>
                  {tx("todosClearSelection", "Clear")}
                </button>
                <span className="todos-batch-count">
                  {selectedIds.size} {tx("todosSelected", "selected")}
                </span>
              </div>
              <div className="todos-batch-actions">
                <span className="todos-batch-label">{tx("todosBatchMark", "Mark")}</span>
                {ALL_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`todos-batch-btn status-${s}`}
                    onClick={() => void batchSetStatus(s)}
                  >
                    {statusLabel(s)}
                  </button>
                ))}
                <span className="todos-batch-divider" />
                {(["low", "medium", "high"] as TodoPriority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`todos-batch-btn priority-${p}`}
                    onClick={() => void batchSetPriority(p)}
                  >
                    <PriorityIcon priority={p} />
                    {tx(`todosPriority${p.charAt(0).toUpperCase() + p.slice(1)}`, p)}
                  </button>
                ))}
                <button
                  type="button"
                  className="todos-batch-btn priority-clear"
                  onClick={() => void batchSetPriority("")}
                >
                  {tx("todosPriorityClear", "—")}
                </button>
                <span className="todos-batch-divider" />
                <button
                  type="button"
                  className="todos-batch-btn batch-delete"
                  onClick={() => void batchDelete()}
                >
                  {tx("todosDeleteSelected", "Delete")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TodoRow({
  item,
  selected,
  onToggleSelect,
  anySelected,
}: {
  item: TodoItem;
  selected: boolean;
  onToggleSelect: () => void;
  anySelected: boolean;
}) {
  const status = item.status;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const onSetStatus = async (s: TodoStatus) => {
    setMenuOpen(false);
    const updated = await updateTodo(item.id, { status: s });
    if (updated) useAppStore.getState().upsertTodo(updated);
  };

  const onSetPriority = async (p: TodoPriority | "") => {
    setMenuOpen(false);
    const updated = await updateTodo(item.id, { priority: p || "" });
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
    <li className={`todo-item todo-item-${status} ${selected ? "is-selected" : ""}`}>
      {/* Batch checkbox */}
      <label className={`todo-check ${anySelected ? "is-visible" : ""}`}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={tx("todosSelectAria", "Select TODO")}
        />
        <span className="todo-check-box" aria-hidden="true">
          {selected && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 4 4 10-10" />
            </svg>
          )}
        </span>
      </label>

      <button
        type="button"
        className="todo-status-button"
        onClick={() => void onSetStatus(nextStatus(status))}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        aria-label={tx("todosCycleStatusAria", "Cycle status")}
        title={tx("todosCycleStatus", "Cycle status (right-click for menu)")}
      >
        <StatusIcon status={status} />
      </button>

      <div className="todo-item-body">
        <div className="todo-item-title">
          <span className={status === "completed" || status === "cancelled" ? "is-struck" : ""}>
            {item.title}
          </span>
          {item.priority ? (
            <span className={`todo-priority todo-priority-${item.priority}`} title={tx(`todosPriority${item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}`, item.priority)}>
              <PriorityIcon priority={item.priority} />
              {item.priority}
            </span>
          ) : null}
        </div>
        {item.notes ? <div className="todo-item-note">{item.notes}</div> : null}
      </div>

      <button
        type="button"
        className={`todo-status-label status-${status}`}
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {statusLabel(status)}
      </button>

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

      {/* Quick-status dropdown */}
      {menuOpen && (
        <div ref={menuRef} className="todo-quick-menu">
          <div className="todo-quick-menu-section">
            <span className="todo-quick-menu-heading">{tx("todosQuickStatus", "Status")}</span>
            <div className="todo-quick-menu-grid">
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`todo-quick-menu-chip status-${s} ${s === status ? "is-active" : ""}`}
                  onClick={() => void onSetStatus(s)}
                >
                  <StatusIcon status={s} />
                  {statusLabel(s)}
                </button>
              ))}
            </div>
          </div>
          <div className="todo-quick-menu-section">
            <span className="todo-quick-menu-heading">{tx("todosQuickPriority", "Priority")}</span>
            <div className="todo-quick-menu-grid">
              {(["", "low", "medium", "high"] as const).map((p) => (
                <button
                  key={p || "none"}
                  type="button"
                  className={`todo-quick-menu-chip priority-${p || "none"} ${item.priority === p || (!item.priority && !p) ? "is-active" : ""}`}
                  onClick={() => void onSetPriority(p)}
                >
                  {p ? <PriorityIcon priority={p} /> : <span className="priority-none-dot" />}
                  {p ? tx(`todosPriority${p.charAt(0).toUpperCase() + p.slice(1)}`, p) : tx("todosPriorityNone", "None")}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
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

function PriorityIcon({ priority }: { priority: TodoPriority }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (priority) {
    case "high":
      return (
        <svg {...common}>
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
      );
    case "medium":
      return (
        <svg {...common}>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      );
    case "low":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="m5 12 7 7 7-7" />
        </svg>
      );
  }
}
