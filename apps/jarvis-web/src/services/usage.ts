// Per-turn token-usage accumulator + composer-footer renderer.
//
// Each `usage` frame from the agent overlays the previous; providers
// usually emit one final `usage` per LLM call, but agents that fan
// out multiple iterations accumulate. `resetUsage()` is called at
// the top of each user turn so the badge tracks the active turn.

import { appStore } from "../store/appStore";

interface UsageState {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  calls: number;
}

/// Wire shape of the `usage` frame the harness emits. All counts
/// optional — providers vary in what they report.
interface UsageFrame {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  reasoning_tokens?: number;
}

const usageState: UsageState = {
  prompt: 0,
  completion: 0,
  cached: 0,
  reasoning: 0,
  calls: 0,
};

export function resetUsage(): void {
  usageState.prompt = 0;
  usageState.completion = 0;
  usageState.cached = 0;
  usageState.reasoning = 0;
  usageState.calls = 0;
  push();
}

export function recordUsage(ev: UsageFrame): void {
  usageState.calls++;
  if (typeof ev.prompt_tokens === "number") usageState.prompt += ev.prompt_tokens;
  if (typeof ev.completion_tokens === "number") usageState.completion += ev.completion_tokens;
  if (typeof ev.cached_prompt_tokens === "number") usageState.cached += ev.cached_prompt_tokens;
  if (typeof ev.reasoning_tokens === "number") usageState.reasoning += ev.reasoning_tokens;
  push();
}

function push(): void {
  // Snapshot — the store does shallow equality so mutating the same
  // object reference wouldn't trigger a re-render.
  appStore.getState().setUsage({ ...usageState });
}
