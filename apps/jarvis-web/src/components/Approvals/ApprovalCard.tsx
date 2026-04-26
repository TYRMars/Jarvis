// One pending / decided approval. Default state shows two buttons
// (Approve / Deny). Clicking Deny "arms" the card: it reveals an
// inline reason editor and re-labels the buttons to
// `Cancel / Confirm deny`. A second Deny click ships the frame.
//
// The inline editor replaced the legacy `window.prompt()` flow —
// far better UX, and Cmd/Ctrl+Enter inside the textarea is a
// shortcut equivalent to clicking Confirm deny.

import { useState } from "react";
import type { ApprovalCardState } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { sendFrame, isOpen } from "../../services/socket";

function send(frame: any): boolean {
  if (!isOpen()) return false;
  return sendFrame(frame);
}

function pretty(value: any): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ApprovalCard({ entry }: { entry: ApprovalCardState }) {
  const [denyArmed, setDenyArmed] = useState(false);
  const [reason, setReason] = useState("");
  /// Local "I just clicked, awaiting echo" flag. Stops a quick second
  /// click from sending a duplicate `approve` / `deny` frame for the
  /// same `tool_call_id` — the server pops responders on first match,
  /// so the second frame would error with "no pending approval".
  const [sent, setSent] = useState(false);
  const decided = entry.status !== "pending";
  const locked = decided || sent;

  const verdictText =
    entry.status === "approved"
      ? t("approved")
      : entry.status === "denied"
      ? t("denied", entry.reason || "")
      : t("approving");

  return (
    <div
      className="approval-card"
      data-status={entry.status}
      data-reason={entry.reason || ""}
    >
      <div className="name">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        {entry.name}
      </div>
      <pre className="args">{pretty(entry.arguments)}</pre>
      <div className="approval-actions">
        <button
          type="button"
          className="approval-btn approve"
          disabled={locked}
          onClick={() => {
            if (denyArmed) {
              // Cancel the deny intent.
              setDenyArmed(false);
              setReason("");
              return;
            }
            if (send({ type: "approve", tool_call_id: entry.id })) setSent(true);
          }}
        >
          {denyArmed ? t("cancel") : t("approve")}
        </button>
        <button
          type="button"
          className="approval-btn deny"
          disabled={locked}
          onClick={() => {
            if (!denyArmed) {
              setDenyArmed(true);
              return;
            }
            const ok = send({
              type: "deny",
              tool_call_id: entry.id,
              reason: reason.trim() || null,
            });
            if (ok) setSent(true);
          }}
        >
          {denyArmed ? t("denyConfirm") : t("deny")}
        </button>
      </div>
      <div className={"approval-reason-row" + (denyArmed && !locked ? "" : " hidden")}>
        <textarea
          className="approval-reason"
          placeholder={t("reasonPrompt")}
          rows={2}
          value={reason}
          disabled={locked}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (denyArmed) {
                const ok = send({
                  type: "deny",
                  tool_call_id: entry.id,
                  reason: reason.trim() || null,
                });
                if (ok) setSent(true);
              }
            }
          }}
        />
        <div className="approval-reason-hint">{t("reasonHint")}</div>
      </div>
      <div className="approval-verdict">{verdictText}</div>
    </div>
  );
}
