// REST routes for the self-improving-agent Memory surface — Phase 1.
//
// Ported from crates/harness-server/src/memory_routes.rs.
//
//   GET    /v1/memories[?scope=user|project|workspace&scope_value=…&kind=…&tags=a,b&pinned=true&limit=N]
//   GET    /v1/memories/:id
//   POST   /v1/memories                         → 201 { item }
//   PATCH  /v1/memories/:id                     → 200 { item }
//   DELETE /v1/memories/:id                     → 200 { deleted: bool }
//
// Every handler 503s when `state.learningMemory` (the @jarvis/learning
// MemoryStore) is absent so callers can distinguish "feature not enabled" from
// "really broken". Phase 1 of docs/proposals/self-improving-agent.zh-CN.md.
//
// DEFERRED: /v1/memory/sync/* (git / iCloud sync). The Rust crate wires those
// through a separate sync backend that the Node AppState does not yet carry, so
// they are intentionally NOT registered here. Port them once the sync subsystem
// lands in AppState.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  memoryScopeIsUser,
  memoryScopeProject,
  memoryScopeUser,
  memoryScopeWorkspace,
  MemoryRejectionError,
  type MemoryFilter,
  type MemoryItem,
  type MemoryKind,
  type MemoryPatch,
  type MemoryStore,
} from "@jarvis/learning";
import type { AppState } from "./state.ts";

/**
 * Cap on the default page size when the caller omits `limit` — without it the
 * JSON-file backend walks the whole memories directory. Mirrors Rust's
 * `filter.limit = Some(200)`.
 */
const DEFAULT_LIST_LIMIT = 200;

/** The wire-valid `kind` values (snake_case union). */
const MEMORY_KINDS: readonly MemoryKind[] = [
  "preference",
  "fact",
  "lesson",
  "gotcha",
  "convention",
];

/** Return the store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): MemoryStore | undefined {
  if (!state.learningMemory) {
    reply.code(503).send({ error: "memory store not configured" });
    return undefined;
  }
  return state.learningMemory;
}

/** Raw query string params (Fastify hands these in as strings). */
interface MemoryQuery {
  scope?: string;
  scope_value?: string;
  kind?: string;
  tags?: string;
  pinned?: string;
  limit?: string;
}

/**
 * Parse a query into a {@link MemoryFilter}. On a bad scope / unknown kind it
 * sends the matching 400 via `reply` and returns undefined (mirrors the Rust
 * `into_filter` Result<_, Response>).
 */
function intoFilter(query: MemoryQuery, reply: FastifyReply): MemoryFilter | undefined {
  // ---- scope (+ scope_value) ----
  let scope: MemoryFilter["scope"];
  if (query.scope === undefined) {
    scope = undefined;
  } else if (query.scope === "user") {
    scope = memoryScopeUser();
  } else if (query.scope === "project") {
    if (query.scope_value === undefined) {
      reply.code(400).send({ error: "scope_value required for scope=project|workspace" });
      return undefined;
    }
    scope = memoryScopeProject(query.scope_value);
  } else if (query.scope === "workspace") {
    if (query.scope_value === undefined) {
      reply.code(400).send({ error: "scope_value required for scope=project|workspace" });
      return undefined;
    }
    scope = memoryScopeWorkspace(query.scope_value);
  } else {
    reply.code(400).send({ error: `unknown scope: ${query.scope}` });
    return undefined;
  }

  // ---- kind (serde would 400 on an unknown variant; mirror that) ----
  let kind: MemoryKind | undefined;
  if (query.kind !== undefined) {
    if (!MEMORY_KINDS.includes(query.kind as MemoryKind)) {
      reply.code(400).send({ error: `unknown kind: ${query.kind}` });
      return undefined;
    }
    kind = query.kind as MemoryKind;
  }

  // ---- tags (comma-separated; rows must carry every listed tag) ----
  const tags =
    query.tags === undefined
      ? []
      : query.tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

  // ---- pinned (Rust serde Option<bool> — only "true"/"false" parse) ----
  let pinned: boolean | undefined;
  if (query.pinned === "true") pinned = true;
  else if (query.pinned === "false") pinned = false;

  // ---- limit (u32; a non-numeric value is treated as absent) ----
  let limit: number | undefined;
  if (query.limit !== undefined) {
    const n = Number.parseInt(query.limit, 10);
    if (Number.isFinite(n) && n >= 0) limit = n;
  }

  return { scope, kind, tags, pinned, limit };
}

export function registerMemoriesRoutes(app: FastifyInstance, state: AppState): void {
  // list (filtered, pinned-first then newest, capped)
  app.get("/v1/memories", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const filter = intoFilter(req.query as MemoryQuery, reply);
    if (!filter) return reply;
    // Cap default page size when the caller omitted `limit`.
    if (filter.limit === undefined) filter.limit = DEFAULT_LIST_LIMIT;
    try {
      const items = await store.list(filter);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // get one
  app.get("/v1/memories/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: "no such memory", id });
      return reply.send({ item });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // create — Phase 1 REST accepts only user-scope items; title must be non-empty
  app.post("/v1/memories", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const item = req.body as MemoryItem;
    // Project / Workspace scopes still go through their per-domain APIs until
    // the unified-memory migration in Phase 2.
    if (!memoryScopeIsUser(item.scope)) {
      return reply.code(400).send({
        error: "POST /v1/memories only accepts user-scope items in phase 1",
      });
    }
    if (item.title.trim().length === 0) {
      return reply.code(400).send({ error: "title must be non-empty" });
    }
    try {
      const saved = await store.upsert(item);
      return reply.code(201).send({ item: saved });
    } catch (e) {
      // Validator rejections (prompt-injection / credential / etc.) are bad
      // client input, not a server fault — surface them as 400.
      if (e instanceof MemoryRejectionError) {
        return reply.code(400).send({ error: e.message });
      }
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // patch — atomic read-modify-write in the store
  app.patch("/v1/memories/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const patch = req.body as MemoryPatch;
    try {
      const saved = await store.patch(id, patch);
      if (!saved) return reply.code(404).send({ error: "no such memory", id });
      return reply.send({ item: saved });
    } catch (e) {
      // A patched row that fails the validator is a bad request, not a fault.
      if (e instanceof MemoryRejectionError) {
        return reply.code(400).send({ error: e.message });
      }
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // delete (idempotent — {deleted:false} for a missing id, always 200)
  app.delete("/v1/memories/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      return reply.send({ deleted });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
