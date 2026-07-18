// Wire-shape contract tests for the WS → store frame router.
// Each `case` in the switch gets at least one test that drives a
// JSON-shaped frame through `handleFrame` and asserts the resulting
// store mutation. These have already saved us twice — once on the
// approval-decision shape (`ev.decision.decision` vs `ev.decision`)
// and once on `tool_progress` arriving before `tool_end`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "../store/appStore";
import { handleFrame, handleFrameForConversation } from "./frames";
import { resetUsage } from "./usage";
import { resetUsageHistory, totalsByModelForWindow } from "./usageCumulator";

vi.mock("./socket", () => ({
  applyRouting: vi.fn(),
  isOpen: () => false,
  sendFrame: vi.fn(() => true),
}));
vi.mock("./conversations", () => ({
  refreshConvoList: vi.fn(),
  clearSessionRoute: vi.fn(),
  forceReloadActiveConversation: vi.fn(() => Promise.resolve(true)),
}));

const get = () => useAppStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetUsage();
  resetUsageHistory();
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

  it("approval_pending creates the same pending card shape as approval_request", () => {
    handleFrame({
      type: "approval_pending",
      id: "ar_replay",
      name: "shell.exec",
      arguments: { cmd: "ls" },
      category: "write",
    });
    expect(get().approvals).toHaveLength(1);
    expect(get().approvals[0]).toMatchObject({ id: "ar_replay", status: "pending" });
  });

  it("approval_pending is idempotent against a prior approval_request for the same id (reconnect case)", () => {
    handleFrame({ type: "approval_request", id: "ar_keep", name: "x", arguments: {} });
    handleFrame({ type: "approval_pending", id: "ar_keep", name: "x", arguments: {} });
    // Reconnect-replay must NOT duplicate the card. Same id → same row.
    expect(get().approvals.filter((a: any) => a.id === "ar_keep")).toHaveLength(1);
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

describe("handleFrame: conversation-not-found cleanup", () => {
  it("error 'conversation `<id>` not found' drops the stale row and resets activeId", () => {
    const ghostId = "bbcfbc8a-8dfa-483d-a6c3-62434fcb7d4a";
    useAppStore.setState({
      activeId: ghostId,
      convoRows: [
        { id: ghostId, message_count: 0 },
        { id: "still-here", message_count: 1 },
      ],
    });
    get().pushUserMessage("hello");
    expect(get().messages).toHaveLength(1);

    handleFrame({ type: "error", message: `conversation \`${ghostId}\` not found` });

    expect(get().convoRows.map((r) => r.id)).toEqual(["still-here"]);
    expect(get().activeId).toBeNull();
    expect(get().messages).toHaveLength(0);
  });

  it("not-found error for a non-active id only drops the row, keeps activeId", () => {
    const ghostId = "ghost";
    useAppStore.setState({
      activeId: "kept",
      convoRows: [
        { id: ghostId, message_count: 0 },
        { id: "kept", message_count: 1 },
      ],
    });
    handleFrame({ type: "error", message: `conversation \`${ghostId}\` not found` });
    expect(get().convoRows.map((r) => r.id)).toEqual(["kept"]);
    expect(get().activeId).toBe("kept");
  });

  it("error with an unrelated message does not touch convoRows", () => {
    useAppStore.setState({
      activeId: "a",
      convoRows: [{ id: "a", message_count: 1 }],
    });
    handleFrame({ type: "error", message: "something else broke" });
    expect(get().convoRows).toHaveLength(1);
    expect(get().activeId).toBe("a");
  });
});

describe("handleFrameForConversation: scoped background frames", () => {
  it("background-conversation frames do NOT flip activeId", () => {
    // Seed: conversation A is active and has one message.
    useAppStore.setState({ activeId: "A" });
    get().pushUserMessage("from A");
    expect(get().activeId).toBe("A");
    expect(get().messages).toHaveLength(1);

    // A delta arrives for background conversation B. It should land in
    // B's surface cache without ever flipping activeId or polluting
    // A's live message slice.
    handleFrameForConversation("B", { type: "delta", content: "B-text" });

    expect(get().activeId).toBe("A"); // never temporarily flipped
    expect(get().messages).toHaveLength(1); // A's surface intact

    // Switch to B and verify B's surface accumulated the delta.
    get().saveConversationSurface("A");
    const restored = get().restoreConversationSurface("B");
    expect(restored).toBe(true);
    const last = get().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.content).toBe("B-text");
    }
  });

  it("background frames do NOT paint the visible pane when activeId is null (welcome/new-chat)", () => {
    // Regression: with no active conversation, the old swap-back was
    // guarded on `before` truthiness, so a background stream's surface
    // was restored into the visible slots and never swapped back — the
    // empty welcome pane suddenly showed (and kept mutating with) the
    // background transcript. The visible pane must stay empty.
    useAppStore.setState({ activeId: null, conversationSurfaces: {} });
    get().clearMessages();
    expect(get().activeId).toBeNull();
    expect(get().messages).toHaveLength(0);

    handleFrameForConversation("bg", { type: "delta", content: "background-text" });

    // Visible pane untouched: still the empty welcome screen.
    expect(get().activeId).toBeNull();
    expect(get().messages).toHaveLength(0);
    // The transient sentinel snapshot must not leak into the surfaces map.
    expect(Object.keys(get().conversationSurfaces)).toEqual(["bg"]);

    // The background delta still landed in the isolated bg surface.
    const restored = get().restoreConversationSurface("bg");
    expect(restored).toBe(true);
    const last = get().messages.at(-1);
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.content).toBe("background-text");
    }
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

  it("started clears stale project and workspace bindings when the server sends nulls", () => {
    get().setDraftProjectId("project-old");
    get().setSocketWorkspace("/old/repo", null);
    handleFrame({ type: "started", id: "convo-free", project_id: null, workspace_path: null });
    expect(get().draftProjectId).toBeNull();
    expect(get().socketWorkspace).toBeNull();
    expect(get().draftWorkspacePath).toBeNull();
  });

  it("resumed applies the conversation project and workspace binding", () => {
    handleFrame({
      type: "resumed",
      id: "convo-bound",
      message_count: 3,
      project_id: "project-1",
      workspace_path: "/repo/project-1",
    });
    expect(get().draftProjectId).toBe("project-1");
    expect(get().socketWorkspace).toBe("/repo/project-1");
    expect(get().draftWorkspacePath).toBe("/repo/project-1");
  });

  it("resumed falls back to the project's first workspace for old project-bound conversations", () => {
    useAppStore.setState({
      projectsById: {
        "project-1": {
          id: "project-1",
          slug: "p1",
          name: "Project 1",
          instructions: "",
          tags: [],
          workspaces: [{ path: "/repo/project-1" }],
          archived: false,
          created_at: "",
          updated_at: "",
        },
      },
    });
    handleFrame({
      type: "resumed",
      id: "convo-old",
      message_count: 3,
      project_id: "project-1",
      workspace_path: null,
    });
    expect(get().socketWorkspace).toBe("/repo/project-1");
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
    handleFrame({ type: "usage", model: "gpt-4o-mini", prompt_tokens: 100, completion_tokens: 50, cached_prompt_tokens: 10 });
    expect(get().usage).toMatchObject({ prompt: 100, completion: 50, cached: 10, calls: 1 });
    handleFrame({ type: "usage", model: "claude-3-5-haiku-latest", prompt_tokens: 5, completion_tokens: 3 });
    expect(get().usage).toMatchObject({ prompt: 105, completion: 53, calls: 2 });
  });

  it("usage frames are persisted per model for the work overview", () => {
    handleFrame({ type: "usage", model: "gpt-4o-mini", prompt_tokens: 100, completion_tokens: 50 });
    handleFrame({ type: "usage", model: "claude-3-5-haiku-latest", prompt_tokens: 20, completion_tokens: 10 });
    handleFrame({ type: "usage", model: "gpt-4o-mini", prompt_tokens: 5, completion_tokens: 5 });

    expect(totalsByModelForWindow(7)).toEqual([
      expect.objectContaining({ model: "gpt-4o-mini", prompt: 105, completion: 55, total: 160, calls: 2 }),
      expect.objectContaining({ model: "claude-3-5-haiku-latest", prompt: 20, completion: 10, total: 30, calls: 1 }),
    ]);
  });

  it("subagent usage frames are also counted", () => {
    handleFrame({
      type: "sub_agent_event",
      frame: {
        subagent_id: "sub-1",
        subagent_name: "review",
        event: {
          kind: "usage",
          model: "claude-3-5-haiku-latest",
          prompt_tokens: 30,
          completion_tokens: 12,
        },
      },
    });

    expect(get().usage).toMatchObject({ prompt: 30, completion: 12, calls: 1 });
    expect(totalsByModelForWindow(7)).toEqual([
      expect.objectContaining({ model: "claude-3-5-haiku-latest", prompt: 30, completion: 12, total: 42, calls: 1 }),
    ]);
  });
});

