// Streaming-text frames. The agent loop emits a sequence of `delta`
// events while the model is producing output, then a single
// `assistant_message` once the iteration finalises (with the
// authoritative full text + reasoning + tool calls).

import { appStore } from "../../store/appStore";

export const messageFrameHandlers: Record<string, (ev: any) => void> = {
  delta: (ev) => {
    appStore.getState().appendDelta(ev.content);
  },
  assistant_message: (ev) => {
    if (ev.message) appStore.getState().finalizeAssistant(ev.message);
  },
};
