// Server-side executor for declarative WorkflowDefinitions. Ported from
// harness-server/src/workflow_runtime.rs.
//
// A workflow is a tree of WorkflowSteps. This module walks the tree and
// executes each leaf `agent` step by driving the existing agent loop
// (`state.createAgent().run(conversation)`), never new execution machinery.
//
// Composition of steps mirrors Claude Code's workflow primitives:
//   - pipeline / phase run children sequentially, threading each child's final
//     assistant text forward as `{{ prev }}`.
//   - parallel runs children concurrently (bounded by an in-process semaphore);
//     the JoinPolicy decides whether a child failure fails the group.
//   - agent steps interpolate `{{ prev }}` and `{{ outputs.<key> }}` into their
//     prompt and record their output under `output_key`.
//
// The orchestrator runs at the server layer (calling Agent.run directly), never
// as a tool the agent invokes.
//
// Node adaptations from the Rust source:
//   - The Node AppState exposes `createAgent(approver?)`; it does NOT take a
//     per-step model or session-workspace override yet. So `subagent` / `model`
//     are forward-compat: a step naming either still runs the main agent loop
//     (logged), so a recipe degrades gracefully rather than erroring — mirroring
//     the Rust subagent path.
//   - Rust wraps each step in `tokio::time::timeout`; here we race the agent
//     run against a timer + an AbortSignal (from the run's cancel controller),
//     so a cancelled run actually stops between/within steps.
import { randomUUID } from "node:crypto";

import {
  newConversation,
  systemMessage,
  userMessage,
  lastAssistantText,
  errorText,
  type Agent,
  type Conversation,
} from "@jarvis/core";
import { defaultMetadata, type ConversationMetadata } from "@jarvis/store";
import {
  newActivity,
  linkConversation,
  type ActivityActor,
  type ActivityKind,
  type Requirement,
} from "@jarvis/project";
import {
  finishWorkflowRun,
  newWorkflowRun,
  workflowStepResultOk,
  workflowStepResultFailed,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepResult,
} from "@jarvis/workflow";

import type { AppState } from "./state.ts";
import { WorkflowRunGate } from "./workflow-concurrency.ts";

/**
 * How many `agent` steps may hit the LLM concurrently within one workflow run.
 * Conservative default — parallel steps are an optimisation, not a throughput
 * contract. Mirrors Rust's `MAX_PARALLEL_AGENTS`.
 */
const MAX_PARALLEL_AGENTS = 4;

/** Default cadence (seconds) for the background stale-run reaper. */
export const DEFAULT_WORKFLOW_REAP_SECONDS = 60;

/**
 * Safety multiplier applied to `timeoutMs` before reaping a stuck `running`
 * row. A healthy run's *steps* are each wrapped in a per-step timeout, but a
 * multi-step workflow can legitimately span several step budgets — so we give
 * the whole run 3× headroom (matching the auto loop) before declaring it
 * abandoned. Runs still alive in-process are never reaped regardless of age
 * (the `isActive` check below), so this threshold only ever bites genuinely
 * orphaned rows. Mirrors Rust's `WORKFLOW_RUNNING_STALE_MULTIPLIER`.
 */
const WORKFLOW_RUNNING_STALE_MULTIPLIER = 3;

/** Per-step interpolation map: `output_key` → final assistant text. */
type Outputs = Map<string, string>;

/**
 * Logger surface the runtime emits through. Defaults to the console; tests can
 * pass a silent / capturing logger. Mirrors the Rust `tracing` calls.
 */
export interface WorkflowLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const SILENT_LOGGER: WorkflowLogger = { info: () => {}, warn: () => {} };

const DEFAULT_LOGGER: WorkflowLogger = {
  info: (msg, fields) => console.info(`[workflow] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[workflow] ${msg}`, fields ?? {}),
};

