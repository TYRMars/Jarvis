// Agent's working plan snapshot. `plan_update` events replace the
// whole array; the rail's `<PlanList>` re-renders. No history, no
// persistence — the snapshot is per-turn ephemeral and the
// conversation store doesn't carry it.

import type { StateCreator } from "zustand";
import type { FullState } from "../appStore";
import type { PlanItem } from "../types";

export interface PlanSlice {
  /// Latest agent plan snapshot. Replaced wholesale on every
  /// `plan_update` event; cleared on `reset`. Empty array means
  /// "no plan yet" — the rail's empty-state UI handles that.
  plan: PlanItem[];

  /// Replace the plan snapshot. Empty `items` clears the plan.
  setPlan: (items: PlanItem[]) => void;
}

export const createPlanSlice: StateCreator<FullState, [], [], PlanSlice> = (set) => ({
  plan: [],
  setPlan: (items) => set({ plan: items }),
});