describe("handleFrame: persistent TODOs", () => {
  beforeEach(() => {
    useAppStore.setState({ todos: [] });
  });

  it("todo_upserted inserts a new item", () => {
    handleFrame({
      type: "todo_upserted",
      todo: {
        id: "t1",
        workspace: "/r",
        title: "fix parser",
        status: "pending",
        created_at: "2026-04-29T12:00:00Z",
        updated_at: "2026-04-29T12:00:00Z",
      },
    });
    expect(get().todos).toHaveLength(1);
    expect(get().todos[0]).toMatchObject({ id: "t1", status: "pending" });
  });

  it("todo_upserted updates an existing item by id (no duplicate)", () => {
    useAppStore.setState({
      todos: [
        {
          id: "t1",
          workspace: "/r",
          title: "fix parser",
          status: "pending",
          created_at: "2026-04-29T12:00:00Z",
          updated_at: "2026-04-29T12:00:00Z",
        },
      ],
    });
    handleFrame({
      type: "todo_upserted",
      todo: {
        id: "t1",
        workspace: "/r",
        title: "fix parser",
        status: "completed",
        created_at: "2026-04-29T12:00:00Z",
        updated_at: "2026-04-29T12:01:00Z",
      },
    });
    expect(get().todos).toHaveLength(1);
    expect(get().todos[0].status).toBe("completed");
  });

  it("todo_deleted removes the matching item", () => {
    useAppStore.setState({
      todos: [
        {
          id: "t1",
          workspace: "/r",
          title: "x",
          status: "pending",
          created_at: "2026-04-29T12:00:00Z",
          updated_at: "2026-04-29T12:00:00Z",
        },
        {
          id: "t2",
          workspace: "/r",
          title: "y",
          status: "pending",
          created_at: "2026-04-29T12:00:00Z",
          updated_at: "2026-04-29T12:00:00Z",
        },
      ],
    });
    handleFrame({ type: "todo_deleted", id: "t1", workspace: "/r" });
    expect(get().todos).toHaveLength(1);
    expect(get().todos[0].id).toBe("t2");
  });

  it("todo_deleted for an unknown id is a no-op", () => {
    useAppStore.setState({
      todos: [
        {
          id: "t1",
          workspace: "/r",
          title: "x",
          status: "pending",
          created_at: "2026-04-29T12:00:00Z",
          updated_at: "2026-04-29T12:00:00Z",
        },
      ],
    });
    handleFrame({ type: "todo_deleted", id: "ghost", workspace: "/r" });
    expect(get().todos).toHaveLength(1);
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

describe("handleFrame: stream-recovery (tail_replay_start + resume_error)", () => {
  it("tail_replay_start with first_seq > clientLastSeq + 1 force-reloads history", async () => {
    const { forceReloadActiveConversation } = await import("./conversations");
    const { invalidateConversationSeq } = await import("./chatRuns");
    (forceReloadActiveConversation as any).mockClear();
    invalidateConversationSeq("conv-gap");
    get().setActiveId("conv-gap");
    // Client has never observed any seq for this conversation, so
    // clientLastSeq returns 0. Server says first_seq = 50, which
    // means seqs 1..49 are missing — exactly the gap case.
    handleFrame({
      type: "tail_replay_start",
      count: 0,
      first_seq: 50,
      latest_seq: 100,
    });
    expect(forceReloadActiveConversation).toHaveBeenCalledTimes(1);
  });

  it("tail_replay_start with first_seq == 1 is the no-eviction case and skips reload", async () => {
    const { forceReloadActiveConversation } = await import("./conversations");
    (forceReloadActiveConversation as any).mockClear();
    get().setActiveId("conv-clean");
    handleFrame({
      type: "tail_replay_start",
      count: 5,
      first_seq: 1,
      latest_seq: 5,
    });
    expect(forceReloadActiveConversation).not.toHaveBeenCalled();
  });

  it("tail_replay_start without first_seq (legacy server) is a no-op", async () => {
    const { forceReloadActiveConversation } = await import("./conversations");
    (forceReloadActiveConversation as any).mockClear();
    get().setActiveId("conv-legacy");
    handleFrame({ type: "tail_replay_start", count: 3 });
    expect(forceReloadActiveConversation).not.toHaveBeenCalled();
  });

  it("resume_error always reloads + drops the seq cursor", async () => {
    const { forceReloadActiveConversation } = await import("./conversations");
    (forceReloadActiveConversation as any).mockClear();
    get().setActiveId("conv-evicted");
    handleFrame({
      type: "resume_error",
      reason: "evicted",
      first_available_seq: 200,
    });
    expect(forceReloadActiveConversation).toHaveBeenCalledTimes(1);
  });

  it("tail_replay_done is a silent marker", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    handleFrame({ type: "tail_replay_done" });
    // Must not log "unknown frame" — the handler exists.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
