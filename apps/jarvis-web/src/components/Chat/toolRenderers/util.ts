// Pure helpers used by the tool-block shell + renderers. Kept in
// their own module so the shell stays focused on layout and the
// renderers stay focused on presentation.

import type { ToolBlockEntry } from "../../../store/appStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// Format the tool's wall-clock duration as a chip-friendly string.
/// Returns `null` when:
///   - the tool is still running (would just flicker as time passes)
///   - the timestamps are synthetic (history-restored entries — both
///     stored as 0 by `loadHistory`)
///   - the duration is zero (sub-millisecond; not worth surfacing)
export function computeDuration(entry: ToolBlockEntry): string | null {
  if (entry.finishedAt == null) return null;
  if (entry.startedAt === 0 && entry.finishedAt === 0) return null;
  const ms = Math.max(0, entry.finishedAt - entry.startedAt);
  if (ms === 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}
