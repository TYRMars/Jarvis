import { wsUrl } from "./api";
import { handleFrameForConversation } from "./frames";
import { appStore } from "../store/appStore";
import type { ConversationSurfaceSnapshot } from "../store/types";
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
  requirementRunId?: string | null;
  verificationCommands?: string[];
}

type ManagedSocket = {
  conversationId: string;
  socket: WebSocket;
  open: boolean;
  terminal: boolean;
};

type TerminalFrame = {
  type?: string;
  message?: unknown;
};

const sockets = new Map<string, ManagedSocket>();

export function startConversationTurn(opts: StartConversationTurnOptions): boolean {
  const existing = sockets.get(opts.conversationId);
  if (existing && existing.socket.readyState <= WebSocket.OPEN && !existing.terminal) {
    showError(t("turnInProgress"));
    return false;
  }
  if (appStore.getState().isConversationRunning(opts.conversationId)) {
    showError(t("turnInProgress"));
    return false;
  }
  closeConversationSocket(opts.conversationId);
  const startupSurface = captureConversationSurface();
  const startupActiveId = appStore.getState().activeId;
  let acceptedByServer = false;
  let legacyFallbackSent = false;

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
  if (opts.requirementRunId) {
    void import("./requirements")
      .then(({ updateRequirementRun }) =>
        updateRequirementRun(opts.requirementRunId!, { status: "running" }),
      )
      .catch((err) => console.warn("requirement run mark running failed", err));
  }

  ws.addEventListener("open", () => {
    managed.open = true;
    sendStartTurnFrame(ws, opts);
  });

  ws.addEventListener("message", (e) => {
    let frame: any;
    try {
      frame = JSON.parse(e.data);
    } catch (err) {
      console.error("bad conversation frame", err, e.data);
      return;
    }
    if (frame?.type === "started" || frame?.type === "resumed") {
      acceptedByServer = true;
    }
    if (
      frame?.type === "error" &&
      !acceptedByServer &&
      !legacyFallbackSent &&
      isStartTurnUnsupported(frame.message)
    ) {
      legacyFallbackSent = true;
      sendLegacyTurnFrames(ws, opts);
      return;
    }
    if (isTerminalFrame(frame)) managed.terminal = true;
    handleFrameForConversation(opts.conversationId, frame);
    if (frame?.type === "error" && !acceptedByServer) {
      rollbackStartupFailure(
        opts.conversationId,
        opts.isNew === true,
        startupActiveId,
        startupSurface,
        typeof frame.message === "string" ? frame.message : undefined,
      );
    }
    if (isTerminalFrame(frame)) {
      if (opts.requirementRunId) {
        void reconcileRequirementRun(opts.requirementRunId, frame, opts.verificationCommands);
      }
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

function sendStartTurnFrame(ws: WebSocket, opts: StartConversationTurnOptions): void {
  const frame: any = {
    type: "start_turn",
    mode: opts.isNew ? "new" : "resume",
    id: opts.conversationId,
    content: opts.content,
    active_skills: appStore.getState().activeSkills,
  };
  if (opts.routing.provider) frame.provider = opts.routing.provider;
  if (opts.routing.model) frame.model = opts.routing.model;
  if (opts.isNew && opts.projectId) frame.project_id = opts.projectId;
  if (opts.isNew && opts.workspacePath) frame.workspace_path = opts.workspacePath;
  if (opts.soulPrompt) frame.soul_prompt = opts.soulPrompt;
  ws.send(JSON.stringify(frame));
}

function sendLegacyTurnFrames(ws: WebSocket, opts: StartConversationTurnOptions): void {
  const first: any = opts.isNew
    ? { type: "new", id: opts.conversationId }
    : { type: "resume", id: opts.conversationId };
  if (opts.routing.provider) first.provider = opts.routing.provider;
  if (opts.routing.model) first.model = opts.routing.model;
  if (opts.isNew && opts.projectId) first.project_id = opts.projectId;
  if (opts.isNew && opts.workspacePath) first.workspace_path = opts.workspacePath;
  ws.send(JSON.stringify(first));

  for (const name of appStore.getState().activeSkills) {
    ws.send(JSON.stringify({ type: "activate_skill", name }));
  }

  const user: any = { type: "user", content: opts.content };
  if (opts.routing.provider) user.provider = opts.routing.provider;
  if (opts.routing.model) user.model = opts.routing.model;
  if (opts.soulPrompt) user.soul_prompt = opts.soulPrompt;
  ws.send(JSON.stringify(user));
}

function isStartTurnUnsupported(message: unknown): boolean {
  return typeof message === "string" && message.includes("unknown variant `start_turn`");
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

function isTerminalFrame(frame: unknown): frame is TerminalFrame {
  const type = (frame as TerminalFrame | null)?.type;
  return type === "done" || type === "error" || type === "interrupted";
}

function captureConversationSurface(): ConversationSurfaceSnapshot {
  const s = appStore.getState();
  return {
    messages: s.messages,
    emptyHintIdShort: s.emptyHintIdShort,
    toolBlocks: s.toolBlocks,
    approvals: s.approvals,
    hitls: s.hitls,
    tasks: s.tasks,
    plan: s.plan,
    proposedPlan: s.proposedPlan,
    subAgentRuns: s.subAgentRuns,
  };
}

function rollbackStartupFailure(
  conversationId: string,
  isNew: boolean,
  startupActiveId: string | null,
  startupSurface: ConversationSurfaceSnapshot,
  message?: string,
): void {
  document.body.classList.toggle("turn-in-flight", false);
  const notFound = /^conversation `[^`]+` not found$/.test(message ?? "");
  appStore.setState((s) => {
    const runs = { ...s.conversationRuns };
    delete runs[conversationId];
    const unread = { ...s.conversationUnread };
    delete unread[conversationId];
    const surfaces = { ...s.conversationSurfaces };
    if (isNew || notFound) {
      delete surfaces[conversationId];
    } else {
      surfaces[conversationId] = startupSurface;
    }
    return {
      ...startupSurface,
      activeId: isNew || notFound ? null : startupActiveId,
      inFlight: false,
      turnStartedAt: null,
      conversationRuns: runs,
      conversationUnread: unread,
      conversationSurfaces: surfaces,
    };
  });
}

async function reconcileRequirementRun(
  runId: string,
  frame: TerminalFrame,
  verificationCommands?: string[],
): Promise<void> {
  try {
    const { updateRequirementRun, verifyRunByCommands } = await import("./requirements");
    if (frame?.type === "done") {
      const commands = (verificationCommands ?? []).map((s) => s.trim()).filter(Boolean);
      if (commands.length > 0) {
        await verifyRunByCommands(runId, commands);
      } else {
        await updateRequirementRun(runId, { status: "completed" });
      }
      return;
    }
    if (frame?.type === "interrupted") {
      await updateRequirementRun(runId, {
        status: "cancelled",
        error: "conversation interrupted",
      });
      return;
    }
    await updateRequirementRun(runId, {
      status: "failed",
      error: typeof frame?.message === "string" ? frame.message : "conversation failed",
    });
  } catch (err) {
    console.warn("requirement run terminal reconciliation failed", err);
  }
}
