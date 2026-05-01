// Approval-gate + permission-mode frames. The agent loop fires
// `approval_request` before invoking a gated tool and pairs it with
// an `approval_decision` once the human (or rule-based policy)
// answers; `permission_mode` / `permission_rules_changed` mirror
// server-side mode + rule state into the store so the badge / rules
// page stay in sync. `plan_proposed` arrives in plan-mode before
// the model is allowed to act.

import { appStore } from "../../store/appStore";

export const approvalFrameHandlers: Record<string, (ev: any) => void> = {
  approval_request: (ev) => {
    appStore.getState().pushApprovalRequest(ev.id, ev.name, ev.arguments);
  },
  approval_decision: (ev) => {
    appStore.getState().setApprovalDecision(
      ev.id,
      ev.decision.decision,
      ev.decision.reason ?? null,
      // Older servers (or builds without the permission store wired
      // up) omit `source`. Pass it through verbatim — the store
      // ignores `null` / `undefined` values cleanly.
      ev.source ?? null,
    );
  },
  plan_proposed: (ev) => {
    appStore.getState().setProposedPlan(ev.plan ?? "");
  },
  permission_mode: (ev) => {
    appStore.getState().setPermissionMode(ev.mode ?? "ask");
  },
  permission_rules_changed: () => {
    // Trigger any subscribed surface (Settings / Permissions) to refetch.
    appStore.getState().bumpPermissionRulesVersion?.();
  },
};
