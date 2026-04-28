// Card shown when the agent (in Plan Mode) calls `exit_plan`.
//
// Renders the plan body verbatim — markdown-ish, but we keep it as
// preformatted text so structural fidelity wins over auto-rendering
// (a model that emits a numbered list will look right; a model that
// emits prose will too). The four buttons cover the usual choices:
//
// - Accept and continue in Ask mode (every gated tool still prompts)
// - Accept and continue in Accept-Edits (auto file writes; ask shell)
// - Accept and continue in Auto (no further prompts this session)
// - Refine — pop the textarea, send `refine_plan` with feedback
//
// `Bypass` is deliberately absent — switching into bypass at runtime
// is forbidden by the server; the picker would just error.

import { useState } from "react";
import { acceptPlan, refinePlan, type PermissionMode } from "../../services/permissions";
import { t } from "../../utils/i18n";

interface PlanProposedCardProps {
  plan: string;
}

export function PlanProposedCard({ plan }: PlanProposedCardProps) {
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  function accept(post: PermissionMode): void {
    if (busy) return;
    setBusy(true);
    if (!acceptPlan(post)) setBusy(false);
    // Successful accept: clears proposedPlan in the store, which
    // unmounts this component — no further state to manage.
  }

  function sendRefine(): void {
    const trimmed = feedback.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (!refinePlan(trimmed)) setBusy(false);
  }

  return (
    <div className="plan-proposed-card">
      <div className="plan-proposed-header">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 9h6M9 13h6M9 17h4" />
        </svg>
        <div className="plan-proposed-title">{t("planProposedTitle")}</div>
      </div>
      <div className="plan-proposed-desc">{t("planProposedDesc")}</div>
      <pre className="plan-proposed-body">{plan.trim() || t("planEmpty")}</pre>
      {refining ? (
        <div className="plan-proposed-refine">
          <textarea
            className="plan-proposed-textarea"
            placeholder={t("planRefinePlaceholder")}
            rows={3}
            value={feedback}
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                sendRefine();
              }
            }}
          />
          <div className="plan-proposed-actions">
            <button
              type="button"
              className="plan-proposed-btn plan-proposed-btn-secondary"
              disabled={busy}
              onClick={() => {
                setRefining(false);
                setFeedback("");
              }}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              className="plan-proposed-btn plan-proposed-btn-primary"
              disabled={busy || !feedback.trim()}
              onClick={sendRefine}
            >
              {t("planRefineSend")}
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-proposed-actions">
          <button
            type="button"
            className="plan-proposed-btn"
            disabled={busy}
            onClick={() => accept("ask")}
          >
            {t("planAcceptAsk")}
          </button>
          <button
            type="button"
            className="plan-proposed-btn"
            disabled={busy}
            onClick={() => accept("accept-edits")}
          >
            {t("planAcceptEdits")}
          </button>
          <button
            type="button"
            className="plan-proposed-btn plan-proposed-btn-primary"
            disabled={busy}
            onClick={() => accept("auto")}
          >
            {t("planAcceptAuto")}
          </button>
          <button
            type="button"
            className="plan-proposed-btn plan-proposed-btn-secondary"
            disabled={busy}
            onClick={() => setRefining(true)}
          >
            {t("planRefine")}
          </button>
        </div>
      )}
    </div>
  );
}
