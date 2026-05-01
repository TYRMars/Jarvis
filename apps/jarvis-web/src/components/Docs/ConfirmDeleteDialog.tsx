import { useEffect, useRef } from "react";
import { t } from "../../utils/i18n";

interface ConfirmDeleteDialogProps {
  title: string;
  detail?: string;
  /// Confirm-button label. Defaults to the localized "Delete doc".
  confirmLabel?: string;
  /// Cancel-button label. Defaults to the localized "Cancel".
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/// Stand-in for the browser `confirm()` dialog. Renders an overlay
/// modal that respects the page's design tokens, traps focus on the
/// confirm button, and dismisses on Esc / overlay click.
export function ConfirmDeleteDialog({
  title,
  detail,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) {
  const resolvedConfirm = confirmLabel ?? t("docsDeleteConfirm");
  const resolvedCancel = cancelLabel ?? t("docsCreateCancel");
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="docs-modal-overlay"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="docs-modal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="docs-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="docs-confirm-title" className="docs-modal-title">
          {title}
        </h2>
        {detail ? <p className="docs-modal-detail">{detail}</p> : null}
        <div className="docs-modal-actions">
          <button
            type="button"
            className="docs-btn-ghost"
            onClick={onCancel}
          >
            {resolvedCancel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="docs-btn-danger"
            onClick={onConfirm}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
