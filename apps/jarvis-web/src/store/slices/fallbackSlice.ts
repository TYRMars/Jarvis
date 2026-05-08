// Recent provider-fallback hops surfaced to the UI. Phase 4.6 of the
// model-tool-compatibility rollout. Each entry is one
// `provider_fallback` frame from the agent stream — typically there
// are zero (every chat run hits primary on the first try). When
// fallbacks fire, the chat header / message rail surface a banner
// so operators can see "you got rate-limited and the harness routed
// to <X>".
//
// Design decisions:
// - Bounded ring: the most recent 8 hops. Older ones drop silently;
//   the banner only shows the latest event anyway, history is for
//   "did this happen during the current turn?" debugging.
// - Reset on conversation `reset` / new — same lifecycle as the
//   plan snapshot.
// - No persistence: ephemeral runtime telemetry, not per-
//   conversation history.

import type { StateCreator } from "zustand";
import type { FullState } from "../appStore";

/// One fallback hop. Mirrors `harness_core::FallbackEvent` field
/// names so the WS payload deserialises directly.
export interface FallbackEntry {
  /// Provider name we started with.
  from: string;
  /// Provider name we routed to.
  to: string;
  /// Wire model id used on the retry.
  model: string;
  /// Truncated upstream error text (server-side cap is 240 chars).
  reason: string;
  /// Streaming path (`true`) vs. blocking `complete()` (`false`).
  streaming: boolean;
  /// Local insertion timestamp (epoch ms). Used by the banner to
  /// auto-dismiss after a few seconds without forcing the user to
  /// click.
  receivedAt: number;
}

const MAX_HISTORY = 8;

export interface FallbackSlice {
  /// Recent fallback hops, newest-first.
  fallbackHistory: FallbackEntry[];

  /// Append a new fallback event. Truncates the history at
  /// `MAX_HISTORY`.
  appendFallback: (entry: Omit<FallbackEntry, "receivedAt">) => void;

  /// Clear the history — called on `reset` and conversation
  /// switches so old banners don't bleed across sessions.
  clearFallbacks: () => void;
}

export const createFallbackSlice: StateCreator<FullState, [], [], FallbackSlice> = (
  set,
) => ({
  fallbackHistory: [],
  appendFallback: (entry) =>
    set((s) => ({
      fallbackHistory: [
        { ...entry, receivedAt: Date.now() },
        ...s.fallbackHistory,
      ].slice(0, MAX_HISTORY),
    })),
  clearFallbacks: () => set({ fallbackHistory: [] }),
});
