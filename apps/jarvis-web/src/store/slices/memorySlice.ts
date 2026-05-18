// Memory compaction markers. The agent emits one
// `AgentEvent::MemoryCompacted` per iteration; the chat surface
// renders an inline marker in the transcript when something
// non-trivial happened (cache hit, fresh summary, fallback prune).
// NoOp emits are still recorded so a future "diagnostics across
// time" view can chart them, but the chat renderer filters them out.

import type { StateCreator } from "zustand";
import type { FullState } from "../appStore";

export type CompactionSource =
  | "no_op"
  | "window_dropped"
  | "cache_memory"
  | "cache_store"
  | "fresh_llm"
  | "ptl_round_one"
  | "ptl_round_two"
  | "summary_unavailable"
  // Forward-compat: unknown values from a newer backend.
  | (string & {});

export interface CompactionMarker {
  /// Where the compaction sat in the conversation when the event
  /// arrived. We use `messages.length` at receive time so the
  /// marker renders just before the *next* message.
  turnIndex: number;
  source: CompactionSource;
  turnsKept: number;
  turnsDropped: number;
  summaryChars?: number;
  workingContextChars?: number;
  modelInputTokensEst: number;
  /// Monotonically increasing within a conversation so React keys
  /// stay stable even when the same turn boundary fires twice.
  seq: number;
}

const MAX_MARKERS_PER_CONVERSATION = 20;

export interface MemorySlice {
  /// Compaction markers per conversation. Active-conversation
  /// fallback under the magic key `"__active__"` so the unscoped
  /// frame dispatch path can still post markers when no id is
  /// resolvable.
  compactionMarkers: Record<string, CompactionMarker[]>;

  /// Append one marker to the indicated conversation. Trims to
  /// MAX_MARKERS_PER_CONVERSATION oldest-first.
  pushCompactionMarker: (conversationId: string, m: Omit<CompactionMarker, "seq">) => void;

  /// Clear markers for a single conversation (used on `reset`).
  /// Pass `null` to wipe every conversation.
  clearCompactionMarkers: (conversationId: string | null) => void;
}

export const createMemorySlice: StateCreator<FullState, [], [], MemorySlice> = (set) => ({
  compactionMarkers: {},
  pushCompactionMarker: (conversationId, marker) =>
    set((s) => {
      const existing = s.compactionMarkers[conversationId] ?? [];
      const seq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 1;
      const next = existing.concat({ ...marker, seq });
      const trimmed =
        next.length > MAX_MARKERS_PER_CONVERSATION
          ? next.slice(next.length - MAX_MARKERS_PER_CONVERSATION)
          : next;
      return {
        compactionMarkers: { ...s.compactionMarkers, [conversationId]: trimmed },
      };
    }),
  clearCompactionMarkers: (conversationId) =>
    set((s) => {
      if (conversationId === null) {
        return { compactionMarkers: {} };
      }
      const next = { ...s.compactionMarkers };
      delete next[conversationId];
      return { compactionMarkers: next };
    }),
});
