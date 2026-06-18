// REST routes for Jarvis-local observability summaries + eval reads.
//
// Ported from crates/harness-server/src/observability_routes.rs. These
// endpoints read the compact local facts stores (ObservabilityStore +
// EvalStore) used by the Jarvis UI. They do NOT query Jaeger / Tempo / other
// OTLP backends — those remain the place for full trace drill-down.
//
// Surface (matches the Rust router 1:1):
//   GET /v1/observability/dashboard          — windowed dashboard snapshot
//   GET /v1/observability/runs               — filtered raw runs
//   GET /v1/observability/tools              — per-tool rollup summary
//   GET /v1/observability/subagents          — per-subagent rollup summary
//   GET /v1/observability/direction          — harness-direction snapshot
//   GET /v1/observability/capability-score   — capability-score snapshot
//   GET /v1/observability/exporter           — OTLP exporter status
//   GET /v1/observability/health             — REST mirror of `harness.health`
//   GET /v1/evals/summary                    — eval summary snapshot
//   GET /v1/evals/cases                      — filtered eval case results
//
// 503 contract: each handler that needs a store returns
// `503 { error: "<x> not configured" }` when its store is absent on AppState,
// matching the Rust `unavailable(...)` helper. Internal errors surface as
// `500 { error }`.
//
// Deferrals vs. Rust:
//   - GET /v1/observability/exporter reads `state.telemetry` in Rust (a
//     boot-time TelemetryStatus snapshot). The Node AppState carries no
//     telemetry field yet, so this handler returns the same JSON shape Rust
//     produces when telemetry is `None` (the `unwrap_or_default()` path):
//     enabled=false, empty endpoint/protocol, service_name="jarvis",
//     service_env="local", sample_ratio=0.
//   - GET /v1/observability/health mirrors the `harness.health` tool. That
//     tool is not separately ported; the Rust route builds it from the same
//     three stores and invokes it directly. We inline the equivalent
//     computation here off AppState's observability / evals / requirementRuns.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorText, type JsonValue } from "@jarvis/core";
import type {
  EvalCaseResult,
  EvalFilter,
  EvalGraderResult,
  EvalStore,
  EvalSuiteKind,
  ObservabilityFilter,
  ObservabilityStore,
  ObservedOutcome,
  ObservedRun,
  ObservedRunKind,
} from "@jarvis/observability";
import type {
  RequirementRun,
  RequirementRunStatus,
  RequirementRunStore,
} from "@jarvis/project";
import { requirementRunStatusIsTerminal } from "@jarvis/project";
import type { AppState } from "./state.ts";

// --------------------------- query parsing -------------------------------

