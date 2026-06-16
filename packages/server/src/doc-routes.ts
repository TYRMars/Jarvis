// REST routes for the `/docs` page — DocProject + DocDraft.
//
// Ported from crates/harness-server/src/docs_routes.rs. Mounted only when
// `state.docs` is configured; every endpoint 503s otherwise — same convention
// as /v1/todos, /v1/projects, /v1/requirements.
//
// Endpoints:
//   GET    /v1/doc-projects?workspace=<abs>   — list (newest-first) scoped to a workspace
//   POST   /v1/doc-projects                   — create (body: {title, kind?, workspace?})
//   GET    /v1/doc-projects/:id               — load one
//   PATCH  /v1/doc-projects/:id               — partial update ({title?, kind?, tags?, pinned?, archived?})
//   DELETE /v1/doc-projects/:id               — hard-delete project + cascade drafts
//   GET    /v1/doc-projects/:id/draft         — most-recent Markdown draft, or null
//   PUT    /v1/doc-projects/:id/draft         — save/replace draft body (body: {content})
//
// The WS bridge (when wired) fans out DocEvent frames as
// doc_project_upserted / doc_project_deleted / doc_draft_upserted.
import { realpathSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  docKindFromWire,
  newDocDraft,
  newDocProject,
  touchDocProject,
  type DocProject,
  type DocStore,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

/** Return the doc store, or send a 503 and return undefined. */
function requireDocStore(state: AppState, reply: FastifyReply): DocStore | undefined {
  if (!state.docs) {
    reply.code(503).send({ error: "doc store not configured" });
    return undefined;
  }
  return state.docs;
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

export function registerDocRoutes(app: FastifyInstance, state: AppState): void {
  // ---- GET /v1/doc-projects?workspace=<abs> ----
  app.get("/v1/doc-projects", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const q = req.query as { workspace?: string };
    const workspace = resolveWorkspace(state, typeof q.workspace === "string" ? q.workspace : undefined);
    if (workspace === undefined) {
      return reply.code(400).send({
        error: "no workspace pinned on the server; pass `?workspace=<abs path>` explicitly",
      });
    }
    try {
      const items = await store.listProjects(workspace);
      return reply.send({ workspace, items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- POST /v1/doc-projects ----
  app.post("/v1/doc-projects", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { title?: unknown; kind?: unknown; workspace?: unknown };
    if (typeof body.title !== "string") {
      return reply.code(400).send({ error: "`title` must not be blank" });
    }
    const title = body.title.trim();
    if (title.length === 0) {
      return reply.code(400).send({ error: "`title` must not be blank" });
    }
    const workspace = resolveWorkspace(
      state,
      typeof body.workspace === "string" ? body.workspace : undefined,
    );
    if (workspace === undefined) {
      return reply.code(400).send({
        error: "no workspace pinned on the server; include `workspace` in the body",
      });
    }
    const item = newDocProject(workspace, title);
    if (typeof body.kind === "string") {
      const parsed = docKindFromWire(body.kind);
      if (parsed === undefined) {
        return reply.code(400).send({ error: `unknown kind \`${body.kind}\`` });
      }
      item.kind = parsed;
    }
    try {
      await store.upsertProject(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(item);
  });

  // ---- GET /v1/doc-projects/:id ----
  app.get("/v1/doc-projects/:id", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const p = await store.getProject(id);
      if (!p) return reply.code(404).send({ error: `doc project \`${id}\` not found` });
      return reply.send(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- PATCH /v1/doc-projects/:id ----
  app.patch("/v1/doc-projects/:id", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      title?: unknown;
      kind?: unknown;
      tags?: unknown;
      pinned?: unknown;
      archived?: unknown;
    };

    let item: DocProject | undefined;
    try {
      item = await store.getProject(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `doc project \`${id}\` not found` });

    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "`title` must not be blank" });
      }
      item.title = trimmed;
    }
    if (typeof body.kind === "string") {
      const parsed = docKindFromWire(body.kind);
      if (parsed === undefined) {
        return reply.code(400).send({ error: `unknown kind \`${body.kind}\`` });
      }
      item.kind = parsed;
    }
    if (Array.isArray(body.tags)) {
      // Trim, drop empties, dedup while preserving caller order.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of body.tags) {
        if (typeof raw !== "string") continue;
        const t = raw.trim();
        if (t.length === 0 || seen.has(t)) continue;
        seen.add(t);
        cleaned.push(t);
      }
      item.tags = cleaned;
    }
    if (typeof body.pinned === "boolean") {
      item.pinned = body.pinned;
    }
    if (typeof body.archived === "boolean") {
      item.archived = body.archived;
    }
    touchDocProject(item);
    try {
      await store.upsertProject(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(item);
  });

  // ---- DELETE /v1/doc-projects/:id ----
  app.delete("/v1/doc-projects/:id", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let deleted: boolean;
    try {
      deleted = await store.deleteProject(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!deleted) {
      return reply.code(404).send({ deleted: false, error: `doc project \`${id}\` not found` });
    }
    return reply.send({ deleted: true });
  });

  // ---- GET /v1/doc-projects/:id/draft ----
  app.get("/v1/doc-projects/:id/draft", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const draft = await store.latestDraft(id);
      // No draft → JSON null body (matching Rust's `Json(Value::Null)`).
      return reply.send(draft ?? null);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- PUT /v1/doc-projects/:id/draft ----
  app.put("/v1/doc-projects/:id/draft", async (req, reply) => {
    const store = requireDocStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== "string") {
      return reply.code(400).send({ error: "missing `content`" });
    }
    // 404 if the parent project doesn't exist.
    let parent: DocProject | undefined;
    try {
      parent = await store.getProject(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!parent) return reply.code(404).send({ error: `doc project \`${id}\` not found` });

    const draft = newDocDraft(id, body.content);
    try {
      await store.upsertDraft(draft);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(draft);
  });
}
