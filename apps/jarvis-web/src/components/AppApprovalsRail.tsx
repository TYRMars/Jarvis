// Right-most slide-out: list of approval cards (pending / decided)
// + close button. Visibility is toggled at the body level — when
// the agent yields an `approval_request` the store-driven panel
// adds `approvals-open`, animating the rail in. The close button
// just removes that class; React doesn't need to keep state for
// "is rail visible" because the CSS transition does the work.

import { ApprovalsPanel } from "./Approvals/ApprovalsPanel";
import { CloseApprovalsButton } from "./Workspace/WorkspaceToggles";

export function AppApprovalsRail() {
  return (
    <aside id="panel" aria-label="Approvals">
      <div className="panel-header">
        <div>
          <div className="eyebrow" data-i18n="review">Review</div>
          <h2 data-i18n="pendingApprovals">Pending Approvals</h2>
        </div>
        <CloseApprovalsButton />
      </div>
      <ApprovalsPanel />
    </aside>
  );
}
