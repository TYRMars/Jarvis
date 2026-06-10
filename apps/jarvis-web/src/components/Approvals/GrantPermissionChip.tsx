// Post-hoc "always allow this tool" chip rendered inside a finished
// approval-gated <ToolBlock>. It calls the SAME rule-append API the
// live ApprovalCard uses (`appendRule`), so the user can persist a
// session-scope allow rule AFTER the tool already ran — including
// from restored transcript history, where there's no live approval
// card to click.
//
// Three states: idle (clickable), granted (rule written), error
// (write failed — `appendRule` already surfaces the banner, the chip
// just reflects it). Granted/error are terminal; the chip stops being
// clickable so a double-tap can't write a duplicate rule.

import { useState } from "react";
import { t } from "../../utils/i18n";
import { appendRule } from "../../services/permissions";

type GrantState = "idle" | "saving" | "granted" | "error";

export function GrantPermissionChip({ tool }: { tool: string }) {
  const [state, setState] = useState<GrantState>("idle");

  const label =
    state === "granted"
      ? t("grantedThisTool")
      : state === "error"
        ? t("grantToolError")
        : state === "saving"
          ? t("grantingThisTool")
          : t("grantThisTool");

  const interactive = state === "idle" || state === "error";

  async function onClick() {
    if (!interactive) return;
    setState("saving");
    // Mirror ApprovalCard's "remember" write: session scope, allow
    // bucket, tool-only matcher. `appendRule` shows its own error
    // banner on failure, so we only need to reflect success/error in
    // the chip's local state.
    const ok = await appendRule({
      scope: "session",
      bucket: "allow",
      rule: { tool },
    });
    setState(ok ? "granted" : "error");
  }

  return (
    <button
      type="button"
      className="grant-chip"
      data-state={state}
      disabled={!interactive}
      title={t("grantThisToolHint", tool)}
      onClick={(e) => {
        // The chip lives inside the clickable tool-header; stop the
        // click from also toggling the block open/closed.
        e.stopPropagation();
        void onClick();
      }}
    >
      {label}
    </button>
  );
}
