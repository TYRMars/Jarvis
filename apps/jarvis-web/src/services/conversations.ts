// Conversation lifecycle. Each helper combines a REST round-trip
// (GET / DELETE / list) with a paired WS frame (`new` / `resume` /
// `reset`) so the client and server stay in lockstep. All errors
// surface through the banner; the React sidebar reads its own state
// from the store, so we just dispatch and the UI catches up.

import { appStore } from "../store/appStore";
import { confirm } from "../components/ui";
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

/// Force-refetch the persisted history for the *currently-active*
/// conversation and replace the in-memory message list. Used by the
/// stream-recovery path when the server reports `resume_error:
/// evicted` (the client has fallen further behind the in-memory
/// ring buffer than its bounds allow) or when `tail_replay_start`
/// signals a `first_seq` gap. Does NOT send a fresh `Resume` frame —
/// the caller is presumed to already be on the active conversation;
/// this is purely a history rehydrate.
///
/// Returns `false` when there is no active conversation, persistence
/// is disabled, or the fetch fails.
export async function forceReloadActiveConversation(): Promise<boolean> {
  const store = appStore.getState();
  if (!store.persistEnabled) return false;
  const id = store.activeId;
  if (!id) return false;
  try {
    const r = await fetch(apiUrl(`/v1/conversations/${encodeURIComponent(id)}`));
    if (!r.ok) return false;
    const body = await r.json();
    appStore.getState().loadHistory(body.messages || []);
    return true;
  } catch (e: any) {
    console.warn("force reload after evicted resume failed", e);
    return false;
  }
}

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
    clearSessionRoute();
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
  clearSessionRoute();
}

export async function resumeConversation(id: string): Promise<void> {
  const store = appStore.getState();
  if (store.activeId === id) {
    store.clearConversationUnread(id);
    syncSessionRoute(id);
    return;
  }
  if (store.activeId) store.saveConversationSurface(store.activeId);
  store.setLoadingConvoId(id);
  try {
    const restored = store.restoreConversationSurface(id);
    const row = store.convoRows.find((r) => r.id === id);
    hydrateBinding(row?.project_id ?? null, row?.workspace_path ?? null);
    if (!restored) {
      const r = await fetch(apiUrl(`/v1/conversations/${encodeURIComponent(id)}`));
      if (!r.ok) throw new Error(`get: ${r.status}`);
      const body = await r.json();
      // Stale-request guard: a newer resume may have switched targets while
      // this fetch was in flight (it overwrote loadingConvoId). Drop this
      // result rather than clobbering the now-active conversation.
      if (appStore.getState().loadingConvoId !== id) return;
      store.loadHistory(body.messages || []);
      hydrateBinding(body.project_id ?? null, body.workspace_path ?? null);
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
    // Stream-recovery cursor: when the client has already seen
    // events for this conversation (cached from prior live tail or
    // REST poll), ask the server to only replay events with
    // `seq > cursor`. The server may still respond with
    // `resume_error: evicted` when our cursor is older than the
    // oldest retained seq — the lifecycle handler force-reloads
    // history in that case.
    const { clientLastSeq } = await import("./chatRuns");
    // Re-check after the dynamic import await: bail if a newer resume took over.
    if (appStore.getState().loadingConvoId !== id) return;
    const cursor = clientLastSeq(id);
    if (cursor > 0) frame.after_seq = cursor;
    // Flip activeId BEFORE sending the frame so any reply
    // (including resumed/error/delta from an in-flight per-turn
    // socket for the same id) lands on the active path in
    // handleFrameForConversation, not the scoped-background path.
    store.setActiveId(id);
    store.clearConversationUnread(id);
    syncSessionRoute(id);
    if (!sendFrame(frame)) {
      store.setLoadingConvoId(null);
      return;
    }
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
  const ok = await confirm({
    title: t("deleteConfirm", id.slice(0, 8)),
    danger: true,
    confirmLabel: t("uiConfirmDeleteOk"),
  });
  if (!ok) return;
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
      clearSessionRoute();
    }
    // GC the local-only metadata so a recycled UUID doesn't inherit
    // a stale title / pin / routing from a previous conversation.
    if (store.pinned.has(id)) store.togglePin(id);
    if (store.titleOverrides[id]) store.setTitleOverride(id, null);
    if (store.convoRouting[id]) store.setConvoRoutingFor(id, null);
    store.clearConversationUnread(id);
    void refreshConvoList();
  } catch (e: any) {
    showError(t("deleteFailed", e.message));
  }
}

/// User-facing lifecycle states matching the backend
/// `ConversationLifecycle` enum. `active` is the default; `archived`
/// soft-archives (still searchable on the archive page); `abandoned`
/// is an explicit "I gave up on this" terminal that also cancels any
/// linked non-terminal RequirementRuns server-side.
export type ConversationLifecycle = "active" | "archived" | "abandoned";

/// PATCH the conversation's lifecycle. Returns the new state on
/// success. Idempotent: re-sending the same state just re-saves the
/// row.
export async function setConversationLifecycle(
  id: string,
  lifecycle: ConversationLifecycle,
): Promise<{ lifecycle: ConversationLifecycle; previous_lifecycle: ConversationLifecycle }> {
  const r = await fetch(
    apiUrl(`/v1/conversations/${encodeURIComponent(id)}/lifecycle`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`lifecycle ${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as {
    lifecycle: ConversationLifecycle;
    previous_lifecycle: ConversationLifecycle;
  };
}

/// Convenience: mark a conversation as `abandoned`. Confirms with the
/// user first because this also cancels any linked non-terminal
/// RequirementRuns. Returns true if the user confirmed and the
/// server accepted; false if cancelled or errored.
export async function abandonConversation(id: string): Promise<boolean> {
  const ok = await confirm({
    title: t("abandonConfirm", id.slice(0, 8)),
    danger: true,
    confirmLabel: t("abandon"),
  });
  if (!ok) return false;
  try {
    await setConversationLifecycle(id, "abandoned");
    void refreshConvoList();
    return true;
  } catch (e: any) {
    showError(t("abandonFailed", e?.message ?? String(e)));
    return false;
  }
}

export function sessionRoute(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

function syncSessionRoute(id: string): void {
  updateAppRoute(sessionRoute(id), "push");
}

export function clearSessionRoute(): void {
  if (typeof window === "undefined") return;
  const hashPath = hashRouterPath();
  if (hashPath?.startsWith("/sessions/")) {
    updateAppRoute("/", "replace");
    return;
  }
  if (window.location.pathname.startsWith("/sessions/")) {
    updateAppRoute("/", "replace");
  }
}

function updateAppRoute(path: string, mode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const hashPath = hashRouterPath();
  if (hashPath !== null) {
    const next = `#${path}`;
    if (window.location.hash === next) return;
    const url = `${window.location.pathname}${window.location.search}${next}`;
    if (mode === "replace") {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  if (window.location.pathname === path) return;
  if (mode === "replace") {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function hashRouterPath(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith("#/")) return null;
  const queryIdx = hash.indexOf("?");
  return queryIdx >= 0 ? hash.slice(1, queryIdx) : hash.slice(1);
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

function hydrateBinding(
  projectId: string | null,
  workspacePath: string | null,
): void {
  const store = appStore.getState();
  store.setDraftProjectId(projectId);
  const fallbackWorkspace =
    projectId ? store.projectsById[projectId]?.workspaces?.[0]?.path ?? null : null;
  store.setSocketWorkspace(workspacePath ?? fallbackWorkspace, null);
}
