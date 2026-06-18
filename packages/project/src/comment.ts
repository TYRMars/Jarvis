// User-authored discussion threads attached to a Requirement.
//
// Ported from crates/harness-project/src/comment.rs. Where Activity is "what
// happened", Comment is "what people / agents said" — free-form prose.
// Comments are NOT append-only: operators can edit / delete.
import type { ActivityActor } from "./activity.ts";

/**
 * One row in the discussion thread for a Requirement. `parent_id` enables
 * one level of threading: a top-level comment has no parent; a reply points
 * at the top-level id. Depth > 1 is rejected at the store layer.
 */
export interface Comment {
  /** Stable identifier (UUID v4). */
  id: string;
  /** The Requirement this comment is attached to. */
  requirement_id: string;
  /** Who wrote it. Reuses {@link ActivityActor}. */
  author: ActivityActor;
  /** Plain markdown body. */
  body: string;
  /**
   * `<top_level_id>` for a one-level reply; absent for a top-level comment.
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  parent_id?: string;
  /** RFC-3339 / ISO-8601. Set on insert, never mutated. */
  created_at: string;
  /** RFC-3339 / ISO-8601. Set on insert (= created_at), bumped on every edit. */
  updated_at: string;
}

/** Build a fresh top-level comment with a new UUID and matching timestamps. */
export function newComment(requirementId: string, author: ActivityActor, body: string): Comment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    requirement_id: requirementId,
    author,
    body,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Build a reply to `parentId`. The depth-1 invariant is the store's
 * responsibility to enforce on insert; this just records the parent.
 */
export function replyComment(
  requirementId: string,
  author: ActivityActor,
  body: string,
  parentId: string,
): Comment {
  const c = newComment(requirementId, author, body);
  c.parent_id = parentId;
  return c;
}

/**
 * Replace the body and bump `updated_at`. Returns `true` when the body
 * actually changed; the store can use this to skip a no-op write.
 */
export function editComment(comment: Comment, newBody: string): boolean {
  if (newBody === comment.body) {
    return false;
  }
  comment.body = newBody;
  comment.updated_at = new Date().toISOString();
  return true;
}

/**
 * Broadcast event for {@link Comment} mutations. Serde shape:
 * `#[serde(tag = "type", rename_all = "snake_case")]`. The `Posted(Comment)`
 * / `Edited(Comment)` newtype variants flatten the comment's fields.
 */
export type CommentEvent =
  | ({ type: "posted" } & Comment)
  | ({ type: "edited" } & Comment)
  | { type: "deleted"; requirement_id: string; comment_id: string };

/** Requirement id the event targets — convenience for per-requirement WS filtering. */
export function commentEventRequirementId(ev: CommentEvent): string {
  return ev.requirement_id;
}
