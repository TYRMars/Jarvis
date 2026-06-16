// HTTP routes for the skill catalogue.
//
// Ported from crates/harness-server/src/skill_routes.rs.
//
//   GET    /v1/skills                  — list every loaded skill
//   GET    /v1/skills/:name            — fetch one skill (manifest + body)
//   POST   /v1/skills/reload           — re-scan disk roots (no-op stub, see Rust)
//   GET    /v1/skills/:name/lifecycle  — lifecycle row (seeds Active from catalog)
//   POST   /v1/skills/:name/archive    — soft-delete (optional `absorbed_into`)
//   POST   /v1/skills/:name/restore    — undo archive
//
// The list / get / reload endpoints require `state.skillCatalog` (the in-memory
// parsed catalogue); without one they 503 so callers can distinguish "feature
// not enabled" from "really broken". The lifecycle / archive / restore
// endpoints additionally require `state.skillLifecycle`.
//
// `GET /:name` fires a fire-and-forget `viewed` skill-usage event when
// `state.skillUsage` is wired — never blocking the read path (mirrors the Rust
// `learning_emit::spawn_record`).
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { SkillCatalog, SkillEntry, SkillSource } from "@jarvis/skill";
import {
  newSkillLifecycle,
  skillScopeUser,
  viewedSkillUsageEvent,
  type SkillCreator,
  type SkillLifecycle,
  type SkillLifecycleStore,
  type SkillSource as LearningSkillSource,
} from "@jarvis/learning";
import type { AppState } from "./state.ts";

/** Return the catalogue, or send a 503 and return undefined. */
function requireCatalog(state: AppState, reply: FastifyReply): SkillCatalog | undefined {
  if (!state.skillCatalog) {
    reply.code(503).send({ error: "skill catalogue not configured" });
    return undefined;
  }
  return state.skillCatalog;
}

/** Return the lifecycle store, or send a 503 and return undefined. */
function requireLifecycle(
  state: AppState,
  reply: FastifyReply,
): SkillLifecycleStore | undefined {
  if (!state.skillLifecycle) {
    reply.code(503).send({ error: "skill lifecycle store not configured" });
    return undefined;
  }
  return state.skillLifecycle;
}

/**
 * Catalogue `SkillSource` → learning-crate `SkillSource`. The catalogue enum
 * has no `other` variant, so its values map straight across (mirrors Rust
 * `skill_routes::map_source`).
 */
function mapSource(src: SkillSource): LearningSkillSource {
  return src;
}

/**
 * Infer who created a skill from its catalogue source. Phase-2 heuristic:
 * bundled / plugin / user map straight across; workspace skills are assumed
 * agent-or-user authored and tracked as `user` until the `skill.manage create`
 * tool starts stamping `agent` explicitly (mirrors Rust `infer_creator`).
 */
function inferCreator(src: SkillSource): SkillCreator {
  switch (src) {
    case "bundled":
      return "bundled";
    case "plugin":
      return "plugin";
    case "user":
    case "workspace":
      return "user";
  }
}

/** Public summary of a catalog entry (no body). Mirrors the Rust `list` json. */
function entrySummary(e: SkillEntry): Record<string, unknown> {
  return {
    name: e.manifest.name,
    description: e.manifest.description,
    license: e.manifest.license ?? null,
    allowed_tools: e.manifest.allowed_tools,
    activation: e.manifest.activation,
    keywords: e.manifest.keywords,
    version: e.manifest.version ?? null,
    source: e.source,
    path: e.path,
  };
}

/**
 * Fetch the lifecycle row for `name`, seeding a default `active` row from the
 * catalogue entry when the store has none yet. Returns the (store, row) pair,
 * or `undefined` after sending the matching response (404 when the skill isn't
 * in the catalogue at all; 503 when either store is absent; 500 on a store
 * error). Mirrors Rust `lifecycle_or_seed`.
 */
