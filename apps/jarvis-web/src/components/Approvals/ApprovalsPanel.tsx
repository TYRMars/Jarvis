// Right-rail approvals panel. Empty state is a small shield card;
// once any approval lands, the list takes over and pinged-open the
// rail (`document.body.classList.add("approvals-open")`) the same
// way the imperative version did.

import { useEffect } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsPanel() {
  const approvals = useAppStore((s) => s.approvals);

  // Toggle the body-level `approvals-open` class so the rail's CSS
  // animates in/out. Mirrors the legacy behaviour 1:1.
  useEffect(() => {
    document.body.classList.toggle("approvals-open", approvals.length > 0);
  }, [approvals.length]);

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
