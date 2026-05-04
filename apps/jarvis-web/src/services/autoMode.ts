// Service layer for the v1.0 auto-mode runtime toggle.
//
// Wraps `GET /v1/auto-mode` and `POST /v1/auto-mode {enabled}`. The
// scheduler runs in `harness-server::auto_mode::spawn` and polls
// the runtime flag at the top of each `JARVIS_WORK_TICK_SECONDS`
// interval — so a flip takes at most one tick to take effect.

import { apiUrl } from "./api";

export interface AutoModeStatus {
  /** `true` when the binary wired up an `AutoModeRuntime`. Tests /
   * mcp-serve mode return `false` and the toggle should hide. */
  configured: boolean;
  /** Current scheduler state. Independent of `configured` only when
   * the binary is broken — normally `enabled` implies `configured`. */
  enabled: boolean;
}

/// Fetch current auto-mode status. Falls back to a "not configured"
/// shape on network error so callers can hide the toggle gracefully.
export async function getAutoModeStatus(): Promise<AutoModeStatus> {
  try {
    const r = await fetch(apiUrl("/v1/auto-mode"));
    if (!r.ok) return { configured: false, enabled: false };
    return (await r.json()) as AutoModeStatus;
  } catch (e) {
    console.warn("auto-mode status fetch failed", e);
    return { configured: false, enabled: false };
  }
}

/// Flip the runtime flag. Returns the server's authoritative state on
/// success; throws on 503 (no runtime) or non-2xx so the toggle can
/// surface the failure rather than silently no-op.
export async function setAutoModeEnabled(enabled: boolean): Promise<AutoModeStatus> {
  const r = await fetch(apiUrl("/v1/auto-mode"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`auto-mode ${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as AutoModeStatus;
}
