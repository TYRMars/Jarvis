// Registry merge semantics. Multiple domains legitimately register a handler
// under the same frame `type` (notably `reset`, owned by both planFrames and
// memoryFrames). The merge must fan out to *all* of them, not silently keep the
// last one — regression test for the shadowed `reset` bug (#361), where a fresh
// free chat left the previous session's plan lingering in the right rail.

import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../../store/appStore";
import { frameHandlers } from "./index";

beforeEach(() => {
  useAppStore.getState().setPlan([]);
  useAppStore.getState().clearCompactionMarkers(null);
});

describe("frameHandlers merge", () => {
  it("reset fans out to BOTH the plan and memory handlers", () => {
    const s = useAppStore.getState();
    s.setPlan([{ id: "p1", title: "step", status: "in_progress" }] as never);
    s.pushCompactionMarker("c1", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });

    const reset = frameHandlers.get("reset");
    expect(reset).toBeDefined();
    reset!({ type: "reset" });

    // planFrames.reset — the one previously shadowed by memoryFrames.reset.
    expect(useAppStore.getState().plan).toEqual([]);
    // memoryFrames.reset — must still fire under the combined handler.
    expect(useAppStore.getState().compactionMarkers).toEqual({});
  });

  it("keeps a single-owner frame type as a plain handler", () => {
    // A type only one module registers must still dispatch normally.
    expect(frameHandlers.get("plan_update")).toBeDefined();
    frameHandlers.get("plan_update")!({
      type: "plan_update",
      items: [{ id: "x", title: "t", status: "pending" }],
    });
    expect(useAppStore.getState().plan).toHaveLength(1);
  });
});
