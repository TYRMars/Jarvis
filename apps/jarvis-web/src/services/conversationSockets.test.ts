import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store/appStore";
import { startConversationTurn } from "./conversationSockets";

vi.mock("./status", () => ({
  showError: vi.fn(),
  setInFlight: (v: boolean) => appStore.getState().setInFlight(v),
  showTransientStatus: vi.fn(),
}));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  emit(type: string, event: any = {}): void {
    if (type === "open") this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.get(type) ?? []) {
      cb(event);
    }
  }
}

describe("conversationSockets", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    appStore.getState().setActiveSkills?.([]);
  });

  it("starts a persisted turn with one atomic start_turn frame", () => {
    appStore.getState().setActiveSkills?.(["code-review", "docs"]);

    const ok = startConversationTurn({
      conversationId: "conv-1",
      content: "ship it",
      routing: { provider: "openai", model: "gpt-test" },
      isNew: true,
      projectId: "proj-1",
      workspacePath: "/tmp/project",
      soulPrompt: "be concise",
    });

    expect(ok).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    expect(ws.sent).toEqual([
      {
        type: "start_turn",
        mode: "new",
        id: "conv-1",
        content: "ship it",
        provider: "openai",
        model: "gpt-test",
        project_id: "proj-1",
        workspace_path: "/tmp/project",
        soul_prompt: "be concise",
        active_skills: ["code-review", "docs"],
      },
    ]);
  });

  it("rolls back a stale resumed conversation when the server rejects startup", () => {
    appStore.getState().setActiveId("fe309dfa-old");

    const ok = startConversationTurn({
      conversationId: "fe309dfa-old",
      content: "hello",
      routing: { provider: null, model: null },
      isNew: false,
    });

    expect(ok).toBe(true);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    expect(appStore.getState().isConversationRunning("fe309dfa-old")).toBe(true);

    ws.emit("message", {
      data: JSON.stringify({
        type: "error",
        message: "conversation `fe309dfa-old` not found",
      }),
    });

    expect(appStore.getState().activeId).toBeNull();
    expect(appStore.getState().isConversationRunning("fe309dfa-old")).toBe(false);
  });

  it("falls back to legacy frames when the server does not know start_turn", () => {
    appStore.getState().setActiveSkills?.(["docs"]);

    const ok = startConversationTurn({
      conversationId: "conv-legacy",
      content: "hello",
      routing: { provider: "openai", model: "gpt-test" },
      isNew: true,
      projectId: "proj-1",
      workspacePath: "/tmp/project",
      soulPrompt: "be concise",
    });

    expect(ok).toBe(true);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", {
      data: JSON.stringify({
        type: "error",
        message:
          "bad client message: unknown variant `start_turn`, expected one of `user`",
      }),
    });

    expect(ws.sent).toEqual([
      {
        type: "start_turn",
        mode: "new",
        id: "conv-legacy",
        content: "hello",
        provider: "openai",
        model: "gpt-test",
        project_id: "proj-1",
        workspace_path: "/tmp/project",
        soul_prompt: "be concise",
        active_skills: ["docs"],
      },
      {
        type: "new",
        id: "conv-legacy",
        provider: "openai",
        model: "gpt-test",
        project_id: "proj-1",
        workspace_path: "/tmp/project",
      },
      { type: "activate_skill", name: "docs" },
      {
        type: "user",
        content: "hello",
        provider: "openai",
        model: "gpt-test",
        soul_prompt: "be concise",
      },
    ]);
    expect(appStore.getState().isConversationRunning("conv-legacy")).toBe(true);
  });
});
