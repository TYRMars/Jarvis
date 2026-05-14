import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store/appStore";
import { refreshChatRuns } from "./chatRuns";

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
