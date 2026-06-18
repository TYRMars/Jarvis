// REST routes for Label — project-scoped tags.
//
// Ported from crates/harness-server/src/labels_routes.rs. Mounted only when
// `state.labels` is configured; 503s otherwise.
//
// Endpoints:
//   GET    /v1/projects/:project_id/labels  — list, alpha-sorted
//   POST   /v1/projects/:project_id/labels  — create
//   PATCH  /v1/labels/:label_id             — rename / recolour / re-describe
//   DELETE /v1/labels/:label_id             — delete (does NOT cascade into Requirement.label_ids)
//
// Name/colour validation comes from `validateLabelName` / `validateLabelColour`.
// Name uniqueness inside a project is enforced by the store layer; its
// "already exists" error surfaces as `409 Conflict`.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  newLabel,
  touchLabel,
  validateLabelColour,
  validateLabelName,
  type Label,
  type LabelStore,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

/**
 * Soft cap on `description`. Long descriptions belong in a doc, not hovering on
 * a kanban chip. Measured in UTF-8 bytes, matching Rust's `str::len()`.
 */
const MAX_LABEL_DESCRIPTION_BYTES = 256;

const utf8 = new TextEncoder();

/** Return the label store, or send a 503 and return undefined. */
function requireLabelStore(state: AppState, reply: FastifyReply): LabelStore | undefined {
  if (!state.labels) {
    reply.code(503).send({ error: "label store not configured" });
    return undefined;
  }
  return state.labels;
}

/**
 * Map `LabelStore.create` / `update` errors into the right HTTP status. The
 * store surfaces "already exists" as a free-form message; we pattern-match on
 * the substring (mirrors Rust's `map_label_store_err`) → 409, else 500.
 */
function mapLabelStoreErr(state: AppState, reply: FastifyReply, e: unknown): FastifyReply {
  const msg = errorText(e);
  if (msg.includes("already exists")) {
    return reply.code(409).send({ error: msg });
  }
  return reply.code(500).send({ error: msg });
}

/**
 * Validate / canonicalise the optional description. Mirrors Rust's
 * `validate_description`:
 *   undefined/null → { ok: undefined } (don't touch)
 *   ""             → { ok: undefined } (clear)
 *   longer         → { ok: trimmed } if within cap, else { err }
 */
function validateDescription(raw: string | undefined): { ok: string | undefined } | { err: string } {
  if (raw == null) return { ok: undefined };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: undefined };
  if (utf8.encode(trimmed).length > MAX_LABEL_DESCRIPTION_BYTES) {
    return { err: `label description exceeds ${MAX_LABEL_DESCRIPTION_BYTES}-byte cap` };
  }
  return { ok: trimmed };
}

export function registerLabelsRoutes(app: FastifyInstance, state: AppState): void {
  // ---- GET /v1/projects/:project_id/labels ----
  app.get("/v1/projects/:project_id/labels", async (req, reply) => {
    const store = requireLabelStore(state, reply);
    if (!store) return reply;
    const projectId = (req.params as { project_id: string }).project_id;
    try {
      const items = await store.listForProject(projectId);
      return reply.send({ project_id: projectId, items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- POST /v1/projects/:project_id/labels ----
  app.post("/v1/projects/:project_id/labels", async (req, reply) => {
    const store = requireLabelStore(state, reply);
    if (!store) return reply;
    const projectId = (req.params as { project_id: string }).project_id;
    const payload = (req.body ?? {}) as { name?: unknown; colour?: unknown; description?: unknown };

    const name = validateLabelName(typeof payload.name === "string" ? payload.name : "");
    if ("err" in name) return reply.code(400).send({ error: name.err });
    const colour = validateLabelColour(typeof payload.colour === "string" ? payload.colour : "");
    if ("err" in colour) return reply.code(400).send({ error: colour.err });
    const description = validateDescription(
      typeof payload.description === "string" ? payload.description : undefined,
    );
    if ("err" in description) return reply.code(400).send({ error: description.err });

    const label = newLabel(projectId, name.ok, colour.ok);
    if (description.ok !== undefined) label.description = description.ok;
    try {
      await store.create(label);
    } catch (e) {
      return mapLabelStoreErr(state, reply, e);
    }
    return reply.code(201).send(label);
  });

  // ---- PATCH /v1/labels/:label_id ----
  app.patch("/v1/labels/:label_id", async (req, reply) => {
    const store = requireLabelStore(state, reply);
    if (!store) return reply;
    const labelId = (req.params as { label_id: string }).label_id;
    let existing: Label | undefined;
    try {
      existing = await store.get(labelId);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!existing) {
      return reply.code(404).send({ error: `label \`${labelId}\` not found` });
    }
    const payload = (req.body ?? {}) as { name?: unknown; colour?: unknown; description?: unknown };

    if (typeof payload.name === "string") {
      const name = validateLabelName(payload.name);
      if ("err" in name) return reply.code(400).send({ error: name.err });
      existing.name = name.ok;
    }
    if (typeof payload.colour === "string") {
      const colour = validateLabelColour(payload.colour);
      if ("err" in colour) return reply.code(400).send({ error: colour.err });
      existing.colour = colour.ok;
    }
    if (typeof payload.description === "string") {
      const description = validateDescription(payload.description);
      if ("err" in description) return reply.code(400).send({ error: description.err });
      // `{ ok: undefined }` clears the description (mirrors Rust assigning None).
      if (description.ok === undefined) delete existing.description;
      else existing.description = description.ok;
    }
    touchLabel(existing);
    let updated: boolean;
    try {
      updated = await store.update(existing);
    } catch (e) {
      return mapLabelStoreErr(state, reply, e);
    }
    if (!updated) {
      return reply.code(404).send({ error: `label \`${labelId}\` not found` });
    }
    return reply.send(existing);
  });

  // ---- DELETE /v1/labels/:label_id ----
  app.delete("/v1/labels/:label_id", async (req, reply) => {
    const store = requireLabelStore(state, reply);
    if (!store) return reply;
    const labelId = (req.params as { label_id: string }).label_id;
    let existing: Label | undefined;
    try {
      existing = await store.get(labelId);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!existing) {
      return reply.code(404).send({ error: `label \`${labelId}\` not found` });
    }
    let deleted: boolean;
    try {
      deleted = await store.delete(existing.project_id, labelId);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!deleted) {
      return reply.code(404).send({ error: `label \`${labelId}\` not found` });
    }
    return reply.send({ deleted: true, label_id: labelId, project_id: existing.project_id });
  });
}
