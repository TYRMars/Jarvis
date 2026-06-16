// Dashboard aggregation helpers shared by both ObservabilityStore backends.
// Ported from harness-store/src/json_file.rs (`percentile_latency`, `count_by`)
// + the body of `JsonFileObservabilityStore::dashboard`.
import type { JsonValue } from "@jarvis/core";
import type { DashboardSnapshot, ObservedRun, ObservedRunKind, TimeWindow } from "./types.ts";

/**
 * `p`-th percentile of the runs' `duration_ms` values, or `undefined` when no
 * run carries a duration. Mirrors Rust's `percentile_latency`:
 * sort ascending, `idx = ceil((n - 1) * p)`, return `values[idx]`.
 */
export function percentileLatency(rows: readonly ObservedRun[], p: number): number | undefined {
  const values: number[] = [];
  for (const r of rows) {
    if (r.duration_ms !== undefined) values.push(r.duration_ms);
  }
  if (values.length === 0) return undefined;
  values.sort((a, b) => a - b);
  const idx = Math.ceil((values.length - 1) * p);
  return values[idx];
}

/**
 * `{ <key>: count }` histogram, keyed-insertion-sorted ascending (mirrors
 * Rust's `BTreeMap` ordering, which is what `serde_json::json!` serialises).
 */
function countBy(rows: readonly ObservedRun[], key: (r: ObservedRun) => string): JsonValue {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.keys()].sort();
  const out: { [k: string]: JsonValue } = {};
  for (const k of sorted) out[k] = counts.get(k) as number;
  return out;
}

/**
 * Rust's `format!("{:?}", kind)` Debug repr of an {@link ObservedRunKind} —
 * the PascalCase variant name, NOT the snake_case serde form. The dashboard's
 * `by_kind` keys are built from this, so we reproduce it exactly.
 */
function kindDebug(kind: ObservedRunKind): string {
  switch (kind) {
    case "agent":
      return "Agent";
    case "subagent":
      return "Subagent";
    case "eval":
      return "Eval";
    case "tool":
      return "Tool";
    case "provider":
      return "Provider";
    case "other":
      return "Other";
  }
}

/**
 * Build a {@link DashboardSnapshot} from the given runs over `window`.
 * `generatedAt` is injected so backends produce a fresh ISO timestamp.
 */
export function buildDashboard(
  rows: readonly ObservedRun[],
  window: TimeWindow,
  generatedAt: string,
): DashboardSnapshot {
  const total_runs = rows.length;
  let successful_runs = 0;
  for (const r of rows) {
    if (r.outcome === "success") successful_runs += 1;
  }
  const failed_runs = total_runs - successful_runs;
  const run_success_rate = total_runs > 0 ? successful_runs / total_runs : undefined;
  const p95_latency_ms = percentileLatency(rows, 0.95);

  const snapshot: DashboardSnapshot = {
    window,
    generated_at: generatedAt,
    total_runs,
    successful_runs,
    failed_runs,
    by_kind: countBy(rows, (r) => kindDebug(r.kind)),
    by_name: countBy(rows, (r) => r.name),
  };
  if (run_success_rate !== undefined) snapshot.run_success_rate = run_success_rate;
  if (p95_latency_ms !== undefined) snapshot.p95_latency_ms = p95_latency_ms;
  return snapshot;
}

/**
 * Apply an {@link ObservabilityFilter}'s field predicates to a run row.
 * Limit / ordering are handled by the caller.
 */
export function runMatchesFilter(
  r: ObservedRun,
  filter: { kind?: string; name?: string; outcome?: string; project_id?: string },
): boolean {
  if (filter.kind !== undefined && r.kind !== filter.kind) return false;
  if (filter.name !== undefined && r.name !== filter.name) return false;
  if (filter.outcome !== undefined && r.outcome !== filter.outcome) return false;
  if (filter.project_id !== undefined && r.project_id !== filter.project_id) return false;
  return true;
}
