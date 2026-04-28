// One pending / decided approval. Default state shows two buttons
// (Approve / Deny). Clicking Deny "arms" the card: it reveals an
// inline reason editor and re-labels the buttons to
// `Cancel / Confirm deny`. A second Deny click ships the frame.
//
// The inline editor replaced the legacy `window.prompt()` flow —
// far better UX, and Cmd/Ctrl+Enter inside the textarea is a
// shortcut equivalent to clicking Confirm deny.
//
// "Always allow this tool" inline checkbox + scope dropdown saves
// a permission rule via the REST API *before* sending the approve
// frame. We do it in this order so the rule is persisted by the
// time the next call lands; if the rule write fails (network /
// store unavailable) the approve still goes through — a one-shot
// approve is strictly safer than refusing the user's explicit
// click. We surface the failure via the shared error banner so
// it's not silent.

import { useState } from "react";
import type { ApprovalCardState } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { sendFrame, isOpen } from "../../services/socket";
import { appendRule, type Scope } from "../../services/permissions";
import { ShellExecDetail } from "./ShellExecDetail";

function send(frame: any): boolean {
  if (!isOpen()) return false;
  return sendFrame(frame);
}

function pretty(value: any): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const SCOPE_OPTIONS: Array<{ scope: Scope; labelKey: string }> = [
  { scope: "session", labelKey: "scopeSession" },
  { scope: "project", labelKey: "scopeProject" },
  { scope: "user", labelKey: "scopeUser" },
];

export function ApprovalCard({ entry }: { entry: ApprovalCardState }) {
  const [denyArmed, setDenyArmed] = useState(false);
  const [reason, setReason] = useState("");
  /// Local "I just clicked, awaiting echo" flag. Stops a quick second
  /// click from sending a duplicate `approve` / `deny` frame for the
  /// same `tool_call_id` — the server pops responders on first match,
  /// so the second frame would error with "no pending approval".
  const [sent, setSent] = useState(false);
  const [remember, setRemember] = useState(false);
  const [rememberScope, setRememberScope] = useState<Scope>("session");
  const decided = entry.status !== "pending";
  const locked = decided || sent;

  const verdictText =
    entry.status === "approved"
      ? t("approved")
      : entry.status === "denied"
      ? t("denied", entry.reason || "")
      : t("approving");

  /// Persist a "always allow this tool" rule, then return — caller
  /// follows up with the approve/deny frame. We deliberately don't
  /// block the approve on rule-write success; the rule write is
  /// fire-and-forget from the user's perspective and any failure is
  /// surfaced via `services/permissions::appendRule` ➜ `showError`.
  async function maybeRemember(bucket: "allow" | "deny"): Promise<void> {
    if (!remember) return;
    await appendRule({
      scope: rememberScope,
      bucket,
      rule: { tool: entry.name },
    });
  }

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
      {entry.name === "shell.exec" ? (
        <ShellExecDetail args={entry.arguments} />
      ) : (
        <pre className="args">{pretty(entry.arguments)}</pre>
      )}
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
            // Fire-and-forget the rule write; do NOT await it before
            // approving — `appendRule` shows its own error banner.
            void maybeRemember("allow");
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
            void maybeRemember("deny");
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
                void maybeRemember("deny");
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
      {!locked ? (
        <div className="approval-remember">
          <label className="approval-remember-toggle">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>{t("rememberAlways")}</span>
          </label>
          {remember ? (
            <label className="approval-remember-scope">
              <span className="approval-remember-scope-label">
                {t("rememberAlwaysScope")}
              </span>
              <select
                value={rememberScope}
                onChange={(e) => setRememberScope(e.target.value as Scope)}
              >
                {SCOPE_OPTIONS.map((o) => (
                  <option key={o.scope} value={o.scope}>
                    {t(o.labelKey)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {remember ? (
            <div className="approval-remember-hint">{t("rememberAlwaysHint")}</div>
          ) : null}
        </div>
      ) : null}
      <div className="approval-verdict">{verdictText}</div>
    </div>
  );
}
