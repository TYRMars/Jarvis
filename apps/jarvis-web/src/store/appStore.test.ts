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

  it("setApprovalDecision stamps the source onto the matching tool block", () => {
    // Seed a tool block first so the source has somewhere to land.
    get().pushToolStart("call_x", "fs.edit", { path: "src/foo.rs" });
    get().pushApprovalRequest("call_x", "fs.edit", { path: "src/foo.rs" });
    get().setApprovalDecision("call_x", "approve", null, {
      kind: "rule",
      scope: "user",
      bucket: "allow",
      index: 0,
    });
    const block = get().toolBlocks["call_x"];
    expect(block.decisionSource).toEqual({
      kind: "rule",
      scope: "user",
      bucket: "allow",
      index: 0,
    });
  });

  it("setApprovalDecision without a source leaves decisionSource null", () => {
    get().pushToolStart("call_y", "fs.edit", { path: "src/bar.rs" });
    get().pushApprovalRequest("call_y", "fs.edit", { path: "src/bar.rs" });
    get().setApprovalDecision("call_y", "approve");
    expect(get().toolBlocks["call_y"].decisionSource).toBeNull();
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

  it("finalizeAssistant repairs cumulative stream snapshots with the final content", () => {
    get().pushUserMessage("hi");
    get().appendDelta("Hel");
    get().appendDelta("Hello!");
    get().finalizeAssistant({ content: "Hello!" });

    const last = get().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.content).toBe("Hello!");
      expect(last.finalised).toBe(true);
    }
  });

  it("finalizeAssistant coalesces adjacent duplicate assistant replies", () => {
    get().pushUserMessage("which subagents can you use?");
    get().appendDelta("I can help with Claude Code.");
    get().finalizeAssistant({ content: "I can help with Claude Code." });

    get().appendDelta("I can help with Claude Code.");
    get().finalizeAssistant({
      content: "I can help with Claude Code.",
      reasoning_content: "The user is asking about subagents.",
    });

    const assistants = get().messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
    if (assistants[0].kind === "assistant") {
      expect(assistants[0].content).toBe("I can help with Claude Code.");
      expect(assistants[0].reasoning).toBe("The user is asking about subagents.");
      expect(assistants[0].finalised).toBe(true);
    }
  });

  it("multi-iteration tool calls without intervening text attach to the right assistant", () => {
    // Reproduces the rendering bug where iteration 2's tool call
    // shows up under iteration 1's assistant bubble because
    // `finalizeAssistant` updated the already-finalised trailing
    // message instead of creating a new one.
    //
    // Frame replay (matches the server's emit order in agent.rs):
    //   user → delta → assistant_message[t1] → tool_start[t1] → tool_end[t1]
    //                → assistant_message[t2] (no delta!) → tool_start[t2] → tool_end[t2]
    //                → delta "all done" → assistant_message[]
    get().pushUserMessage("do the thing");
    // Iteration 1: delta then tool call
    get().appendDelta("Let me check.");
    get().finalizeAssistant({ content: "Let me check." });
    get().pushToolStart("t1", "fs.read", { path: "a" });
    get().setToolEnd("t1", "<file body>");
    // Iteration 2: pure tool call — NO delta. This is where the
    // bug used to fire.
    get().finalizeAssistant({ content: "" });
    get().pushToolStart("t2", "fs.read", { path: "b" });
    get().setToolEnd("t2", "<other body>");
    // Iteration 3: final reply, no tools.
    get().appendDelta("all done");
    get().finalizeAssistant({ content: "all done" });

    const assistants = get().messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(3);
    // Tool t1 belongs to iter-1's assistant; t2 to iter-2's.
    if (assistants[0].kind === "assistant") {
      expect(assistants[0].content).toBe("Let me check.");
      expect(assistants[0].toolCallIds).toEqual(["t1"]);
    }
    if (assistants[1].kind === "assistant") {
      expect(assistants[1].content).toBe("");
      expect(assistants[1].toolCallIds).toEqual(["t2"]);
    }
    if (assistants[2].kind === "assistant") {
      expect(assistants[2].content).toBe("all done");
      expect(assistants[2].toolCallIds).toEqual([]);
    }
  });

  it("loadHistory hides ask.* tool-only assistant messages", () => {
    get().loadHistory([
      { role: "user", content: "ask me" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "ask_1",
            name: "ask.text",
            arguments: { title: "Deployment target" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "ask_1",
        content: JSON.stringify({
          request_id: "hitl_1",
          status: "submitted",
          payload: "staging",
        }),
      },
      { role: "assistant", content: "Using staging." },
    ]);

    const assistants = get().messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(1);
    if (assistants[0].kind === "assistant") {
      expect(assistants[0].content).toBe("Using staging.");
      expect(assistants[0].toolCallIds).toEqual([]);
    }
    expect(get().toolBlocks.ask_1).toBeUndefined();
  });

  it("loadHistory rebuilds the tasks rail from persisted tool calls", () => {
    // Seed leftover tasks from a previous conversation so the test
    // also asserts they get cleared (no leakage across switches).
    get().upsertTask({ id: "stale", name: "shell.exec", args: {}, status: "ok" });
    expect(get().tasks).toHaveLength(1);

    get().loadHistory([
      { role: "user", content: "look at git" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc_1", name: "git.status", arguments: {} },
          { id: "tc_2", name: "fs.read", arguments: { path: "README.md" } },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "## main" },
      { role: "tool", tool_call_id: "tc_2", content: "abc\ndef\n" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc_3", name: "shell.exec", arguments: { command: "ls" } }],
      },
      { role: "tool", tool_call_id: "tc_3", content: "tool denied: not allowed" },
    ]);

    const tasks = get().tasks;
    expect(tasks).toHaveLength(3);
    // Stale task from before the load is gone.
    expect(tasks.find((t) => t.id === "stale")).toBeUndefined();
    // Insertion order matches walking the history top-down.
    expect(tasks.map((t) => t.id)).toEqual(["tc_1", "tc_2", "tc_3"]);
    // Status pulled through from the matching tool blocks.
    expect(tasks[2].status).toBe("denied");
    // Timestamps are monotonic so a future live tool call sorts later.
    expect(tasks[0].startedAt).toBeLessThan(tasks[2].startedAt);
  });

  it("clearMessages resets per-conversation slices including tasks/plan", () => {
    get().upsertTask({ id: "t1", name: "shell.exec", args: {}, status: "ok" });
    get().setPlan([{ id: "p1", title: "step", status: "completed" }]);
    get().setProposedPlan("draft");
    get().clearMessages();
    expect(get().tasks).toEqual([]);
    expect(get().plan).toEqual([]);
    expect(get().proposedPlan).toBeNull();
  });

  it("loadHistory hides persisted system prompt messages", () => {
    get().loadHistory([
      { role: "system", content: "large operational prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(get().messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
    expect(get().messages.some((m) => m.kind === "system")).toBe(false);
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
