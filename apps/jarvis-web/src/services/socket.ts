// Single-tenant WebSocket client. Owns the live connection, tracks
// reconnection intent, and exposes `sendFrame` so other modules can
// ship `ClientFrame`s without touching the raw socket. The legacy
// state singleton no longer carries `state.ws` — this module is the
// source of truth.
//
// Frame routing (`handleFrame`) lives in `services/frames.ts`;
// `connect()` wires it as the `message` listener.

import { wsUrl } from "./api";
import { setStatus, setInFlight, showError } from "./status";
import { handleFrame } from "./frames";
import { appStore } from "../store/appStore";
import { t } from "../utils/i18n";

let socket: WebSocket | null = null;
let shouldReconnect = true;

/// Open the socket if it isn't already. Idempotent — calls during a
/// live connection are no-ops; calls during a `CLOSING` cycle wait
/// for the close to land before opening a fresh one.
export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  shouldReconnect = true;
  const ws = new WebSocket(wsUrl());
  socket = ws;
  setStatus("connecting");

  ws.addEventListener("open", () => {
    setStatus("connected", "connected");
    // Push the user's saved routing as soon as the socket opens so
    // the *first* `user` frame doesn't ride the server's default.
    applyRouting({ reconnectOnDefault: false });
  });
  ws.addEventListener("close", () => {
    setStatus("disconnected", "error");
    setInFlight(false);
    if (shouldReconnect) setTimeout(connect, 1000);
  });
  ws.addEventListener("error", () => setStatus("websocketError", "error"));
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
/// instead of carrying the previous turn's sticky pick.
export function reconnectSocket(): void {
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
