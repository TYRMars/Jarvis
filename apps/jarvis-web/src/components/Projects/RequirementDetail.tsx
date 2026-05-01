import { useEffect } from "react";
import type { Requirement, RequirementStatus } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  linkRequirementConversation,
  updateRequirement,
} from "../../services/requirements";
import { COLUMNS } from "./columns";
import { MarkdownLite } from "./MarkdownLite";

// Right-side slide-in panel that replaces the previous in-place
// expand interaction. The card surface stays compact (single
// description-clamp); clicking the card opens this panel with full
// markdown + actions.
//
// Owned by `ProjectBoard`: `requirement` is `null` when closed,
// `Requirement` when a card is selected. Backdrop click, ESC, and
// the X button all dispatch `onClose`.
export function RequirementDetail({
  requirement,
  activeConversationId,
  onClose,
  onChanged,
  onOpenConversation,
}: {
  requirement: Requirement | null;
  activeConversationId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  // Close on Escape — common modal/panel behaviour. Effect guard:
  // only attach the listener while the panel is open so we don't
  // intercept Escape from sibling features (search, command-K).
  useEffect(() => {
    if (!requirement) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requirement, onClose]);

  if (!requirement) return null;

  const desc = requirement.description?.trim() ?? "";
  const sessions = requirement.conversation_ids.length;
  const idShort = requirement.id.replace(/-/g, "").slice(0, 6).toUpperCase();
  const canLink =
    !!activeConversationId &&
    !requirement.conversation_ids.includes(activeConversationId);
  const statusCol = COLUMNS.find((c) => c.status === requirement.status);
  const statusLabel = statusCol ? t(statusCol.labelKey) : requirement.status;

  const setStatus = (status: RequirementStatus) => {
    updateRequirement(requirement.id, { status });
    onChanged();
  };

  const linkCurrent = () => {
    if (!activeConversationId) return;
    linkRequirementConversation(requirement.id, activeConversationId);
    onChanged();
  };

  return (
    <>
      <div
        className="requirement-detail-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="requirement-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="requirement-detail-title"
      >
        <header className="requirement-detail-head">
          <div className="requirement-detail-meta">
            <span className="requirement-card-id">REQ-{idShort}</span>
            <select
              className={
                "requirement-status-pill status-" + requirement.status
              }
              value={requirement.status}
              onChange={(e) => setStatus(e.target.value as RequirementStatus)}
              aria-label={t("reqStatusAria", statusLabel)}
            >
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {t(c.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="ghost-icon requirement-detail-close"
            onClick={onClose}
            aria-label={t("detailClose")}
            title={t("detailCloseTitle")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12" />
              <path d="M6 18l12-12" />
            </svg>
          </button>
        </header>

        <h2
          id="requirement-detail-title"
          className="requirement-detail-title"
        >
          {requirement.title}
        </h2>

        {desc ? (
          <div className="requirement-detail-body">
            <MarkdownLite text={desc} />
          </div>
        ) : (
          <p className="requirement-detail-empty">{t("detailEmptyDesc")}</p>
        )}

        <footer className="requirement-detail-footer">
          {sessions > 0 && (
            <span className="requirement-detail-sessions">
              {t("reqSessions", sessions)}
            </span>
          )}
          <span className="flex-1" />
          {requirement.conversation_ids[0] && (
            <button
              type="button"
              className="requirement-link-btn"
              onClick={() =>
                onOpenConversation(requirement.conversation_ids[0])
              }
            >
              {t("detailOpenLatest")}
            </button>
          )}
          {canLink && (
            <button
              type="button"
              className="requirement-link-btn"
              onClick={linkCurrent}
            >
              {t("detailLinkCurrent")}
            </button>
          )}
        </footer>
      </aside>
    </>
  );
}
