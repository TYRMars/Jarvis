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

export function handleFrame(ev: any): void {
  // Fan out to React subscribers (useWebSocket consumers) before
  // the registry dispatch runs, so a component that wants to mirror
  // a frame into store-only state can do so without racing against
  // store mutations below.
  legacyDispatchFrame(ev);
  const handler = frameHandlers.get(ev.type);
  if (handler) handler(ev);
  else console.warn("unknown frame", ev);
}
