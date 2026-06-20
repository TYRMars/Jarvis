// REST routes for the tool catalog + runtime mute toggle.
//
// Ported from crates/harness-server/src/routes.rs (`list_tools` / `patch_tool`).
// Mounted only when `state.tools` (the shared ToolRegistry) is configured;
// 503s otherwise — same convention as the store-backed routes.
//
// Endpoints:
//   GET   /v1/tools?source=&pack=&risk=  — full catalog INCLUDING muted tools,
//                                          so the UI can un-mute them. Each entry
//                                          carries the name-convention pack/risk
//                                          classification (see @jarvis/core
//                                          tool-metadata). Server-side facet
//                                          filtering + sort by name.
//   PATCH /v1/tools/:name { enabled }    — flip the registry's in-process mute
//                                          set. `false` mutes (the LLM stops
//                                          seeing it); `true` un-mutes. Returns
//                                          {name, enabled, muted_count}. 404 when
//                                          the tool isn't registered.
//
// The mute set lives in-process only — a restart returns to "everything
// enabled". Because `createAgent` shares this same registry instance, a mute
// takes effect for the next turn without a rebuild.
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  toolMetadataFromTool,
  toolMetadataToWire,
  type ToolMetadata,
  type ToolRegistry,
} from "@jarvis/core";
import type { AppState } from "./state.ts";

/** Return the shared tool registry, or send a 503 and return undefined. */
function requireRegistry(state: AppState, reply: FastifyReply): ToolRegistry | undefined {
  if (!state.tools) {
    reply.code(503).send({ error: "tool registry not configured" });
    return undefined;
  }
  return state.tools;
}

interface ToolsQuery {
  source?: string;
  pack?: string;
  risk?: string;
}

export function registerToolsRoutes(app: FastifyInstance, state: AppState): void {
  // --------------------------- list ------------------------------------
  app.get("/v1/tools", async (req, reply) => {
    const reg = requireRegistry(state, reply);
    if (!reg) return reply;
    const q = (req.query ?? {}) as ToolsQuery;

    let entries: ToolMetadata[] = reg.allNames().map((name) => {
      const tool = reg.resolveUnchecked(name);
      // `allNames` lists live keys, so resolveUnchecked never misses here.
      const meta = toolMetadataFromTool(tool!);
      meta.enabled = !reg.isMuted(name);
      // SubAgent wrappers are registered as `subagent.<kind>`.
      const sub = name.startsWith("subagent.") ? name.slice("subagent.".length) : undefined;
      if (sub) meta.source = { kind: "subagent", subagent: sub };
      return meta;
    });

    // Server-side facet filtering for the catalog UI.
    if (q.source) entries = entries.filter((m) => m.source.kind === q.source);
    if (q.pack) entries = entries.filter((m) => m.pack === q.pack);
    if (q.risk) entries = entries.filter((m) => m.risk === q.risk);

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return reply.send({ total: entries.length, tools: entries.map(toolMetadataToWire) });
  });

  // --------------------------- mute toggle -----------------------------
  app.patch("/v1/tools/:name", async (req, reply) => {
    const reg = requireRegistry(state, reply);
    if (!reg) return reply;
    const name = (req.params as { name: string }).name;
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "body.enabled must be a boolean" });
    }
    // `contains` ignores the mute set (unlike `has`), so a muted tool is still
    // found here and can be un-muted.
    if (!reg.contains(name)) {
      return reply.code(404).send({ error: `tool \`${name}\` is not registered` });
    }
    if (body.enabled) reg.unmute(name);
    else reg.mute(name);
    return reply.send({ name, enabled: body.enabled, muted_count: reg.mutedCount() });
  });
}
