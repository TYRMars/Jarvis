// REST routes for the persistent project TODO board.
//
// Ported from crates/harness-server/src/todos_routes.rs. Mounted only when
// `state.todos` is configured; every endpoint 503s otherwise — same convention
// as /v1/docs, /v1/projects, /v1/requirements.
//
// Endpoints:
//   GET    /v1/todos?workspace=<abs>  — list (default workspace = the server's
//                                       pinned root)
//   POST   /v1/todos                  — create
//                                       (body: {title, status?, priority?, notes?, workspace?})
//   PATCH  /v1/todos/:id              — partial update
//                                       (body: any subset of {title, status, priority, notes})
//   DELETE /v1/todos/:id              — remove
//
// The WS bridge (when wired) filters TodoEvents by the socket's pinned
// workspace and forwards as todo_upserted / todo_deleted frames. Both REST and
// tool mutations go through the store's subscribe() fanout, so a single
// mutation reaches every connected client without duplicate emits.
import { realpathSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  newTodoItem,
  todoPriorityFromWire,
  todoStatusFromWire,
  touchTodoItem,
  type TodoItem,
  type TodoStore,
} from "@jarvis/todo";
import type { AppState } from "./state.ts";

/** Return the todo store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): TodoStore | undefined {
  if (!state.todos) {
    reply.code(503).send({ error: "todo store not configured" });
    return undefined;
  }
  return state.todos;
}

/**
 * Produce a stable string key for a workspace path. Mirrors Rust's
 * `canonicalize_workspace`: resolve symlinks (so macOS /var ↔ /private/var
 * differences vanish) and normalise `.`/`..`/trailing separators; fall back to
 * the lossy input when the path doesn't resolve (a caller-chosen non-existent
 * root is not a server bug).
 */
function canonicalizeWorkspace(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve the workspace key for a request: the explicit override (when present
 * and non-empty) else the server-pinned root. `undefined` when neither is
 * available — handlers translate that into a 400. Mirrors Rust's
 * `resolve_workspace`.
 */
function resolveWorkspace(state: AppState, overridePath: string | undefined): string | undefined {
  const path = overridePath != null && overridePath.length > 0 ? overridePath : state.workspaceRoot;
  if (path == null || path.length === 0) return undefined;
  return canonicalizeWorkspace(path);
}

export function registerTodosRoutes(app: FastifyInstance, state: AppState): void {
  // ----------------------- GET /v1/todos -----------------------
  app.get("/v1/todos", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const q = req.query as { workspace?: string };
    const workspace = resolveWorkspace(state, typeof q.workspace === "string" ? q.workspace : undefined);
    if (workspace === undefined) {
      return reply.code(400).send({
        error: "no workspace pinned on the server; pass `?workspace=<abs path>` explicitly",
      });
    }
    try {
      const items = await store.list(workspace);
      return reply.send({ workspace, items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- POST /v1/todos -----------------------
  app.post("/v1/todos", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as {
      title?: unknown;
      status?: unknown;
      priority?: unknown;
      notes?: unknown;
      workspace?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return reply.code(400).send({ error: "`title` must not be blank" });
    }
    const override = typeof body.workspace === "string" ? body.workspace : undefined;
    const workspace = resolveWorkspace(state, override);
    if (workspace === undefined) {
      return reply.code(400).send({
        error: "no workspace pinned on the server; include `workspace` in the body",
      });
    }
    const item = newTodoItem(workspace, title);
    if (typeof body.status === "string") {
      const parsed = todoStatusFromWire(body.status);
      if (parsed === undefined) {
        return reply.code(400).send({ error: `unknown status \`${body.status}\`` });
      }
      item.status = parsed;
    }
    if (typeof body.priority === "string" && body.priority.length > 0) {
      const parsed = todoPriorityFromWire(body.priority);
      if (parsed === undefined) {
        return reply.code(400).send({ error: `unknown priority \`${body.priority}\`` });
      }
      item.priority = parsed;
    }
    if (typeof body.notes === "string") {
      const trimmed = body.notes.trim();
      if (trimmed.length > 0) item.notes = trimmed;
    }
    try {
      await store.upsert(item);
      return reply.code(201).send(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- PATCH /v1/todos/:id -----------------------
  app.patch("/v1/todos/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let item: TodoItem | undefined;
    try {
      item = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `todo \`${id}\` not found` });
    const body = (req.body ?? {}) as {
      title?: unknown;
      status?: unknown;
      priority?: unknown;
      notes?: unknown;
    };
    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "`title` must not be blank" });
      }
      item.title = trimmed;
    }
    if (typeof body.status === "string") {
      const parsed = todoStatusFromWire(body.status);
      if (parsed === undefined) {
        return reply.code(400).send({ error: `unknown status \`${body.status}\`` });
      }
      item.status = parsed;
    }
    // `priority` present clears (when blank) or sets; absent leaves it as-is.
    if (typeof body.priority === "string") {
      const trimmed = body.priority.trim();
      if (trimmed.length === 0) {
        delete item.priority;
      } else {
        const parsed = todoPriorityFromWire(trimmed);
        if (parsed === undefined) {
          return reply.code(400).send({ error: `unknown priority \`${body.priority}\`` });
        }
        item.priority = parsed;
      }
    }
    // `notes` present clears (when blank) or sets; absent leaves it as-is.
    if (typeof body.notes === "string") {
      const trimmed = body.notes.trim();
      if (trimmed.length === 0) {
        delete item.notes;
      } else {
        item.notes = trimmed;
      }
    }
    touchTodoItem(item);
    try {
      await store.upsert(item);
      return reply.send(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- DELETE /v1/todos/:id -----------------------
  app.delete("/v1/todos/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      if (deleted) return reply.send({ deleted: true });
      return reply.code(404).send({ deleted: false, error: `todo \`${id}\` not found` });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
