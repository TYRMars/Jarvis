// Right-rail approvals panel. The active approval prompt is shown
// above the composer; this rail remains a manual review/history view.

import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsPanel() {
  const approvals = useAppStore((s) => s.approvals);

  return (
    <div id="approval-list" className="panel-body">
      {approvals.length === 0 ? (
        <div className="empty-state approval-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-5" />
          </svg>
          <p>{t("approvalsEmpty")}</p>
        </div>
      ) : (
        approvals.map((entry) => <ApprovalCard key={entry.id} entry={entry} />)
      )}
    </div>
  );
}
