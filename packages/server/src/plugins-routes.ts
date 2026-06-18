// HTTP routes for the plugin manager + the online market proxies.
//
// Ported from crates/harness-server/src/plugin_routes.rs and market_routes.rs.
//
//   GET    /v1/plugins                  — list installed plugins
//   POST   /v1/plugins/install          — install from a local path
//   GET    /v1/plugins/marketplace      — built-in catalogue stub
//   GET    /v1/plugins/:name            — fetch one plugin's record
//   DELETE /v1/plugins/:name            — uninstall by name
//
//   GET    /v1/market/mcp               — search the MCP registry (deferred → empty)
//   GET    /v1/market/skills            — search skills.sh (deferred → empty)
//   POST   /v1/market/skills/install    — install a SKILL.md from GitHub (deferred → 503)
//
// The plugin routes require `state.plugins` (the @jarvis/plugin PluginManager);
// without one they 503 so callers can distinguish "feature not enabled" from
// "really broken". The marketplace stub is a pure hard-coded list shipped with
// the binary, exactly as in Rust — a future change can swap it for a remote
// JSON index without touching client code.
//
// DEFERRAL — the `/v1/market/*` endpoints in Rust call live external HTTP
// registries (registry.modelcontextprotocol.io, skills.sh,
// raw.githubusercontent.com). No remote-registry / HTTP-client subsystem is
// wired into AppState, and `skills/install` additionally needs a user-skill
// directory that AppState does not carry. Rather than reach out to the network
// from a route handler (and make tests non-deterministic), the search
// endpoints return an empty static catalogue with a `note` flagging the
// deferral, and the install endpoint 503s. Wiring a market client +
// user-skill-dir onto AppState (a later phase) restores the live behaviour
// without changing these method+path+response shapes for the empty case.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import { PluginManagerError, type PluginManager } from "@jarvis/plugin";
import type { AppState } from "./state.ts";

/** Return the plugin manager, or send a 503 and return undefined. */
function requireManager(state: AppState, reply: FastifyReply): PluginManager | undefined {
  if (!state.plugins) {
    reply.code(503).send({ error: "plugin manager not configured" });
    return undefined;
  }
  return state.plugins;
}

/**
 * Map a {@link PluginManagerError} to a `(status, message)` pair, mirroring
 * Rust `plugin_routes::map_error`:
 *   already_installed / conflict → 409
 *   not_installed                → 404
 *   manifest                     → 400
 *   _                            → 500
 */
function mapError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof PluginManagerError) {
    let status: number;
    switch (e.kind) {
      case "already_installed":
      case "conflict":
        status = 409;
        break;
      case "not_installed":
        status = 404;
        break;
      case "manifest":
        status = 400;
        break;
      default:
        status = 500;
        break;
    }
    return reply.code(status).send({ error: e.message });
  }
  return reply.code(500).send({ error: errorText(e) });
}

/**
 * Hard-coded built-in marketplace list. Each entry points at a path that ships
 * in-repo (under `examples/plugins/`) so a clean clone can install one with a
 * single click. Mirrors Rust `plugin_routes::marketplace` — pure data, no
 * state extractor.
 */
function builtinMarketplace(): Array<Record<string, unknown>> {
  return [
    {
      name: "code-review-pack",
      description: "Bundles the in-tree `code-review` skill as a real plugin.",
      source: "path",
      value: "examples/plugins/code-review-pack",
      tags: ["skills"],
    },
    {
      name: "gitnexus",
      description:
        "Bridges GitNexus (knowledge-graph code intelligence) as an MCP server, plus a workflow skill.",
      source: "path",
      value: "examples/plugins/gitnexus",
      tags: ["mcp", "skills", "code-intelligence"],
    },
  ];
}

export function registerPluginsRoutes(app: FastifyInstance, state: AppState): void {
  // ---- /v1/plugins ----

  // list installed plugins
  app.get("/v1/plugins", async (_req, reply) => {
    const mgr = requireManager(state, reply);
    if (!mgr) return reply;
    try {
      const plugins = await mgr.list();
      return reply.send({ plugins });
    } catch (e) {
      return mapError(reply, e);
    }
  });

  // install from a local path. Wire body: { source: "path", value: "<dir>" }.
  // (`source` is the serde tag; the only variant today is `path`.)
  app.post("/v1/plugins/install", async (req, reply) => {
    const mgr = requireManager(state, reply);
    if (!mgr) return reply;
    const body = (req.body ?? {}) as { source?: unknown; value?: unknown };
    if (body.source !== "path" || typeof body.value !== "string") {
      // Mirrors serde's failure to deserialise the tagged enum (bad/missing
      // `source` tag or `value`). Axum returns 422 for a body-deserialise
      // failure; Fastify has no schema here, so we surface an explicit 400.
      return reply
        .code(400)
        .send({ error: "expected { source: \"path\", value: <string> }" });
    }
    try {
      const report = await mgr.installFromPath(body.value);
      return reply.code(201).send(report);
    } catch (e) {
      return mapError(reply, e);
    }
  });

  // built-in marketplace stub (pure data — no manager needed, matching Rust)
  app.get("/v1/plugins/marketplace", async (_req, reply) => {
    return reply.send({ plugins: builtinMarketplace() });
  });

  // fetch one plugin's record
  app.get("/v1/plugins/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const mgr = requireManager(state, reply);
    if (!mgr) return reply;
    try {
      const plugin = await mgr.get(name);
      if (!plugin) {
        return reply.code(404).send({ error: "no such plugin", name });
      }
      return reply.send(plugin);
    } catch (e) {
      return mapError(reply, e);
    }
  });

  // uninstall by name
  app.delete("/v1/plugins/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const mgr = requireManager(state, reply);
    if (!mgr) return reply;
    try {
      await mgr.uninstall(name);
      return reply.send({ deleted: true, name });
    } catch (e) {
      return mapError(reply, e);
    }
  });

  // ---- /v1/market/* (deferred — see file header) ----

  // search the MCP registry. Deferred: returns an empty static result set with
  // a `note` until a market HTTP client is wired onto AppState.
  app.get("/v1/market/mcp", async (_req, reply) => {
    return reply.send({
      servers: [],
      note: "remote MCP registry not wired; market search is deferred",
    });
  });

  // search skills.sh. Deferred: returns an empty static result set with a
  // `note` until a market HTTP client is wired onto AppState.
  app.get("/v1/market/skills", async (_req, reply) => {
    return reply.send({
      skills: [],
      note: "remote skills registry not wired; market search is deferred",
    });
  });

  // install a SKILL.md from a GitHub source. Deferred: needs both a remote
  // download client and a user-skill directory (neither on AppState yet), so
  // 503 until that subsystem lands.
  app.post("/v1/market/skills/install", async (_req, reply) => {
    return reply
      .code(503)
      .send({ error: "skill market install not configured (deferred)" });
  });
}
