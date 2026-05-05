// Conversation lifecycle. Each helper combines a REST round-trip
// (GET / DELETE / list) with a paired WS frame (`new` / `resume` /
// `reset`) so the client and server stay in lockstep. All errors
// surface through the banner; the React sidebar reads its own state
// from the store, so we just dispatch and the UI catches up.

import { appStore } from "../store/appStore";
import { t } from "../utils/i18n";
import { apiUrl } from "./api";
import { sendFrame } from "./socket";
import { showError } from "./status";

/// Monotonic sequence guarding `refreshConvoList` against
/// out-of-order responses — only the latest fetch is allowed to
/// mutate the store. A user clicking through three conversations
/// rapidly otherwise risks the rail rendering the *first* fetch's
/// result last.
let convoListSeq = 0;

export async function refreshConvoList(): Promise<void> {
  if (!appStore.getState().persistEnabled) return;
  const mySeq = ++convoListSeq;
  appStore.getState().setConvoListLoading(true);
  try {
    const filter = appStore.getState().activeProjectFilter;
    const url = filter
      ? `/v1/conversations?limit=50&project_id=${encodeURIComponent(filter)}`
      : "/v1/conversations?limit=50";
    const r = await fetch(apiUrl(url));
    if (mySeq !== convoListSeq) return; // newer fetch superseded us
    if (r.status === 503) {
      appStore.getState().setPersistEnabled(false);
      appStore.getState().setConvoListLoading(false);
      return;
    }
    if (!r.ok) throw new Error(`list: ${r.status}`);
    const rows = await r.json();
    if (mySeq !== convoListSeq) return;
    appStore.getState().setConvoRows(rows);
  } catch (e: any) {
    if (mySeq !== convoListSeq) return;
    console.warn("conversation list fetch failed", e);
    appStore.getState().setConvoListLoading(false);
    showError(t("listFailed", e.message));
  }
}

/// Open a fresh persisted session (or reset the in-memory free-chat
/// session).
///
/// - `opts.projectId` binds the new conversation to a Project (its
///   `instructions` get re-injected as a system message every turn).
///   `null` / unset = free chat.
/// - `opts.workspacePath` pins this socket's filesystem root and
///   records the binding in the workspaces ledger. `null` /
///   undefined defaults to the currently-pinned `socketWorkspace`
///   (so callers without a picker still inherit). Pass an empty
///   string or explicit `null` to force "no workspace".
export function newConversation(
  opts: { projectId?: string | null; workspacePath?: string | null } = {},
): void {
  const store = appStore.getState();
  if (store.activeId) store.saveConversationSurface(store.activeId);
  if (!store.persistEnabled) {
    if (!sendFrame({ type: "reset" })) return;
    store.clearMessages();
    store.setActiveId(null);
    return;
  }
  store.clearMessages();
  store.clearApprovals();
  store.clearHitls();
  store.clearTasks();
  store.setPlan([]);
  store.setProposedPlan(null);
  store.clearSubAgentRuns();
  if (opts.projectId !== undefined) store.setDraftProjectId(opts.projectId);
  if (opts.workspacePath !== undefined) {
    store.setDraftWorkspace(opts.workspacePath, null);
  }
  store.setActiveId(null);
}

export async function resumeConversation(id: string): Promise<void> {
  const store = appStore.getState();
  if (store.activeId === id) return;
  if (store.activeId) store.saveConversationSurface(store.activeId);
  store.setLoadingConvoId(id);
  try {
    const restored = store.restoreConversationSurface(id);
    if (!restored) {
      const r = await fetch(apiUrl(`/v1/conversations/${encodeURIComponent(id)}`));
      if (!r.ok) throw new Error(`get: ${r.status}`);
      const body = await r.json();
      store.loadHistory(body.messages || []);
      store.saveConversationSurface(id);
    }
    // Restore this conversation's saved provider+model first so the
    // resume frame ships the right routing on the same WS turn.
    const saved = store.convoRouting[id];
    const known = store.providers.some((p) =>
      [p.default_model, ...p.models].some((m) => `${p.name}|${m}` === saved),
    );
    if (saved && known && saved !== store.routing) {
      store.setRouting(saved);
    }
    const frame: any = { type: "resume", id };
    const { provider, model } = pickedRouting();
    if (provider) frame.provider = provider;
    if (model) frame.model = model;
    if (!sendFrame(frame)) {
      store.setLoadingConvoId(null);
      return;
    }
    store.setActiveId(id);
  } catch (e: any) {
    store.setLoadingConvoId(null);
    showError(t("resumeFailed", e.message));
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const store = appStore.getState();
  if (store.isConversationRunning(id)) {
    showError(t("turnInProgress"));
    return;
  }
  if (!confirm(t("deleteConfirm", id.slice(0, 8)))) return;
  try {
    const r = await fetch(
      apiUrl(`/v1/conversations/${encodeURIComponent(id)}`),
      { method: "DELETE" },
    );
    if (!r.ok && r.status !== 404) throw new Error(`delete: ${r.status}`);
    if (store.activeId === id) {
      store.clearMessages();
      store.setActiveId(null);
      sendFrame({ type: "reset" });
    }
    // GC the local-only metadata so a recycled UUID doesn't inherit
    // a stale title / pin / routing from a previous conversation.
    if (store.pinned.has(id)) store.togglePin(id);
    if (store.titleOverrides[id]) store.setTitleOverride(id, null);
    if (store.convoRouting[id]) store.setConvoRoutingFor(id, null);
    void refreshConvoList();
  } catch (e: any) {
    showError(t("deleteFailed", e.message));
  }
}

/// Read the current routing off the store and split into the
/// `{ provider, model }` shape the WS frame expects. `""` (server
/// default) → both null.
function pickedRouting(): { provider: string | null; model: string | null } {
  const v = appStore.getState().routing;
  if (!v) return { provider: null, model: null };
  const idx = v.indexOf("|");
  if (idx < 0) return { provider: v, model: null };
  return { provider: v.slice(0, idx) || null, model: v.slice(idx + 1) || null };
}