async function lifecycleOrSeed(
  state: AppState,
  reply: FastifyReply,
  name: string,
): Promise<{ store: SkillLifecycleStore; row: SkillLifecycle } | undefined> {
  const store = requireLifecycle(state, reply);
  if (!store) return undefined;
  let existing: SkillLifecycle | undefined;
  try {
    existing = await store.get(name);
  } catch (e) {
    reply.code(500).send({ error: errorText(e) });
    return undefined;
  }
  if (existing) return { store, row: existing };
  // No row yet — seed from the catalogue so archive/restore work the first
  // time without a separate "register" step.
  const catalog = requireCatalog(state, reply);
  if (!catalog) return undefined;
  const entry = catalog.get(name);
  if (!entry) {
    reply.code(404).send({ error: "no such skill", name });
    return undefined;
  }
  const seeded = newSkillLifecycle(name, mapSource(entry.source), inferCreator(entry.source));
  return { store, row: seeded };
}

export function registerSkillRoutes(app: FastifyInstance, state: AppState): void {
  // list every loaded skill (deterministic name order)
  app.get("/v1/skills", async (_req, reply) => {
    const catalog = requireCatalog(state, reply);
    if (!catalog) return reply;
    const skills = catalog.entries().map(entrySummary);
    return reply.send({ skills });
  });

  // fetch one skill (manifest + body); fires a fire-and-forget viewed event
  app.get("/v1/skills/:name", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const catalog = requireCatalog(state, reply);
    if (!catalog) return reply;
    // Phase-0 self-improving-agent — record the view before returning the
    // body. Fire-and-forget; never block the read path on the learning store.
    const entry = catalog.get(name);
    if (entry && state.skillUsage) {
      const ev = viewedSkillUsageEvent(name, mapSource(entry.source), skillScopeUser());
      void state.skillUsage.recordEvent(ev).catch(() => {
        /* telemetry must never break the read path */
      });
    }
    if (!entry) {
      return reply.code(404).send({ error: "no such skill", name });
    }
    return reply.send({ ...entrySummary(entry), body: entry.body });
  });

  // re-scan disk roots — conservative no-op stub (mirrors Rust `reload`).
  // Catalog mutations (plugin install / uninstall) flow through the manager,
  // so a naive re-scan would clobber plugin entries; we surface the count and
  // leave the actual merge for a future change.
  app.post("/v1/skills/reload", async (_req, reply) => {
    const catalog = requireCatalog(state, reply);
    if (!catalog) return reply;
    return reply.send({ count: catalog.size, reloaded: false });
  });

  // lifecycle row (seeds Active from the catalogue when absent)
  app.get("/v1/skills/:name/lifecycle", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const seeded = await lifecycleOrSeed(state, reply, name);
    if (!seeded) return reply;
    return reply.send({ lifecycle: seeded.row });
  });

  // archive (soft-delete); optional `absorbed_into` umbrella skill
  app.post("/v1/skills/:name/archive", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const seeded = await lifecycleOrSeed(state, reply, name);
    if (!seeded) return reply;
    const body = (req.body ?? {}) as { absorbed_into?: unknown };
    const absorbed =
      typeof body.absorbed_into === "string" && body.absorbed_into.length > 0
        ? body.absorbed_into
        : undefined;
    const row: SkillLifecycle = {
      ...seeded.row,
      state: "archived",
      archived_at: new Date().toISOString(),
    };
    if (absorbed !== undefined) row.absorbed_into = absorbed;
    else delete row.absorbed_into;
    try {
      const saved = await seeded.store.upsert(row);
      return reply.send({ lifecycle: saved });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // restore (undo archive)
  app.post("/v1/skills/:name/restore", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const seeded = await lifecycleOrSeed(state, reply, name);
    if (!seeded) return reply;
    const row: SkillLifecycle = { ...seeded.row, state: "active" };
    delete row.archived_at;
    delete row.absorbed_into;
    try {
      const saved = await seeded.store.upsert(row);
      return reply.send({ lifecycle: saved });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
