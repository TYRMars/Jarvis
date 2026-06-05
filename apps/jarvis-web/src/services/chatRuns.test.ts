import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store/appStore";
import {
  clientLastSeq,
  invalidateConversationSeq,
  observeFrameSeq,
  refreshChatRuns,
} from "./chatRuns";

vi.mock("./conversationSockets", () => ({
  isConversationSocketOpen: () => false,
}));
vi.mock("./frames", () => ({
  handleFrameForConversation: vi.fn(),
}));

describe("chatRuns", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    })));
  });

  it("observeFrameSeq is monotonic and ignores non-numeric / non-positive values", () => {
    invalidateConversationSeq("c-seq");
    expect(clientLastSeq("c-seq")).toBe(0);

    observeFrameSeq("c-seq", 5);
    expect(clientLastSeq("c-seq")).toBe(5);

    // Out-of-order arrival (broadcast lag or REST poll catching up
    // after a live frame already landed) — must NOT move backwards.
    observeFrameSeq("c-seq", 3);
    expect(clientLastSeq("c-seq")).toBe(5);

    observeFrameSeq("c-seq", 12);
    expect(clientLastSeq("c-seq")).toBe(12);

    // Lifecycle frames carry no `seq` — these are no-ops.
    observeFrameSeq("c-seq", undefined);
    observeFrameSeq("c-seq", null);
    observeFrameSeq("c-seq", "8");
    observeFrameSeq("c-seq", 0);
    observeFrameSeq("c-seq", -1);
    expect(clientLastSeq("c-seq")).toBe(12);
  });

  it("invalidateConversationSeq drops the cursor so the next observe re-anchors from zero", () => {
    invalidateConversationSeq("c-clear");
    observeFrameSeq("c-clear", 7);
    expect(clientLastSeq("c-clear")).toBe(7);
    invalidateConversationSeq("c-clear");
    expect(clientLastSeq("c-clear")).toBe(0);
    // After invalidation, the next observed seq becomes the new
    // baseline regardless of what was there before.
    observeFrameSeq("c-clear", 2);
    expect(clientLastSeq("c-clear")).toBe(2);
  });

  it("clears a local active run when the server no longer has it", async () => {
    appStore.getState().setActiveId("fe309dfa-old");
    appStore.getState().setConversationRunStatus("fe309dfa-old", "running", {
      startedAt: Date.now(),
    });

    await refreshChatRuns();

    expect(appStore.getState().isConversationRunning("fe309dfa-old")).toBe(false);
    expect(appStore.getState().conversationRuns["fe309dfa-old"].status).toBe("failed");
    expect(appStore.getState().conversationRuns["fe309dfa-old"].lastError).toBe(
      "run state unavailable on server",
    );
  });
});
