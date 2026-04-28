// Modal for `gh pr create` — opened from the WorkspaceDiff card's
// [Create PR...] button. Fetches a server-side preview on open
// (suggested title from the most recent commit subject; suggested
// body from the bullet list of commits), then lets the user tweak
// before submitting.
//
// Defaults to `--draft` so the PR doesn't trigger CODEOWNERS / CI
// runs until the user explicitly switches it off. Always pushes
// the branch first; without that, `gh pr create` would refuse.
//
// If the server reports `gh_available: false`, the dialog renders
// a graceful "install gh + run gh auth login" hint instead of the
// form — better than letting the user fill out a form that's
// guaranteed to 400.

import { useEffect, useState } from "react";
import {
  createPr,
  fetchPrPreview,
  type PrPreview,
} from "../../services/workspaceDiff";
import { t } from "../../utils/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  base: string;
}

export function CreatePrDialog({ open, onClose, base }: Props) {
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ url: string; draft: boolean } | null>(null);

  // Refetch the preview each time the dialog opens. Cheaper than
  // caching — the title / body could be stale after a fresh commit
  // in the meantime, and the preview endpoint is fast (one git log
  // call).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccess(null);
    setLoadingPreview(true);
    void fetchPrPreview(base).then((p) => {
      setLoadingPreview(false);
      if (p == null) {
        setError(t("prDialogPreviewFailed"));
        return;
      }
      setPreview(p);
      setTitle(p.suggested_title);
      setBody(p.suggested_body);
      setDraft(true);
    });
  }, [open, base]);

  if (!open) return null;

  async function submit(): Promise<void> {
    if (busy) return;
    const t_ = title.trim();
    if (!t_) {
      setError(t("prDialogTitleRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createPr({
        title: t_,
        body,
        base,
        draft,
        push: true,
      });
      setSuccess({ url: result.url, draft: result.draft });
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  // gh missing → render a help screen instead of the form.
  const ghMissing = preview != null && !preview.gh_available;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal-card pr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="pr-dialog-title">{t("prDialogTitle")}</h3>
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
          {loadingPreview ? (
            <div className="modal-empty">{t("prDialogLoading")}</div>
          ) : ghMissing ? (
            <div className="modal-error pr-dialog-gh-missing">
              <strong>{t("prDialogGhMissing")}</strong>
              <pre className="pr-dialog-gh-cmd">{`brew install gh\ngh auth login`}</pre>
              <p>{t("prDialogGhMissingHint")}</p>
            </div>
          ) : success ? (
            <div className="pr-dialog-success">
              <p>{success.draft ? t("prDialogSuccessDraft") : t("prDialogSuccess")}</p>
              <a href={success.url} target="_blank" rel="noreferrer noopener" className="pr-dialog-url">
                {success.url}
              </a>
            </div>
          ) : (
            <>
              <div className="pr-dialog-branches">
                <code>{preview?.branch ?? "HEAD"}</code>
                <span aria-hidden="true">→</span>
                <code>{base}</code>
              </div>

              <label className="modal-field">
                <span className="modal-label">{t("prDialogTitleField")}</span>
                <input
                  className="modal-input"
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
              </label>

              <label className="modal-field">
                <span className="modal-label">{t("prDialogBodyField")}</span>
                <textarea
                  className="modal-textarea"
                  rows={8}
                  value={body}
                  disabled={busy}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <span className="modal-hint">{t("prDialogBodyHint")}</span>
              </label>

              <label className="modal-checkbox">
                <input
                  type="checkbox"
                  checked={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.checked)}
                />
                <span>{t("prDialogDraft")}</span>
              </label>

              {error ? <div className="modal-error">{error}</div> : null}
            </>
          )}
        </div>

        <footer className="modal-footer">
          {success ? (
            <button
              type="button"
              className="modal-btn modal-btn-primary"
              onClick={onClose}
            >
              {t("done")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="modal-btn"
                disabled={busy}
                onClick={onClose}
              >
                {t("cancel")}
              </button>
              {!ghMissing && !loadingPreview ? (
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  disabled={busy || !title.trim()}
                  onClick={() => void submit()}
                >
                  {busy
                    ? t("prDialogCreating")
                    : draft
                      ? t("prDialogCreateDraft")
                      : t("prDialogCreate")}
                </button>
              ) : null}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
