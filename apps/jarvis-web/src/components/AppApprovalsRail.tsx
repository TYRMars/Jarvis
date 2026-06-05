// Right-most slide-out: approval history + close button. Active
// approval prompts now live above the composer, Claude-Code style;
// this rail is only opened manually for review.

import { ApprovalsPanel } from "./Approvals/ApprovalsPanel";
import { CloseApprovalsButton } from "./Workspace/WorkspaceToggles";
import { t } from "../utils/i18n";

export function AppApprovalsRail() {
  return (
    <aside id="panel" aria-label={t("chatCoreApprovalsRail")}>
      <div className="panel-header">
        <div>
          <div className="eyebrow" data-i18n="review">{t("review")}</div>
          <h2 data-i18n="pendingApprovals">{t("pendingApprovals")}</h2>
        </div>
        <CloseApprovalsButton />
      </div>
      <ApprovalsPanel />
    </aside>
  );
}
