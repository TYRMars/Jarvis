// Persistent banner shown above the message list when the per-socket
// permission mode is `plan` AND no plan has been proposed yet. Tells
// the user "you're in plan mode — the agent will draft a plan before
// touching anything; nothing will execute until you accept it." Once
// the agent calls `exit_plan` and a `plan_proposed` frame arrives,
// `PlanProposedCard` takes over the review dock and this banner
// becomes redundant — so we hide it whenever `proposedPlan != null`.
//
// The "Exit plan mode" button switches back to `ask` (the safest
// mode). Same pattern as BypassBanner.

import { useAppStore } from "../../store/appStore";
import { setSocketMode } from "../../services/permissions";
import { t } from "../../utils/i18n";

export function PlanModeBanner() {
  const mode = useAppStore((s) => s.permissionMode);
  const proposedPlan = useAppStore((s) => s.proposedPlan);
  if (mode !== "plan") return null;
  // Once a plan arrives, PlanProposedCard provides much richer feedback
  // and the banner becomes noise.
  if (proposedPlan) return null;
  return (
    <div className="plan-mode-banner" role="status">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
      <span className="plan-mode-banner-text">
        {t("permModePlanActiveBanner")}
      </span>
      <button
        type="button"
        className="plan-mode-banner-btn"
        onClick={() => setSocketMode("ask")}
        title={t("permModePlanExitHint")}
      >
        {t("permModePlanExitBtn")}
      </button>
    </div>
  );
}
