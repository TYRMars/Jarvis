// REST routes for SubAgents — the read-only catalogue + the runs ledger.
//
// Ported from crates/harness-server/src/subagents_routes.rs (the catalogue) and
// crates/harness-server/src/subagent_runs_routes.rs (the runs ledger).
//
// Endpoints:
//
// | Method | Path                              | Returns                                 |
// |--------|-----------------------------------|-----------------------------------------|
// | GET    | /v1/subagents                     | {items: SubAgentDescriptor[]}           |
// | GET    | /v1/subagents/runs                | {items: SubAgentRunRecord[]}            |
// | GET    | /v1/subagents/runs/:id            | {run: SubAgentRunRecord, events: [...]} |
// | POST   | /v1/subagents/runs/:id/cancel     | {cancelled: boolean}                    |
//
// `/v1/subagents` mirrors Rust's catalogue route: it *always* 200s, returning an
// empty array when no SubAgentRegistry is wired (the Rust route reads the
// canonical ToolRegistry, which is always present; the absence of any
// `subagent.*` tool yields `[]`). The Node AppState carries the registry
// directly as `state.subagents`, so an absent registry is the analogue of "no
// subagent tools registered" → empty list, not a 503.
//
// The runs endpoints follow the 503-when-store-absent convention: they return
// 503 when `state.subagentRuns` is unset (mirrors Rust's
// `AppState.subagent_runs == None`).
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, type JsonValue } from "@jarvis/core";
import { subAgentRequiresApproval, type SubAgentRegistry, type SubAgentRunStore } from "@jarvis/subagents";
import type { AppState } from "./state.ts";

/**
 * One built-in SubAgent. The wire shape is a strict subset of the tool spec
 * plus the SubAgent-specific `requires_approval` flag the UI uses to label
 * "needs approval" vs "auto-runs". Mirrors Rust's `SubAgentDescriptor`.
 */
interface SubAgentDescriptor {
  /** Bare subagent name, e.g. `read_doc` (the registry key). */
  name: string;
  /** Full tool name as it appears in the agent's catalogue, e.g. `subagent.read_doc`. */
  tool_name: string;
  /** One-line description from the SubAgent. Used as the card subtitle. */
  description: string;
  /** `true` when the wrapping `subagent.<name>` tool is approval-gated. */
  requires_approval: boolean;
  /** JSON schema for the tool input. Surfaced for diagnostics. */
  parameters: JsonValue;
}

/** Fold the registry into the sorted-by-name descriptor list. */
function collect(registry: SubAgentRegistry | undefined): SubAgentDescriptor[] {
  if (!registry) return [];
  const items: SubAgentDescriptor[] = registry.iter().map((sub) => ({
    name: sub.name,
    tool_name: `subagent.${sub.name}`,
    description: sub.description,
    requires_approval: subAgentRequiresApproval(sub),
    parameters: sub.inputSchema(),
  }));
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return items;
}

/** Return the runs store, or send a 503 and return undefined. */
function requireRuns(state: AppState, reply: FastifyReply): SubAgentRunStore | undefined {
  if (!state.subagentRuns) {
    reply.code(503).send({ error: "subagent runs registry not configured" });
    return undefined;
  }
  return state.subagentRuns;
}

export function registerSubagentsRoutes(app: FastifyInstance, state: AppState): void {
  // ---- catalogue: read-only list of registered subagents (always 200) ----
  app.get("/v1/subagents", async (_req, reply) => {
    return reply.send({ items: collect(state.subagents) });
  });

  // ---- runs ledger: list active + recent runs, newest-first ----
  app.get("/v1/subagents/runs", async (_req, reply) => {
    const runs = requireRuns(state, reply);
    if (!runs) return reply;
    try {
      const items = await runs.list();
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- runs detail: one run + its recorded event log ----
  app.get("/v1/subagents/runs/:id", async (req, reply) => {
    const runs = requireRuns(state, reply);
    if (!runs) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const run = await runs.get(id);
      if (!run) {
        return reply.code(404).send({ error: `subagent run \`${id}\` not found` });
      }
      const events = (await runs.events(id)) ?? [];
      return reply.send({ run, events });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- runs cancel: cooperative cancel of a still-running run ----
  app.post("/v1/subagents/runs/:id/cancel", async (req, reply) => {
    const runs = requireRuns(state, reply);
    if (!runs) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const ok = await runs.cancel(id);
      if (ok) return reply.send({ cancelled: true });
      return reply.code(404).send({ cancelled: false, error: "no such running subagent run" });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
