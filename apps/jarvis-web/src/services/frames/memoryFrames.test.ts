// Frame handler dispatches MemoryCompacted events into the active
// conversation's slot. Tests the wire-shape → store-action path.

import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../../store/appStore";
import { memoryFrameHandlers } from "./memoryFrames";

beforeEach(() => {
  useAppStore.getState().clearCompactionMarkers(null);
});

describe("memory_compacted handler", () => {
  it("posts the CompactionInfo under the active conversation id", () => {
    useAppStore.setState({ activeId: "convo-1", messages: [] });
    memoryFrameHandlers["memory_compacted"]({
      type: "memory_compacted",
      info: {
        source: "fresh_llm",
        turns_kept: 2,
        turns_dropped: 4,
        summary_chars: 180,
        working_context_chars: 90,
        model_input_tokens_est: 1234,
      },
    });
    const markers = useAppStore.getState().compactionMarkers["convo-1"];
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      source: "fresh_llm",
      turnsKept: 2,
      turnsDropped: 4,
      summaryChars: 180,
      workingContextChars: 90,
      modelInputTokensEst: 1234,
    });
  });

  it("uses the __active__ fallback key when no conversation is active", () => {
    useAppStore.setState({ activeId: null, messages: [] });
    memoryFrameHandlers["memory_compacted"]({
      type: "memory_compacted",
      info: { source: "cache_memory", turns_kept: 0, turns_dropped: 0, model_input_tokens_est: 0 },
    });
    expect(useAppStore.getState().compactionMarkers["__active__"]).toHaveLength(1);
  });

  it("defaults missing numeric fields to 0 and source to no_op", () => {
    useAppStore.setState({ activeId: "c", messages: [] });
    memoryFrameHandlers["memory_compacted"]({ type: "memory_compacted", info: {} });
    const m = useAppStore.getState().compactionMarkers["c"][0];
    expect(m.source).toBe("no_op");
    expect(m.turnsKept).toBe(0);
    expect(m.turnsDropped).toBe(0);
    expect(m.modelInputTokensEst).toBe(0);
    expect(m.summaryChars).toBeUndefined();
  });

  it("reset clears every conversation's markers", () => {
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
      source: "cache_memory",
      turnsKept: 0,
      turnsDropped: 1,
      modelInputTokensEst: 1,
    });
    memoryFrameHandlers["reset"]({ type: "reset" });
    expect(useAppStore.getState().compactionMarkers).toEqual({});
  });

  it("records turnIndex from the current message count", () => {
    useAppStore.setState({
      activeId: "c",
      messages: [
        { uid: "u1", kind: "user", content: "hi", userOrdinal: 1 },
        { uid: "a1", kind: "assistant", content: "hello", reasoning: "", toolCallIds: [], finalised: true },
      ] as never,
    });
    memoryFrameHandlers["memory_compacted"]({
      type: "memory_compacted",
      info: { source: "fresh_llm", turns_kept: 1, turns_dropped: 1, model_input_tokens_est: 5 },
    });
    const m = useAppStore.getState().compactionMarkers["c"][0];
    expect(m.turnIndex).toBe(2);
  });
});
