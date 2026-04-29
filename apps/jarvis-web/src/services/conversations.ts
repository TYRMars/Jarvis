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
/// session). When `opts.projectId` is set, the new conversation is
/// bound to that project so every turn re-injects its instructions
/// (see `harness-server::project_binder`). Pass `null` (the default)
/// for a free-chat session.
export function newConversation(opts: { projectId?: string | null } = {}): void {
  const store = appStore.getState();
  if (store.inFlight) {
    showError(t("turnInProgress"));
    return;
  }
  if (!store.persistEnabled) {
    if (!sendFrame({ type: "reset" })) return;
    store.clearMessages();
    store.setActiveId(null);
    return;
  }
  const frame: any = { type: "new" };
  const { provider, model } = pickedRouting();
  if (provider) frame.provider = provider;
  if (model) frame.model = model;
  if (opts.projectId) frame.project_id = opts.projectId;
  // Inherit the currently-pinned workspace so new conversations
  // persist their binding from the start. The server canonicalises
  // and validates; an invalid path errors the New handshake rather
  // than silently falling through to the binary's startup root.
  if (store.socketWorkspace) frame.workspace_path = store.socketWorkspace;
  if (!sendFrame(frame)) return;
  store.clearMessages();
}

export async function resumeConversation(id: string): Promise<void> {
  const store = appStore.getState();
  if (store.inFlight) {
    showError(t("turnInProgress"));
    return;
  }
  if (store.activeId === id) return;
  store.setLoadingConvoId(id);
  try {
    const r = await fetch(apiUrl(`/v1/conversations/${encodeURIComponent(id)}`));
    if (!r.ok) throw new Error(`get: ${r.status}`);
    const body = await r.json();
    store.loadHistory(body.messages || []);
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
  if (store.inFlight) {
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