/** Options threading optional collaborators into a single run. */
export interface DriveWorkflowOptions {
  /** Bind the run to a kanban card: seeds the system prompt, links conversations, emits Activity. */
  requirement?: Requirement;
  /** Override the workspace root for this run (forward-compat; not yet applied to the agent). */
  workspaceOverride?: string;
  /** Per-step wall-clock budget in milliseconds. */
  timeoutMs?: number;
  /** Pre-minted run to execute (the manual `/run` route uses this; else one is minted). */
  run?: WorkflowRun;
  /** Cancel signal — aborting it stops the run between / within steps. */
  signal?: AbortSignal;
  /** Logger override (tests pass a silent one). */
  logger?: WorkflowLogger;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Mint a fresh WorkflowRun (unless one is supplied), persist it `running`, and
 * execute the definition to completion. Used by the auto loop (awaited inline)
 * and by the manual `/run` route (spawned). Mirrors Rust's `drive_workflow` +
 * `execute_workflow_run` collapsed into one entry point that accepts a
 * pre-minted run.
 *
 * A workflow whose terminal status is `failed` surfaces by setting `run.error`
 * + status `failed` on the returned run (the auto loop inspects this), but does
 * NOT throw — the route layer reads the run status. The Rust `drive_workflow`
 * returns `Err` for a failed run; here the caller checks `run.status`.
 */
export async function driveWorkflow(
  state: AppState,
  def: WorkflowDefinition,
  opts: DriveWorkflowOptions = {},
): Promise<WorkflowRun> {
  const store = state.workflows;
  if (!store) throw new Error("workflow store missing");

  const logger = opts.logger ?? DEFAULT_LOGGER;
  const requirement = opts.requirement;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Reuse a pre-minted run (manual route) or mint one persisted as `running`.
  const run: WorkflowRun = opts.run ?? newWorkflowRun(def.id, requirement?.id);
  if (!opts.run) {
    try {
      await store.upsertRun(run);
    } catch (e) {
      logger.warn("persist running run failed", { error: errorText(e), workflow_id: def.id });
    }
  }

  // Record this run as alive in-process for its whole duration. The stale-run
  // reaper skips runs in this set, so it never reclaims a run still executing
  // here — only rows orphaned by a crash (whose liveness set died with the
  // process) age out. The guard clears on completion *and* on abort.
  const gate = state.workflowRunGate;
  const inflight = gate?.markInflight(run.id);

  try {
    // Base system prompt: a requirement contributes a context frame; ad-hoc
    // runs get a generic one. (Rust builds a full context manifest via
    // harness-requirement; that builder isn't ported yet, so we use a compact
    // requirement summary — the wire shape of the step results is unaffected.)
    const baseSystem = requirement
      ? requirementSystemPrompt(requirement, def)
      : `You are executing the '${def.name}' workflow. Complete each step's instruction precisely.`;

    if (requirement) {
      await recordActivity(state, requirement.id, "run_started", SYSTEM_ACTOR, {
        workflow: true,
        workflow_id: def.id,
        workflow_run_id: run.id,
      });
    }

    const ctx: Ctx = {
      state,
      baseSystem,
      projectId: requirement?.project_id,
      timeoutMs,
      signal: opts.signal,
      logger,
      sem: new Semaphore(MAX_PARALLEL_AGENTS),
    };

    const outcome = await execSequential(ctx, def.steps, undefined, new Map());
    run.step_results = outcome.results;
    if (opts.signal?.aborted) {
      // Cancelled mid-flight wins over an incidental step failure: a step that
      // failed *because* it observed the abort isn't a real failure. (Rust
      // achieves this by aborting the whole task; the route's cancel handler
      // then writes `cancelled`.)
      run.error = run.error ?? "run cancelled by operator";
      finishWorkflowRun(run, "cancelled");
    } else if (outcome.failed) {
      run.error = run.error ?? "one or more workflow steps failed";
      finishWorkflowRun(run, "failed");
    } else {
      finishWorkflowRun(run, "succeeded");
    }

    try {
      await store.upsertRun(run);
    } catch (e) {
      logger.warn("persist final run failed", { error: errorText(e), workflow_id: def.id });
    }

    // Link every step conversation back onto the requirement and record a
    // finish Activity, so the run shows up in the card's drawers.
    if (requirement && state.requirements) {
      try {
        const latest = await state.requirements.get(requirement.id);
        if (latest) {
          let changed = false;
          for (const r of run.step_results) {
            if (r.conversation_id !== undefined && linkConversation(latest, r.conversation_id)) {
              changed = true;
            }
          }
          if (changed) await state.requirements.upsert(latest);
        }
      } catch (e) {
        logger.warn("link conversations failed", { error: errorText(e) });
      }
    }
    if (requirement) {
      await recordActivity(state, requirement.id, "run_finished", SYSTEM_ACTOR, {
        workflow: true,
        workflow_id: def.id,
        workflow_run_id: run.id,
        status: run.status,
        steps: run.step_results.length,
      });
    }

    return run;
  } finally {
    inflight?.clear();
  }
}

/**
 * Reconcile a run that a spawned executor may have left mid-flight: if the
 * persisted run is still `running`, flip it to `failed` so a crash (whose
 * terminal-status write never ran) can't leave it hanging forever. No-op when
 * the store is absent or the run already reached a terminal state. Mirrors
 * Rust's `fail_run_if_running`.
 */
export async function failRunIfRunning(
  state: AppState,
  runId: string,
  error: string,
  logger: WorkflowLogger = DEFAULT_LOGGER,
): Promise<void> {
  const store = state.workflows;
  if (!store) return;
  let run: WorkflowRun | undefined;
  try {
    run = await store.getRun(runId);
  } catch (e) {
    logger.warn("reconcile panicked run failed", { error: errorText(e), run_id: runId });
    return;
  }
  if (!run || run.status !== "running") return;
  run.error = error;
  finishWorkflowRun(run, "failed");
  try {
    await store.upsertRun(run);
  } catch (e) {
    logger.warn("persist panicked run failed", { error: errorText(e), run_id: runId });
  }
}

// ---------- execution context + step walk ----------------------------------

interface Ctx {
  state: AppState;
  baseSystem: string;
  projectId: string | undefined;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  logger: WorkflowLogger;
  sem: Semaphore;
}

/** Accumulated result of executing a step (or a group of steps). */
interface ExecResult {
  /** Flattened leaf results in execution order. */
  results: WorkflowStepResult[];
  /** Final assistant text of the last leaf — threaded as `{{ prev }}`. */
  lastOutput: string | undefined;
  /** `output_key` → output bindings produced by this subtree. */
  produced: Array<[string, string]>;
  /** `true` when a hard failure occurred that should stop a sequential parent. */
  failed: boolean;
}

function emptyResult(): ExecResult {
  return { results: [], lastOutput: undefined, produced: [], failed: false };
}

/**
 * Run `steps` in order, threading `prev` and accumulating `outputs`. Stops at
 * the first failed step (downstream steps usually depend on upstream output).
 * Mirrors Rust's `exec_sequential`.
 */
async function execSequential(
  ctx: Ctx,
  steps: WorkflowStep[],
  prev: string | undefined,
  outputs: Outputs,
): Promise<ExecResult> {
  const acc = emptyResult();
  let cursor = prev;
  for (const step of steps) {
    const r = await execStep(ctx, step, cursor, outputs);
    for (const [k, v] of r.produced) outputs.set(k, v);
    acc.produced.push(...r.produced);
    acc.results.push(...r.results);
    if (r.lastOutput !== undefined) {
      cursor = r.lastOutput;
      acc.lastOutput = r.lastOutput;
    }
    if (r.failed) {
      acc.failed = true;
      break;
    }
  }
  return acc;
}

/** Dispatch one step by kind. Mirrors Rust's `exec_step`. */
async function execStep(
  ctx: Ctx,
  step: WorkflowStep,
  prev: string | undefined,
  outputs: Outputs,
): Promise<ExecResult> {
  const kind = step.kind;
  switch (kind.type) {
    case "agent":
      return execAgent(ctx, step, kind.prompt, kind.subagent, kind.model, kind.output_key, prev, outputs);
    case "pipeline":
      return execSequential(ctx, kind.steps, prev, new Map(outputs));
    case "phase":
      ctx.logger.info("entering phase", { phase: kind.title });
      return execSequential(ctx, kind.steps, prev, new Map(outputs));
    case "parallel":
      return execParallel(ctx, kind.steps, prev, new Map(outputs), kind.join);
  }
}

/**
 * Run children concurrently. All children see the same incoming `prev` +
 * `outputs` snapshot; their `output_key`s are merged after the join
 * (last-writer-wins on collisions). Mirrors Rust's `exec_parallel`.
 */
async function execParallel(
  ctx: Ctx,
  steps: WorkflowStep[],
  prev: string | undefined,
  outputs: Outputs,
  join: "all_required" | "best_effort",
): Promise<ExecResult> {
  // All children see the same snapshot; pass per-child clones so a child's
  // own produced keys don't leak sideways into a sibling mid-flight.
  const childResults = await Promise.all(
    steps.map((s) => execStep(ctx, s, prev, new Map(outputs))),
  );

  const acc = emptyResult();
  let anyFailed = false;
  for (const r of childResults) {
    acc.results.push(...r.results);
    acc.produced.push(...r.produced);
    if (r.failed) anyFailed = true;
  }
  // Parallel groups don't thread a single `prev` downstream.
  acc.lastOutput = undefined;
  acc.failed = join === "all_required" && anyFailed;
  return acc;
}

/**
 * The leaf: drive one agent turn. The subagent path is forward-compat — a step
 * that names a subagent still runs the main agent loop (logged), so the recipe
 * degrades gracefully rather than erroring. Mirrors Rust's `exec_agent`.
 */
async function execAgent(
  ctx: Ctx,
  step: WorkflowStep,
  prompt: string,
  subagent: string | undefined,
  model: string | undefined,
  outputKey: string | undefined,
  prev: string | undefined,
  outputs: Outputs,
): Promise<ExecResult> {
  // Bound how many agent loops run concurrently across the run.
  const permit = await ctx.sem.acquire();
  try {
    // Bail before doing any work if the run was already cancelled.
    if (ctx.signal?.aborted) {
      return single(workflowStepResultFailed(step, undefined, "run cancelled by operator"));
    }
    if (subagent) {
      ctx.logger.info("subagent delegation not yet wired; running main agent", {
        subagent,
        step: step.name,
      });
    }
    if (model) {
      ctx.logger.info("per-step model override not yet wired; using run default", {
        model,
        step: step.name,
      });
    }

    const rendered = renderTemplate(prompt, prev, outputs);
    const conversationId = randomUUID();
    const conv: Conversation = newConversation();
    conv.messages.push(systemMessage(ctx.baseSystem));
    conv.messages.push(userMessage(rendered));
    const metadata: ConversationMetadata = {
      ...defaultMetadata(),
      project_id: ctx.projectId ?? null,
    };

    let agent: Agent;
    try {
      agent = ctx.state.createAgent();
    } catch (e) {
      // Build failed before the conversation was persisted — nothing to orphan.
      return single(workflowStepResultFailed(step, undefined, `agent build: ${errorText(e)}`));
    }

    // Persist the initial conversation only once we hold a runnable agent, so a
    // build failure can't leave an orphaned envelope no step result references.
    if (ctx.state.store) {
      try {
        await ctx.state.store.saveEnvelope(conversationId, conv, metadata);
      } catch (e) {
        ctx.logger.warn("save conversation failed", { error: errorText(e) });
      }
    }

    const result = await runWithTimeout(agent, conv, ctx.timeoutMs, ctx.signal);

    if (result.kind === "ok") {
      if (ctx.state.store) {
        try {
          await ctx.state.store.saveEnvelope(conversationId, conv, metadata);
        } catch (e) {
          ctx.logger.warn("re-save conversation failed", { error: errorText(e) });
        }
      }
      const output = lastAssistantText(conv) ?? "";
      const acc = emptyResult();
      acc.lastOutput = output;
      acc.results.push(workflowStepResultOk(step, conversationId, output));
      if (outputKey !== undefined) acc.produced.push([outputKey, output]);
      return acc;
    }
    if (result.kind === "timeout") {
      return single(
        workflowStepResultFailed(step, conversationId, `agent timed out after ${ctx.timeoutMs}ms`),
      );
    }
    if (result.kind === "cancelled") {
      return single(workflowStepResultFailed(step, conversationId, "run cancelled by operator"));
    }
    return single(workflowStepResultFailed(step, conversationId, `agent error: ${result.error}`));
  } finally {
    permit.release();
  }
}

type RunResult =
  | { kind: "ok" }
  | { kind: "error"; error: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/**
 * Run the agent, racing against a per-step timer and the run-cancel signal.
 * `agent.run` mutates `conv` in place. On timeout / cancel we abort an internal
 * `AbortController` that is threaded into `agent.run`, so the loop actually
 * halts — it stops issuing further `llm.complete` calls and, critically, stops
 * invoking side-effecting tools (`fs.write` / `shell.exec` / …) — rather than
 * merely being abandoned to keep mutating the workspace in the background.
 * Mirrors Rust's `tokio::time::timeout` wrap plus the cancellation Rust
 * achieves via task abort.
 */
async function runWithTimeout(
  agent: Agent,
  conv: Conversation,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const cancel = new Promise<RunResult>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      controller.abort();
      resolve({ kind: "cancelled" });
      return;
    }
    onAbort = () => {
      controller.abort();
      resolve({ kind: "cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const run = agent
    .run(conv, controller.signal)
    .then((): RunResult => ({ kind: "ok" }))
    // Once we've aborted, the loop's AbortError is the expected consequence of
    // the timeout/cancel that already won the race — don't surface it as a
    // distinct error (the winning promise reports the real terminal reason).
    .catch((e): RunResult => (controller.signal.aborted ? { kind: "ok" } : { kind: "error", error: errorText(e) }));

  try {
    return await Promise.race([run, timeout, cancel]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Wrap a single (failed or ok) step result into an ExecResult. */
function single(result: WorkflowStepResult): ExecResult {
  return {
    results: [result],
    lastOutput: undefined,
    produced: [],
    failed: result.status === "failed",
  };
}

/**
 * Interpolate `{{ prev }}` and `{{ outputs.<key> }}` into a prompt. Both spaced
 * (`{{ prev }}`) and tight (`{{prev}}`) forms are honoured. Unknown
 * placeholders are left untouched. Mirrors Rust's `render_template`.
 */
export function renderTemplate(
  prompt: string,
  prev: string | undefined,
  outputs: Outputs,
): string {
  let out = prompt;
  const prevVal = prev ?? "";
  out = out.split("{{ prev }}").join(prevVal).split("{{prev}}").join(prevVal);
  for (const [key, value] of outputs) {
    out = out.split(`{{ outputs.${key} }}`).join(value).split(`{{outputs.${key}}}`).join(value);
  }
  return out;
}

// ---------- stale-run reaper -------------------------------------------------

/**
 * Sweep the workflow run store and reclaim runs stuck `running` / `pending`
 * past their wall-clock budget — the orphans left behind when a process is
 * killed mid-run (issue #78). Such a row would otherwise stay `running`
 * forever, since the task that owned it died without writing a terminal status.
 *
 * Skips any run still alive in *this* process (present in the
 * {@link WorkflowRunGate} liveness set) — those finalize themselves. Returns
 * the number of rows reclaimed. No-ops (returns 0) when the store is absent.
 *
 * Orphans are flipped to `cancelled` (the neutral "we gave up on this row"
 * state), not `failed` — we don't know what happened to the dead task, only
 * that it never finished. Mirrors Rust's `reap_stale_workflow_runs`.
 */
export async function reapStaleWorkflowRuns(
  state: AppState,
  timeoutMs: number,
  logger: WorkflowLogger = DEFAULT_LOGGER,
): Promise<number> {
  const store = state.workflows;
  if (!store) return 0;
  let runs: WorkflowRun[];
  try {
    runs = await store.listRuns(undefined, undefined);
  } catch (e) {
    logger.warn("reaper: list_runs failed; skipping sweep", { error: errorText(e) });
    return 0;
  }
  const budget = Math.max(1, timeoutMs);
  const runningThreshold = budget * WORKFLOW_RUNNING_STALE_MULTIPLIER;
  const gate = state.workflowRunGate;
  let reaped = 0;
  for (const run of runs) {
    let threshold: number;
    if (run.status === "pending") threshold = budget;
    else if (run.status === "running") threshold = runningThreshold;
    else continue;

    // Still executing here — leave it alone; it'll finalize itself.
    if (gate?.isActive(run.id)) continue;
    if (!workflowRunIsStale(run, threshold)) continue;

    const prior = run.status;
    if (run.error === undefined) {
      run.error = "stuck workflow run reclaimed (assumed abandoned after process restart)";
    }
    finishWorkflowRun(run, "cancelled");
    try {
      await store.upsertRun(run);
    } catch (e) {
      logger.warn("reaper: persist failed", { run_id: run.id, error: errorText(e) });
      continue;
    }
    logger.warn("reaper reclaimed stale in-flight run", {
      run_id: run.id,
      prior_status: prior,
      threshold_ms: threshold,
    });
    reaped += 1;
  }
  return reaped;
}

/**
 * `true` when `run`'s age exceeds `thresholdMs`. A run whose `started_at`
 * doesn't parse is treated as *not* stale (we'd rather leave a malformed row
 * than reap it on a parse error). Mirrors Rust's `workflow_run_is_stale`.
 */
function workflowRunIsStale(run: WorkflowRun, thresholdMs: number): boolean {
  const startedAt = Date.parse(run.started_at);
  if (Number.isNaN(startedAt)) return false;
  const ageMs = Date.now() - startedAt;
  return ageMs > thresholdMs;
}

/** Handle to a running reaper loop; call {@link ReaperHandle.stop} to halt it. */
export interface ReaperHandle {
  stop(): void;
}

/**
 * Spawn the background workflow stale-run reaper: one sweep immediately
 * (catching orphans left by a prior process), then every `tickSeconds`.
 * Returns a no-op handle (and never schedules) when the store is absent.
 * `tickSeconds` and `timeoutMs` are both clamped to ≥1. Mirrors Rust's
 * `spawn_workflow_reaper`.
 */
export function spawnWorkflowReaper(
  state: AppState,
  tickSeconds: number,
  timeoutMs: number,
  logger: WorkflowLogger = DEFAULT_LOGGER,
): ReaperHandle {
  if (!state.workflows) {
    return { stop: () => {} };
  }
  const tick = Math.max(1, tickSeconds);
  logger.info("stale-run reaper started", { tick_seconds: tick, timeout_ms: timeoutMs });

  let stopped = false;
  const sweep = async (): Promise<void> => {
    if (stopped) return;
    const reaped = await reapStaleWorkflowRuns(state, timeoutMs, logger);
    if (reaped > 0) logger.info("reaper reclaimed stale runs", { count: reaped });
  };
  // One immediate sweep, then on an interval.
  void sweep();
  const handle = setInterval(() => void sweep(), tick * 1000);
  // Don't keep the process alive solely for the reaper.
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

// ---------- helpers ----------------------------------------------------------

const SYSTEM_ACTOR: ActivityActor = { type: "system" };

/**
 * Fire-and-forget audit append. Failures are swallowed (the run still
 * proceeds; losing a telemetry row should never break execution). Mirrors the
 * `record_activity` helper the Rust workflow runtime calls.
 */
async function recordActivity(
  state: AppState,
  requirementId: string,
  kind: ActivityKind,
  actor: ActivityActor,
  body: Record<string, unknown>,
): Promise<void> {
  const store = state.activities;
  if (!store) return;
  try {
    await store.append(newActivity(requirementId, kind, actor, body as never));
  } catch {
    /* tolerate audit-append failure */
  }
}

/**
 * Compact system frame for a requirement-bound run. The Rust runtime builds a
 * full context manifest via `harness-requirement`; that builder isn't ported
 * yet, so we render the requirement's headline + description. The step-result
 * wire shape is unaffected by this difference.
 */
function requirementSystemPrompt(req: Requirement, def: WorkflowDefinition): string {
  const lines = [
    `You are executing the '${def.name}' workflow for requirement: ${req.title}.`,
  ];
  if (req.description && req.description.trim().length > 0) {
    lines.push("", req.description.trim());
  }
  lines.push("", "Complete each step's instruction precisely.");
  return lines.join("\n");
}

/**
 * A tiny counting semaphore bounding concurrent agent loops within one run.
 * `acquire` resolves immediately when a slot is free, else queues FIFO and
 * resolves when a holder releases. Single-threaded → no locking needed.
 */
class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = Math.max(1, permits);
  }

  acquire(): Promise<SemaphorePermit> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#makePermit());
    }
    return new Promise<SemaphorePermit>((resolve) => {
      this.#waiters.push(() => {
        this.#available -= 1;
        resolve(this.#makePermit());
      });
    });
  }

  #makePermit(): SemaphorePermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#available += 1;
        const next = this.#waiters.shift();
        if (next) next();
      },
    };
  }
}

interface SemaphorePermit {
  release(): void;
}

// Re-export so the test file can reference the logger sink without re-deriving.
export { SILENT_LOGGER };
export { WorkflowRunGate };
