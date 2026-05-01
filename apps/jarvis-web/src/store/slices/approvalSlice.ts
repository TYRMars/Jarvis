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
}

export const createApprovalSlice: StateCreator<FullState, [], [], ApprovalSlice> = (set) => ({
  approvals: [],
  permissionMode: "ask",
  permissionRulesVersion: 0,
  proposedPlan: null,
  activeSkills: [],

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
  setActiveSkills: (names) => set({ activeSkills: names }),
});
