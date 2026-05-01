// Tool-call execution state. The flat `toolBlocks` map is keyed by
// the model-provided tool-call id; assistant `<UiMessage>` entries
// reference these ids in their `toolCallIds` array so the chat
// renderer can lay tool blocks out under the correct turn.
//
// `pushToolStart` reaches into `messages` to attach the call to the
// trailing assistant entry — that cross-slice write is intentional
// and atomic via the unified Zustand `set`.

import type { StateCreator } from "zustand";
import type { FullState } from "../appStore";
import type { ToolBlockEntry, UiMessage } from "../types";
import { nextUid } from "../uid";

export interface ToolSlice {
  /// Flat tool-block map. Assistant messages reference entries by id.
  toolBlocks: Record<string, ToolBlockEntry>;

  /// Tool-call lifecycle. The assistant message that triggered the
  /// call is whatever entry is currently last in the list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pushToolStart: (id: string, name: string, args: any) => void;
  /// Streaming chunk from a still-running tool. Appended to
  /// `toolBlocks[id].progress` so `<ToolBlock>` re-renders with the
  /// growing output.
  appendToolProgress: (id: string, stream: string, chunk: string) => void;
  setToolEnd: (id: string, content: string) => void;
}

export const createToolSlice: StateCreator<FullState, [], [], ToolSlice> = (set) => ({
  toolBlocks: {},

  pushToolStart: (id, name, args) => {
    set((s) => {
      const msgs = s.messages.slice();
      // Attach to the trailing assistant turn (creating one if the
      // model fired a tool call before any visible text).
      let lastIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].kind === "assistant") {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx < 0) {
        const uid = nextUid("a");
        msgs.push({
          uid,
          kind: "assistant",
          content: "",
          reasoning: "",
          toolCallIds: [id],
          finalised: false,
        });
      } else {
        const cur = msgs[lastIdx] as Extract<UiMessage, { kind: "assistant" }>;
        if (!cur.toolCallIds.includes(id)) {
          msgs[lastIdx] = { ...cur, toolCallIds: [...cur.toolCallIds, id] };
        }
      }
      const tools = {
        ...s.toolBlocks,
        [id]: {
          id,
          name,
          args,
          status: "running" as const,
          output: null,
          progress: "",
          decisionSource: null,
          startedAt: Date.now(),
          finishedAt: null,
        },
      };
      return { messages: msgs, toolBlocks: tools, emptyHintIdShort: null };
    });
  },

  appendToolProgress: (id, _stream, chunk) => {
    set((s) => {
      const block = s.toolBlocks[id];
      if (!block) return s;
      // Streams are interleaved verbatim — `<ToolBlock>` shows the
      // raw scroll-back; the model still gets the formatted summary
      // via `output`. The `_stream` label is currently informational
      // only; future work could colourise stderr.
      return {
        toolBlocks: {
          ...s.toolBlocks,
          [id]: { ...block, progress: block.progress + chunk },
        },
      };
    });
  },

  setToolEnd: (id, content) => {
    set((s) => {
      const block = s.toolBlocks[id];
      if (!block) return s;
      const denied = content.startsWith("tool denied:");
      const failed = content.startsWith("tool error:");
      const status: ToolBlockEntry["status"] = denied
        ? "denied"
        : failed
          ? "error"
          : "ok";
      return {
        toolBlocks: {
          ...s.toolBlocks,
          [id]: { ...block, status, output: content, finishedAt: Date.now() },
        },
      };
    });
  },
});
