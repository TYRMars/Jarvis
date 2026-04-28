// Audit chip that explains where an approval decision came from.
// Sits inside `<ToolBlock>` for any gated tool whose approval was
// resolved without the user clicking a button — typically a stored
// rule or the active mode's default.
//
// Three variants render:
//
//   • `user_prompt` → omitted entirely (the user clicked, no audit
//     surface needed beyond the existing approve/deny verdict).
//   • `mode_default` → `mode: auto` chip — neutral palette.
//   • `rule` → `rule: user/allow #2` chip — coloured by scope so
//     project-scope (committed) reads visibly distinct from
//     user-scope (private). Title attribute spells out the full
//     citation for hover.
//
// Deliberately compact — these chips appear next to the tool's
// status badge and shouldn't dominate the row. Click navigates
// to Settings → Permissions for `rule` sources so the user can
// inspect / edit the rule that fired.

import type { ApprovalSource } from "../../types/frames";
import { t } from "../../utils/i18n";

interface Props {
  source: ApprovalSource;
}

function modeLabel(mode: string): string {
  // Reuse the mode-badge i18n keys so the picker / chip / banner
  // all read the same.
  const map: Record<string, string> = {
    ask: "permModeAsk",
    "accept-edits": "permModeAcceptEdits",
    plan: "permModePlan",
    auto: "permModeAuto",
    bypass: "permModeBypass",
  };
  const key = map[mode];
  return key ? t(key) : mode;
}

function scopeShort(scope: "user" | "project" | "session"): string {
  return scope[0].toUpperCase();
}

export function DecisionSourceChip({ source }: Props) {
  if (source.kind === "user_prompt") return null;

  if (source.kind === "mode_default") {
    return (
      <span
        className="decision-source decision-source-mode"
        data-mode={source.mode}
        title={t("decisionSourceModeTooltip", modeLabel(source.mode))}
      >
        {t("decisionSourceModeChip", modeLabel(source.mode))}
      </span>
    );
  }

  // source.kind === "rule"
  const tooltip = t("decisionSourceRuleTooltip", source.scope, source.bucket, source.index);
  return (
    <a
      href="#permissions"
      className="decision-source decision-source-rule"
      data-scope={source.scope}
      data-bucket={source.bucket}
      title={tooltip}
      onClick={() => {
        // Bring the user to the Settings → Permissions section.
        // Routing happens through react-router-dom from `/settings`,
        // but a hash jump from the chat works too because the
        // SettingsPage tabs are hash-driven.
        if (window.location.pathname !== "/settings") {
          window.location.href = "/settings#permissions";
        } else {
          window.location.hash = "permissions";
        }
      }}
    >
      {t("decisionSourceRuleChip", scopeShort(source.scope), source.bucket)}
    </a>
  );
}
