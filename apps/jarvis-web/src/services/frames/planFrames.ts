// Working-plan frames. `plan_update` carries a full snapshot every
// time (replace, not patch — see `harness_core::plan`); `reset`
// clears the snapshot when the conversation is reset.

import { appStore } from "../../store/appStore";

export const planFrameHandlers: Record<string, (ev: any) => void> = {
  plan_update: (ev) => {
    // Replace, not patch — the agent always sends the full snapshot.
    appStore.getState().setPlan(Array.isArray(ev.items) ? ev.items : []);
  },
  reset: () => {
    appStore.getState().setPlan([]);
  },
};
