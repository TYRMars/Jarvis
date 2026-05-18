// Tests for the per-conversation compaction-marker slice. Validates
// the append + trim + clear behaviour the chat surface relies on.

import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../appStore";

beforeEach(() => {
  useAppStore.getState().clearCompactionMarkers(null);
});

describe("memorySlice", () => {
  it("appends a marker under the supplied conversation id", () => {
    useAppStore.getState().pushCompactionMarker("c1", {
      turnIndex: 4,
      source: "fresh_llm",
      turnsKept: 2,
      turnsDropped: 3,
      summaryChars: 180,
      modelInputTokensEst: 1234,
    });
    const markers = useAppStore.getState().compactionMarkers["c1"];
    expect(markers).toHaveLength(1);
    expect(markers[0].source).toBe("fresh_llm");
    expect(markers[0].seq).toBe(1);
  });

  it("assigns monotonic seq numbers per conversation", () => {
    const s = useAppStore.getState();
    s.pushCompactionMarker("c1", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 10,
    });
    s.pushCompactionMarker("c1", {
      turnIndex: 1,
      source: "cache_memory",
      turnsKept: 1,
      turnsDropped: 0,
      modelInputTokensEst: 12,
    });
    const markers = useAppStore.getState().compactionMarkers["c1"];
    expect(markers.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("trims oldest entries past MAX_MARKERS_PER_CONVERSATION (20)", () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 25; i++) {
      s.pushCompactionMarker("c1", {
        turnIndex: i,
        source: "no_op",
        turnsKept: 0,
        turnsDropped: 0,
        modelInputTokensEst: i,
      });
    }
    const markers = useAppStore.getState().compactionMarkers["c1"];
    expect(markers).toHaveLength(20);
    // First survivor is the 6th push (i=5) since the first 5 got trimmed.
    expect(markers[0].modelInputTokensEst).toBe(5);
    expect(markers[19].modelInputTokensEst).toBe(24);
  });

  it("clears markers for a single conversation", () => {
    const s = useAppStore.getState();
    s.pushCompactionMarker("c1", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });
    s.pushCompactionMarker("c2", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });
    s.clearCompactionMarkers("c1");
    expect(useAppStore.getState().compactionMarkers["c1"]).toBeUndefined();
    expect(useAppStore.getState().compactionMarkers["c2"]).toHaveLength(1);
  });

  it("clears every conversation when passed null", () => {
    const s = useAppStore.getState();
    s.pushCompactionMarker("c1", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });
    s.pushCompactionMarker("c2", {
      turnIndex: 0,
      source: "fresh_llm",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });
    s.clearCompactionMarkers(null);
    expect(useAppStore.getState().compactionMarkers).toEqual({});
  });
});
