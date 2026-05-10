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

  // ---- Read-only config snapshot (only present when configured). ----

  /** Wire form of `JARVIS_WORK_MODE`: `"off"` or `"auto"`. */
  mode?: "off" | "auto";
  /** Tick cadence in seconds. */
  tick_seconds?: number;
  /** Per-tick burst budget — how many candidates one tick may pick. */
  max_units_per_tick?: number;
  /** Global concurrency cap — semaphore pool size for in-flight runs. */
  max_concurrent_units?: number;
  /** Retry ceiling per requirement before the loop stops re-picking it. */
  max_retries?: number;
  /** Wall-clock budget per agent loop pickup, in milliseconds. */
  run_timeout_ms?: number;
  // ---- Live runtime state. ----

  /** Free permits in the concurrency semaphore right now. */
  available_permits?: number;
  /** RFC-3339 timestamp of the most recent tick observed. `null` until
   * the first tick fires (early after boot, or in tests that skip the
   * spawn loop). */
  last_tick_at?: string | null;
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
