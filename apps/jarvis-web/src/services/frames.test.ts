// Wire-shape contract tests for the WS → store frame router.
// Each `case` in the switch gets at least one test that drives a
// JSON-shaped frame through `handleFrame` and asserts the resulting
// store mutation. These have already saved us twice — once on the
// approval-decision shape (`ev.decision.decision` vs `ev.decision`)
// and once on `tool_progress` arriving before `tool_end`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "../store/appStore";
import { handleFrame } from "./frames";

vi.mock("./socket", () => ({
  applyRouting: vi.fn(),
  isOpen: () => false,
  sendFrame: vi.fn(() => true),
}));
vi.mock("./conversations", () => ({ refreshConvoList: vi.fn() }));

const get = () => useAppStore.getState();

beforeEach(() => {
  localStorage.clear();
});

describe("handleFrame: chat / tool flow", () => {
  it("delta + assistant_message accumulate then finalise", () => {
    handleFrame({ type: "delta", content: "Hel" });
    handleFrame({ type: "delta", content: "lo!" });
    handleFrame({
      type: "assistant_message",
      message: { role: "assistant", content: "Hello!" },
    });
    const last = get().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.content).toBe("Hello!");
      expect(last.finalised).toBe(true);
    }
  });

  it("tool_start → tool_progress → tool_end populates the block + the rail task", () => {
    handleFrame({
      type: "tool_start",
      id: "call_1",
      name: "shell.exec",
      arguments: { cmd: "ls" },
    });
    expect(get().toolBlocks.call_1).toMatchObject({ status: "running", progress: "" });
    expect(get().tasks).toHaveLength(1);
    expect(get().tasks[0]).toMatchObject({ id: "call_1", status: "running" });

    handleFrame({ type: "tool_progress", id: "call_1", name: "shell.exec", stream: "stdout", chunk: "line 1\n" });
    handleFrame({ type: "tool_progress", id: "call_1", name: "shell.exec", stream: "stdout", chunk: "line 2\n" });
    expect(get().toolBlocks.call_1.progress).toBe("line 1\nline 2\n");
    // Task status hasn't changed yet — still running.
    expect(get().tasks[0].status).toBe("running");

    handleFrame({ type: "tool_end", id: "call_1", name: "shell.exec", content: "exit=0\n--- stdout ---\nline 1\nline 2\n" });
    expect(get().toolBlocks.call_1).toMatchObject({ status: "ok" });
    expect(get().tasks[0].status).toBe("ok");
  });

  it("tool_end with `tool denied:` prefix sets denied status", () => {
    handleFrame({ type: "tool_start", id: "c", name: "shell.exec", arguments: {} });
    handleFrame({ type: "tool_end", id: "c", name: "shell.exec", content: "tool denied: nope" });
    expect(get().toolBlocks.c.status).toBe("denied");
    expect(get().tasks[0].status).toBe("denied");
  });

  it("tool_end with `tool error:` prefix sets error status", () => {
    handleFrame({ type: "tool_start", id: "c", name: "shell.exec", arguments: {} });
    handleFrame({ type: "tool_end", id: "c", name: "shell.exec", content: "tool error: broken" });
    expect(get().toolBlocks.c.status).toBe("error");
    expect(get().tasks[0].status).toBe("error");
  });

  it("ask.* tool lifecycle stays out of chat tool blocks and task rail", () => {
    handleFrame({
      type: "tool_start",
      id: "ask_1",
      name: "ask.text",
      arguments: { title: "Deployment target" },
    });
    handleFrame({
      type: "tool_end",
      id: "ask_1",
      name: "ask.text",
      content: '{"status":"submitted","payload":"staging"}',
    });
    expect(get().toolBlocks.ask_1).toBeUndefined();
    expect(get().tasks).toHaveLength(0);
  });
});

describe("handleFrame: native ask flow", () => {
  it("hitl_request creates a pending ask entry and response resolves it", () => {
    handleFrame({
      type: "hitl_request",
      request: {
        id: "hitl_1",
        transport: "text",
        kind: "input",
        title: "Deployment target",
        body: "Which target?",
      },
    });
    expect(get().hitls).toHaveLength(1);
    expect(get().hitls[0]).toMatchObject({
      request: { id: "hitl_1", title: "Deployment target" },
      status: "pending",
    });

    handleFrame({
      type: "hitl_response",
      response: {
        request_id: "hitl_1",
        status: "submitted",
        payload: "staging",
      },
    });
    expect(get().hitls[0]).toMatchObject({
      status: "submitted",
      payload: "staging",
    });
  });
});

