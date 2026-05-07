// Phase 3.8 — discussion thread for one Requirement.
//
// Mounted inside `RequirementDetail` (right rail), under the TODO /
// runs / activity sections. Renders an oldest-first list of
// top-level comments with their depth-1 replies indented underneath,
// plus an inline composer at the bottom for new top-level posts.
//
// Each row supports:
//   - Reply (top-level only — depth-1 invariant enforced server-side)
//   - Edit (own row only; v0 every Human-authored row counts as "own")
//   - Delete (cascades into replies on the server; UI mirrors that)
//
// Loads via `loadComments(requirementId)` on mount and on
// requirement-id change. Subscribes to the cache via
// `subscribeComments` so optimistic mutations + future WS frames
// repaint without a manual refetch.
//
// The component intentionally renders a 503 sentinel ("comments
// disabled") rather than a loading spinner forever when the server
// answers 503 — that maps to "comment store not configured", which
// is a deployment choice, not a transient.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  deleteComment,
  editComment,
  listComments,
  loadComments,
  postComment,
  subscribeComments,
} from "../../services/comments";
import type { Comment } from "../../types/frames";
import { Button } from "../ui";
import { t } from "../../utils/i18n";
import { actorLabel, formatTime } from "./activityRow";

interface RequirementCommentsProps {
  requirementId: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

export function RequirementComments({ requirementId }: RequirementCommentsProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  // `bump` re-renders on any cache change for this requirement.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Refresh cache + subscribe on requirement-id change.
  useEffect(() => {
    let alive = true;
    setLoad({ kind: "loading" });
    void loadComments(requirementId)
      .then((rows) => {
        if (!alive) return;
        if (rows == null) {
          setLoad({ kind: "disabled" });
        } else {
          setLoad({ kind: "ready" });
        }
      })
      .catch((e: Error) => {
        if (!alive) return;
        setLoad({ kind: "error", message: e.message });
      });
    const unsub = subscribeComments(requirementId, () => bump());
    return () => {
      alive = false;
      unsub();
    };
  }, [requirementId]);

  const allComments = listComments(requirementId);
  const { topLevel, repliesByParent } = useMemo(
    () => groupComments(allComments),
    [allComments],
  );

  if (load.kind === "loading" || load.kind === "idle") {
    return (
      <details className="requirement-detail-comments" open>
        <summary className="requirement-detail-record-summary">
          <span className="requirement-detail-runs-heading">
            {t("commentsHeading")}
          </span>
          <span className="requirement-detail-record-meta">
            {t("commentsLoading")}
          </span>
        </summary>
      </details>
    );
  }

  if (load.kind === "disabled") {
    return (
      <details className="requirement-detail-comments">
        <summary className="requirement-detail-record-summary">
          <span className="requirement-detail-runs-heading">
            {t("commentsHeading")}
          </span>
          <span className="requirement-detail-record-meta">
            {t("commentsDisabled")}
          </span>
        </summary>
        <p className="requirement-detail-empty">{t("commentsDisabledHelp")}</p>
      </details>
    );
  }

  return (
    <details className="requirement-detail-comments" open>
      <summary className="requirement-detail-record-summary">
        <span className="requirement-detail-runs-heading">
          {t("commentsHeading")}
        </span>
        <span className="requirement-detail-record-meta">
          {load.kind === "error"
            ? t("commentsLoadError")
            : t("commentsSummary", allComments.length)}
        </span>
      </summary>

      {load.kind === "error" && (
        <p className="requirement-detail-comments-error" role="alert">
          {load.message}
        </p>
      )}

      {topLevel.length === 0 ? (
        <p className="requirement-detail-empty">{t("commentsEmpty")}</p>
      ) : (
        <ol className="requirement-detail-comments-list">
          {topLevel.map((c) => (
            <CommentThread
              key={c.id}
              comment={c}
              replies={repliesByParent.get(c.id) ?? []}
              requirementId={requirementId}
            />
          ))}
        </ol>
      )}

      <CommentComposer requirementId={requirementId} />
    </details>
  );
}

// ---------- thread (top-level + its depth-1 replies) ----------------

function CommentThread({
  comment,
  replies,
  requirementId,
}: {
  comment: Comment;
  replies: Comment[];
  requirementId: string;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <li className="requirement-detail-comment-thread">
      <CommentRow comment={comment} requirementId={requirementId} />
      {replies.length > 0 && (
        <ol className="requirement-detail-comment-replies">
          {replies.map((r) => (
            <li key={r.id}>
              <CommentRow comment={r} requirementId={requirementId} />
            </li>
          ))}
        </ol>
      )}
      <div className="requirement-detail-comment-actions">
        {!replying ? (
          <button
            type="button"
            className="requirement-detail-comment-action"
            onClick={() => setReplying(true)}
          >
            {t("commentsReply")}
          </button>
        ) : (
          <CommentComposer
            requirementId={requirementId}
            parentId={comment.id}
            placeholder={t("commentsReplyPlaceholder")}
            onDone={() => setReplying(false)}
          />
        )}
      </div>
    </li>
  );
}

// ---------- single row (with edit + delete) -------------------------

function CommentRow({
  comment,
  requirementId,
}: {
  comment: Comment;
  requirementId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasEdited = comment.updated_at !== comment.created_at;

  // Keep the textarea synced if a different edit lands while we're
  // viewing (e.g. WS broadcast in a future phase).
  useEffect(() => {
    if (!editing) setBody(comment.body);
  }, [comment.body, editing]);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || trimmed === comment.body) {
      setEditing(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await editComment(comment.id, requirementId, trimmed);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [body, comment.body, comment.id, requirementId]);

  const remove = useCallback(async () => {
    if (!window.confirm(t("commentsDeleteConfirm"))) return;
    try {
      await deleteComment(comment.id, requirementId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [comment.id, requirementId]);

  return (
    <article className="requirement-detail-comment-row">
      <header className="requirement-detail-comment-meta">
        <span className="requirement-detail-comment-author">
          {actorLabel(comment.author)}
        </span>
        <span className="requirement-detail-comment-time">
          {formatTime(comment.created_at)}
          {wasEdited && (
            <span
              className="requirement-detail-comment-edited"
              title={comment.updated_at}
            >
              {t("commentsEdited")}
            </span>
          )}
        </span>
      </header>
      {editing ? (
        <div className="requirement-detail-comment-editor">
          <textarea
            className="requirement-detail-comment-textarea"
            value={body}
            disabled={pending}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
          <div className="requirement-detail-comment-editor-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={() => void submit()}
            >
              {t("commentsSave")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setBody(comment.body);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="requirement-detail-comment-body">{comment.body}</p>
      )}
      {error && (
        <p className="requirement-detail-comment-error" role="alert">
          {error}
        </p>
      )}
      {!editing && comment.author.type === "human" && (
        <div className="requirement-detail-comment-actions">
          <button
            type="button"
            className="requirement-detail-comment-action"
            onClick={() => setEditing(true)}
          >
            {t("commentsEdit")}
          </button>
          <button
            type="button"
            className="requirement-detail-comment-action requirement-detail-comment-action-danger"
            onClick={() => void remove()}
          >
            {t("commentsDelete")}
          </button>
        </div>
      )}
    </article>
  );
}

// ---------- composer (top-level OR reply) ---------------------------

function CommentComposer({
  requirementId,
  parentId,
  placeholder,
  onDone,
}: {
  requirementId: string;
  parentId?: string;
  placeholder?: string;
  onDone?: () => void;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus replies for a snappier feel — top-level composer
  // stays unfocused so we don't steal focus from the rest of the
  // detail panel on open.
  useEffect(() => {
    if (parentId && ref.current) ref.current.focus();
  }, [parentId]);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      await postComment(requirementId, trimmed, parentId);
      setBody("");
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [body, parentId, requirementId, onDone]);

  return (
    <form
      className="requirement-detail-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        className="requirement-detail-comment-textarea"
        value={body}
        disabled={pending}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder ?? t("commentsPlaceholder")}
        rows={parentId ? 2 : 3}
        // Cmd / Ctrl + Enter submits — common chat-app affordance.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="requirement-detail-comment-composer-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={pending || body.trim().length === 0}
        >
          {parentId ? t("commentsReplySubmit") : t("commentsSubmit")}
        </Button>
        {onDone && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onDone}
          >
            {t("cancel")}
          </Button>
        )}
      </div>
      {error && (
        <p className="requirement-detail-comment-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------- pure: split top-level vs replies ------------------------

interface Grouped {
  topLevel: Comment[];
  repliesByParent: Map<string, Comment[]>;
}

function groupComments(rows: Comment[]): Grouped {
  const topLevel: Comment[] = [];
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of rows) {
    if (c.parent_id) {
      const list = repliesByParent.get(c.parent_id) ?? [];
      list.push(c);
      repliesByParent.set(c.parent_id, list);
    } else {
      topLevel.push(c);
    }
  }
  // Both groups should already arrive oldest-first from the server,
  // but enforce locally so optimistic inserts that race the round-trip
  // still show in the right order.
  topLevel.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const list of repliesByParent.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return { topLevel, repliesByParent };
}
