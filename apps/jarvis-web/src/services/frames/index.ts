// Aggregated frame-handler registry. Per-domain modules each export
// a `Record<string, handler>`; we merge them once at module init
// into a `Map<string, handler>` keyed by frame `type`. The router
// in `services/frames.ts` does a single `Map.get` lookup per frame.
//
// When two domains register a handler under the same key (e.g. both
// plan and memory frames clear their own state on `reset`), we
// *compose* them into one handler that fans the frame to every
// registrant in registration order — so no domain's handler is
// silently dropped. (The previous `...spread` merge kept only the
// last one, which shadowed planFrames' `reset` behind memoryFrames'
// — see issue #361.)

import { messageFrameHandlers } from "./messageFrames";
import { toolFrameHandlers } from "./toolFrames";
import { approvalFrameHandlers } from "./approvalFrames";
import { planFrameHandlers } from "./planFrames";
import { subAgentFrameHandlers } from "./subAgentFrames";
import { hitlFrameHandlers } from "./hitlFrames";
import { lifecycleFrameHandlers } from "./lifecycleFrames";
import { domainFrameHandlers } from "./domainFrames";
import { fallbackFrameHandlers } from "./fallbackFrames";
import { memoryFrameHandlers } from "./memoryFrames";

type FrameHandler = (ev: any) => void;

/**
 * Merge per-domain handler records into one map. On a key collision, compose
 * the handlers so both run (in registration order) instead of the later one
 * silently overwriting the earlier.
 */
function mergeFrameHandlers(
  modules: Record<string, FrameHandler>[],
): Map<string, FrameHandler> {
  const merged = new Map<string, FrameHandler>();
  for (const mod of modules) {
    for (const [key, handler] of Object.entries(mod)) {
      const existing = merged.get(key);
      merged.set(
        key,
        existing
          ? (ev) => {
              existing(ev);
              handler(ev);
            }
          : handler,
      );
    }
  }
  return merged;
}

export const frameHandlers: Map<string, FrameHandler> = mergeFrameHandlers([
  messageFrameHandlers,
  toolFrameHandlers,
  approvalFrameHandlers,
  planFrameHandlers,
  subAgentFrameHandlers,
  hitlFrameHandlers,
  lifecycleFrameHandlers,
  fallbackFrameHandlers,
  memoryFrameHandlers,
  domainFrameHandlers,
]);
