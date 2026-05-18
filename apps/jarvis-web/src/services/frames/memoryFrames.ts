// Memory compaction frames. The agent emits one
// `AgentEvent::MemoryCompacted` per iteration carrying a
// `CompactionInfo` describing what the memory backend did:
// cache hit / fresh summary / fallback prune / no-op.
//
// We post the marker into the active conversation's slot so
// `<MessageList>` can render an inline transcript card. NoOp
// emits are recorded too — the chat renderer filters them
// out, but a future diagnostics view may chart them.

import { appStore } from "../../store/appStore";

const ACTIVE_KEY = "__active__";

export const memoryFrameHandlers: Record<string, (ev: any) => void> = {
  memory_compacted: (ev) => {
    const info = ev?.info ?? {};
    const state = appStore.getState();
    const conversationId = state.activeId ?? ACTIVE_KEY;
    const messages = state.messages ?? [];
    state.pushCompactionMarker(conversationId, {
      turnIndex: messages.length,
      source: typeof info.source === "string" ? info.source : "no_op",
      turnsKept: typeof info.turns_kept === "number" ? info.turns_kept : 0,
      turnsDropped: typeof info.turns_dropped === "number" ? info.turns_dropped : 0,
      summaryChars:
        typeof info.summary_chars === "number" ? info.summary_chars : undefined,
      workingContextChars:
        typeof info.working_context_chars === "number"
          ? info.working_context_chars
          : undefined,
      modelInputTokensEst:
        typeof info.model_input_tokens_est === "number"
          ? info.model_input_tokens_est
          : 0,
    });
  },
  // `reset` is broadcast by the lifecycle layer when the user
  // clears the current conversation or switches to a fresh one.
  // Mirror what planFrames does — purge the markers so a new
  // session doesn't inherit the previous one's compaction trail.
  reset: () => {
    appStore.getState().clearCompactionMarkers(null);
  },
};
