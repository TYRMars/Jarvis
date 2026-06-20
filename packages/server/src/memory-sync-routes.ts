// Memory sync + includes routes — graceful 503 stubs.
//
// The Rust server exposes git/iCloud memory sync + include-directive management
// (crates/harness-server/src/memory_sync_routes.rs). That backend — git
// wrappers, iCloud-Drive resolution, include-cache lifecycle — is a substantial
// subsystem not yet ported to Node. Until it lands, these routes are registered
// (not 404) and report a 503 "not configured": the web Settings·MemorySyncSection
// + MemoryIncludesPanel are 503-aware and degrade to a "sync not configured"
// state rather than erroring. This keeps the Rust-decommission cutover
// non-breaking; porting the real subsystem is a tracked follow-up
// (docs/proposals/rust-decommission-p8-gaps.md).
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppState } from "./state.ts";

const NOT_CONFIGURED = "memory sync backend not configured";

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: NOT_CONFIGURED });
}

export function registerMemorySyncRoutes(app: FastifyInstance, _state: AppState): void {
  // git / iCloud sync
  app.get("/v1/memory/sync_status", async (_req, reply) => unavailable(reply));
  app.post("/v1/memory/sync", async (_req, reply) => unavailable(reply));
  app.post("/v1/memory/sync_setup", async (_req, reply) => unavailable(reply));
  app.post("/v1/memory/sync_setup_icloud", async (_req, reply) => unavailable(reply));
  // include directives
  app.get("/v1/memory/includes", async (_req, reply) => unavailable(reply));
  app.post("/v1/memory/includes", async (_req, reply) => unavailable(reply));
  app.delete("/v1/memory/includes", async (_req, reply) => unavailable(reply));
  app.post("/v1/memory/includes/refresh", async (_req, reply) => unavailable(reply));
}
