// Modal for "stage all + commit" — opened from the WorkspaceDiff
// card's [Commit...] button. Deliberately direct (REST endpoint, not
// agent loop): the user has already eyeballed the diff in the card
// and clicked a button; routing through the agent would burn LLM
// tokens for a fully-specified action.
//
// What it does:
//   1. Subject + body textarea (subject mandatory; body optional).
//   2. Optional "Push to origin after commit" checkbox.
//   3. Confirm → POST /v1/workspace/commit → re-fetch the diff so
//      the rail card updates with the new HEAD.
//   4. Inline error region for git failures (no commits, merge
//      conflict, push auth issue, etc.). Banner stays for cross-
//      cutting errors only.
//
// Cmd / Ctrl + Enter inside the textarea submits, matching the
// reason-prompt pattern in ApprovalCard.

import { useEffect, useRef, useState } from "react";
import {
  commitWorkspace,
  refreshWorkspaceDiff,
} from "../../services/workspaceDiff";
import { t } from "../../utils/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  uncommittedFiles: number;
  uncommittedAdded: number;
  uncommittedRemoved: number;
}

export function CommitDialog({
  open,
  onClose,
  uncommittedFiles,
  uncommittedAdded,
  uncommittedRemoved,
}: Props) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [push, setPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);

  // Reset form fields each time the dialog opens so a stale message
  // from a cancelled previous attempt doesn't get accidentally re-used.
  useEffect(() => {
    if (open) {
      setSubject("");
      setBody("");
      setPush(false);
      setError(null);
      // Focus subject field on open for fast keyboard flow.
      window.setTimeout(() => subjectRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  async function submit(): Promise<void> {
    if (busy) return;
    const s = subject.trim();
    if (!s) {
      setError(t("commitDialogSubjectRequired"));
      return;
    }
    const message = body.trim() ? `${s}\n\n${body.trim()}` : s;
    setBusy(true);
    setError(null);
    try {
      const result = await commitWorkspace({ message, push });
      // Refresh the diff card so committed numbers move from the
      // "uncommitted" warning bar into the main stat row.
      await refreshWorkspaceDiff();
      // Close on full success. If push was requested but failed, we
      // keep the dialog open with the error so the user can decide
      // whether to retry (the commit itself succeeded, so the next
      // "Commit" click would say "nothing to commit" — that's why
      // we surface push errors prominently).
      if (push && !result.pushed && result.push_error) {
        setError(t("commitDialogPushFailed", result.push_error));
        setBusy(false);
        return;
      }
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Soft warning when subject exceeds the 72-char convention.
  const subjectWarn = subject.length > 72;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal-card commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="commit-dialog-title">{t("commitDialogTitle")}</h3>
          <button
            type="button"
            className="modal-close"
            disabled={busy}
            onClick={onClose}
            aria-label={t("cancel")}
          >
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="commit-dialog-summary">
            {t("commitDialogSummary", uncommittedFiles, uncommittedAdded, uncommittedRemoved)}
          </div>

          <label className="modal-field">
            <span className="modal-label">{t("commitDialogSubject")}</span>
            <input
              ref={subjectRef}
              className={`modal-input${subjectWarn ? " modal-input-warn" : ""}`}
              value={subject}
              disabled={busy}
              placeholder="feat: add code review rail card"
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <span className={`modal-hint${subjectWarn ? " warn" : ""}`}>
              {subjectWarn
                ? t("commitDialogSubjectTooLong", subject.length)
                : t("commitDialogSubjectHint")}
            </span>
          </label>

          <label className="modal-field">
            <span className="modal-label">{t("commitDialogBody")}</span>
            <textarea
              className="modal-textarea"
              rows={5}
              value={body}
              disabled={busy}
              placeholder={t("commitDialogBodyPlaceholder")}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <span className="modal-hint">{t("commitDialogBodyHint")}</span>
          </label>

          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={push}
              disabled={busy}
              onChange={(e) => setPush(e.target.checked)}
            />
            <span>{t("commitDialogPush")}</span>
          </label>

          {error ? <div className="modal-error">{error}</div> : null}
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            className="modal-btn"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-primary"
            disabled={busy || !subject.trim()}
            onClick={() => void submit()}
          >
            {busy ? t("commitDialogCommitting") : t("commitDialogCommit")}
          </button>
        </footer>
      </div>
    </div>
  );
}
