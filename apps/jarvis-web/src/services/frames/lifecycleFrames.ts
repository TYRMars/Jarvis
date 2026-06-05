// Per-turn lifecycle + connection-level frames. Owns the
// "convo started / resumed / done / interrupted / error" state
// machine that drives the in-flight indicator, the loading-convo
// guard, the convo list refresh, and the pending-approval /
// pending-hitl finalisation on terminal events.

import { appStore } from "../../store/appStore";
import { recordUsage } from "../usage";
import { recordUsageDaily } from "../usageCumulator";
import { applyRouting } from "../socket";
import { setInFlight, showError, showTransientStatus } from "../status";
import {
  refreshConvoList,
  clearSessionRoute,
  forceReloadActiveConversation,
} from "../conversations";
import { clientLastSeq, invalidateConversationSeq } from "../chatRuns";

const NOT_FOUND_RE = /^conversation `([^`]+)` not found$/;

export const lifecycleFrameHandlers: Record<string, (ev: any) => void> = {
  usage: (ev) => {
    // Per-turn composer badge (resets between turns).
    recordUsage(ev);
    // Long-running daily cumulator (persists across turns + reloads
    // for the WorkOverview UsagePanel).
    recordUsageDaily(ev);
  },
  tasks_snapshot: (ev) => {
    // P7: server pushes a fresh BackgroundTasksPanel snapshot at
    // every turn boundary so the panel can drop its tight 3s poll
    // and rely on push for most updates. The frontend keeps a
    // longer-interval safety poll for the panel's first-open case.
    const items: unknown = ev?.items;
    appStore
      .getState()
      .setBackgroundTasksSnapshot(Array.isArray(items) ? (items as unknown[]) : []);
  },
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
    // "conversation `<id>` not found" → the sidebar row is stale
    // (file deleted out of band, or pre-eager-persist abandoned
    // run). Drop the row and reset activeId if it pointed there
    // so the UI stops hammering a ghost id on every reload.
    const m = NOT_FOUND_RE.exec(ev.message ?? "");
    if (m) {
      const staleId = m[1];
      const store = appStore.getState();
      store.setConvoRows(store.convoRows.filter((r: any) => r.id !== staleId));
      store.clearConversationSurface(staleId);
      store.clearConversationUnread(staleId);
      if (store.activeId === staleId) {
        store.setActiveId(null);
        store.clearMessages();
        store.clearApprovals();
        store.clearHitls();
        store.clearTasks();
        store.setPlan([]);
        store.setProposedPlan(null);
        store.clearSubAgentRuns();
        clearSessionRoute();
      }
    }
    if (!isSoftError(ev.message)) {
      const store = appStore.getState();
      store.setLoadingConvoId(null);
      setInFlight(false);
      store.finalizePendingApprovals();
      store.finalizePendingHitls();
    }
  },
  started: (ev) => onStarted(ev),
  resumed: (ev) => onResumed(ev),
  configured: () => {
    showTransientStatus("configured", "connected");
  },
  workspace_changed: (ev) => {
    const path = ev.path ?? null;
    appStore.getState().setSocketWorkspace?.(path, ev.workspace ?? null);
  },
  skill_activated: (ev) => skillUpdated(ev),
  skill_deactivated: (ev) => skillUpdated(ev),
  tail_replay_start: (ev) => onTailReplayStart(ev),
  tail_replay_done: () => {
    // Pure marker: snapshot replay just finished, the WS is now in
    // live-tail mode. No store work needed — the per-event handlers
    // have already updated state as the snapshot drained.
  },
  resume_error: (ev) => onResumeError(ev),
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
  if ("project_id" in ev) {
    store.setDraftProjectId?.(ev.project_id ?? null);
  }
  if ("workspace_path" in ev) {
    const projectId = typeof ev.project_id === "string" ? ev.project_id : null;
    store.setSocketWorkspace?.(
      ev.workspace_path ?? defaultProjectWorkspace(store, projectId),
      ev.workspace ?? null,
    );
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
        workspace_path: ev.workspace_path ?? null,
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

function onResumed(ev: any): void {
  const id = ev.id as string;
  const store = appStore.getState();
  store.setLoadingConvoId(null);
  store.setActiveId(id);
  // Rehydrate the conversation's bound project / workspace so the
  // in-session execution shoulder can find the linked Requirement
  // immediately after a refresh-and-resume — without these the user
  // would see a stale or empty shoulder until they navigate elsewhere.
  if ("project_id" in ev) {
    store.setDraftProjectId?.(ev.project_id ?? null);
  }
  if ("workspace_path" in ev) {
    const projectId = typeof ev.project_id === "string" ? ev.project_id : null;
    store.setSocketWorkspace?.(
      ev.workspace_path ?? defaultProjectWorkspace(store, projectId),
      ev.workspace ?? null,
    );
  }
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

function defaultProjectWorkspace(
  store: ReturnType<typeof appStore.getState>,
  projectId: string | null,
): string | null {
  if (!projectId) return null;
  return store.projectsById?.[projectId]?.workspaces?.[0]?.path ?? null;
}

/// `tail_replay_start` precedes the snapshot of buffered frames the
/// server is about to replay on a Resume. It carries the server's
/// current `first_seq` / `latest_seq` window so the client can
/// detect whether events the client thought it had seen (cached in
/// `lastSeqByConversation`) have been silently evicted from the
/// ring. The active-conversation invariant: by the time this frame
/// arrives, the client has already sent `Resume {id}` and so the
/// id we care about is `activeId`.
///
/// Gap rule: if the server's oldest retained seq is greater than
/// `clientLastSeq + 1`, at least one event is missing. Force a
/// REST history reload and drop the seq cursor so subsequent
/// REST poll catch-ups don't filter against a stale anchor.
function onTailReplayStart(ev: any): void {
  const firstSeq = typeof ev?.first_seq === "number" ? ev.first_seq : undefined;
  if (firstSeq === undefined) return;
  const id = appStore.getState().activeId;
  if (!id) return;
  const cursor = clientLastSeq(id);
  if (firstSeq > cursor + 1) {
    invalidateConversationSeq(id);
    void forceReloadActiveConversation();
  }
}

/// `resume_error` fires when the server can't serve the requested
/// `after_seq` because the events have been evicted from the ring
/// buffer. Reason is `"evicted"` in v1. Fall back to a full REST
/// history reload — there's nothing useful the in-flight tail can
/// stream us once we've lost the prefix.
function onResumeError(ev: any): void {
  const reason = typeof ev?.reason === "string" ? ev.reason : "unknown";
  showTransientStatus(`resume gap (${reason})`, "warn");
  const id = appStore.getState().activeId;
  if (id) {
    invalidateConversationSeq(id);
    void forceReloadActiveConversation();
  }
}
