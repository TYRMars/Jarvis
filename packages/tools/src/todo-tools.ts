// Persistent workspace TODO board — `todo.{list,add,update,delete}` tools.
// Ported from crates/harness-tools/src/todo.rs.
//
// These tools mutate a @jarvis/todo `TodoStore` directly. Each tool resolves
// the active workspace per-call: a non-empty per-call `workspace` override
// wins, otherwise the construction-time default root is used, canonicalized
// lexically via `path.resolve` (already-absolute inputs pass through). The
// Rust uses a task-local workspace channel (`active_workspace_or` +
// `canonicalize_workspace`); the Node harness has no such channel, so the
// override-or-default is resolved the same way the `doc.*` tools do.
//
// All four are `ToolCategory::Read` (NO approval gate). TODOs are metadata,
// not destructive disk/network ops; users wanting stricter control can add an
// approver rule for `todo.*`. This matches the Rust exactly — `todo.delete` is
// NOT approval-gated there; its mass-delete protection lives in the input
// schema (an explicit `ids` array, capped at 50, no `{all: true}` wildcard).
//
// The per-turn mutation budget (`countMutation` from @jarvis/todo) is consumed
// by `add` / `update` and once per id in `delete`, so a single big `ids` array
// can't sneak past the cap that sequential calls would hit. Outside a
// `withTurnBudget` scope the count is a free pass (REST handlers, tests).
//
// Tools are registered conditionally — `registerTodoTools(registry, { todos,
// workspace })` enables them; without a store, the family is simply not
// registered and the model gets "tool not found". Falling back silently to
// in-memory storage would defeat the persistence promise.
import path from "node:path";

import type { JsonValue, Tool, ToolCategory, ToolRegistry } from "@jarvis/core";
import type { TodoItem, TodoPriority, TodoStatus, TodoStore } from "@jarvis/todo";
import {
  countMutation,
  newTodoItem,
  todoPriorityFromWire,
  todoStatusFromWire,
  touchTodoItem,
} from "@jarvis/todo";

/**
 * Maximum ids accepted by a single `todo.delete` call. Models that want to
 * "clear everything" must enumerate ids — preventing a stray `{all: true}`
 * payload from nuking the backlog. Mirrors the Rust `MAX_DELETE_IDS_PER_CALL`.
 */
const MAX_DELETE_IDS_PER_CALL = 50;

// ---------- helpers --------------------------------------------------------

function asObject(args: JsonValue): { [k: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as { [k: string]: JsonValue };
  }
  return {};
}

function asString(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: JsonValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new Error("expected an array of strings");
  }
  return v.map((item) => {
    if (typeof item !== "string") {
      throw new Error("expected an array of strings");
    }
    return item;
  });
}

/**
 * Resolve the target workspace. A non-empty per-call `workspace` override
 * wins; otherwise the construction-time default root is used. The result is
 * canonicalized lexically via `path.resolve` (already-absolute inputs are
 * returned unchanged) — mirrors the Rust `resolve_workspace`.
 */
function resolveWorkspace(defaultRoot: string, override: string | undefined): string {
  const raw = override !== undefined && override !== "" ? override : defaultRoot;
  return path.resolve(raw);
}

/** Parse a wire status string, throwing on unknown values (matches Rust). */
function parseStatus(s: string): TodoStatus {
  const status = todoStatusFromWire(s);
  if (status === undefined) {
    throw new Error(
      `unknown status \`${s}\` — expected one of ` +
        "pending / in_progress / completed / cancelled / blocked",
    );
  }
  return status;
}

/** Parse a wire priority string, throwing on unknown values (matches Rust). */
function parsePriority(s: string): TodoPriority {
  const priority = todoPriorityFromWire(s);
  if (priority === undefined) {
    throw new Error(`unknown priority \`${s}\` — expected low / medium / high`);
  }
  return priority;
}

/** Serialise a TODO item to its public wire object. */
function itemToJson(item: TodoItem): JsonValue {
  return item as unknown as JsonValue;
}

// ---------- todo.list ------------------------------------------------------

export class TodoListTool implements Tool {
  readonly name = "todo.list";
  readonly category: ToolCategory = "read";
  readonly description =
    "List persistent TODOs for the current workspace, newest " +
    "first. Capped at 500 items. Pass an explicit `workspace` " +
    "(absolute path) only if you need to query a different " +
    "workspace than the agent is pinned to. " +
    "Usually unnecessary on the first turn — pending / in_progress / blocked items " +
    "for the pinned workspace are already injected into the system prompt as a " +
    "`=== project todos ===` block. Call this when you need the full list " +
    "(including completed/cancelled), an item the binder may have just missed, " +
    "or a different workspace.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path. Optional; defaults to the agent's pinned workspace.",
      },
    },
  };

  readonly #store: TodoStore;
  readonly #defaultRoot: string;

  constructor(store: TodoStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));
    const items = await this.#store.list(workspace);
    return JSON.stringify({
      workspace,
      items: items.map(itemToJson),
    });
  }
}

// ---------- todo.add -------------------------------------------------------

