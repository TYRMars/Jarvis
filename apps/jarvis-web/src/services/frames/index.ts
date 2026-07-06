// Aggregated frame-handler registry. Per-domain modules each export
// a `Record<string, handler>`; we merge them once at module init
// into a `Map<string, handler>` keyed by frame `type`. The router
// in `services/frames.ts` does a single `Map.get` lookup per frame.
//
// Some frame types are legitimately handled by more than one domain
// — e.g. `reset` must both clear the working plan (planFrames) and
// purge the memory-compaction markers (memoryFrames). A plain
// `...spread` merge would silently keep only the last handler under
// each key (last-one-wins), dropping the others. Instead we COMBINE
// handlers sharing a key into a single fan-out that invokes each in
// registration order, so no domain's side-effect is lost.

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

// Merge per-domain records into one `Map<type, handler>`, combining any
// handlers that share a frame `type` into a single handler that fans out to
// each (in registration order) rather than silently overwriting.
function mergeFrameHandlers(
  modules: ReadonlyArray<Record<string, FrameHandler>>,
): Map<string, FrameHandler> {
  const buckets = new Map<string, FrameHandler[]>();
  for (const mod of modules) {
    for (const [type, handler] of Object.entries(mod)) {
      const existing = buckets.get(type);
      if (existing) existing.push(handler);
      else buckets.set(type, [handler]);
    }
  }

  const merged = new Map<string, FrameHandler>();
  for (const [type, handlers] of buckets) {
    merged.set(
      type,
      handlers.length === 1
        ? handlers[0]
        : (ev) => {
            for (const handler of handlers) handler(ev);
          },
    );
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
