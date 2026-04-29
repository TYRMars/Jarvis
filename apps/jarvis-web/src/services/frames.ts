// Server → client frame router. Owns the dispatch from the WS
// `message` event into store actions + side-effects (focus, body
// classes, transient status banners). Pure store mutation — no DOM
// surgery; React components own their own renders.

import { appStore } from "../store/appStore";
import { recordUsage } from "./usage";
import { legacyDispatchFrame } from "../hooks/useWebSocket";
import { applyRouting } from "./socket";
import { setInFlight, showError, showTransientStatus } from "./status";
import { refreshConvoList } from "./conversations";

export function handleFrame(ev: any): void {
  // Fan out to React subscribers (useWebSocket consumers) before
  // the imperative switch runs, so a component that wants to mirror
  // a frame into store-only state can do so without racing against
  // store mutations below.
  legacyDispatchFrame(ev);
  const store = appStore.getState();
  switch (ev.type) {
    case "delta":
      store.appendDelta(ev.content);
      break;
    case "assistant_message":
      if (ev.message) store.finalizeAssistant(ev.message);
      break;
    case "tool_start":
      if (typeof ev.name === "string" && ev.name.startsWith("ask.")) break;
      store.upsertTask({ id: ev.id, name: ev.name, args: ev.arguments, status: "running" });
      store.pushToolStart(ev.id, ev.name, ev.arguments);
      break;
    case "tool_progress":
      store.appendToolProgress(ev.id, ev.stream, ev.chunk);
      break;
    case "tool_end":
      onToolEnd(ev);
      break;
    case "plan_update":
      // Replace, not patch — the agent always sends the full snapshot.
      store.setPlan(Array.isArray(ev.items) ? ev.items : []);
      break;
    case "approval_request":
      store.pushApprovalRequest(ev.id, ev.name, ev.arguments);
      break;
    case "approval_decision":
      store.setApprovalDecision(
        ev.id,
        ev.decision.decision,
        ev.decision.reason ?? null,
        // Older servers (or builds without the permission store
        // wired up) omit `source`. Pass it through verbatim — the
        // store ignores `null` / `undefined` values cleanly.
        ev.source ?? null,
      );
      break;
    case "hitl_request":
      if (ev.request) store.pushHitlRequest(ev.request);
      break;
    case "hitl_response":
      if (ev.response) store.setHitlResponse(ev.response);
      break;
    case "usage":
      recordUsage(ev);
      break;
    case "interrupted":
      store.setLoadingConvoId(null);
      setInFlight(false);
      store.finalizePendingApprovals();
      store.finalizePendingHitls();
      showTransientStatus("interrupted", "warn");
      break;
    case "forked":
      store.applyForked(ev.user_ordinal);
      break;
    case "done":
      store.setLoadingConvoId(null);
      setInFlight(false);
      store.finalizePendingApprovals();
      store.finalizePendingHitls();
      break;
    case "error":
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
        store.setLoadingConvoId(null);
        setInFlight(false);
        store.finalizePendingApprovals();
        store.finalizePendingHitls();
      }
      break;
    case "started":
      onStarted(ev);
      break;
    case "resumed":
      onResumed(ev.id, ev.message_count);
      break;
    case "configured":
      showTransientStatus("configured", "connected");
      break;
    case "reset":
      store.setPlan([]);
      break;
    // ---- Permission-mode frames (server-side, see harness-server::routes) ----
    // The mode badge / plan card / audit timeline live in components
    // we'll wire next; for now we just stash the mode + remember the
    // proposed plan so the chrome doesn't log "unknown frame" noise.
    case "permission_mode":
      store.setPermissionMode(ev.mode ?? "ask");
      break;
    case "permission_rules_changed":
      // Trigger any subscribed surface (Settings/Permissions) to refetch.
      store.bumpPermissionRulesVersion?.();
      break;
    case "plan_proposed":
      store.setProposedPlan(ev.plan ?? "");
      break;
    case "skill_activated":
    case "skill_deactivated": {
      const active = ev.active ?? [];
      store.setActiveSkills?.(active);
      break;
    }
    case "workspace_changed": {
      const path = ev.path ?? null;
      store.setSocketWorkspace?.(path, ev.workspace ?? null);
      break;
    }
    default:
      console.warn("unknown frame", ev);
  }
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

function onToolEnd(ev: any): void {
  const store = appStore.getState();
  const block = store.toolBlocks[ev.id];
  store.setToolEnd(ev.id, ev.content);
  if (!block) return;
  const denied = ev.content.startsWith("tool denied:");
  const failed = ev.content.startsWith("tool error:");
  const status = denied ? "denied" : failed ? "error" : "ok";
  store.upsertTask({ id: ev.id, name: block.name, args: block.args, status });
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
