// REST routes for the self-improving-agent surface — Phase 0.
//
// Ported from crates/harness-server/src/learning_routes.rs. Phase 0 of
// docs/proposals/self-improving-agent.zh-CN.md ("可观测但不自动写"):
// everything is read-only telemetry + a write endpoint for tools to record
// events. No mutation of skills, no memory writes, no review fork.
//
// Endpoints:
//
// | Method | Path                              | Body / Query                | Returns                       |
// |--------|-----------------------------------|-----------------------------|-------------------------------|
// | GET    | /v1/learning/skill-usage          | ?skill=…&action=…&limit=…   | {events: SkillUsageEvent[]}   |
// | GET    | /v1/learning/skill-usage/report   | same filters                | {rows: SkillUsageRow[]}       |
// | POST   | /v1/learning/skill-usage          | SkillUsageEvent (id/ts auto)| {event: SkillUsageEvent} (201)|
//
// Returns 503 when `state.skillUsage` is absent so callers can distinguish
// "not configured" from "really broken".
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  sanitizeSkillUsageEvent,
  skillScopeProject,
  skillScopeUser,
  skillScopeWorkspace,
  SkillUsageRejectionError,
  type SkillUsageAction,
  type SkillUsageEvent,
  type SkillUsageFilter,
  type SkillUsageStore,
} from "@jarvis/learning";
import type { AppState } from "./state.ts";

/**
 * Cap on the default page size — without a `limit` the JSON-file backend walks
 * the whole events directory. Mirrors Rust's `filter.limit = Some(200)`.
 */
const DEFAULT_LIST_LIMIT = 200;

/** The set of wire-valid `action` values (snake_case union). */
const SKILL_USAGE_ACTIONS: readonly SkillUsageAction[] = [
  "listed",
  "viewed",
  "used",
  "patched",
  "created",
  "archived",
  "restored",
];

/** Return the store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): SkillUsageStore | undefined {
  if (!state.skillUsage) {
    reply.code(503).send({ error: "learning store not configured" });
    return undefined;
  }
  return state.skillUsage;
}

/** Raw query string params (Fastify hands these in as strings). */
interface SkillUsageQuery {
  skill?: string;
  action?: string;
  scope?: string;
  scope_value?: string;
  conversation_id?: string;
  limit?: string;
}

/**
 * Parse a query into a {@link SkillUsageFilter}. On a bad scope / unknown
 * action it sends the matching 400 via `reply` and returns undefined (mirrors
 * the Rust `into_filter` Result<_, Response>).
 */
function intoFilter(query: SkillUsageQuery, reply: FastifyReply): SkillUsageFilter | undefined {
  // ---- scope (+ scope_value) ----
  let scope: SkillUsageFilter["scope"];
  if (query.scope === undefined) {
    scope = undefined;
  } else if (query.scope === "user") {
    scope = skillScopeUser();
  } else if (query.scope === "project") {
    if (query.scope_value === undefined) {
      reply.code(400).send({ error: "scope_value required for scope=project|workspace" });
      return undefined;
    }
    scope = skillScopeProject(query.scope_value);
  } else if (query.scope === "workspace") {
    if (query.scope_value === undefined) {
      reply.code(400).send({ error: "scope_value required for scope=project|workspace" });
      return undefined;
    }
    scope = skillScopeWorkspace(query.scope_value);
  } else {
    reply.code(400).send({ error: `unknown scope: ${query.scope}` });
    return undefined;
  }

  // ---- action (serde would 400 on an unknown variant; mirror that) ----
  let action: SkillUsageAction | undefined;
  if (query.action !== undefined) {
    if (!SKILL_USAGE_ACTIONS.includes(query.action as SkillUsageAction)) {
      reply.code(400).send({ error: `unknown action: ${query.action}` });
      return undefined;
    }
    action = query.action as SkillUsageAction;
  }

  // ---- limit (u32; a non-numeric value is ignored, matching serde's
  // Option<u32> on a missing/unparseable query param being absent) ----
  let limit: number | undefined;
  if (query.limit !== undefined) {
    const n = Number.parseInt(query.limit, 10);
    if (Number.isFinite(n) && n >= 0) limit = n;
  }

  return {
    skill_name: query.skill,
    action,
    scope,
    conversation_id: query.conversation_id,
    limit,
  };
}

export function registerLearningRoutes(app: FastifyInstance, state: AppState): void {
  // list raw events (newest-first, capped)
  app.get("/v1/learning/skill-usage", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const filter = intoFilter(req.query as SkillUsageQuery, reply);
    if (!filter) return reply;
    // Cap default page size when the caller omitted `limit`.
    if (filter.limit === undefined) filter.limit = DEFAULT_LIST_LIMIT;
    try {
      const events = await store.listEvents(filter);
      return reply.send({ events });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // aggregated per-skill report
  app.get("/v1/learning/skill-usage/report", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const filter = intoFilter(req.query as SkillUsageQuery, reply);
    if (!filter) return reply;
    try {
      const rows = await store.report(filter);
      return reply.send({ rows });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // record one event (id/created_at re-stamped server-side; size caps enforced)
  app.post("/v1/learning/skill-usage", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    let event: SkillUsageEvent;
    try {
      // Never trust the wire payload: blank client-supplied id/created_at and
      // enforce size caps on skill_name / attributes.
      event = sanitizeSkillUsageEvent(req.body as SkillUsageEvent);
    } catch (e) {
      if (e instanceof SkillUsageRejectionError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
    try {
      const stored = await store.recordEvent(event);
      return reply.code(201).send({ event: stored });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
