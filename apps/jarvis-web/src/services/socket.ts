// Single-tenant WebSocket client. Owns the live connection, tracks
// reconnection intent + backoff, exposes `sendFrame` so other modules
// can ship `ClientFrame`s without touching the raw socket.
//
// **Auto-reconnect contract.** When the socket closes unexpectedly we
// enter a backoff loop:
//
//   attempt 1 → wait 1s   (+ jitter)
//   attempt 2 → wait 2s
//   ...
//   attempt N → min(30s, 2^(N-1) seconds)
//
// Each attempt updates the status badge ("reconnecting (N)…") so
// the user can see we're actively trying. Exponential backoff stops
// us hammering a bouncing server. We listen to `navigator.onLine` /
// `online` events and re-attempt immediately when connectivity comes
// back instead of waiting out the full backoff.
//
// On successful reopen we:
//   1. reset in-flight (a turn that was running when the socket
//      dropped is gone — server can't stream into a dead socket);
//   2. re-apply the user's routing pick (`configure` frame);
//   3. if there was an `activeId`, send a fresh `resume {id}` so the
//      conversation state matches the persisted one.
//
// Frame routing (`handleFrame`) lives in `services/frames.ts`;
// `connect()` wires it as the `message` listener.

import { wsUrl } from "./api";
import { setStatus, setInFlight } from "./status";
import { handleFrame } from "./frames";
import { appStore } from "../store/appStore";
import { showError } from "./status";
import { t } from "../utils/i18n";

let socket: WebSocket | null = null;
let shouldReconnect = true;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/// Was the previous open ever-successful? Used to distinguish "never
/// connected" (probably a config / boot issue → log loud) from "we
/// were online a moment ago" (network blip → quiet retry).
let everConnected = false;

/// Cap on the exponential delay. 30 s is short enough that a bored
/// user doesn't think the app is dead, long enough that a flapping
/// server isn't getting hammered.
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/// Compute the delay before retry attempt `n` (1-indexed). Jitter is
/// ±20 % so a fleet of clients doesn't synchronise their reconnect
/// volleys at the same wall-clock instant.
function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.floor(base + jitter));
}

function clearReconnectTimer(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!shouldReconnect) return;
  clearReconnectTimer();
  reconnectAttempt += 1;
  const delay = backoffMs(reconnectAttempt);
  // Render "reconnecting (N) in 4s..." so the user sees we're alive.
  appStore.getState().setStatus("reconnecting", "warn");
  appStore.getState().setReconnectAttempt?.(reconnectAttempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/// Open the socket if it isn't already. Idempotent — calls during a
/// live connection are no-ops; calls during a `CLOSING` cycle wait
/// for the close to land before opening a fresh one (the next tick's
/// `close` listener triggers `scheduleReconnect`).
export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  shouldReconnect = true;
  clearReconnectTimer();

  const ws = new WebSocket(wsUrl());
  socket = ws;
  // Distinguish first-attempt vs reconnect for the badge text.
  if (reconnectAttempt === 0) setStatus("connecting");
  else setStatus("reconnecting", "warn");

  ws.addEventListener("open", () => {
    everConnected = true;
    reconnectAttempt = 0;
    appStore.getState().setReconnectAttempt?.(0);
    setStatus("connected", "connected");
    // The server can't stream into a socket that's gone; whatever
    // turn was in flight when we dropped is over from the client's
    // perspective. Reset so the composer's Send button isn't stuck.
    setInFlight(false);

    // Re-apply the user's routing first (server starts on its own
    // default after reconnect — same as initial open).
    applyRouting({ reconnectOnDefault: false });

    // If we had an active conversation when the socket dropped,
    // ask the server to resume it so subsequent user turns land
    // in the right thread. We import lazily to avoid the
    // socket/conversations cyclic dependency at module-eval time.
    const activeId = appStore.getState().activeId;
    if (activeId) {
      void import("./conversations").then(({ resumeConversation }) => {
        // resumeConversation is a no-op if `activeId === id` already
        // — we transiently null the activeId so the resume frame
        // actually goes out.
        const store = appStore.getState();
        store.setActiveId(null);
        void resumeConversation(activeId);
      });
    }
  });

  ws.addEventListener("close", () => {
    setInFlight(false);
    if (shouldReconnect) {
      scheduleReconnect();
    } else {
      setStatus("disconnected", "error");
    }
  });

  ws.addEventListener("error", () => {
    // Don't update status here — the close event always follows and
    // will set the right state. Just log noisily on the very first
    // failed attempt so config / boot issues are obvious in DevTools.
    if (!everConnected && reconnectAttempt === 0) {
      console.warn("WebSocket error on initial connect — check the server");
    }
  });

  ws.addEventListener("message", (e) => {
    let frame: any;
    try {
      frame = JSON.parse(e.data);
    } catch (err) {
      console.error("bad frame", err, e.data);
      return;
    }
    handleFrame(frame);
  });
}

