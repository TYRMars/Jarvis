// REST routes for Comment — per-requirement discussion threads.
//
// Ported from crates/harness-server/src/comments_routes.rs. Mounted only when
// `state.comments` is configured; every endpoint 503s otherwise so callers can
// distinguish "feature off" from "really broken".
//
// Endpoints:
//   GET    /v1/requirements/:id/comments  — list, oldest-first
//   POST   /v1/requirements/:id/comments  — post a top-level comment or reply
//   PATCH  /v1/comments/:comment_id       — edit body (?requirement_id=…)
//   DELETE /v1/comments/:comment_id       — delete (cascades to replies) (?requirement_id=…)
//
// Authoring policy (v0, mirrors Rust): every REST author is `Human`; real user
// identity arrives later. Body is trimmed + non-empty + length-capped. Every
// successful mutation also emits an `ActivityKind::Comment` row into
// `state.activities` (best-effort — a missing ActivityStore is silently skipped).
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, type JsonValue } from "@jarvis/core";
import {
  newActivity,
  newComment,
  replyComment,
  type ActivityActor,
  type Comment,
  type CommentStore,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

/**
 * Soft cap on a single comment body. Mirrors the Rust `MAX_COMMENT_BODY_BYTES`
 * (Linear: 32 KiB, GitHub: 64 KiB). Past this the model stops being useful as
 * discussion and the agent token budget suffers — push long content into the
 * description / a doc. Measured in UTF-8 bytes, matching Rust's `str::len()`.
 */
const MAX_COMMENT_BODY_BYTES = 32 * 1024;

const utf8 = new TextEncoder();

/** Return the comment store, or send a 503 and return undefined. */
function requireCommentStore(state: AppState, reply: FastifyReply): CommentStore | undefined {
  if (!state.comments) {
    reply.code(503).send({ error: "comment store not configured" });
    return undefined;
  }
  return state.comments;
}

/** Truncate a body for the activity preview, mirroring Rust's `preview`. */
function preview(body: string, cap: number): string {
  const trimmed = body.trim();
  const chars = [...trimmed];
  if (chars.length <= cap) return trimmed;
  return chars.slice(0, cap).join("") + "…";
}

/**
 * Best-effort audit emit. Mirrors `record_comment_activity` — failures are
 * swallowed (the timeline row is non-critical), and a missing ActivityStore is
 * a no-op.
 */
async function recordCommentActivity(state: AppState, comment: Comment, action: string): Promise<void> {
  if (!state.activities) return;
  const body: JsonValue = {
    comment_id: comment.id,
    action,
    parent_id: comment.parent_id ?? null,
    preview: preview(comment.body, 120),
  };
  const activity = newActivity(comment.requirement_id, "comment", comment.author, body);
  try {
    await state.activities.append(activity);
  } catch {
    /* losing a timeline row must not cost the comment write */
  }
}

export function registerCommentsRoutes(app: FastifyInstance, state: AppState): void {
  // ---- GET /v1/requirements/:id/comments ----
  app.get("/v1/requirements/:id/comments", async (req, reply) => {
    const store = requireCommentStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const items = await store.listForRequirement(id);
      return reply.send({ requirement_id: id, items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- POST /v1/requirements/:id/comments ----
  app.post("/v1/requirements/:id/comments", async (req, reply) => {
    const store = requireCommentStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const payload = (req.body ?? {}) as { body?: unknown; parent_id?: unknown };
    if (typeof payload.body !== "string") {
      return reply.code(400).send({ error: "comment body must not be empty" });
    }
    const body = payload.body.trim();
    if (body.length === 0) {
      return reply.code(400).send({ error: "comment body must not be empty" });
    }
    if (utf8.encode(body).length > MAX_COMMENT_BODY_BYTES) {
      return reply.code(400).send({ error: `comment body exceeds ${MAX_COMMENT_BODY_BYTES}-byte cap` });
    }

    // v0 — every REST POST is a Human author.
    const author: ActivityActor = { type: "human" };
    const parentRaw = typeof payload.parent_id === "string" ? payload.parent_id : undefined;
    const comment =
      parentRaw != null && parentRaw.trim().length > 0
        ? replyComment(id, author, body, parentRaw.trim())
        : newComment(id, author, body);

    try {
      await store.create(comment);
    } catch (e) {
      // `parent_id` validation errors come from the store's depth check —
      // surface them as 400 rather than 500 so the client knows the input was
      // wrong. (Mirrors Rust's substring match on "depth 1" / "not found".)
      const msg = errorText(e);
      if (msg.includes("depth 1") || msg.includes("not found")) {
        return reply.code(400).send({ error: msg });
      }
      return reply.code(500).send({ error: msg });
    }
    await recordCommentActivity(state, comment, "posted");
    return reply.code(201).send(comment);
  });

  // ---- PATCH /v1/comments/:comment_id?requirement_id=… ----
  app.patch("/v1/comments/:comment_id", async (req, reply) => {
    const store = requireCommentStore(state, reply);
    if (!store) return reply;
    const commentId = (req.params as { comment_id: string }).comment_id;
    const requirementId = (req.query as { requirement_id?: string }).requirement_id;
    if (typeof requirementId !== "string" || requirementId.trim().length === 0) {
      return reply.code(400).send({ error: "requirement_id query param is required" });
    }
    const payload = (req.body ?? {}) as { body?: unknown };
    if (typeof payload.body !== "string") {
      return reply.code(400).send({ error: "comment body must not be empty" });
    }
    const newBody = payload.body.trim();
    if (newBody.length === 0) {
      return reply.code(400).send({ error: "comment body must not be empty" });
    }
    if (utf8.encode(newBody).length > MAX_COMMENT_BODY_BYTES) {
      return reply.code(400).send({ error: `comment body exceeds ${MAX_COMMENT_BODY_BYTES}-byte cap` });
    }

    // Build a partial Comment carrying only the caller-mutable fields; the
    // store's `update` pins id / requirement_id / author / parent_id /
    // created_at from the existing row. The placeholders here are ignored.
    const now = new Date().toISOString();
    const patch: Comment = {
      id: commentId,
      requirement_id: requirementId,
      author: { type: "human" }, // placeholder; preserved by store impl
      body: newBody,
      created_at: now,
      updated_at: now,
    };

    let updated: boolean;
    try {
      updated = await store.update(patch);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!updated) {
      return reply.code(404).send({ error: `comment \`${commentId}\` not found` });
    }
    // Re-load so the activity payload + response reflect the real author /
    // parent_id, not the placeholders we passed to `update`.
    let edited: Comment | undefined;
    try {
      const rows = await store.listForRequirement(requirementId);
      edited = rows.find((c) => c.id === commentId);
    } catch {
      edited = undefined;
    }
    if (edited) {
      await recordCommentActivity(state, edited, "edited");
      return reply.send(edited);
    }
    // Edge case: row vanished between update and re-list (concurrent delete).
    return reply.send({ id: commentId, requirement_id: requirementId, body: newBody });
  });

  // ---- DELETE /v1/comments/:comment_id?requirement_id=… ----
  app.delete("/v1/comments/:comment_id", async (req, reply) => {
    const store = requireCommentStore(state, reply);
    if (!store) return reply;
    const commentId = (req.params as { comment_id: string }).comment_id;
    const requirementId = (req.query as { requirement_id?: string }).requirement_id;
    if (typeof requirementId !== "string" || requirementId.trim().length === 0) {
      return reply.code(400).send({ error: "requirement_id query param is required" });
    }
    let deleted: boolean;
    try {
      deleted = await store.delete(requirementId, commentId);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!deleted) {
      return reply.code(404).send({ error: `comment \`${commentId}\` not found` });
    }
    // We don't have the original Comment in hand, so emit a minimal activity
    // row. Author defaults to Human (v0 — see post handler).
    if (state.activities) {
      const activity = newActivity(
        requirementId,
        "comment",
        { type: "human" },
        { comment_id: commentId, action: "deleted" },
      );
      try {
        await state.activities.append(activity);
      } catch {
        /* tolerate audit-emit failure */
      }
    }
    return reply.send({ deleted: true });
  });
}
