// Per-turn lifecycle + connection-level frames. Owns the
// "convo started / resumed / done / interrupted / error" state
// machine that drives the in-flight indicator, the loading-convo
// guard, the convo list refresh, and the pending-approval /
// pending-hitl finalisation on terminal events.

import { appStore } from "../../store/appStore";
import { recordUsage } from "../usage";
import { applyRouting } from "../socket";
import { setInFlight, showError, showTransientStatus } from "../status";
import { refreshConvoList } from "../conversations";

export const lifecycleFrameHandlers: Record<string, (ev: any) => void> = {
  usage: (ev) => recordUsage(ev),
  forked: (ev) => {
    appStore.getState().applyForked(ev.user_ordinal);
  },
  done: () => {
    const store = appStore.getState();
    store.setLoadingConvoId(null);
    setInFlight(false);
    store.finalizePendingApprovals();
    store.finalizePendingHitls();
  },
  interrupted: () => {
    const store = appStore.getState();
    store.setLoadingConvoId(null);
    setInFlight(false);
    store.finalizePendingApprovals();
    store.finalizePendingHitls();
    showTransientStatus("interrupted", "warn");
  },
  error: (ev) => {
    // Two flavours of `error` come down this channel:
    //  1. Terminal — the agent loop bailed, the turn is over.
    //  2. Soft — the server rejected a *frame* (e.g. the user
    //     fired a second `user` while a turn was in progress, or
    //     `approve` for an unknown id). Treating soft rejections
    //     as terminal would cancel the still-running turn's
    //     indicator and let the user spam-send again.
    // We can't perfectly tell them apart from the wire, but the
    // soft errors all carry recognisable prefixes; everything
    // else is treated as terminal.
    showError(ev.message);
    if (!isSoftError(ev.message)) {
      const store = appStore.getState();
      store.setLoadingConvoId(null);
      setInFlight(false);
      store.finalizePendingApprovals();
      store.finalizePendingHitls();
    }
  },
  started: (ev) => onStarted(ev),
  resumed: (ev) => onResumed(ev.id, ev.message_count),
  configured: () => {
    showTransientStatus("configured", "connected");
  },
  workspace_changed: (ev) => {
    const path = ev.path ?? null;
    appStore.getState().setSocketWorkspace?.(path, ev.workspace ?? null);
  },
  skill_activated: (ev) => skillUpdated(ev),
  skill_deactivated: (ev) => skillUpdated(ev),
};

function skillUpdated(ev: any): void {
  const active = ev.active ?? [];
  appStore.getState().setActiveSkills?.(active);
}

/// Recognisable prefixes for server frame-rejection errors that
/// should NOT terminate the turn. The server emits these via
/// `send_error()` in `routes.rs`; we keep the prefixes loose
/// because a future tweak to the message text shouldn't silently
/// flip behaviour.
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

function onStarted(ev: any): void {
  const id = ev.id as string;
  const store = appStore.getState();
  store.setLoadingConvoId(null);
  store.setActiveId(id);
  if (typeof ev.workspace_path === "string") {
    store.setSocketWorkspace?.(ev.workspace_path, ev.workspace ?? null);
  }
  if (typeof ev.project_id === "string") {
    store.setDraftProjectId?.(ev.project_id);
  }
  // Brand-new conversation — pin the current routing so a future
  // resume restores the same model+provider it started under.
  if (store.routing && store.convoRouting[id] !== store.routing) {
    store.setConvoRoutingFor(id, store.routing);
  }
  // Optimistically prepend a stub row so the user sees the new
  // conversation in the rail immediately, without waiting for the
  // network round-trip. The async `refreshConvoList` below replaces
  // this stub with the authoritative server row.
  const rows = store.convoRows;
  if (!rows.some((r: any) => r.id === id)) {
    const now = new Date().toISOString();
    store.setConvoRows([
      {
        id,
        title: null,
        message_count: 0,
        created_at: now,
        updated_at: now,
        project_id: ev.project_id ?? null,
      },
      ...rows,
    ]);
  }
  if (store.messages.length === 0) {
    store.showEmptyHint(id.slice(0, 8));
  }
  document.getElementById("input")?.focus();
  void refreshConvoList();
}

function onResumed(id: string, _count: number): void {
  const store = appStore.getState();
  store.setLoadingConvoId(null);
  store.setActiveId(id);
  // Restore this conversation's saved routing when the catalog still
  // contains it. Stale entries (provider removed, option gone) are
  // dropped silently — the global default takes over rather than
  // shipping a frame the server would reject.
  const saved = store.convoRouting[id];
  const known = store.providers.some((p) =>
    [p.default_model, ...p.models].some((m) => `${p.name}|${m}` === saved),
  );
  if (saved && known && saved !== store.routing) {
    store.setRouting(saved);
    applyRouting({ reconnectOnDefault: true });
  } else if (saved && !known) {
    store.setConvoRoutingFor(id, null);
  } else if (!saved && store.routing) {
    // No record yet: pin the current routing so future resumes
    // restore it.
    store.setConvoRoutingFor(id, store.routing);
  }
}
