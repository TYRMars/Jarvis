// Typed access to the singleton WebSocket connection. Routing,
// reconnection, and frame fan-out all live in `services/socket.ts`
// + `services/frames.ts`. This hook is the React-side adapter:
//
//   - read connection status from the store
//   - call `send()` against the live socket
//   - subscribe to specific server frames via `useFrame()`
//
// `legacyDispatchFrame` is what `services/frames.ts::handleFrame`
// calls when it wants React subscribers to also see the frame.

import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import type { ClientFrame, ServerFrame, ConnectionStatus } from "../types/frames";
import { sendFrame } from "../services/socket";

type FrameListener = (frame: ServerFrame) => void;
const listeners = new Set<FrameListener>();

/// Called by `services/frames.ts::handleFrame` for every server
/// frame so React subscribers fan out alongside store dispatches.
export function legacyDispatchFrame(frame: ServerFrame) {
  for (const fn of listeners) fn(frame);
}

/// Subscribe to every server frame. Returns the typed snapshot of
/// connection status; call `send` to push a typed client frame
/// across the WS.
export function useWebSocket(onFrame?: FrameListener): {
  status: ConnectionStatus;
  send: (frame: ClientFrame) => boolean;
} {
  const status = useAppStore((s) => s.connection);
  const handlerRef = useRef(onFrame);
  handlerRef.current = onFrame;

  useEffect(() => {
    if (!handlerRef.current) return;
    const h = (f: ServerFrame) => handlerRef.current?.(f);
    listeners.add(h);
    return () => { listeners.delete(h); };
  }, []);

  return {
    status,
    send: (frame) => sendFrame(frame),
  };
}
