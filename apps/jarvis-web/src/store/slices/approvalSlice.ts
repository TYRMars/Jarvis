// Approval gate, plan-mode-proposed plan, permission-mode badge,
// and the active-skills mirror. The approval cards are rendered in
// the right rail / review dock; `permissionMode` drives the mode
// badge in the composer footer; `proposedPlan` is the markdown
// blob the agent submits in plan-mode awaiting human accept.
//
// `setApprovalDecision` writes to `toolBlocks` (toolSlice) too so
// the chat history can stamp an "auto-approved by user-rule" chip
// directly on the matching tool card — same atomic-set pattern as
// chatSlice.

import type { StateCreator } from "zustand";
import type { ApprovalSource } from "../../types/frames";
import type { FullState } from "../appStore";
import type { ApprovalCardState } from "../types";

export type PermissionMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

export interface ApprovalSlice {
  /// Pending / resolved approval cards rendered in the right rail.
  /// Order = arrival order; React renders newest at the bottom of
  /// the list.
  approvals: ApprovalCardState[];
  permissionMode: PermissionMode;
  /// Bumped every time the server emits `permission_rules_changed`.
  /// Settings/Permissions section watches this and re-fetches.
  permissionRulesVersion: number;
  /// Plan proposed by the agent (Plan Mode) waiting for user accept.
  /// Cleared when the user accepts or refines.
  proposedPlan: string | null;
  /// Skill names currently active on this WS session. Mirrored from
  /// the server's `skill_activated` / `skill_deactivated` frames so
  /// every component (Settings tab, future header chip) sees the
  /// same source of truth. Empty until the user toggles one.
  activeSkills: string[];
  /// Most-recent mode change, with its source ("tool" when the
  /// model self-switched via `enter_plan_mode`, "user" when the
  /// operator clicked, "plan_accepted" after AcceptPlan, etc.).
  /// `<ModeChangedToast>` watches this and auto-clears after a
  /// few seconds — only the source != "user" path produces a
  /// visible toast (an operator click shouldn't toast back at
  /// themselves). `null` between events.
  recentModeChange: { mode: PermissionMode; via: string; at: number } | null;
  /// Skills the server predicts WILL auto-activate via the M3.3
  /// path-match rule on the *next* user turn, given the files the
  /// agent touched in the previous turn. Refreshed by the
  /// `skill_auto_activated_for_next_turn` WS frame at end-of-turn;
  /// cleared (server-side recomputes) at the next user message.
  /// Lets the Composer chip warn the user "if you send now, X will
  /// auto-activate" before they actually type.
  autoActivatedNextTurnSkills: string[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pushApprovalRequest: (id: string, name: string, args: any) => void;
  setApprovalDecision: (
    id: string,
    decision: "approve" | "deny",
    reason?: string | null,
    source?: ApprovalSource | null,
  ) => void;
  /// Mark every still-pending approval as denied. Called when a turn
  /// terminates so stale cards don't tempt the user into a click that
  /// would error with "no pending approval" against the now-cleared
  /// server-side responder map.
  finalizePendingApprovals: () => void;
  clearApprovals: () => void;

  setPermissionMode: (mode: PermissionMode) => void;
  bumpPermissionRulesVersion: () => void;
  setProposedPlan: (plan: string | null) => void;
  setActiveSkills: (names: string[]) => void;
  setAutoActivatedNextTurnSkills: (names: string[]) => void;
  setRecentModeChange: (
    change: { mode: PermissionMode; via: string; at: number } | null,
  ) => void;
}

export const createApprovalSlice: StateCreator<FullState, [], [], ApprovalSlice> = (set) => ({
  approvals: [],
  permissionMode: "ask",
  permissionRulesVersion: 0,
  proposedPlan: null,
  activeSkills: [],
  autoActivatedNextTurnSkills: [],
  recentModeChange: null,

  pushApprovalRequest: (id, name, args) => {
    set((s) => {
      // Idempotent: a duplicate frame with the same id is a no-op.
      if (s.approvals.some((c) => c.id === id)) return s;
      return {
        approvals: [
          ...s.approvals,
          { id, name, arguments: args, status: "pending", reason: null },
        ],
      };
    });
  },
  setApprovalDecision: (id, decision, reason, source) => {
    set((s) => {
      // Update the approval card (right rail / review dock).
      const approvals = s.approvals.map((c) =>
        c.id === id
          ? {
              ...c,
              status: decision === "approve" ? ("approved" as const) : ("denied" as const),
              reason: reason || null,
            }
          : c,
      );
      // Stamp the source onto the matching tool block so the chat
      // history can render an "auto-approved by user-rule" chip.
      // Only attach when the server actually told us where the
      // decision came from — older builds omit `source`.
      if (source && s.toolBlocks[id]) {
        return {
          approvals,
          toolBlocks: {
            ...s.toolBlocks,
            [id]: { ...s.toolBlocks[id], decisionSource: source },
          },
        };
      }
      return { approvals };
    });
  },
  finalizePendingApprovals: () => {
    set((s) => ({
      approvals: s.approvals.map((c) =>
        c.status === "pending"
          ? { ...c, status: "denied", reason: c.reason ?? "(turn ended)" }
          : c,
      ),
    }));
  },
  clearApprovals: () => set({ approvals: [] }),

  setPermissionMode: (mode) => set({ permissionMode: mode }),
  bumpPermissionRulesVersion: () =>
    set((s) => ({ permissionRulesVersion: s.permissionRulesVersion + 1 })),
  setProposedPlan: (plan) => set({ proposedPlan: plan }),
  setActiveSkills: (names) => {
    const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
    set({ activeSkills: unique });
  },
  setAutoActivatedNextTurnSkills: (names) => {
    const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
    set({ autoActivatedNextTurnSkills: unique });
  },
  setRecentModeChange: (change) => set({ recentModeChange: change }),
});
