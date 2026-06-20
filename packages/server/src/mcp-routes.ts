// REST routes for the MCP server manager. Ported from harness-server's
// mcp_routes.rs. Mounted only when `state.mcpManager` is configured; 503s
// otherwise. The web Settings → McpSection drives all six.
//
//   GET    /v1/mcp/servers                 — { servers: McpServerInfo[] }
//   POST   /v1/mcp/servers                 — add (201 { prefix, tools })
//   GET    /v1/mcp/servers/:prefix         — one McpServerInfo (404 if absent)
//   PUT    /v1/mcp/servers/:prefix         — replace config ({ prefix, tools })
//   DELETE /v1/mcp/servers/:prefix         — remove ({ deleted, prefix } / 404)
//   POST   /v1/mcp/servers/:prefix/health  — probe ({ ok, tools?, latency_ms, error? }, always 200)
//   POST   /v1/mcp/servers/:prefix/reload  — restart ({ prefix, tools, latency_ms })
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  McpManager,
  McpManagerError,
  wireToConfig,
  type McpClientConfigWire,
} from "./mcp-manager.ts";
import type { AppState } from "./state.ts";

function requireManager(state: AppState, reply: FastifyReply): McpManager | undefined {
  if (!state.mcpManager) {
    reply.code(503).send({ error: "mcp manager not configured" });
    return undefined;
  }
  return state.mcpManager;
}

function mapError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof McpManagerError) return reply.code(e.status).send({ error: e.message });
  return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
}

function readConfigBody(reply: FastifyReply, body: unknown): McpClientConfigWire | undefined {
  const b = body as McpClientConfigWire | undefined;
  if (!b || typeof b.prefix !== "string" || typeof b.transport !== "object" || b.transport === null) {
    reply.code(400).send({ error: "body must be a McpClientConfig { prefix, transport, ... }" });
    return undefined;
  }
  return b;
}

export function registerMcpRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/mcp/servers", async (_req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    return reply.send({ servers: m.list() });
  });

  app.post("/v1/mcp/servers", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const body = readConfigBody(reply, req.body);
    if (!body) return reply;
    try {
      const tools = await m.add(wireToConfig(body));
      return reply.code(201).send({ prefix: body.prefix, tools });
    } catch (e) {
      return mapError(reply, e);
    }
  });

  app.get("/v1/mcp/servers/:prefix", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const prefix = (req.params as { prefix: string }).prefix;
    const info = m.get(prefix);
    if (!info) return reply.code(404).send({ error: `unknown mcp server '${prefix}'` });
    return reply.send(info);
  });

  app.put("/v1/mcp/servers/:prefix", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const prefix = (req.params as { prefix: string }).prefix;
    const body = readConfigBody(reply, req.body);
    if (!body) return reply;
    if (body.prefix !== prefix) {
      return reply
        .code(400)
        .send({ error: `body prefix '${body.prefix}' does not match path '${prefix}'` });
    }
    try {
      const tools = await m.replace(prefix, wireToConfig(body));
      return reply.send({ prefix, tools });
    } catch (e) {
      return mapError(reply, e);
    }
  });

  app.delete("/v1/mcp/servers/:prefix", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const prefix = (req.params as { prefix: string }).prefix;
    const deleted = await m.remove(prefix);
    if (!deleted) return reply.code(404).send({ error: `unknown mcp server '${prefix}'`, prefix });
    return reply.send({ deleted: true, prefix });
  });

  app.post("/v1/mcp/servers/:prefix/health", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const prefix = (req.params as { prefix: string }).prefix;
    const start = Date.now();
    try {
      const tools = await m.health(prefix);
      return reply.send({ ok: true, tools, latency_ms: Date.now() - start });
    } catch (e) {
      // Health failures are reported in-body with a 200 (the web's McpHealth
      // expects `{ ok: false, error }`), not as an HTTP error.
      return reply.send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latency_ms: Date.now() - start,
      });
    }
  });

  app.post("/v1/mcp/servers/:prefix/reload", async (req, reply) => {
    const m = requireManager(state, reply);
    if (!m) return reply;
    const prefix = (req.params as { prefix: string }).prefix;
    const start = Date.now();
    try {
      const tools = await m.reload(prefix);
      return reply.send({ prefix, tools, latency_ms: Date.now() - start });
    } catch (e) {
      return mapError(reply, e);
    }
  });
}