describe("handleFrame: approval flow", () => {
  it("approval_request creates a pending card", () => {
    handleFrame({
      type: "approval_request",
      id: "ar_1",
      name: "shell.exec",
      arguments: { cmd: "rm -rf" },
    });
    expect(get().approvals).toHaveLength(1);
    expect(get().approvals[0]).toMatchObject({ id: "ar_1", status: "pending" });
  });

  it("approval_decision unpacks the nested `{ decision: 'approve' }` shape", () => {
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    handleFrame({
      type: "approval_decision",
      id: "ar_1",
      name: "x",
      decision: { decision: "approve" },
    });
    expect(get().approvals[0]).toMatchObject({ status: "approved", reason: null });
  });

  it("approval_decision with deny carries the reason through", () => {
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    handleFrame({
      type: "approval_decision",
      id: "ar_1",
      name: "x",
      decision: { decision: "deny", reason: "no thanks" },
    });
    expect(get().approvals[0]).toMatchObject({ status: "denied", reason: "no thanks" });
  });
});

describe("handleFrame: terminal events finalise pending approvals", () => {
  it("done event flips still-pending approvals to denied", () => {
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    get().setInFlight(true);
    handleFrame({ type: "done", outcome: { kind: "stopped", iterations: 1 } });
    expect(get().inFlight).toBe(false);
    expect(get().approvals[0]).toMatchObject({ status: "denied", reason: "(turn ended)" });
  });

  it("error event also finalises + surfaces banner", () => {
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    get().setInFlight(true);
    handleFrame({ type: "error", message: "boom" });
    expect(get().inFlight).toBe(false);
    expect(get().bannerError).toBe("boom");
    expect(get().approvals[0].status).toBe("denied");
  });

  it("`turn in progress` errors are soft — banner only, in-flight stays", () => {
    // Regression: the server rejects a stray `user` frame mid-turn
    // with this message; treating it as terminal would cancel the
    // running turn's indicator and let the user spam-send again.
    get().setInFlight(true);
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    handleFrame({ type: "error", message: "turn already in progress" });
    expect(get().inFlight).toBe(true); // turn still in flight
    expect(get().bannerError).toBe("turn already in progress");
    expect(get().approvals[0].status).toBe("pending"); // not finalised
  });

  it("`no pending approval` errors are soft (benign double-approve race)", () => {
    get().setInFlight(true);
    handleFrame({ type: "error", message: "no pending approval for `tool_xyz`" });
    expect(get().inFlight).toBe(true);
  });

  it("interrupted event finalises + flashes warn status", () => {
    handleFrame({ type: "approval_request", id: "ar_1", name: "x", arguments: {} });
    get().setInFlight(true);
    handleFrame({ type: "interrupted" });
    expect(get().inFlight).toBe(false);
    expect(get().approvals[0].status).toBe("denied");
    expect(get().statusKey).toBe("interrupted");
  });
});

describe("handleFrame: forked + resumed + started", () => {
  it("forked drops messages from the matching userOrdinal forward", () => {
    get().pushUserMessage("a");
    get().pushUserMessage("b");
    expect(get().messages).toHaveLength(2);
    handleFrame({ type: "forked", user_ordinal: 1 });
    expect(get().messages).toHaveLength(1);
  });

  it("started pins the current routing onto the new conversation", () => {
    get().setRouting("openai|gpt-4o");
    handleFrame({ type: "started", id: "convo-7" });
    expect(get().activeId).toBe("convo-7");
    expect(get().convoRouting["convo-7"]).toBe("openai|gpt-4o");
    expect(get().convoRows[0]?.id).toBe("convo-7"); // optimistic stub
  });

  it("resumed restores a known saved routing", () => {
    useAppStore.setState({
      providers: [
        { name: "openai", default_model: "gpt-4o", models: ["gpt-4o", "gpt-4o-mini"], is_default: true },
      ],
      convoRouting: { "convo-9": "openai|gpt-4o-mini" },
    });
    handleFrame({ type: "resumed", id: "convo-9", message_count: 12 });
    expect(get().activeId).toBe("convo-9");
    expect(get().routing).toBe("openai|gpt-4o-mini");
  });

  it("resumed drops a stale routing entry whose model is gone", () => {
    useAppStore.setState({
      providers: [
        { name: "openai", default_model: "gpt-4o", models: ["gpt-4o"], is_default: true },
      ],
      convoRouting: { "convo-x": "anthropic|claude-3" }, // unknown
    });
    handleFrame({ type: "resumed", id: "convo-x", message_count: 1 });
    expect(get().convoRouting["convo-x"]).toBeUndefined();
  });
});

describe("handleFrame: usage", () => {
  it("usage frame accumulates into the store's UsageBadge slice", () => {
    handleFrame({ type: "usage", prompt_tokens: 100, completion_tokens: 50, cached_prompt_tokens: 10 });
    expect(get().usage).toMatchObject({ prompt: 100, completion: 50, cached: 10, calls: 1 });
    handleFrame({ type: "usage", prompt_tokens: 5, completion_tokens: 3 });
    expect(get().usage).toMatchObject({ prompt: 105, completion: 53, calls: 2 });
  });
});

describe("handleFrame: unknown frame", () => {
  it("logs a warning but doesn't throw", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    handleFrame({ type: "totally_made_up", oddball: 1 });
    expect(spy).toHaveBeenCalledWith("unknown frame", expect.objectContaining({ type: "totally_made_up" }));
    spy.mockRestore();
  });
});