export class TodoAddTool implements Tool {
  readonly name = "todo.add";
  readonly category: ToolCategory = "read";
  readonly description =
    "Append a new TODO to the current workspace's persistent " +
    "board. Returns the created item with a server-allocated " +
    "id. Use this to record persistent follow-ups that should " +
    "survive the current turn (cleanups, deferred refactors, " +
    "things the user asked you to remember). For ephemeral " +
    "in-turn planning — a checklist you want to render in the " +
    "UI for this single turn — use `plan.update` instead.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      title: { type: "string", description: "One-sentence headline." },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "cancelled", "blocked"],
        description: "Defaults to `pending`.",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Optional priority hint; omit for unprioritised.",
      },
      notes: { type: "string", description: "Optional one-line note." },
      workspace: {
        type: "string",
        description: "Optional absolute path; defaults to the agent's pinned workspace.",
      },
    },
    required: ["title"],
  };

  readonly #store: TodoStore;
  readonly #defaultRoot: string;

  constructor(store: TodoStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const title = (asString(obj["title"]) ?? "").trim();
    if (title === "") {
      throw new Error("todo.add: `title` must not be blank");
    }
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));
    const item = newTodoItem(workspace, title);
    const statusRaw = asString(obj["status"]);
    if (statusRaw !== undefined) {
      item.status = parseStatus(statusRaw);
    }
    const priorityRaw = asString(obj["priority"]);
    if (priorityRaw !== undefined) {
      item.priority = parsePriority(priorityRaw);
    }
    const notesRaw = asString(obj["notes"]);
    if (notesRaw !== undefined) {
      const trimmed = notesRaw.trim();
      if (trimmed !== "") {
        item.notes = trimmed;
      }
    }
    countMutation();
    await this.#store.upsert(item);
    return JSON.stringify(itemToJson(item));
  }
}

// ---------- todo.update ----------------------------------------------------

export class TodoUpdateTool implements Tool {
  readonly name = "todo.update";
  readonly category: ToolCategory = "read";
  readonly description =
    "Update a persistent TODO by id. Pass the `id` from the " +
    "`=== project todos ===` block in the system prompt or from " +
    "`todo.list`. Status transitions are: pending → in_progress → " +
    "completed (or blocked / cancelled at any point). Pass any " +
    "subset of {title, status, priority, notes} — omitted fields " +
    "keep their existing value. To clear `notes` or `priority`, " +
    "pass an empty string.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "cancelled", "blocked"],
      },
      priority: {
        type: "string",
        description: "low / medium / high, or empty string to clear.",
        enum: ["", "low", "medium", "high"],
      },
      notes: { type: "string" },
    },
    required: ["id"],
  };

  readonly #store: TodoStore;

  constructor(store: TodoStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("todo.update: bad args: missing `id`");
    }
    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`todo.update: id \`${id}\` not found`);
    }
    if (obj["title"] !== undefined) {
      const trimmed = (asString(obj["title"]) ?? "").trim();
      if (trimmed === "") {
        throw new Error("todo.update: `title` must not be blank");
      }
      item.title = trimmed;
    }
    const statusRaw = asString(obj["status"]);
    if (statusRaw !== undefined) {
      item.status = parseStatus(statusRaw);
    }
    const priorityRaw = asString(obj["priority"]);
    if (priorityRaw !== undefined) {
      // Empty string clears the priority.
      const trimmed = priorityRaw.trim();
      item.priority = trimmed === "" ? undefined : parsePriority(trimmed);
    }
    const notesRaw = asString(obj["notes"]);
    if (notesRaw !== undefined) {
      const trimmed = notesRaw.trim();
      item.notes = trimmed === "" ? undefined : trimmed;
    }
    touchTodoItem(item);
    countMutation();
    await this.#store.upsert(item);
    return JSON.stringify(itemToJson(item));
  }
}

// ---------- todo.delete ----------------------------------------------------

export class TodoDeleteTool implements Tool {
  readonly name = "todo.delete";
  readonly category: ToolCategory = "read";
  readonly description =
    "Delete one or more persistent TODOs by id. Up to 50 ids " +
    "per call (mass-delete protection). Returns the number of " +
    "rows actually removed (idempotent — already-absent ids " +
    "count as 0).";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 50,
      },
    },
    required: ["ids"],
  };

  readonly #store: TodoStore;

  constructor(store: TodoStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const ids = asStringArray(obj["ids"]) ?? [];
    if (ids.length === 0) {
      throw new Error("todo.delete: `ids` must not be empty");
    }
    if (ids.length > MAX_DELETE_IDS_PER_CALL) {
      throw new Error(
        `todo.delete: too many ids (${ids.length}) — cap is ${MAX_DELETE_IDS_PER_CALL} per call`,
      );
    }
    let deleted = 0;
    for (const id of ids) {
      // Each row deletion counts toward the per-turn budget so a single
      // big-`ids`-array call can't sneak past the cap that sequential
      // `todo.add` / `todo.update` calls would hit.
      countMutation();
      if (await this.#store.delete(id)) {
        deleted += 1;
      }
    }
    return JSON.stringify({ deleted_count: deleted });
  }
}

// ---------- registration helper --------------------------------------------

/**
 * Stores + config needed to construct the `todo.*` tool family. `todos` is the
 * backing {@link TodoStore}; `workspace` is the construction-time default root
 * used when a tool call omits an explicit `workspace` override.
 */
export interface TodoToolStores {
  todos: TodoStore;
  workspace: string;
}

/**
 * Construct and register the `todo.*` tools into `registry`. All four are
 * `read`-category (ungated) — matching the Rust, where `todo.delete`'s
 * mass-delete protection lives in the input schema, not an approval gate.
 */
export function registerTodoTools(registry: ToolRegistry, stores: TodoToolStores): void {
  const { todos, workspace } = stores;
  registry.register(new TodoListTool(todos, workspace));
  registry.register(new TodoAddTool(todos, workspace));
  registry.register(new TodoUpdateTool(todos));
  registry.register(new TodoDeleteTool(todos));
}