/** Parse a `?limit=` style numeric query param. `undefined` when absent/NaN. */
function parseLimit(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Read a string query param, returning `undefined` for absent/empty. */
function parseStr(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Coerce a query param into a boolean. Strings parse via curl-friendly rules. */
function parseBool(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  return undefined;
}

/** Validate a value is a known ObservedRunKind (else `undefined`). */
const RUN_KINDS: readonly ObservedRunKind[] = [
  "agent",
  "subagent",
  "eval",
  "tool",
  "provider",
  "other",
];
function parseRunKind(raw: unknown): ObservedRunKind | undefined {
  const s = parseStr(raw);
  return s !== undefined && (RUN_KINDS as readonly string[]).includes(s)
    ? (s as ObservedRunKind)
    : undefined;
}

/** Validate a value is a known ObservedOutcome (else `undefined`). */
const OUTCOMES: readonly ObservedOutcome[] = [
  "success",
  "error",
  "timeout",
  "cancelled",
  "max_iterations",
  "unknown",
];
function parseOutcome(raw: unknown): ObservedOutcome | undefined {
  const s = parseStr(raw);
  return s !== undefined && (OUTCOMES as readonly string[]).includes(s)
    ? (s as ObservedOutcome)
    : undefined;
}

/** Validate a value is a known EvalSuiteKind (else `undefined`). */
const SUITE_KINDS: readonly EvalSuiteKind[] = ["capability", "regression", "smoke", "other"];
function parseSuiteKind(raw: unknown): EvalSuiteKind | undefined {
  const s = parseStr(raw);
  return s !== undefined && (SUITE_KINDS as readonly string[]).includes(s)
    ? (s as EvalSuiteKind)
    : undefined;
}

// --------------------------- 503 / 500 helpers ----------------------------

function unavailable(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(503).send({ error: message });
}

function internalError(reply: FastifyReply, e: unknown): FastifyReply {
  return reply.code(500).send({ error: errorText(e) });
}

// ------------------------- shared numeric helpers -------------------------

function average(sum: number, count: number): number | undefined {
  return count > 0 ? sum / count : undefined;
}

/** Mirror of Rust `ratio`: `Some(num/den)` when den > 0 else `None`. */
function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

/**
 * `p`-th percentile of a pre-collected number array. Mirrors Rust `percentile`:
 * `idx = ceil((n - 1) * p)`. Caller must pass an ASCENDING-sorted slice.
 */
function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const idx = Math.ceil((values.length - 1) * Math.max(0, Math.min(1, p)));
  return values[idx];
}

function scoreFromFloat(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

/** Mirror of `score_from_rate`. */
function scoreFromRate(rate: number | undefined): number | undefined {
  return rate === undefined ? undefined : scoreFromFloat(Math.max(0, Math.min(1, rate)) * 100);
}

/** P95-style latency → 0..100 efficiency score (good→100, poor→0, lerp between). */
function latencyScore(p95Ms: number | undefined, goodMs: number, poorMs: number): number {
  if (p95Ms === undefined) return 50;
  if (p95Ms <= goodMs) return 100;
  if (p95Ms >= poorMs) return 0;
  const span = poorMs - goodMs;
  const used = p95Ms - goodMs;
  return scoreFromFloat((1 - used / span) * 100);
}

function runsByKind(runs: readonly ObservedRun[], kind: ObservedRunKind): ObservedRun[] {
  return runs.filter((r) => r.kind === kind);
}

function successRate(runs: readonly ObservedRun[]): number | undefined {
  if (runs.length === 0) return undefined;
  return runs.filter((r) => r.outcome === "success").length / runs.length;
}

function evalSuccessRate(cases: readonly EvalCaseResult[]): number | undefined {
  if (cases.length === 0) return undefined;
  return cases.filter((c) => c.outcome === "success").length / cases.length;
}

function isBadOutcome(outcome: ObservedOutcome): boolean {
  return (
    outcome === "error" ||
    outcome === "timeout" ||
    outcome === "cancelled" ||
    outcome === "max_iterations"
  );
}

function countErrors(runs: readonly ObservedRun[]): number {
  return runs.filter(
    (r) => r.outcome === "error" || r.outcome === "timeout" || r.outcome === "cancelled",
  ).length;
}

/** Ascending-sorted durations percentile over a run slice. */
function durationPercentile(runs: readonly ObservedRun[], pct: number): number | undefined {
  const durations: number[] = [];
  for (const r of runs) if (r.duration_ms !== undefined) durations.push(r.duration_ms);
  durations.sort((a, b) => a - b);
  return percentile(durations, pct);
}

/**
 * Read a numeric attribute by key, preferring `attributes` then `metrics`.
 * Mirrors Rust `number_attr` (only finite numbers count).
 */
function numberAttr(run: ObservedRun, key: string): number | undefined {
  const fromBag = (bag: JsonValue): number | undefined => {
    if (bag !== null && typeof bag === "object" && !Array.isArray(bag)) {
      const v = (bag as { [k: string]: JsonValue })[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return fromBag(run.attributes) ?? fromBag(run.metrics);
}

function averageAttr(runs: readonly ObservedRun[], key: string): number | undefined {
  let sum = 0;
  let count = 0;
  for (const r of runs) {
    const n = numberAttr(r, key);
    if (n !== undefined) {
      sum += n;
      count += 1;
    }
  }
  return average(sum, count);
}

function shortId(id: string): string {
  return [...id].slice(0, 8).join("");
}

// ------------------------------ exporter ----------------------------------

interface ExporterStatus {
  enabled: boolean;
  endpoint: string;
  protocol: string;
  service_name: string;
  service_env: string;
  sample_ratio: number;
}

/**
 * The default exporter status — the shape Rust returns when no OTLP exporter
 * was installed (`TelemetryStatus::default()`). The Node AppState carries no
 * telemetry snapshot yet, so this is the only branch.
 */
function defaultExporterStatus(): ExporterStatus {
  return {
    enabled: false,
    endpoint: "",
    protocol: "",
    service_name: "jarvis",
    service_env: "local",
    sample_ratio: 0,
  };
}

// ------------------------------ runs summary ------------------------------

interface ObservedRunSummary {
  name: string;
  runs: number;
  success: number;
  errors: number;
  unknown: number;
  success_rate: number | undefined;
  median_duration_ms: number | undefined;
  p95_duration_ms: number | undefined;
  avg_duration_ms: number | undefined;
  avg_output_bytes: number | undefined;
  avg_frames: number | undefined;
  avg_tool_calls: number | undefined;
}

interface SummaryBucket {
  runs: number;
  success: number;
  errors: number;
  unknown: number;
  durations: number[];
  outputBytesSum: number;
  outputBytesCount: number;
  framesSum: number;
  framesCount: number;
  toolCallsSum: number;
  toolCallsCount: number;
}

function newBucket(): SummaryBucket {
  return {
    runs: 0,
    success: 0,
    errors: 0,
    unknown: 0,
    durations: [],
    outputBytesSum: 0,
    outputBytesCount: 0,
    framesSum: 0,
    framesCount: 0,
    toolCallsSum: 0,
    toolCallsCount: 0,
  };
}

/**
 * Group runs by name and roll up counts / rates / latency / attr averages.
 * Names are emitted in ascending key order (Rust uses a BTreeMap), matching
 * the deterministic ordering the dashboard expects before re-sorting.
 */
function summarizeRuns(runs: readonly ObservedRun[]): ObservedRunSummary[] {
  const buckets = new Map<string, SummaryBucket>();
  for (const run of runs) {
    let bucket = buckets.get(run.name);
    if (!bucket) {
      bucket = newBucket();
      buckets.set(run.name, bucket);
    }
    bucket.runs += 1;
    switch (run.outcome) {
      case "success":
        bucket.success += 1;
        break;
      case "error":
      case "timeout":
      case "cancelled":
        bucket.errors += 1;
        break;
      case "unknown":
      case "max_iterations":
        bucket.unknown += 1;
        break;
    }
    if (run.duration_ms !== undefined) bucket.durations.push(run.duration_ms);
    const ob = numberAttr(run, "output_bytes");
    if (ob !== undefined) {
      bucket.outputBytesSum += ob;
      bucket.outputBytesCount += 1;
    }
    const fr = numberAttr(run, "frames");
    if (fr !== undefined) {
      bucket.framesSum += fr;
      bucket.framesCount += 1;
    }
    const tc = numberAttr(run, "tool_calls");
    if (tc !== undefined) {
      bucket.toolCallsSum += tc;
      bucket.toolCallsCount += 1;
    }
  }
  const names = [...buckets.keys()].sort();
  const out: ObservedRunSummary[] = [];
  for (const name of names) {
    const bucket = buckets.get(name) as SummaryBucket;
    bucket.durations.sort((a, b) => a - b);
    const durationSum = bucket.durations.reduce((acc, d) => acc + d, 0);
    out.push({
      name,
      runs: bucket.runs,
      success: bucket.success,
      errors: bucket.errors,
      unknown: bucket.unknown,
      success_rate: bucket.runs > 0 ? bucket.success / bucket.runs : undefined,
      median_duration_ms: percentile(bucket.durations, 0.5),
      p95_duration_ms: percentile(bucket.durations, 0.95),
      avg_duration_ms:
        bucket.durations.length > 0 ? durationSum / bucket.durations.length : undefined,
      avg_output_bytes: average(bucket.outputBytesSum, bucket.outputBytesCount),
      avg_frames: average(bucket.framesSum, bucket.framesCount),
      avg_tool_calls: average(bucket.toolCallsSum, bucket.toolCallsCount),
    });
  }
  return out;
}

async function listKindSummary(
  store: ObservabilityStore,
  kind: ObservedRunKind,
  key: string,
  limit: number | undefined,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const scanLimit = Math.min((limit ?? 500) * 20, 10_000);
  let runs: ObservedRun[];
  try {
    runs = await store.listRuns({ kind, limit: scanLimit });
  } catch (e) {
    return internalError(reply, e);
  }
  const summaries = summarizeRuns(runs);
  summaries.sort((a, b) => {
    if (b.errors !== a.errors) return b.errors - a.errors;
    if (b.runs !== a.runs) return b.runs - a.runs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const trimmed = summaries.slice(0, Math.min(limit ?? 50, 500));
  return reply.send({ [key]: trimmed });
}

// --------------------------- direction snapshot ---------------------------

interface DirectionComponent {
  key: string;
  label: string;
  score: number;
  value: number | undefined;
  detail: string;
}

interface DirectionRecommendation {
  key: string;
  priority: number;
  tone: string;
  title: string;
  detail: string;
  metric: string | undefined;
}

function component(
  key: string,
  label: string,
  score: number,
  value: number | undefined,
  detail: string,
): DirectionComponent {
  return { key, label, score, value, detail };
}

function recommendation(
  key: string,
  priority: number,
  tone: string,
  title: string,
  detail: string,
  metric: string | undefined,
): DirectionRecommendation {
  return { key, priority, tone, title, detail, metric };
}

function topErrorHotspot(runs: readonly ObservedRun[]): [string, number] | undefined {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.outcome === "error" || run.outcome === "timeout" || run.outcome === "cancelled") {
      counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
    }
  }
  // Rust iterates a BTreeMap (ascending name) and keeps `max_by(count, then
  // name desc)`, so among ties the lexicographically-largest name wins.
  let best: [string, number] | undefined;
  for (const name of [...counts.keys()].sort()) {
    const n = counts.get(name) as number;
    if (best === undefined || n > best[1] || (n === best[1] && name > best[0])) {
      best = [name, n];
    }
  }
  return best;
}

function directionSnapshot(
  runs: readonly ObservedRun[],
  evalCases: readonly EvalCaseResult[] | undefined,
): {
  generated_at: string;
  score: number;
  primary_focus: string;
  components: DirectionComponent[];
  recommendations: DirectionRecommendation[];
  sample: JsonValue;
} {
  const agentRuns = runsByKind(runs, "agent");
  const toolRuns = runsByKind(runs, "tool");
  const subagentRuns = runsByKind(runs, "subagent");
  const agentSuccessRate = successRate(agentRuns) ?? successRate(runs);
  const toolSuccessRate = successRate(toolRuns);
  const subagentSuccessRate = successRate(subagentRuns);
  const evalRate = evalCases !== undefined ? evalSuccessRate(evalCases) : undefined;

  const agentP95 = durationPercentile(agentRuns, 0.95) ?? durationPercentile(runs, 0.95);
  const subagentP95 = durationPercentile(subagentRuns, 0.95);
  const toolErrors = countErrors(toolRuns);
  const subagentErrors = countErrors(subagentRuns);

  let reliability: number;
  if (agentSuccessRate !== undefined && toolSuccessRate !== undefined) {
    reliability = scoreFromFloat((0.82 * agentSuccessRate + 0.18 * toolSuccessRate) * 100);
  } else if (agentSuccessRate !== undefined) {
    reliability = scoreFromFloat(agentSuccessRate * 100);
  } else if (toolSuccessRate !== undefined) {
    reliability = scoreFromFloat(toolSuccessRate * 100);
  } else if (runs.length === 0) {
    reliability = 50;
  } else {
    reliability = scoreFromRate(successRate(runs)) ?? 50;
  }

  let verification: number;
  if (evalCases !== undefined) {
    const coverage = Math.max(0, Math.min(1, evalCases.length / 20));
    const rate = evalRate ?? 0;
    verification = scoreFromFloat((0.7 * rate + 0.3 * coverage) * 100);
  } else {
    verification = 35;
  }

  let subagentRoi: number;
  if (subagentRuns.length === 0) {
    subagentRoi = 50;
  } else {
    const rate = subagentSuccessRate ?? 0;
    const latency = latencyScore(subagentP95, 30_000, 180_000) / 100;
    const avgCalls = averageAttr(subagentRuns, "tool_calls") ?? 0;
    const productive = Math.max(0, Math.min(1, avgCalls / 4));
    subagentRoi = scoreFromFloat((0.62 * rate + 0.24 * latency + 0.14 * productive) * 100);
  }

  const efficiency = latencyScore(agentP95, 20_000, 180_000);

  let observability: number;
  {
    let kinds = 0;
    if (agentRuns.length > 0) kinds += 1;
    if (toolRuns.length > 0) kinds += 1;
    if (subagentRuns.length > 0) kinds += 1;
    if (evalCases !== undefined && evalCases.length > 0) kinds += 1;
    const depth = Math.max(0, Math.min(1, runs.length / 50));
    observability = scoreFromFloat((0.45 + 0.35 * (kinds / 4) + 0.2 * depth) * 100);
  }

  const components: DirectionComponent[] = [
    component(
      "reliability",
      "Reliability",
      reliability,
      agentSuccessRate,
      "Jarvis run-loop success and terminal-state hygiene",
    ),
    component(
      "verification",
      "Verification",
      verification,
      evalRate,
      "Eval pass rate plus coverage depth",
    ),
    component(
      "subagent_roi",
      "SubAgent ROI",
      subagentRoi,
      subagentSuccessRate,
      "Delegation success, latency, and useful tool-call density",
    ),
    component(
      "efficiency",
      "Efficiency",
      efficiency,
      agentP95,
      "P95 latency pressure across observed runs",
    ),
    component(
      "observability",
      "Observability",
      observability,
      runs.length,
      "Recorded signal breadth across agent, tool, SubAgent, and eval",
    ),
  ];

  const score = scoreFromFloat(
    reliability * 0.3 +
      verification * 0.25 +
      subagentRoi * 0.2 +
      efficiency * 0.15 +
      observability * 0.1,
  );

  // Rust uses `min_by_key(|c| c.score)` — among ties the FIRST minimum wins
  // (min_by_key keeps the earlier element on equal keys via `<`).
  let primaryFocus = "observability";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of components) {
    if (c.score < bestScore) {
      bestScore = c.score;
      primaryFocus = c.key;
    }
  }

  const recommendations: DirectionRecommendation[] = [];
  if (reliability < 75 && agentSuccessRate !== undefined) {
    recommendations.push(
      recommendation(
        "stabilize_run_loop",
        1,
        "danger",
        "Stabilize the run loop",
        "Agent success is below the operating threshold. Prioritize provider errors, terminal-state cleanup, and retry behavior before adding new capabilities.",
        agentSuccessRate !== undefined
          ? `run success ${Math.round(agentSuccessRate * 100)}%`
          : undefined,
      ),
    );
  }
  const hotspot = topErrorHotspot(toolRuns);
  if (hotspot !== undefined) {
    recommendations.push(
      recommendation(
        "fix_tool_hotspot",
        2,
        "warn",
        "Fix the noisiest tool first",
        `\`${hotspot[0]}\` contributes the largest current tool-error cluster. Improve schema validation, timeout policy, or error text for model recovery.`,
        `${hotspot[1]} errors`,
      ),
    );
  } else if (toolErrors > 0) {
    recommendations.push(
      recommendation(
        "reduce_tool_errors",
        2,
        "warn",
        "Reduce tool error pressure",
        "Tool failures are present but not concentrated in one tool. Review permission denials, malformed arguments, and recoverable error messages.",
        `${toolErrors} tool errors`,
      ),
    );
  }
  if (verification < 70) {
    recommendations.push(
      recommendation(
        "expand_eval_coverage",
        3,
        "warn",
        "Expand eval coverage",
        "Direction decisions are weak without repeatable evals. Add cases for planning, tool use, file edits, SubAgent delegation, and recovery from tool errors.",
        evalCases !== undefined ? `${evalCases.length} eval cases` : undefined,
      ),
    );
  }
  if (subagentRuns.length > 0 && subagentRoi < 75) {
    recommendations.push(
      recommendation(
        "tune_subagent_delegation",
        4,
        "warn",
        "Tune SubAgent delegation",
        "SubAgents are not yet paying for their overhead. Route them to complex work, add clearer completion criteria, or reduce delegation on short tasks.",
        `${subagentErrors} subagent errors`,
      ),
    );
  } else if (subagentRuns.length === 0) {
    recommendations.push(
      recommendation(
        "exercise_subagent_path",
        4,
        "neutral",
        "Exercise the SubAgent path",
        "No SubAgent runs are recorded yet. Add a small delegation smoke eval so Claude Code / Codex style workers are visible in the harness score.",
        undefined,
      ),
    );
  }
  if (efficiency < 70 && agentP95 !== undefined) {
    recommendations.push(
      recommendation(
        "cut_latency_pressure",
        5,
        "warn",
        "Reduce latency pressure",
        "Observed P95 latency is high. Check long-running tools, streaming stalls, retry fan-out, and unnecessary SubAgent hops.",
        agentP95 !== undefined ? `p95 ${agentP95}ms` : undefined,
      ),
    );
  }
  if (observability < 75) {
    recommendations.push(
      recommendation(
        "fill_signal_gaps",
        6,
        "neutral",
        "Fill telemetry gaps",
        "The dashboard is missing breadth across agent, tool, SubAgent, or eval records. Keep JSON persistence on and add span summaries for trace drill-down.",
        `${runs.length} observed runs`,
      ),
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      recommendation(
        "promote_release_gate",
        1,
        "ok",
        "Promote the harness gate",
        "Signals are stable enough to use eval baselines and score deltas as a pre-release gate.",
        `direction score ${score}`,
      ),
    );
  }
  recommendations.sort((a, b) => a.priority - b.priority);
  const trimmedRecs = recommendations.slice(0, 5);

  return {
    generated_at: new Date().toISOString(),
    score,
    primary_focus: primaryFocus,
    components,
    recommendations: trimmedRecs,
    sample: {
      runs: runs.length,
      agent_runs: agentRuns.length,
      tool_runs: toolRuns.length,
      subagent_runs: subagentRuns.length,
      eval_cases: evalCases !== undefined ? evalCases.length : null,
    },
  };
}

// ------------------------- capability score -------------------------------

interface CapabilityDriver {
  key: string;
  label: string;
  value: number | undefined;
  weight: number;
  score: number;
  detail: string;
}

interface CapabilityEvidence {
  kind: string;
  id: string;
  title: string;
  detail: string;
  metric: string | undefined;
  tone: string;
}

interface CapabilityDimensionScore {
  key: string;
  label: string;
  score: number;
  confidence: number;
  summary: string;
  drivers: CapabilityDriver[];
  evidence: CapabilityEvidence[];
}

function driver(
  key: string,
  label: string,
  value: number | undefined,
  weight: number,
  detail: string,
): CapabilityDriver {
  const score =
    value === undefined ? 50 : scoreFromFloat(Math.max(0, Math.min(1, value)) * 100);
  return { key, label, value, weight, score, detail };
}

function weightedDriverScore(drivers: readonly CapabilityDriver[]): number {
  const weightSum = drivers.reduce((acc, d) => acc + d.weight, 0);
  if (weightSum <= Number.EPSILON) return 50;
  return scoreFromFloat(drivers.reduce((acc, d) => acc + d.score * d.weight, 0) / weightSum);
}

function dimension(
  key: string,
  label: string,
  summary: string,
  drivers: CapabilityDriver[],
  confidence: number,
  evidence: CapabilityEvidence[],
): CapabilityDimensionScore {
  return {
    key,
    label,
    score: weightedDriverScore(drivers),
    confidence,
    summary,
    drivers,
    evidence,
  };
}

/** Mirror of Rust `json_key`: snake_case wire string for an enum value. */
function jsonKey(value: string | undefined): string {
  return value ?? "unknown";
}

class CapabilityFacts {
  readonly obsRuns: readonly ObservedRun[];
  readonly evalCases: readonly EvalCaseResult[];
  readonly requirementRuns: readonly RequirementRun[];
  readonly agentRuns: ObservedRun[];
  readonly toolRuns: ObservedRun[];
  readonly subagentRuns: ObservedRun[];
  readonly terminalRuns: RequirementRun[];
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly cancelledRuns: number;
  readonly timeoutLike: number;
  readonly maxIterationLike: number;
  readonly verifiedRuns: number;
  readonly verificationPassed: number;
  readonly sampleCount: number;

  constructor(
    obsRuns: readonly ObservedRun[],
    evalCases: readonly EvalCaseResult[],
    requirementRuns: readonly RequirementRun[],
  ) {
    this.obsRuns = obsRuns;
    this.evalCases = evalCases;
    this.requirementRuns = requirementRuns;
    this.agentRuns = runsByKind(obsRuns, "agent");
    this.toolRuns = runsByKind(obsRuns, "tool");
    this.subagentRuns = runsByKind(obsRuns, "subagent");
    this.terminalRuns = requirementRuns.filter((r) => requirementRunStatusIsTerminal(r.status));
    this.completedRuns = requirementRuns.filter((r) => r.status === "completed").length;
    this.failedRuns = requirementRuns.filter((r) => r.status === "failed").length;
    this.cancelledRuns = requirementRuns.filter((r) => r.status === "cancelled").length;
    this.timeoutLike =
      requirementRuns.filter(
        (r) => r.error !== undefined && r.error.toLowerCase().includes("timed out"),
      ).length + obsRuns.filter((r) => r.outcome === "timeout").length;
    this.maxIterationLike =
      requirementRuns.filter(
        (r) => r.error !== undefined && r.error.toLowerCase().includes("max iterations"),
      ).length + obsRuns.filter((r) => r.outcome === "max_iterations").length;
    this.verifiedRuns = requirementRuns.filter((r) => r.verification !== undefined).length;
    this.verificationPassed = requirementRuns.filter(
      (r) => r.verification !== undefined && r.verification.status === "passed",
    ).length;
    this.sampleCount = obsRuns.length + evalCases.length + requirementRuns.length;
  }

  completionRate(): number | undefined {
    return ratio(this.completedRuns, this.terminalRuns.length);
  }
  terminalRate(): number | undefined {
    return ratio(this.terminalRuns.length, this.requirementRuns.length);
  }
  verificationPassRate(): number | undefined {
    return ratio(this.verificationPassed, this.verifiedRuns);
  }
  verificationCoverage(): number | undefined {
    return ratio(this.verifiedRuns, this.terminalRuns.length);
  }
  evalPassRate(): number | undefined {
    return evalSuccessRate(this.evalCases);
  }
  capabilityEvalPassRate(): number | undefined {
    return evalSuccessRate(this.evalCases.filter((c) => c.suite_kind === "capability"));
  }
  regressionEvalPassRate(): number | undefined {
    return evalSuccessRate(this.evalCases.filter((c) => c.suite_kind === "regression"));
  }
  timeoutFreeRate(): number | undefined {
    return ratio(
      Math.max(0, this.terminalRuns.length - (this.timeoutLike + this.maxIterationLike)),
      this.terminalRuns.length,
    );
  }
}

/** Confidence weighting shared by every dimension. Mirrors Rust `confidence_for`. */
function confidenceFor(
  facts: CapabilityFacts,
  obsWeight: number,
  evalWeight: number,
  runWeight: number,
  verificationWeight: number,
): number {
  const sampleConf = Math.max(0, Math.min(1, Math.log(facts.sampleCount + 1) / Math.log(31)));
  const obs = facts.obsRuns.length > 0 ? 1 : 0;
  const ev = facts.evalCases.length > 0 ? 1 : 0;
  const runs = facts.requirementRuns.length > 0 ? 1 : 0;
  const verification = facts.verifiedRuns > 0 ? 1 : 0;
  const coverage =
    obs * obsWeight + ev * evalWeight + runs * runWeight + verification * verificationWeight;
  return Math.max(0, Math.min(1, sampleConf * coverage));
}

function evalFailureFreeRate(
  cases: readonly EvalCaseResult[],
  needles: readonly string[],
): number | undefined {
  if (cases.length === 0) return undefined;
  const matching = cases.filter((c) => {
    if (c.failure_class === undefined) return false;
    const key = jsonKey(c.failure_class);
    return needles.some((n) => key.includes(n));
  }).length;
  return (cases.length - matching) / cases.length;
}

function requirementRunEvidence(run: RequirementRun): CapabilityEvidence {
  const tone =
    run.status === "failed" || run.status === "cancelled"
      ? "danger"
      : run.status === "pending" || run.status === "running"
        ? "warn"
        : "ok";
  return {
    kind: "requirement_run",
    id: run.id,
    title: run.summary ?? `requirement ${shortId(run.requirement_id)}`,
    detail: run.error ?? jsonKey(run.status),
    metric: `status ${jsonKey(run.status)}`,
    tone,
  };
}

function observedRunEvidence(run: ObservedRun): CapabilityEvidence {
  return {
    kind: jsonKey(run.kind),
    id: run.id,
    title: run.name,
    detail: jsonKey(run.outcome),
    metric: run.duration_ms !== undefined ? `${run.duration_ms}ms` : undefined,
    tone: isBadOutcome(run.outcome) ? "danger" : "neutral",
  };
}

function requirementFailureEvidence(facts: CapabilityFacts, limit: number): CapabilityEvidence[] {
  return facts.requirementRuns
    .filter((r) => r.status === "failed" || r.status === "cancelled")
    .slice(0, limit)
    .map(requirementRunEvidence);
}

function evalFailureEvidence(facts: CapabilityFacts, limit: number): CapabilityEvidence[] {
  return facts.evalCases
    .filter((c) => c.outcome !== "success")
    .slice(0, limit)
    .map((c) => ({
      kind: "eval_case",
      id: c.id,
      title: c.scenario,
      detail: c.failure_class !== undefined ? jsonKey(c.failure_class) : jsonKey(c.outcome),
      metric: `${c.suite} / ${jsonKey(c.suite_kind)}`,
      tone: "danger",
    }));
}

function evidenceForUnderstanding(facts: CapabilityFacts): CapabilityEvidence[] {
  const rows = evalFailureEvidence(facts, 3);
  rows.push(...requirementFailureEvidence(facts, 2));
  return rows.slice(0, 4);
}

function evidenceForPlanning(facts: CapabilityFacts): CapabilityEvidence[] {
  let rows = facts.requirementRuns
    .filter((r) => {
      if (r.error === undefined) return false;
      const lower = r.error.toLowerCase();
      return lower.includes("timed out") || lower.includes("max iterations");
    })
    .slice(0, 4)
    .map(requirementRunEvidence);
  if (rows.length === 0) rows = requirementFailureEvidence(facts, 4);
  return rows;
}

function evidenceForInvocation(facts: CapabilityFacts): CapabilityEvidence[] {
  const rows = facts.toolRuns
    .filter((r) => isBadOutcome(r.outcome))
    .slice(0, 3)
    .map(observedRunEvidence);
  rows.push(
    ...facts.subagentRuns
      .filter((r) => isBadOutcome(r.outcome))
      .slice(0, 2)
      .map(observedRunEvidence),
  );
  return rows;
}

function evidenceForDelivery(facts: CapabilityFacts): CapabilityEvidence[] {
  const rows = requirementFailureEvidence(facts, 4);
  rows.push(...evalFailureEvidence(facts, 2));
  return rows.slice(0, 4);
}

function scoreTaskUnderstanding(facts: CapabilityFacts): CapabilityDimensionScore {
  const capabilityEval = facts.capabilityEvalPassRate() ?? facts.evalPassRate();
  const drivers = [
    driver(
      "capability_eval_pass_rate",
      "Capability eval pass rate",
      capabilityEval,
      0.4,
      "Repeatable eval cases that target task comprehension",
    ),
    driver(
      "verification_pass_rate",
      "Verification pass rate",
      facts.verificationPassRate(),
      0.25,
      "Requirement runs whose verification checks passed",
    ),
    driver(
      "completion_rate",
      "Completion rate",
      facts.completionRate(),
      0.2,
      "Terminal requirement runs that reached completed",
    ),
    driver(
      "misunderstanding_free_rate",
      "No misunderstanding failure class",
      evalFailureFreeRate(facts.evalCases, [
        "understanding",
        "instruction",
        "constraint",
        "acceptance",
      ]),
      0.15,
      "Eval cases not classified as instruction, constraint, or acceptance misses",
    ),
  ];
  return dimension(
    "task_understanding",
    "Task understanding",
    "Whether Jarvis understood goal, constraints, and acceptance criteria",
    drivers,
    confidenceFor(facts, 0.45, 0.25, 0.2, 0.1),
    evidenceForUnderstanding(facts),
  );
}

function scorePlanningExecution(facts: CapabilityFacts): CapabilityDimensionScore {
  const agentSuccess = successRate(facts.agentRuns) ?? successRate(facts.obsRuns);
  const drivers = [
    driver(
      "terminal_rate",
      "Terminal-state rate",
      facts.terminalRate(),
      0.25,
      "Runs that leave pending/running and settle into a terminal state",
    ),
    driver(
      "completion_rate",
      "Execution completion rate",
      facts.completionRate(),
      0.3,
      "Terminal requirement runs that completed successfully",
    ),
    driver(
      "timeout_free_rate",
      "Timeout/max-iteration avoidance",
      facts.timeoutFreeRate(),
      0.25,
      "Runs that did not hit timeout or max-iteration boundaries",
    ),
    driver(
      "agent_success_rate",
      "Observed agent success",
      agentSuccess,
      0.2,
      "Observed Jarvis agent runs marked successful",
    ),
  ];
  return dimension(
    "planning_execution",
    "Planning execution",
    "Whether Jarvis can decompose, sequence, and finish the work loop",
    drivers,
    confidenceFor(facts, 0.15, 0.15, 0.55, 0.15),
    evidenceForPlanning(facts),
  );
}

function scoreCapabilityInvocation(facts: CapabilityFacts): CapabilityDimensionScore {
  const toolSuccess = successRate(facts.toolRuns);
  const subagentSuccess = successRate(facts.subagentRuns);
  const agentSuccess = successRate(facts.agentRuns) ?? successRate(facts.obsRuns);
  const latency = latencyScore(durationPercentile(facts.obsRuns, 0.95), 20_000, 180_000) / 100;
  const delegationVisibility =
    facts.subagentRuns.length > 0
      ? (subagentSuccess ?? 0) * 0.7 +
        (latencyScore(durationPercentile(facts.subagentRuns, 0.95), 30_000, 180_000) / 100) * 0.3
      : undefined;
  const drivers = [
    driver(
      "tool_success_rate",
      "Tool success rate",
      toolSuccess,
      0.35,
      "Observed tool calls that completed without error",
    ),
    driver(
      "subagent_success_rate",
      "SubAgent success rate",
      subagentSuccess,
      0.25,
      "Delegated worker runs that completed successfully",
    ),
    driver(
      "agent_recovery_rate",
      "Agent recovery proxy",
      agentSuccess,
      0.2,
      "Agent run success after using available capabilities",
    ),
    driver(
      "latency_efficiency",
      "Latency efficiency",
      latency,
      0.1,
      "P95 latency converted into an efficiency score",
    ),
    driver(
      "delegation_visibility",
      "Delegation visibility",
      delegationVisibility,
      0.1,
      "Whether SubAgent paths are exercised and successful",
    ),
  ];
  return dimension(
    "capability_invocation",
    "Capability invocation",
    "Whether Jarvis chooses tools and SubAgents effectively",
    drivers,
    confidenceFor(facts, 0.45, 0.2, 0.1, 0.25),
    evidenceForInvocation(facts),
  );
}

function scoreTaskDelivery(facts: CapabilityFacts): CapabilityDimensionScore {
  const regression = facts.regressionEvalPassRate() ?? facts.evalPassRate();
  const failureFree = ratio(
    Math.max(0, facts.terminalRuns.length - (facts.failedRuns + facts.cancelledRuns)),
    facts.terminalRuns.length,
  );
  const drivers = [
    driver(
      "completion_rate",
      "Completion rate",
      facts.completionRate(),
      0.35,
      "Terminal requirement runs that reached completed",
    ),
    driver(
      "verification_pass_rate",
      "Verification pass rate",
      facts.verificationPassRate(),
      0.3,
      "Attached verification results that passed",
    ),
    driver(
      "regression_eval_pass_rate",
      "Regression eval pass rate",
      regression,
      0.2,
      "Regression suites that still pass",
    ),
    driver(
      "verification_coverage",
      "Verification coverage",
      facts.verificationCoverage(),
      0.1,
      "Terminal runs with attached verification evidence",
    ),
    driver(
      "failure_free_rate",
      "Failure-free terminal rate",
      failureFree,
      0.05,
      "Terminal runs not marked failed or cancelled",
    ),
  ];
  return dimension(
    "task_delivery",
    "Task delivery",
    "Whether Jarvis produces verifiable completed work",
    drivers,
    confidenceFor(facts, 0.2, 0.25, 0.45, 0.1),
    evidenceForDelivery(facts),
  );
}

function capabilityScoreSnapshot(
  obsRuns: readonly ObservedRun[],
  evalCases: readonly EvalCaseResult[],
  requirementRuns: readonly RequirementRun[],
): {
  generated_at: string;
  overall_score: number;
  confidence: number;
  sample_count: number;
  dimensions: CapabilityDimensionScore[];
  rules: JsonValue;
} {
  const facts = new CapabilityFacts(obsRuns, evalCases, requirementRuns);
  const dimensions = [
    scoreTaskUnderstanding(facts),
    scorePlanningExecution(facts),
    scoreCapabilityInvocation(facts),
    scoreTaskDelivery(facts),
  ];
  const rawOverall = dimensions.reduce((acc, d) => acc + d.score, 0) / dimensions.length;
  const deliveryScore = dimensions.find((d) => d.key === "task_delivery")?.score ?? 50;
  let overallScore = scoreFromFloat(rawOverall);
  if (deliveryScore < 60) overallScore = Math.min(overallScore, 69);
  const confidence =
    average(
      dimensions.reduce((acc, d) => acc + d.confidence, 0),
      dimensions.length,
    ) ?? 0;

  return {
    generated_at: new Date().toISOString(),
    overall_score: overallScore,
    confidence,
    sample_count: facts.sampleCount,
    dimensions,
    rules: {
      scale: "0-100",
      weights: {
        task_understanding: 0.25,
        planning_execution: 0.25,
        capability_invocation: 0.25,
        task_delivery: 0.25,
      },
      caps: [
        "if task_delivery < 60, overall_score <= 69",
        "confidence is reduced when eval, verification, observability, or requirement-run signals are missing",
      ],
    },
  };
}

// ------------------------------ eval summary ------------------------------

interface EvalTrialReliability {
  task_groups: number;
  pass_at_k: number | undefined;
  pass_all: number | undefined;
}

/** `{ <key>: count }` BTreeMap-ordered histogram. */
function countBy<T>(rows: readonly T[], f: (row: T) => string): { [k: string]: number } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = f(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: { [k: string]: number } = {};
  for (const k of [...counts.keys()].sort()) out[k] = counts.get(k) as number;
  return out;
}

function countGraderKinds(cases: readonly EvalCaseResult[]): { [k: string]: number } {
  const counts = new Map<string, number>();
  for (const c of cases) {
    const graders: readonly EvalGraderResult[] = c.grader_results ?? [];
    for (const g of graders) {
      const key = jsonKey(g.kind);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out: { [k: string]: number } = {};
  for (const k of [...counts.keys()].sort()) out[k] = counts.get(k) as number;
  return out;
}

function countFailureClasses(cases: readonly EvalCaseResult[]): { [k: string]: number } {
  const counts = new Map<string, number>();
  for (const c of cases) {
    if (c.failure_class !== undefined) {
      const key = jsonKey(c.failure_class);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out: { [k: string]: number } = {};
  for (const k of [...counts.keys()].sort()) out[k] = counts.get(k) as number;
  return out;
}

function trialReliability(cases: readonly EvalCaseResult[]): EvalTrialReliability {
  const groups = new Map<string, EvalCaseResult[]>();
  for (const c of cases) {
    const key = `${c.suite} ${c.case_id}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }
  const taskGroups = groups.size;
  let anyPass = 0;
  let allPass = 0;
  for (const trials of groups.values()) {
    if (trials.some((c) => c.outcome === "success")) anyPass += 1;
    if (trials.length > 0 && trials.every((c) => c.outcome === "success")) allPass += 1;
  }
  return {
    task_groups: taskGroups,
    pass_at_k: ratio(anyPass, taskGroups),
    pass_all: ratio(allPass, taskGroups),
  };
}

function evalSummary(cases: readonly EvalCaseResult[]): {
  generated_at: string;
  total_cases: number;
  passed_cases: number;
  pass_rate: number | undefined;
  capability_pass_rate: number | undefined;
  regression_pass_rate: number | undefined;
  trial_reliability: EvalTrialReliability;
  by_suite_kind: JsonValue;
  by_grader_kind: JsonValue;
  by_failure_class: JsonValue;
  transcript_cases: number;
} {
  const passedCases = cases.filter((c) => c.outcome === "success").length;
  const capability = cases.filter((c) => c.suite_kind === "capability");
  const regression = cases.filter((c) => c.suite_kind === "regression");
  const transcriptCases = cases.filter((c) => c.transcript_artifact_id !== undefined).length;

  return {
    generated_at: new Date().toISOString(),
    total_cases: cases.length,
    passed_cases: passedCases,
    pass_rate: ratio(passedCases, cases.length),
    capability_pass_rate: evalSuccessRate(capability),
    regression_pass_rate: evalSuccessRate(regression),
    trial_reliability: trialReliability(cases),
    by_suite_kind: countBy(cases, (c) => jsonKey(c.suite_kind)),
    by_grader_kind: countGraderKinds(cases),
    by_failure_class: countFailureClasses(cases),
    transcript_cases: transcriptCases,
  };
}

// ------------------------------ health ------------------------------------

interface HealthSourceStatus {
  configured: boolean;
  rows: number;
  error?: string;
}

interface HealthDriver {
  key: string;
  label: string;
  value: number | undefined;
  weight: number;
  score: number;
  detail: string;
}

interface HealthDimension {
  key: string;
  label: string;
  score: number;
  confidence: number;
  summary: string;
  drivers: HealthDriver[];
}

const HEALTH_DEFAULT_LIMIT = 2_000;
const HEALTH_MAX_LIMIT = 10_000;

function healthDriver(
  key: string,
  label: string,
  value: number | undefined,
  weight: number,
  detail: string,
): HealthDriver {
  const score =
    value === undefined ? 50 : scoreFromFloat(Math.max(0, Math.min(1, value)) * 100);
  return { key, label, value, weight, score, detail };
}

function healthDimension(
  key: string,
  label: string,
  summary: string,
  drivers: HealthDriver[],
  confidence: number,
): HealthDimension {
  return { key, label, score: weightedDriverScore(drivers), confidence, summary, drivers };
}

function evalSuccessRateByKind(
  cases: readonly EvalCaseResult[],
  kind: EvalSuiteKind,
): number | undefined {
  let total = 0;
  let passed = 0;
  for (const c of cases) {
    if (c.suite_kind === kind) {
      total += 1;
      if (c.outcome === "success") passed += 1;
    }
  }
  return ratio(passed, total);
}

function errorHotspots(runs: readonly ObservedRun[], limit: number): JsonValue {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (isBadOutcome(run.outcome)) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
  }
  const rows = [...counts.entries()];
  // Rust: sort by errors desc, then name asc.
  rows.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows.slice(0, limit).map(([name, errors]) => ({ name, errors }));
}

function observedEvidenceKind(kind: ObservedRunKind): string {
  switch (kind) {
    case "agent":
      return "agent_run";
    case "subagent":
      return "subagent_run";
    case "eval":
      return "eval_run";
    case "tool":
      return "tool_run";
    case "provider":
      return "provider_run";
    case "other":
      return "observed_run";
  }
}

/**
 * Build the `harness.health` payload from the three local stores. Mirrors the
 * `HarnessHealthTool::invoke` output verbatim so dashboards / scripts can use
 * the chat path or this REST path interchangeably.
 */
function buildHealthPayload(
  obsRuns: readonly ObservedRun[],
  evalCases: readonly EvalCaseResult[],
  requirementRuns: readonly RequirementRun[],
  sources: { observability: HealthSourceStatus; evals: HealthSourceStatus; requirementRuns: HealthSourceStatus },
  includeEvidence: boolean,
): Record<string, unknown> {
  const facts = new CapabilityFacts(obsRuns, evalCases, requirementRuns);

  const dimensions: HealthDimension[] = [
    healthDimension(
      "task_understanding",
      "Task understanding",
      "Goal, constraints, and acceptance criteria comprehension",
      [
        healthDriver(
          "capability_eval_pass_rate",
          "Capability eval pass rate",
          facts.capabilityEvalPassRate() ?? facts.evalPassRate(),
          0.4,
          "Repeatable eval cases targeting task comprehension",
        ),
        healthDriver(
          "verification_pass_rate",
          "Verification pass rate",
          facts.verificationPassRate(),
          0.25,
          "Requirement runs whose verification checks passed",
        ),
        healthDriver(
          "completion_rate",
          "Completion rate",
          facts.completionRate(),
          0.2,
          "Terminal requirement runs that reached completed",
        ),
        healthDriver(
          "misunderstanding_free_rate",
          "Misunderstanding-free rate",
          evalFailureFreeRate(facts.evalCases, [
            "understanding",
            "instruction",
            "constraint",
            "acceptance",
          ]),
          0.15,
          "Eval cases not classified as instruction, constraint, or acceptance misses",
        ),
      ],
      confidenceFor(facts, 0.45, 0.25, 0.2, 0.1),
    ),
    healthDimension(
      "planning_execution",
      "Planning execution",
      "Decomposition, sequencing, and terminal-state discipline",
      [
        healthDriver(
          "terminal_rate",
          "Terminal-state rate",
          facts.terminalRate(),
          0.25,
          "Runs that leave pending/running and settle into a terminal state",
        ),
        healthDriver(
          "completion_rate",
          "Execution completion rate",
          facts.completionRate(),
          0.3,
          "Terminal requirement runs that completed successfully",
        ),
        healthDriver(
          "timeout_free_rate",
          "Timeout/max-iteration avoidance",
          facts.timeoutFreeRate(),
          0.25,
          "Runs that did not hit timeout or max-iteration boundaries",
        ),
        healthDriver(
          "agent_success_rate",
          "Observed agent success",
          successRate(facts.agentRuns) ?? successRate(facts.obsRuns),
          0.2,
          "Observed Jarvis agent runs marked successful",
        ),
      ],
      confidenceFor(facts, 0.15, 0.15, 0.55, 0.15),
    ),
    healthDimension(
      "capability_invocation",
      "Capability invocation",
      "Tool and SubAgent selection effectiveness",
      (() => {
        const latencyEfficiency =
          latencyScore(durationPercentile(facts.obsRuns, 0.95), 20_000, 180_000) / 100;
        const subagentSuccess = successRate(facts.subagentRuns);
        const delegationVisibility =
          facts.subagentRuns.length > 0
            ? (subagentSuccess ?? 0) * 0.7 +
              (latencyScore(durationPercentile(facts.subagentRuns, 0.95), 30_000, 180_000) / 100) *
                0.3
            : undefined;
        return [
          healthDriver(
            "tool_success_rate",
            "Tool success rate",
            successRate(facts.toolRuns),
            0.35,
            "Observed tool calls that completed without error",
          ),
          healthDriver(
            "subagent_success_rate",
            "SubAgent success rate",
            subagentSuccess,
            0.25,
            "Delegated worker runs that completed successfully",
          ),
          healthDriver(
            "agent_recovery_rate",
            "Agent recovery proxy",
            successRate(facts.agentRuns) ?? successRate(facts.obsRuns),
            0.2,
            "Agent run success after using available capabilities",
          ),
          healthDriver(
            "latency_efficiency",
            "Latency efficiency",
            latencyEfficiency,
            0.1,
            "P95 latency converted into an efficiency score",
          ),
          healthDriver(
            "delegation_visibility",
            "Delegation visibility",
            delegationVisibility,
            0.1,
            "Whether SubAgent paths are exercised and successful",
          ),
        ];
      })(),
      confidenceFor(facts, 0.45, 0.2, 0.1, 0.25),
    ),
    healthDimension(
      "task_delivery",
      "Task delivery",
      "Verifiable completed work production",
      [
        healthDriver(
          "completion_rate",
          "Completion rate",
          facts.completionRate(),
          0.35,
          "Terminal requirement runs that reached completed",
        ),
        healthDriver(
          "verification_pass_rate",
          "Verification pass rate",
          facts.verificationPassRate(),
          0.3,
          "Attached verification results that passed",
        ),
        healthDriver(
          "regression_eval_pass_rate",
          "Regression eval pass rate",
          evalSuccessRateByKind(facts.evalCases, "regression") ?? facts.evalPassRate(),
          0.2,
          "Regression suites that still pass",
        ),
        healthDriver(
          "verification_coverage",
          "Verification coverage",
          facts.verificationCoverage(),
          0.1,
          "Terminal runs with attached verification evidence",
        ),
        healthDriver(
          "failure_free_rate",
          "Failure-free terminal rate",
          ratio(
            Math.max(0, facts.terminalRuns.length - (facts.failedRuns + facts.cancelledRuns)),
            facts.terminalRuns.length,
          ),
          0.05,
          "Terminal runs not marked failed or cancelled",
        ),
      ],
      confidenceFor(facts, 0.2, 0.25, 0.45, 0.1),
    ),
  ];

  let overallScore = scoreFromFloat(
    dimensions.reduce((acc, d) => acc + d.score, 0) / dimensions.length,
  );
  const delivery = dimensions.find((d) => d.key === "task_delivery");
  if (delivery !== undefined && delivery.score < 60) overallScore = Math.min(overallScore, 69);
  const confidence =
    average(
      dimensions.reduce((acc, d) => acc + d.confidence, 0),
      dimensions.length,
    ) ?? 0;

  // primary_focus: first dimension with the minimum score (min_by_key keeps
  // the earlier element on ties).
  let primaryFocus = "observability";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const d of dimensions) {
    if (d.score < bestScore) {
      bestScore = d.score;
      primaryFocus = d.key;
    }
  }

  const scoreOf = (key: string): number => dimensions.find((d) => d.key === key)?.score ?? 50;
  const actions: JsonValue[] = [];
  if (scoreOf("task_delivery") < 70) {
    actions.push({
      key: "stabilize_delivery_gate",
      priority: 1,
      tone: "danger",
      title: "优先稳定交付闭环",
      why: "交付分低时，新增能力会放大不确定性。先让 run 能完成、验证能通过、失败能归因。",
      metric: `completed ${facts.completedRuns}/terminal ${facts.terminalRuns.length}`,
      next_steps: [
        "为失败最多的 RequirementRun 补明确验收条件",
        "把 verification failed/timeout 的错误文本归类",
        "新增 regression eval 覆盖已修复失败",
      ],
    });
  }
  if (scoreOf("planning_execution") < 70) {
    actions.push({
      key: "reduce_timeout_and_iteration_failures",
      priority: 2,
      tone: "warn",
      title: "收敛规划执行失败",
      why: "timeout/max-iteration 通常说明拆解粒度、停止条件或工具等待策略不稳定。",
      metric: `timeout_like ${facts.timeoutLike}, max_iteration_like ${facts.maxIterationLike}`,
      next_steps: [
        "把长任务拆成可验证的子 Requirement",
        "为自动调度增加 max-iteration 前的中间保存点",
        "审计耗时最高的 agent/tool/subagent span",
      ],
    });
  }
  if (scoreOf("capability_invocation") < 75) {
    actions.push({
      key: "tune_tools_and_subagents",
      priority: 3,
      tone: "warn",
      title: "优化工具与 SubAgent 调用",
      why: "工具和 SubAgent 是 harness 放大能力的主要路径，失败率或不可见会直接影响方向判断。",
      metric: `tools ${facts.toolRuns.length}, subagents ${facts.subagentRuns.length}`,
      next_steps: [
        "修复错误最多的 tool schema/timeout/recoverable error text",
        "为 Claude Code/Codex delegation 加 smoke eval",
        "记录每次 SubAgent 的输入目标、退出原因和产物证据",
      ],
    });
  }
  if (scoreOf("task_understanding") < 70) {
    actions.push({
      key: "sharpen_task_acceptance",
      priority: 4,
      tone: "warn",
      title: "强化任务理解与验收表达",
      why: "理解力不足时，后续规划和工具调用即使成功也可能交付错目标。",
      metric: `capability eval cases ${facts.evalCases.length}`,
      next_steps: [
        "新增 ambiguous/constraint/acceptance 类 capability eval",
        "把用户需求拆成 objective、constraints、acceptance 三段记录",
        "用真实失败案例生成最小复现 eval",
      ],
    });
  }
  if (facts.sampleCount < 30 || facts.evalCases.length === 0 || facts.subagentRuns.length === 0) {
    actions.push({
      key: "fill_signal_gaps",
      priority: 5,
      tone: "neutral",
      title: "补齐观测样本",
      why: "样本不足会让优化方向偏向个案；至少需要 run、tool、SubAgent、eval 四类信号。",
      metric: `sample_count ${facts.sampleCount}`,
      next_steps: [
        "保持 JARVIS_OBSERVABILITY_STORE_URL 与 JARVIS_EVAL_STORE_URL 开启",
        "跑一组覆盖自动调度、工具调用、SubAgent 委派的真实案例",
        "把最近失败 run 转成 eval baseline",
      ],
    });
  }
  actions.sort(
    (a, b) =>
      ((a as { priority: number }).priority ?? 99) - ((b as { priority: number }).priority ?? 99),
  );
  const trimmedActions = actions.slice(0, 5);

  const signals: JsonValue = {
    observed_runs: facts.obsRuns.length,
    agent_runs: facts.agentRuns.length,
    tool_runs: facts.toolRuns.length,
    subagent_runs: facts.subagentRuns.length,
    eval_cases: facts.evalCases.length,
    requirement_runs: facts.requirementRuns.length,
    terminal_requirement_runs: facts.terminalRuns.length,
    completed_requirement_runs: facts.completedRuns,
    failed_requirement_runs: facts.failedRuns,
    cancelled_requirement_runs: facts.cancelledRuns,
    verified_requirement_runs: facts.verifiedRuns,
    verification_passed: facts.verificationPassed,
    agent_success_rate: successRate(facts.agentRuns) ?? null,
    tool_success_rate: successRate(facts.toolRuns) ?? null,
    subagent_success_rate: successRate(facts.subagentRuns) ?? null,
    eval_pass_rate: facts.evalPassRate() ?? null,
    completion_rate: facts.completionRate() ?? null,
    verification_pass_rate: facts.verificationPassRate() ?? null,
    p95_latency_ms: durationPercentile(facts.obsRuns, 0.95) ?? null,
    error_hotspots: errorHotspots(facts.obsRuns, 5),
  };

  const evidence: JsonValue[] = [];
  if (includeEvidence) {
    for (const run of facts.requirementRuns
      .filter((r) => r.status === "failed" || r.status === "cancelled")
      .slice(0, 5)) {
      const e = requirementRunEvidence(run);
      evidence.push({
        kind: e.kind,
        id: e.id,
        title: e.title,
        detail: e.detail,
        ...(e.metric !== undefined ? { metric: e.metric } : {}),
        tone: e.tone,
      });
    }
    for (const c of facts.evalCases.filter((x) => x.outcome !== "success").slice(0, 5)) {
      evidence.push({
        kind: "eval_case",
        id: c.id,
        title: c.scenario,
        detail: c.failure_class !== undefined ? jsonKey(c.failure_class) : jsonKey(c.outcome),
        metric: `${c.suite} / ${jsonKey(c.suite_kind)}`,
        tone: "danger",
      });
    }
    for (const run of facts.obsRuns.filter((r) => isBadOutcome(r.outcome)).slice(0, 5)) {
      evidence.push({
        kind: observedEvidenceKind(run.kind),
        id: run.id,
        title: run.name,
        detail: jsonKey(run.outcome),
        ...(run.duration_ms !== undefined ? { metric: `${run.duration_ms}ms` } : {}),
        tone: "danger",
      });
    }
  }
  const trimmedEvidence = evidence.slice(0, 12);

  const sourceStatus = (s: HealthSourceStatus): JsonValue => ({
    configured: s.configured,
    rows: s.rows,
    ...(s.error !== undefined ? { error: s.error } : {}),
  });

  return {
    tool: "harness.health",
    generated_at: new Date().toISOString(),
    overall_score: overallScore,
    confidence,
    sample_count: facts.sampleCount,
    primary_focus: primaryFocus,
    dimensions,
    signals,
    actions: trimmedActions,
    evidence: trimmedEvidence,
    sources: {
      observability: sourceStatus(sources.observability),
      evals: sourceStatus(sources.evals),
      requirement_runs: sourceStatus(sources.requirementRuns),
    },
    rules: {
      scale: "0-100",
      overall:
        "average(task_understanding, planning_execution, capability_invocation, task_delivery); capped at 69 when task_delivery < 60",
      confidence: "ln(sample_count + 1) / ln(31) multiplied by available signal coverage",
      dimension_weights: {
        task_understanding: {
          capability_eval_pass_rate: 0.4,
          verification_pass_rate: 0.25,
          completion_rate: 0.2,
          misunderstanding_free_rate: 0.15,
        },
        planning_execution: {
          terminal_rate: 0.25,
          completion_rate: 0.3,
          timeout_free_rate: 0.25,
          agent_success_rate: 0.2,
        },
        capability_invocation: {
          tool_success_rate: 0.35,
          subagent_success_rate: 0.25,
          agent_recovery_rate: 0.2,
          latency_efficiency: 0.1,
          delegation_visibility: 0.1,
        },
        task_delivery: {
          completion_rate: 0.35,
          verification_pass_rate: 0.3,
          regression_eval_pass_rate: 0.2,
          verification_coverage: 0.1,
          failure_free_rate: 0.05,
        },
      },
    },
  };
}

// ------------------------------ load helpers ------------------------------

async function loadObservedRuns(
  store: ObservabilityStore | undefined,
  limit: number,
): Promise<[ObservedRun[], HealthSourceStatus]> {
  if (store === undefined) return [[], { configured: false, rows: 0 }];
  try {
    const rows = await store.listRuns({ limit });
    return [rows, { configured: true, rows: rows.length }];
  } catch (e) {
    return [[], { configured: true, rows: 0, error: errorText(e) }];
  }
}

async function loadEvalCases(
  store: EvalStore | undefined,
  limit: number,
): Promise<[EvalCaseResult[], HealthSourceStatus]> {
  if (store === undefined) return [[], { configured: false, rows: 0 }];
  try {
    const rows = await store.listCaseResults({ limit });
    return [rows, { configured: true, rows: rows.length }];
  } catch (e) {
    return [[], { configured: true, rows: 0, error: errorText(e) }];
  }
}

async function loadRequirementRuns(
  store: RequirementRunStore | undefined,
  limit: number,
): Promise<[RequirementRun[], HealthSourceStatus]> {
  if (store === undefined) return [[], { configured: false, rows: 0 }];
  try {
    const rows = await store.listAll(limit);
    return [rows, { configured: true, rows: rows.length }];
  } catch (e) {
    return [[], { configured: true, rows: 0, error: errorText(e) }];
  }
}

// ------------------------------ registration ------------------------------

export function registerObservabilityRoutes(app: FastifyInstance, state: AppState): void {
  // GET /v1/observability/exporter — OTLP exporter status. Always 200 (mirrors
  // Rust's `unwrap_or_default`); returns the default snapshot because the Node
  // AppState carries no telemetry field yet.
  app.get("/v1/observability/exporter", async (_req, reply) => {
    return reply.send(defaultExporterStatus());
  });

  // GET /v1/observability/dashboard?window=<label>
  app.get("/v1/observability/dashboard", async (req, reply) => {
    if (state.observability === undefined) {
      return unavailable(reply, "observability store not configured");
    }
    const q = (req.query ?? {}) as { window?: string };
    const window = parseStr(q.window) ?? "24h";
    try {
      const snapshot = await state.observability.dashboard({ label: window });
      return reply.send(snapshot);
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // GET /v1/observability/runs?kind=&name=&outcome=&project_id=&limit=
  app.get("/v1/observability/runs", async (req, reply) => {
    if (state.observability === undefined) {
      return unavailable(reply, "observability store not configured");
    }
    const q = (req.query ?? {}) as { [k: string]: unknown };
    const limit = Math.min(parseLimit(q.limit) ?? 50, 500);
    const filter: ObservabilityFilter = { limit };
    const kind = parseRunKind(q.kind);
    if (kind !== undefined) filter.kind = kind;
    const name = parseStr(q.name);
    if (name !== undefined) filter.name = name;
    const outcome = parseOutcome(q.outcome);
    if (outcome !== undefined) filter.outcome = outcome;
    const projectId = parseStr(q.project_id);
    if (projectId !== undefined) filter.project_id = projectId;
    try {
      const runs = await state.observability.listRuns(filter);
      return reply.send({ runs });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // GET /v1/observability/tools?limit=
  app.get("/v1/observability/tools", async (req, reply) => {
    if (state.observability === undefined) {
      return unavailable(reply, "observability store not configured");
    }
    const q = (req.query ?? {}) as { limit?: unknown };
    return listKindSummary(state.observability, "tool", "tools", parseLimit(q.limit), reply);
  });

  // GET /v1/observability/subagents?limit=
  app.get("/v1/observability/subagents", async (req, reply) => {
    if (state.observability === undefined) {
      return unavailable(reply, "observability store not configured");
    }
    const q = (req.query ?? {}) as { limit?: unknown };
    return listKindSummary(
      state.observability,
      "subagent",
      "subagents",
      parseLimit(q.limit),
      reply,
    );
  });

  // GET /v1/observability/direction?limit=
  app.get("/v1/observability/direction", async (req, reply) => {
    if (state.observability === undefined) {
      return unavailable(reply, "observability store not configured");
    }
    const q = (req.query ?? {}) as { limit?: unknown };
    const scanLimit = Math.min(parseLimit(q.limit) ?? 2_000, 10_000);
    let runs: ObservedRun[];
    try {
      runs = await state.observability.listRuns({ limit: scanLimit });
    } catch (e) {
      return internalError(reply, e);
    }
    let evalCases: EvalCaseResult[] | undefined;
    if (state.evals !== undefined) {
      try {
        evalCases = await state.evals.listCaseResults({ limit: scanLimit });
      } catch (e) {
        return internalError(reply, e);
      }
    }
    return reply.send(directionSnapshot(runs, evalCases));
  });

  // GET /v1/observability/capability-score?limit=
  app.get("/v1/observability/capability-score", async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: unknown };
    const scanLimit = Math.min(parseLimit(q.limit) ?? 2_000, 10_000);

    let obsRuns: ObservedRun[] = [];
    if (state.observability !== undefined) {
      try {
        obsRuns = await state.observability.listRuns({ limit: scanLimit });
      } catch (e) {
        return internalError(reply, e);
      }
    }
    let evalCases: EvalCaseResult[] = [];
    if (state.evals !== undefined) {
      try {
        evalCases = await state.evals.listCaseResults({ limit: scanLimit });
      } catch (e) {
        return internalError(reply, e);
      }
    }
    let requirementRuns: RequirementRun[] = [];
    if (state.requirementRuns !== undefined) {
      try {
        requirementRuns = await state.requirementRuns.listAll(scanLimit);
      } catch (e) {
        return internalError(reply, e);
      }
    }

    if (
      obsRuns.length === 0 &&
      evalCases.length === 0 &&
      requirementRuns.length === 0 &&
      state.observability === undefined &&
      state.evals === undefined &&
      state.requirementRuns === undefined
    ) {
      return unavailable(reply, "capability scoring stores not configured");
    }

    return reply.send(capabilityScoreSnapshot(obsRuns, evalCases, requirementRuns));
  });

  // GET /v1/observability/health?limit=&include_evidence=
  app.get("/v1/observability/health", async (req: FastifyRequest, reply) => {
    if (
      state.observability === undefined &&
      state.evals === undefined &&
      state.requirementRuns === undefined
    ) {
      return unavailable(
        reply,
        "no observability / evals / requirement-runs store configured; nothing to summarise",
      );
    }
    const q = (req.query ?? {}) as { limit?: unknown; include_evidence?: unknown };
    const rawLimit = parseLimit(q.limit);
    const limit = Math.max(
      1,
      Math.min(rawLimit ?? HEALTH_DEFAULT_LIMIT, HEALTH_MAX_LIMIT),
    );
    const includeEvidence = parseBool(q.include_evidence) ?? true;

    const [obsRuns, obsSource] = await loadObservedRuns(state.observability, limit);
    const [evalCases, evalSource] = await loadEvalCases(state.evals, limit);
    const [requirementRuns, runSource] = await loadRequirementRuns(state.requirementRuns, limit);

    return reply.send(
      buildHealthPayload(
        obsRuns,
        evalCases,
        requirementRuns,
        { observability: obsSource, evals: evalSource, requirementRuns: runSource },
        includeEvidence,
      ),
    );
  });

  // GET /v1/evals/summary?limit=
  app.get("/v1/evals/summary", async (req, reply) => {
    if (state.evals === undefined) {
      return unavailable(reply, "eval store not configured");
    }
    const q = (req.query ?? {}) as { limit?: unknown };
    const limit = Math.min(parseLimit(q.limit) ?? 2_000, 10_000);
    try {
      const cases = await state.evals.listCaseResults({ limit });
      return reply.send(evalSummary(cases));
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // GET /v1/evals/cases?suite=&suite_kind=&case_id=&outcome=&limit=
  app.get("/v1/evals/cases", async (req, reply) => {
    if (state.evals === undefined) {
      return unavailable(reply, "eval store not configured");
    }
    const q = (req.query ?? {}) as { [k: string]: unknown };
    const limit = Math.min(parseLimit(q.limit) ?? 50, 500);
    const filter: EvalFilter = { limit };
    const suite = parseStr(q.suite);
    if (suite !== undefined) filter.suite = suite;
    const suiteKind = parseSuiteKind(q.suite_kind);
    if (suiteKind !== undefined) filter.suite_kind = suiteKind;
    const caseId = parseStr(q.case_id);
    if (caseId !== undefined) filter.case_id = caseId;
    const outcome = parseOutcome(q.outcome);
    if (outcome !== undefined) filter.outcome = outcome;
    try {
      const cases = await state.evals.listCaseResults(filter);
      return reply.send({ cases });
    } catch (e) {
      return internalError(reply, e);
    }
  });
}
