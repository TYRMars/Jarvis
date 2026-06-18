// HTTP routes for the persisted workspaces registry.
//
// Ported from crates/harness-server/src/workspaces_routes.rs.
//
//   GET    /v1/workspaces            — list recent (newest first)
//   POST   /v1/workspaces            — touch (insert / promote)
//   POST   /v1/workspaces/touch      — alias for POST /v1/workspaces
//   DELETE /v1/workspaces?path=<abs> — drop from recent
//   DELETE /v1/workspaces/forget?path=<abs> — alias for DELETE /v1/workspaces
//
// All endpoints require a WorkspaceStore on AppState. Without one, every route
// returns 503 so callers can distinguish "feature not enabled" from "really
// broken" (mirrors the 503-when-unconfigured convention of the other domains).
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { WorkspaceStore } from "@jarvis/store";
import type { AppState } from "./state.ts";

/** Return the workspaces registry, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): WorkspaceStore | undefined {
  if (!state.workspaces) {
    reply.code(503).send({ error: "workspaces registry not configured" });
    return undefined;
  }
  return state.workspaces;
}

export function registerWorkspacesRoutes(app: FastifyInstance, state: AppState): void {
  // ----------------------- GET /v1/workspaces -----------------------
  app.get("/v1/workspaces", async (_req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      return reply.send({ workspaces: await store.listRecent() });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- POST /v1/workspaces (touch) -----------------------
  const touch = async (
    req: { body?: unknown },
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { path?: unknown };
    if (typeof body.path !== "string") {
      return reply.code(400).send({ error: "`path` must be a string" });
    }
    try {
      const canonical = await store.touch(body.path);
      return reply.send({ path: canonical, recent: await store.listRecent() });
    } catch (e) {
      return reply.code(400).send({ error: errorText(e) });
    }
  };
  app.post("/v1/workspaces", touch);
  app.post("/v1/workspaces/touch", touch);

  // ----------------------- DELETE /v1/workspaces (forget) -----------------------
  const forget = async (
    req: { query: unknown },
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const q = req.query as { path?: unknown };
    if (typeof q.path !== "string") {
      return reply.code(400).send({ error: "`path` query parameter is required" });
    }
    try {
      await store.forget(q.path);
      return reply.send({ deleted: true, recent: await store.listRecent() });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  };
  app.delete("/v1/workspaces", forget);
  app.delete("/v1/workspaces/forget", forget);
}
