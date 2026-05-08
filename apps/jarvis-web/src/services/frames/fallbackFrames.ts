// Provider-fallback frames. The agent loop emits one
// `provider_fallback` event per chain hop when the active LLM
// provider returns 429 / 5xx / timeout and the harness routes the
// retry to the next entry in `policy.fallbacks`. The chat header /
// inline banner reads the latest entry to surface "fell back from
// X to Y" to the operator.

import { appStore } from "../../store/appStore";

interface ProviderFallbackFrame {
  type: "provider_fallback";
  event: {
    from: string;
    to: string;
    model: string;
    reason: string;
    streaming: boolean;
  };
}

export const fallbackFrameHandlers: Record<string, (ev: any) => void> = {
  provider_fallback: (ev: ProviderFallbackFrame) => {
    const e = ev.event;
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") {
      return;
    }
    appStore.getState().appendFallback({
      from: e.from,
      to: e.to,
      model: e.model ?? "",
      reason: e.reason ?? "",
      streaming: !!e.streaming,
    });
  },
};
