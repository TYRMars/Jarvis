// Human-in-the-loop frames. `hitl_request` adds a pending question
// card; `hitl_response` resolves it with the user's answer.

import { appStore } from "../../store/appStore";

export const hitlFrameHandlers: Record<string, (ev: any) => void> = {
  hitl_request: (ev) => {
    if (ev.request) appStore.getState().pushHitlRequest(ev.request);
  },
  hitl_response: (ev) => {
    if (ev.response) appStore.getState().setHitlResponse(ev.response);
  },
};
