// SubAgent activity frames. The Rust side emits one
// `AgentEvent::SubAgentEvent { frame }` per inner-subagent event
// (Started / Delta / ToolStart / ToolEnd / Status / Done / Error).
// We unwrap `frame` and hand it straight to the slice reducer,
// which folds it into the `subAgentRuns` aggregate the UI renders.
//
// The wire `frame.event` matches the `SubAgentEvent` shape in
// `src/components/SubAgent/types.ts` (which mirrors
// `harness_core::SubAgentEvent`). On `reset` the chat slice's
// clearMessages already wipes runs, so no reset listener here.

import { appStore } from "../../store/appStore";
import type { SubAgentFrame } from "../../components/SubAgent/types";

export const subAgentFrameHandlers: Record<string, (ev: any) => void> = {
  sub_agent_event: (ev) => {
    const frame = (ev && ev.frame) as SubAgentFrame | undefined;
    if (!frame || !frame.subagent_id || !frame.event) return;
    appStore.getState().applySubAgentFrame(frame);
  },
};
