// Store reducer tests — focused on the slices that have shipped a
// real bug, not exhaustive coverage. Each test uses
// `useAppStore.getState()` / `setState` to drive actions and
// observes the resulting state shape.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { useAppStore } from "./appStore";

const get = () => useAppStore.getState();

beforeEach(() => {
  // setup.ts rewinds INITIAL between tests, but localStorage writes
  // bleed across in-process tests since jsdom keeps one document
  // per worker. Wipe the keys we touch.
  localStorage.clear();
});

describe("approvals", () => {
  it("pushApprovalRequest is idempotent on duplicate id", () => {
    get().pushApprovalRequest("call_1", "shell.exec", { cmd: "ls" });
    get().pushApprovalRequest("call_1", "shell.exec", { cmd: "ls" });
    expect(get().approvals).toHaveLength(1);
    expect(get().approvals[0].status).toBe("pending");
  });

  it("setApprovalDecision flips a single entry", () => {
    get().pushApprovalRequest("a", "shell.exec", {});
    get().pushApprovalRequest("b", "shell.exec", {});
    get().setApprovalDecision("a", "approve");
    get().setApprovalDecision("b", "deny", "no thanks");
    expect(get().approvals[0]).toMatchObject({ id: "a", status: "approved", reason: null });
    expect(get().approvals[1]).toMatchObject({ id: "b", status: "denied", reason: "no thanks" });
  });

  it("finalizePendingApprovals only touches still-pending entries", () => {
    get().pushApprovalRequest("a", "shell.exec", {});
    get().pushApprovalRequest("b", "shell.exec", {});
    get().setApprovalDecision("a", "approve");
    get().finalizePendingApprovals();
    expect(get().approvals[0]).toMatchObject({ id: "a", status: "approved" });
    expect(get().approvals[1]).toMatchObject({
      id: "b",
      status: "denied",
      reason: "(turn ended)",
    });
  });
});

describe("convoRouting", () => {
  it("setRouting also persists the active conversation's pin", () => {
    get().setActiveId("convo-7");
    get().setRouting("openai|gpt-4o");
    expect(get().routing).toBe("openai|gpt-4o");
    expect(get().convoRouting["convo-7"]).toBe("openai|gpt-4o");
    expect(JSON.parse(localStorage.getItem("jarvis.convo.routing")!)).toEqual({
      "convo-7": "openai|gpt-4o",
    });
  });

  it("setRouting('') clears the active convo's entry", () => {
    get().setActiveId("convo-7");
    get().setRouting("openai|gpt-4o");
    get().setRouting("");
    expect(get().convoRouting["convo-7"]).toBeUndefined();
  });

  it("setRouting with no active convo only updates global routing", () => {
    get().setRouting("openai|gpt-4o");
    expect(get().routing).toBe("openai|gpt-4o");
    expect(get().convoRouting).toEqual({});
  });

  it("setConvoRoutingFor is a no-op when value is unchanged", () => {
    get().setConvoRoutingFor("c1", "openai|gpt-4o");
    const before = get().convoRouting;
    get().setConvoRoutingFor("c1", "openai|gpt-4o");
    // Identity check: action returned `s` so reference is preserved.
    expect(get().convoRouting).toBe(before);
  });
});

describe("pinned + titleOverrides", () => {
  it("togglePin flips and persists", () => {
    get().togglePin("c1");
    expect(get().pinned.has("c1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("jarvis.convo.pinned")!)).toEqual(["c1"]);
    get().togglePin("c1");
    expect(get().pinned.has("c1")).toBe(false);
    expect(JSON.parse(localStorage.getItem("jarvis.convo.pinned")!)).toEqual([]);
  });

  it("setTitleOverride writes and clears", () => {
    get().setTitleOverride("c1", "  hello  ");
    expect(get().titleOverrides.c1).toBe("hello");
    get().setTitleOverride("c1", null);
    expect(get().titleOverrides.c1).toBeUndefined();
  });
});

describe("composer pasted blobs", () => {
  it("addPastedBlob returns a placeholder containing the token", () => {
    const placeholder = get().addPastedBlob("a".repeat(2048));
    expect(placeholder).toMatch(/^\[Pasted [\d.]+ KB\] #[a-f0-9]+$/);
    const token = placeholder.match(/#([a-f0-9]+)/)![1];
    expect(get().pastedBlobs[token]).toBe("a".repeat(2048));
  });

  it("expandPastedPlaceholders replaces placeholders with original content", () => {
    const placeholder = get().addPastedBlob("hello world");
    const text = `look: ${placeholder}\nthanks`;
    expect(get().expandPastedPlaceholders(text)).toBe("look: hello world\nthanks");
  });

  it("gcPastedBlobs drops blobs whose placeholder no longer appears", () => {
    const placeholder = get().addPastedBlob("hello");
    get().setComposerValue(`note: ${placeholder}`);
    get().gcPastedBlobs();
    expect(Object.keys(get().pastedBlobs)).toHaveLength(1);
    get().setComposerValue("note: nothing pasted");
    get().gcPastedBlobs();
    expect(get().pastedBlobs).toEqual({});
  });
});

describe("settings", () => {
  it("setTheme persists + sets the html data-theme attribute", () => {
    get().setTheme("dark");
    expect(get().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("jarvis.theme")).toBe("dark");
  });

  it("setLang persists + sets the html lang attribute", () => {
    get().setLang("zh");
    expect(get().lang).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem("jarvis.lang")).toBe("zh");
  });
});

describe("setInFlight", () => {
  it("toggles the body.turn-in-flight class", () => {
    get().setInFlight(true);
    expect(document.body.classList.contains("turn-in-flight")).toBe(true);
    get().setInFlight(false);
    expect(document.body.classList.contains("turn-in-flight")).toBe(false);
  });

  it("clamps turnStartedAt to a stable timestamp across overlapping starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T10:00:00Z"));
    get().setInFlight(true);
    const t1 = get().turnStartedAt;
    vi.setSystemTime(new Date("2026-04-26T10:00:05Z"));
    get().setInFlight(true);
    expect(get().turnStartedAt).toBe(t1);
    vi.useRealTimers();
  });
});

describe("messages slice", () => {
  it("pushUserMessage appends and increments userOrdinal", () => {
    get().pushUserMessage("first");
    get().pushUserMessage("second");
    const users = get().messages.filter((m) => m.kind === "user") as Array<{
      kind: "user";
      content: string;
      userOrdinal: number;
    }>;
    expect(users.map((u) => u.userOrdinal)).toEqual([0, 1]);
    expect(users.map((u) => u.content)).toEqual(["first", "second"]);
  });

  it("appendDelta accumulates into the trailing assistant entry", () => {
    get().pushUserMessage("hi");
    get().appendDelta("Hel");
    get().appendDelta("lo!");
    const last = get().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") expect(last.content).toBe("Hello!");
  });

  it("applyForked drops messages from the matching userOrdinal forward", () => {
    get().pushUserMessage("a");
    get().appendDelta("answer-a");
    get().pushUserMessage("b");
    get().appendDelta("answer-b");
    expect(get().messages).toHaveLength(4);
    get().applyForked(1);
    expect(get().messages).toHaveLength(2);
    expect(get().messages[0].kind).toBe("user");
    expect(get().messages[1].kind).toBe("assistant");
  });
});
