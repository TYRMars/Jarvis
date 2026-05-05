import { wsUrl } from "./api";
import { handleFrameForConversation } from "./frames";
import { appStore } from "../store/appStore";
import { showError } from "./status";
import { t } from "../utils/i18n";

type Routing = { provider: string | null; model: string | null };

export interface StartConversationTurnOptions {
  conversationId: string;
  content: string;
  routing: Routing;
  isNew?: boolean;
  projectId?: string | null;
  workspacePath?: string | null;
  soulPrompt?: string | null;
}

type ManagedSocket = {
  conversationId: string;
  socket: WebSocket;
  open: boolean;
  terminal: boolean;
};

const sockets = new Map<string, ManagedSocket>();

export function startConversationTurn(opts: StartConversationTurnOptions): boolean {
  const existing = sockets.get(opts.conversationId);
  if (existing && existing.socket.readyState <= WebSocket.OPEN && !existing.terminal) {
    showError(t("turnInProgress"));
    return false;
  }
  closeConversationSocket(opts.conversationId);

  const ws = new WebSocket(wsUrl());
  const managed: ManagedSocket = {
    conversationId: opts.conversationId,
    socket: ws,
    open: false,
    terminal: false,
  };
  sockets.set(opts.conversationId, managed);
  appStore.getState().setConversationRunStatus(opts.conversationId, "running", {
    startedAt: Date.now(),
    lastError: null,
  });

  ws.addEventListener("open", () => {
    managed.open = true;
    const first: any = opts.isNew
      ? { type: "new", id: opts.conversationId }
      : { type: "resume", id: opts.conversationId };
    if (opts.routing.provider) first.provider = opts.routing.provider;
    if (opts.routing.model) first.model = opts.routing.model;
    if (opts.isNew && opts.projectId) first.project_id = opts.projectId;
    if (opts.isNew && opts.workspacePath) first.workspace_path = opts.workspacePath;
    ws.send(JSON.stringify(first));

    const user: any = { type: "user", content: opts.content };
    if (opts.routing.provider) user.provider = opts.routing.provider;
    if (opts.routing.model) user.model = opts.routing.model;
    if (opts.soulPrompt) user.soul_prompt = opts.soulPrompt;
    ws.send(JSON.stringify(user));
  });

  ws.addEventListener("message", (e) => {
    let frame: any;
    try {
      frame = JSON.parse(e.data);
    } catch (err) {
      console.error("bad conversation frame", err, e.data);
      return;
    }
    if (isTerminalFrame(frame)) managed.terminal = true;
    handleFrameForConversation(opts.conversationId, frame);
    if (isTerminalFrame(frame)) {
      closeConversationSocket(opts.conversationId);
      void import("./conversations").then(({ refreshConvoList }) => refreshConvoList());
    }
  });

  ws.addEventListener("close", () => {
    sockets.delete(opts.conversationId);
    if (!managed.terminal) {
      void import("./chatRuns").then(({ refreshChatRuns }) => refreshChatRuns());
    }
  });

  ws.addEventListener("error", () => {
    if (!managed.terminal) {
      void import("./chatRuns").then(({ refreshChatRuns }) => refreshChatRuns());
    }
  });

  return true;
}

export function sendFrameToConversation(conversationId: string | null, frame: any): boolean {
  if (!conversationId) return false;
  const managed = sockets.get(conversationId);
  if (!managed || managed.socket.readyState !== WebSocket.OPEN) return false;
  managed.socket.send(JSON.stringify(frame));
  return true;
}

export function sendFrameToActiveConversation(frame: any): boolean {
  return sendFrameToConversation(appStore.getState().activeId, frame);
}

export function isConversationSocketOpen(conversationId: string | null): boolean {
  if (!conversationId) return false;
  const managed = sockets.get(conversationId);
  return !!managed && managed.socket.readyState === WebSocket.OPEN;
}

export function requestActiveConversationInterrupt(): boolean {
  const id = appStore.getState().activeId;
  if (!id) return false;
  if (sendFrameToConversation(id, { type: "interrupt" })) return true;
  void import("./chatRuns").then(({ interruptChatRun }) => interruptChatRun(id));
  return true;
}

export function closeConversationSocket(conversationId: string): void {
  const existing = sockets.get(conversationId);
  if (!existing) return;
  sockets.delete(conversationId);
  try {
    existing.socket.close();
  } catch {
    // best effort
  }
}

function isTerminalFrame(frame: any): boolean {
  return frame?.type === "done" || frame?.type === "error" || frame?.type === "interrupted";
}
