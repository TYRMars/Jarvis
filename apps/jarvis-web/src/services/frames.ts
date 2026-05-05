// Server → client frame router. Owns the dispatch from the WS
// `message` event into store actions + side-effects (focus, body
// classes, transient status banners). Pure store mutation — no DOM
// surgery; React components own their own renders.
//
// Per-domain handler logic lives under `./frames/` (messageFrames,
// toolFrames, approvalFrames, planFrames, hitlFrames,
// lifecycleFrames, domainFrames). This file only routes.

import { legacyDispatchFrame } from "../hooks/useWebSocket";
import { frameHandlers } from "./frames/index";
import { appStore } from "../store/appStore";

export function handleFrame(ev: any): void {
  handleFrameForConversation(null, ev);
}

export function handleFrameForConversation(conversationId: string | null, ev: any): void {
  if (conversationId) {
    applyConversationRunHint(conversationId, ev);
  }
  if (conversationId && appStore.getState().activeId !== conversationId) {
    handleScopedFrame(conversationId, ev);
    return;
  }
  // Fan out to React subscribers (useWebSocket consumers) before
  // the registry dispatch runs, so a component that wants to mirror
  // a frame into store-only state can do so without racing against
  // store mutations below.
  legacyDispatchFrame(ev);
  const handler = frameHandlers.get(ev.type);
  if (handler) handler(ev);
  else console.warn("unknown frame", ev);
  if (conversationId) {
    applyConversationRunHint(conversationId, ev);
  }
}

function handleScopedFrame(conversationId: string, ev: any): void {
  const before = appStore.getState().activeId;
  const store = appStore.getState();
  if (before) store.saveConversationSurface(before);
  const hadSurface = store.restoreConversationSurface(conversationId);
  if (!hadSurface) {
    // Seed an empty surface so live frames have somewhere isolated
    // to land. The terminal `done` path refreshes persisted history
    // through the conversation list; when the user opens this
    // conversation later, `resumeConversation` can still hydrate the
    // full snapshot if needed.
    store.clearMessages();
    store.clearApprovals();
    store.clearHitls();
    store.clearTasks();
    store.setPlan([]);
    store.setProposedPlan(null);
    store.clearSubAgentRuns();
  }
  appStore.getState().setActiveId(conversationId);

  legacyDispatchFrame(ev);
  const handler = frameHandlers.get(ev.type);
  if (handler) handler(ev);
  else console.warn("unknown frame", ev);

  applyConversationRunHint(conversationId, ev);
  appStore.getState().saveConversationSurface(conversationId);
  if (before && before !== conversationId) {
    appStore.getState().restoreConversationSurface(before);
  }
  appStore.getState().setActiveId(before);
  const activeRunning = before
    ? appStore.getState().isConversationRunning(before)
    : false;
  appStore.getState().setInFlight(activeRunning);
}

function applyConversationRunHint(conversationId: string, ev: any): void {
  const store = appStore.getState();
  switch (ev?.type) {
    case "tool_start":
      store.setConversationRunStatus(conversationId, "running", {
        currentTool: typeof ev.name === "string" ? ev.name : null,
      });
      break;
    case "approval_request":
      store.setConversationRunStatus(conversationId, "waiting_approval");
      break;
    case "hitl_request":
      store.setConversationRunStatus(conversationId, "waiting_hitl");
      break;
    case "delta":
    case "assistant_message":
    case "tool_end":
    case "approval_decision":
    case "hitl_response":
      store.setConversationRunStatus(conversationId, "running");
      break;
    case "done":
      store.setConversationRunStatus(conversationId, "completed");
      break;
    case "interrupted":
      store.setConversationRunStatus(conversationId, "cancelled");
      break;
    case "error":
      if (!isSoftError(ev.message)) {
        store.setConversationRunStatus(conversationId, "failed", {
          lastError: ev.message ?? "error",
        });
      }
      break;
  }
}

function isSoftError(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    msg.startsWith("turn already in progress") ||
    msg.startsWith("turn in progress") ||
    msg.startsWith("no pending approval") ||
    msg.startsWith("bad client message") ||
    msg.startsWith("binary frames not supported")
  );
}
