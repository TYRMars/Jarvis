// Aggregated frame-handler registry. Per-domain modules each export
// a `Record<string, handler>`; we merge them once at module init
// into a `Map<string, handler>` keyed by frame `type`. The router
// in `services/frames.ts` does a single `Map.get` lookup per frame.
//
// Keep frame names unique across domains — two handlers under the
// same key would collide silently (last-one-wins via `...spread`).

import { messageFrameHandlers } from "./messageFrames";
import { toolFrameHandlers } from "./toolFrames";
import { approvalFrameHandlers } from "./approvalFrames";
import { planFrameHandlers } from "./planFrames";
import { subAgentFrameHandlers } from "./subAgentFrames";
import { hitlFrameHandlers } from "./hitlFrames";
import { lifecycleFrameHandlers } from "./lifecycleFrames";
import { domainFrameHandlers } from "./domainFrames";

export const frameHandlers: Map<string, (ev: any) => void> = new Map(
  Object.entries({
    ...messageFrameHandlers,
    ...toolFrameHandlers,
    ...approvalFrameHandlers,
    ...planFrameHandlers,
    ...subAgentFrameHandlers,
    ...hitlFrameHandlers,
    ...lifecycleFrameHandlers,
    ...domainFrameHandlers,
  }),
);