/// Tear down the live socket and wait a beat before reopening. Used
/// when the user picks the "server default" routing so the new
/// socket negotiates against the server's idea of the default
/// instead of carrying the previous turn's sticky pick. Also exposed
/// as the "Reconnect now" button on the connection-status badge so
/// users can short-circuit backoff.
export function reconnectSocket(): void {
  clearReconnectTimer();
  reconnectAttempt = 0;
  appStore.getState().setReconnectAttempt?.(0);
  if (socket && socket.readyState <= WebSocket.OPEN) {
    shouldReconnect = false;
    socket.close();
  }
  socket = null;
  setTimeout(() => {
    shouldReconnect = true;
    connect();
  }, 50);
}

/// Send a JSON frame over the live socket. Returns `false` (and
/// surfaces a banner) when the socket isn't open, so callers can
/// short-circuit without nesting null checks.
export function sendFrame(obj: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showError(t("websocketNotConnected"));
    return false;
  }
  socket.send(JSON.stringify(obj));
  return true;
}

/// Returns true when a user-initiated frame can ride the live socket
/// right now. Used by callers that want to gate UI without taking
/// the banner side-effect of `sendFrame`.
export function isOpen(): boolean {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

/// Read the store's current routing and split it into the
/// `{ provider, model }` shape the WS `user` / `resume` / `fork`
/// frames expect. `""` (server default) → both null, which means
/// "let the server pick".
export function pickedRouting(): { provider: string | null; model: string | null } {
  const v = appStore.getState().routing;
  if (!v) return { provider: null, model: null };
  const idx = v.indexOf("|");
  if (idx < 0) return { provider: v, model: null };
  return { provider: v.slice(0, idx) || null, model: v.slice(idx + 1) || null };
}

/// Send a `configure` frame carrying the store's current routing,
/// or — when the user has picked the empty "server default" — drop
/// the live socket and reconnect so the server picks its default
/// fresh. No-op while a turn is in flight (the server rejects mid-
/// turn `configure` anyway).
export function applyRouting(opts: { reconnectOnDefault?: boolean } = {}): void {
  if (!isOpen() || appStore.getState().inFlight) return;
  const { provider, model } = pickedRouting();
  if (!provider && !model) {
    if (opts.reconnectOnDefault) reconnectSocket();
    return;
  }
  const frame: any = { type: "configure" };
  if (provider) frame.provider = provider;
  if (model) frame.model = model;
  sendFrame(frame);
}

/// Update the store's `routing` and immediately push a `configure`
/// frame (or reconnect if the user picked the empty "server default").
/// One-stop entry for the model picker.
export function selectModel(value: string): void {
  appStore.getState().setRouting(value);
  applyRouting({ reconnectOnDefault: true });
}

/// Ask the server to abort the current turn. No-op when nothing is
/// in flight — the server would reject a stray interrupt anyway.
export function requestInterrupt(): void {
  if (!appStore.getState().inFlight) return;
  sendFrame({ type: "interrupt" });
}

/// Wire up `online` / `offline` listeners so we react to network
/// changes without waiting for the next backoff tick. Called once
/// from the boot module.
export function installConnectivityListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => {
    // Only fast-path if we're currently in the backoff loop.
    if (reconnectTimer != null) {
      clearReconnectTimer();
      reconnectAttempt = 0;
      appStore.getState().setReconnectAttempt?.(0);
      connect();
    }
  });
  window.addEventListener("offline", () => {
    // Don't actively close — the WS will detect on its own and the
    // close listener will start backoff. We just update the badge
    // so the user sees a clear reason.
    appStore.getState().setStatus("offline", "error");
  });
  // Some browsers (Firefox in particular) drop WS quietly on tab
  // suspend + resume. Re-test the connection on `pageshow` /
  // `visibilitychange` so we recover faster than the next ping.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !isOpen() && reconnectTimer != null) {
      clearReconnectTimer();
      connect();
    }
  });
}
