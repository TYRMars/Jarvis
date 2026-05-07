// Service layer for Phase 3.8 per-requirement Comment threads.
//
// Shape mirrors `services/requirements.ts`: a per-requirement
// in-memory cache + subscriber set, populated lazily by `loadComments`
// and updated optimistically by mutations. Components subscribe via
// `subscribeComments(requirementId, fn)` and read synchronously via
// `listComments(requirementId)`.
//
// We keep this **separate** from the requirements cache rather than
// stuffing `comments?: Comment[]` onto each Requirement row because:
// - comments are paged separately on the wire (different REST URL),
// - a kanban list view shouldn't pay the cost of every requirement's
//   thread, and
// - WS broadcast shape (when it lands) will be `comment_*` frames,
//   not `requirement_upserted` round-trips.
//
// REST endpoints (see `crates/harness-server/src/comments_routes.rs`):
//   GET    /v1/requirements/:id/comments          -> { items: Comment[] }
//   POST   /v1/requirements/:id/comments          -> Comment (201)
//   PATCH  /v1/comments/:cid?requirement_id=:rid  -> Comment
//   DELETE /v1/comments/:cid?requirement_id=:rid  -> { deleted: true }

import type { Comment } from "../types/frames";
import { apiUrl } from "./api";

// ---------- in-memory cache + subscribers --------------------------

const cache: Map<string, Comment[]> = new Map();
const subscribers = new Map<string, Set<() => void>>();

function notify(requirementId: string): void {
  const set = subscribers.get(requirementId);
  if (!set) return;
  for (const s of set) {
    try {
      s();
    } catch (e) {
      console.warn("comments subscriber threw", e);
    }
  }
}

/**
 * Subscribe to cache updates for one requirement. Returns the
 * unsubscribe function. Idiomatic React-effect pattern:
 *
 *   useEffect(() => subscribeComments(reqId, () => bump((n) => n + 1)),
 *             [reqId]);
 */
export function subscribeComments(
  requirementId: string,
  fn: () => void,
): () => void {
  const set = subscribers.get(requirementId) ?? new Set();
  subscribers.set(requirementId, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(requirementId);
  };
}

/**
 * Synchronous read from cache. Returns `[]` if `loadComments` has
 * never been called for `requirementId`.
 */
export function listComments(requirementId: string): Comment[] {
  return cache.get(requirementId) ?? [];
}

/**
 * Refresh cache from the server. Returns `null` if the server
 * answered 503 ("comment store not configured"), so the caller can
 * render a "feature disabled" state instead of a loading spinner
 * forever.
 */
export async function loadComments(
  requirementId: string,
): Promise<Comment[] | null> {
  const r = await fetch(
    apiUrl(`/v1/requirements/${encodeURIComponent(requirementId)}/comments`),
  );
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`comments list: ${r.status}`);
  const body = (await r.json()) as { items: Comment[] };
  cache.set(requirementId, body.items ?? []);
  notify(requirementId);
  return body.items ?? [];
}

/**
 * Post a top-level comment (omit `parentId`) or a depth-1 reply.
 * Optimistically appends to the cache so the UI shows the new row
 * instantly; reconciles with the server's UUID + timestamps after
 * the response.
 */
export async function postComment(
  requirementId: string,
  body: string,
  parentId?: string,
): Promise<Comment> {
  const r = await fetch(
    apiUrl(`/v1/requirements/${encodeURIComponent(requirementId)}/comments`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parentId ? { body, parent_id: parentId } : { body }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`post comment ${r.status}: ${text}`);
  }
  const created = (await r.json()) as Comment;
  // Insert in oldest-first order (the GET endpoint sorts that way).
  const list = cache.get(requirementId) ?? [];
  const next = list.concat(created);
  next.sort((a, b) => a.created_at.localeCompare(b.created_at));
  cache.set(requirementId, next);
  notify(requirementId);
  return created;
}

/**
 * Edit an existing comment's body. The `requirementId` is required
 * by the server because the URL only carries the comment id.
 */
export async function editComment(
  commentId: string,
  requirementId: string,
  body: string,
): Promise<Comment> {
  const r = await fetch(
    apiUrl(
      `/v1/comments/${encodeURIComponent(commentId)}?requirement_id=${encodeURIComponent(
        requirementId,
      )}`,
    ),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`edit comment ${r.status}: ${text}`);
  }
  const updated = (await r.json()) as Comment;
  const list = cache.get(requirementId) ?? [];
  const idx = list.findIndex((c) => c.id === commentId);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = updated;
    cache.set(requirementId, next);
    notify(requirementId);
  }
  return updated;
}

/**
 * Hard-delete a comment. Deleting a top-level comment cascades into
 * its replies on the server side; the cache is updated to reflect
 * the same drop.
 */
export async function deleteComment(
  commentId: string,
  requirementId: string,
): Promise<void> {
  const r = await fetch(
    apiUrl(
      `/v1/comments/${encodeURIComponent(commentId)}?requirement_id=${encodeURIComponent(
        requirementId,
      )}`,
    ),
    { method: "DELETE" },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`delete comment ${r.status}: ${text}`);
  }
  // Drop the comment AND any replies pointing at it (server cascades;
  // the local cache must mirror that).
  const list = cache.get(requirementId) ?? [];
  const next = list.filter(
    (c) => c.id !== commentId && c.parent_id !== commentId,
  );
  cache.set(requirementId, next);
  notify(requirementId);
}

/**
 * Drop the cache entry for a requirement. Useful when a Requirement
 * row is deleted — saves us from leaking comments for ids that
 * aren't on the kanban any more.
 */
export function forgetComments(requirementId: string): void {
  cache.delete(requirementId);
  subscribers.delete(requirementId);
}

// ---------- WS frame appliers --------------------------------------
//
// Wired up in `services/frames/domainFrames.ts`. Each helper
// idempotently merges the broadcast row into the local cache so a
// late-arriving frame after an optimistic mutation doesn't double-
// insert. The cache stays the single source of truth for any
// component that calls `listComments`.

export function applyCommentPosted(c: Comment): void {
  const list = cache.get(c.requirement_id) ?? [];
  if (list.some((existing) => existing.id === c.id)) {
    // Optimistic insert already landed — overwrite to pick up any
    // server-side normalisation (timestamps, body trim, etc.).
    const next = list.map((existing) =>
      existing.id === c.id ? c : existing,
    );
    cache.set(c.requirement_id, next);
  } else {
    const next = list.concat(c);
    next.sort((a, b) => a.created_at.localeCompare(b.created_at));
    cache.set(c.requirement_id, next);
  }
  notify(c.requirement_id);
}

export function applyCommentEdited(c: Comment): void {
  const list = cache.get(c.requirement_id);
  if (!list) return; // not loaded for this requirement yet
  const idx = list.findIndex((existing) => existing.id === c.id);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = c;
  cache.set(c.requirement_id, next);
  notify(c.requirement_id);
}

export function applyCommentDeleted(
  requirementId: string,
  commentId: string,
): void {
  const list = cache.get(requirementId);
  if (!list) return;
  // Server cascades top-level → replies; the WS bridge fires one
  // `Deleted` per row, so this filter handles either case (drops
  // exactly one matching id per call).
  const next = list.filter((c) => c.id !== commentId);
  if (next.length !== list.length) {
    cache.set(requirementId, next);
    notify(requirementId);
  }
}
