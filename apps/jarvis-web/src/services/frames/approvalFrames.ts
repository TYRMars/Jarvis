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
  // Replay frame for approvals the agent is *still* blocked on,
  // surfaced after a `Resume` so a reconnecting socket can take
  // over the prompt. Wire shape: `{id, name, arguments, category}`
  // — same fields as `approval_request` so the store reducer is
  // shared. The replay is idempotent: if the store already has the
  // approval (e.g. it survived in the snapshot replay), pushing it
  // again is a no-op (same `id`).
  approval_pending: (ev) => {
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
    // M2.3 UX: when the model itself switched the mode (via the
    // `enter_plan_mode` tool), surface a transient toast so the
    // operator isn't silently surprised on the next turn. The
    // store action no-ops when `via` isn't "tool".
    if (typeof ev?.via === "string") {
      appStore.getState().setRecentModeChange?.({
        mode: ev.mode ?? "ask",
        via: ev.via,
        at: Date.now(),
      });
    }
  },
  permission_rules_changed: () => {
    // Trigger any subscribed surface (Settings / Permissions) to refetch.
    appStore.getState().bumpPermissionRulesVersion?.();
  },
  /// M3.3: server's prediction of which skills would auto-activate
  /// on the next user turn given the agent's recently-touched
  /// files. Emitted at end-of-turn (Done) and at session start;
  /// payload `{skills: string[]}`. Empty array clears any stale
  /// Composer chip when the user pivots and no files match.
  skill_auto_activated_for_next_turn: (ev) => {
    const names: string[] = Array.isArray(ev?.skills) ? ev.skills : [];
    appStore.getState().setAutoActivatedNextTurnSkills(names);
  },
};
