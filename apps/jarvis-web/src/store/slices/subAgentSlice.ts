// SubAgent runs visible to the current conversation. Frames arrive
// via `AgentEvent::SubAgentEvent` (one for each Started / Delta /
// ToolStart / etc. emitted by a delegated subagent) and the reducer
// maintains a `Map<subagent_id, SubAgentRun>` aggregate the UI can
// render directly — both inline (next to the assistant bubble that
// triggered the dispatch) and in the workspace rail's tasks panel.
//
// Runs are kept until the user resets the conversation. The chat
// slice's `clearMessages` clears the runs map too via the same
// atomic `set` so a Reset doesn't leave stale subagent cards
// pinned to the empty stream.

import type { StateCreator } from "zustand";
import type { FullState } from "../appStore";
import {
  applyFrame,
  emptyRun,
  type SubAgentFrame,
  type SubAgentRun,
} from "../../components/SubAgent/types";

export interface SubAgentSlice {
  /// Aggregated runs keyed by `subagent_id`. Stable across the
  /// whole conversation (no eviction) so completed runs stay
  /// available in the rail's "recent" section.
  subAgentRuns: Record<string, SubAgentRun>;

  /// Fold one frame into the runs map. Creates the run on
  /// `Started` if it didn't exist; subsequent frames mutate the
  /// run via `applyFrame`. No-op for unknown subagent_ids on
  /// non-Started frames (covers the "frame arrived before the
  /// store woke up" race).
  applySubAgentFrame: (frame: SubAgentFrame) => void;

  /// Clear all runs. Called by the chat slice's reset action.
  clearSubAgentRuns: () => void;
}

export const createSubAgentSlice: StateCreator<FullState, [], [], SubAgentSlice> = (
  set,
  get,
) => ({
  subAgentRuns: {},
  applySubAgentFrame: (frame) => {
    const now = Date.now();
    const current = get().subAgentRuns;
    const existing = current[frame.subagent_id];
    const base =
      existing ?? emptyRun(frame.subagent_id, frame.subagent_name);
    const next = applyFrame(base, frame, now);
    set({
      subAgentRuns: { ...current, [frame.subagent_id]: next },
    });
  },
  clearSubAgentRuns: () => set({ subAgentRuns: {} }),
});
