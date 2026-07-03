// Background scheduler + on-demand trigger for scheduled automation tasks.
//
// Ported from crates/harness-server/src/automation_runtime.rs. An
// {@link AutomationTask} is a prompt re-run on its {@link ScheduleSpec}; this
// module is the polling driver that picks due tasks each tick, marks them
// `running`, drives the agent loop, and records the outcome — plus the
// process-wide {@link AutomationClaims} reservation set that closes the
// double-fire window between a scheduler tick and a manual trigger.
//
// Node adaptations from the Rust source:
//   - Rust reaches `state.build_agent(provider, model)` to honour per-task
//     provider/model overrides. The Node `AppState.createAgent(approver?)` does
//     not yet take those overrides, so the runtime logs and runs the main agent
//     loop when a task pins a provider/model — a forward-compat seam mirroring
//     the workflow runtime's per-step-model degradation. The exposed
//     {@link AutomationDeps.buildAgent} seam lets the composition root (or a
//     test) supply override-aware construction without this module reading env.
//   - Rust spawns a tokio task per run; here each run is a fire-and-forget
//     async fn whose RAII claim is released in a `finally`.
//   - The scheduler/reaper env knobs (`JARVIS_AUTOMATION_TICK_SECONDS`,
//     `JARVIS_AUTOMATION_RUN_TIMEOUT_MS`) are read by the composition root and
//     passed in as config — this module never touches `process.env`.

import {
  newConversation,
  userMessage,
  errorText,
  type Agent,
  type Conversation,
} from "@jarvis/core";
import { defaultMetadata, type ConversationMetadata, type ConversationStore } from "@jarvis/store";
import {
  isDueAt,
  isStaleRunning,
  markFinished,
  markManualRunStarted,
  markRunning,
  markStaleReclaimed,
  type AutomationStore,
  type AutomationTask,
} from "@jarvis/automation";

// ---------- defaults (mirror the Rust consts) ------------------------------

/** Scheduler poll cadence (seconds). Mirrors `DEFAULT_TICK_SECONDS`. */
export const DEFAULT_AUTOMATION_TICK_SECONDS = 5;

/**
 * Wall-clock budget after which a task still flagged `running` is assumed
 * abandoned and reclaimed. Mirrors `DEFAULT_RUN_TIMEOUT_MS` (10 min).
 */
export const DEFAULT_AUTOMATION_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Safety multiplier applied to the run timeout before reaping a `running` row,
 * so a slow-but-healthy run is never reaped out from under itself. Mirrors
 * `RUNNING_STALE_MULTIPLIER`.
 */
export const RUNNING_STALE_MULTIPLIER = 3;

// ---------- AutomationClaims -----------------------------------------------

/**
 * Process-wide in-memory reservation set guarding against double-firing the
 * same automation. Mirrors Rust's `AutomationClaims` + `AutomationRunClaim`
 * Drop semantics.
 *
 * The persisted `last_run_status === "running"` flag alone cannot close the
 * window between a scheduler tick observing a task as due and the spawned run
 * asynchronously persisting `running`: a second tick (or a manual trigger)
 * firing inside that window re-lists the still-due task and spawns a duplicate
 * run. {@link tryClaim} reserves the id **synchronously** before the spawn, so
 * only one run per automation id can be in flight at a time regardless of how
 * slow the persisted write is.
 */
export class AutomationClaims {
  readonly #active = new Set<string>();

  /**
   * Attempt to reserve `id`. Returns a release function when the id was not
   * already claimed (caller MUST call it exactly once when the run
   * terminates), or `undefined` when a run for this id is already in flight.
   * The release is idempotent so a double-release can't drop a *later* claim
   * for the same id.
   */
  tryClaim(id: string): (() => void) | undefined {
    if (this.#active.has(id)) return undefined;
    this.#active.add(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(id);
    };
  }

  /** Diagnostics: whether an id is currently reserved. */
  isClaimed(id: string): boolean {
    return this.#active.has(id);
  }
}

/**
 * Process-wide default claim set, shared by the scheduler loop and the manual
 * `/v1/automations/:id/run` route so a manual trigger can't race a just-spawned
 * scheduled run. The Rust source threads `state.automation_claims`; since the
 * Node `AppState` does not carry it and must not be edited here, both call
 * sites reach for this module-level singleton — equivalent process-wide
 * behaviour. A test that wants an isolated set passes its own via
 * {@link AutomationDeps.claims}.
 */
export const sharedAutomationClaims = new AutomationClaims();

// ---------- run trigger ----------------------------------------------------

/** Whether a run was started by the scheduler or a manual trigger. */
export type RunTrigger = "schedule" | "manual";

/** `true` when a task is currently flagged `running`. Mirrors Rust `is_running`. */
export function isRunning(task: AutomationTask): boolean {
  return task.last_run_status === "running";
}

// ---------- logger seam ----------------------------------------------------

/** Logger surface the runtime emits through. Mirrors the Rust `tracing` calls. */
export interface AutomationLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_LOGGER: AutomationLogger = {
  info: (msg, fields) => console.info(`[automation] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[automation] ${msg}`, fields ?? {}),
};

/** Silent logger for tests. */
export const SILENT_LOGGER: AutomationLogger = { info: () => {}, warn: () => {} };

// ---------- AutomationDeps --------------------------------------------------

/**
 * The injectable surface the scheduler + on-demand trigger operate over. The
 * automation store is required; the rest are seams the composition root (or a
 * test) supplies.
 */
export interface AutomationDeps {
  /** Persistence for the task rows. Required. */
  automations: AutomationStore;
  /** Optional conversation persistence — threaded runs save into it. */
  store?: ConversationStore;
  /**
   * Build the agent that drives one task's run. Mirrors Rust
   * `state.build_agent(provider, model)`. Provider/model overrides are passed
   * through; an implementation that can't honour them is free to ignore them
   * and build the default agent (forward-compat).
   */
  buildAgent(opts: { provider?: string; model?: string }): Agent;
  /** Reservation set (defaults to {@link sharedAutomationClaims}). */
  claims?: AutomationClaims;
  /** Logger (tests pass {@link SILENT_LOGGER}). */
  logger?: AutomationLogger;
}

function claimsOf(deps: AutomationDeps): AutomationClaims {
  return deps.claims ?? sharedAutomationClaims;
}

// ---------- scheduler config -----------------------------------------------

export interface AutomationSchedulerConfig {
  /** Poll cadence in seconds (clamped to ≥1). */
  tickSeconds?: number;
  /** Per-run wall-clock budget before reaping (clamped to ≥1). */
  runTimeoutMs?: number;
}

// ---------- the tick --------------------------------------------------------

/**
 * One scheduler tick: reap stale `running` rows, then spawn a run for every
 * due, unclaimed task. Returns the number of runs spawned. The spawned runs
 * are fire-and-forget by default; `awaitRuns` (test seam) makes the tick
 * resolve only after they settle so assertions don't need polling. Mirrors the
 * loop body of Rust's `spawn_automation_scheduler`.
 */
export async function automationTick(
  deps: AutomationDeps,
  config: AutomationSchedulerConfig = {},
  opts: { awaitRuns?: boolean; now?: string } = {},
): Promise<number> {
  const logger = deps.logger ?? DEFAULT_LOGGER;
  const claims = claimsOf(deps);
  const runTimeoutMs = Math.max(1, config.runTimeoutMs ?? DEFAULT_AUTOMATION_RUN_TIMEOUT_MS);
  const staleThresholdMs = runTimeoutMs * RUNNING_STALE_MULTIPLIER;
  const now = opts.now ?? new Date().toISOString();
  const awaitRuns = opts.awaitRuns ?? false;

  let tasks: AutomationTask[];
  try {
    tasks = await deps.automations.list();
  } catch (e) {
    logger.warn("automation scheduler list failed", { error: errorText(e) });
    return 0;
  }

  const runs: Promise<void>[] = [];
  let spawned = 0;
  for (const task of tasks) {
    // Reap tasks pinned `running` by a lost worker before evaluating due-ness —
    // without this they never reschedule again.
    let current = task;
    if (isStaleRunning(current, now, staleThresholdMs)) {
      const reclaimed = structuredClone(current);
      markStaleReclaimed(reclaimed, now);
      try {
        await deps.automations.upsert(reclaimed);
        logger.warn("automation reaped stale running task", {
          automation_id: reclaimed.id,
          stale_threshold_ms: staleThresholdMs,
        });
        current = reclaimed;
      } catch (e) {
        logger.warn("automation reaper could not persist reclamation", {
          error: errorText(e),
          automation_id: reclaimed.id,
        });
        continue;
      }
    }

    if (!isDueAt(current, now)) continue;

    // Reserve the id synchronously, before the spawn — closing the TOCTOU
    // window the persisted flag alone cannot.
    const release = claims.tryClaim(current.id);
    if (!release) continue;
    spawned += 1;
    // Mirror the manual trigger path's guard: `runAutomation`'s pre-execute
    // bookkeeping (`structuredClone` / `markRunning`) runs before its inner
    // try/catch, so a throw there rejects this promise. In production these
    // runs are fire-and-forget (`awaitRuns` is false), so without a `.catch`
    // that rejection surfaces as a process-level unhandledRejection and can
    // take the whole server down (#299).
    runs.push(
      runAutomation(deps, current, "schedule", release, config).catch((e) => {
        logger.warn("scheduled automation run rejected", {
          error: errorText(e),
          automation_id: current.id,
        });
      }),
    );
  }

  if (awaitRuns) await Promise.all(runs);
  return spawned;
}

// ---------- the run ---------------------------------------------------------

/**
 * Execute one automation run end to end: mark the task `running` + persist,
 * drive the agent loop, then reload + mark the outcome (succeeded / failed) +
 * persist. The `release` claim is held for the whole run and dropped on exit
 * (success, early-return, or throw). Mirrors Rust's `spawn_automation_run`
 * collapsed into an awaitable (the caller decides whether to await).
 */
export async function runAutomation(
  deps: AutomationDeps,
  task: AutomationTask,
  trigger: RunTrigger,
  release: () => void,
  config: AutomationSchedulerConfig = {},
): Promise<void> {
  const logger = deps.logger ?? DEFAULT_LOGGER;
  try {
    const now = new Date().toISOString();
    const working = structuredClone(task);
    if (trigger === "schedule") {
      markRunning(working, now);
    } else {
      markManualRunStarted(working, now);
    }
    try {
      await deps.automations.upsert(working);
    } catch (e) {
      logger.warn("automation run could not mark running", {
        error: errorText(e),
        automation_id: working.id,
      });
      return;
    }

    const result = await executeTask(deps, working);

    // Reload so a mutation the run itself made to the row isn't clobbered.
    let latest: AutomationTask | undefined;
    try {
      latest = await deps.automations.get(working.id);
    } catch (e) {
      logger.warn("automation run could not reload task", {
        error: errorText(e),
        automation_id: working.id,
      });
      latest = working;
    }
    if (!latest) return; // deleted mid-run → nothing to finalise

    markFinished(latest, new Date().toISOString(), result.error);
    try {
      await deps.automations.upsert(latest);
    } catch (e) {
      logger.warn("automation run could not persist final status", {
        error: errorText(e),
        automation_id: latest.id,
      });
    }
  } finally {
    release();
  }
}

/**
 * Drive the agent over the task's prompt, threading into the task's conversation
 * when one is bound + persistence is configured. Returns `{ error }` (undefined
 * error == success), never throws — the caller records the outcome. Mirrors
 * Rust's `execute_task`.
 */
async function executeTask(
  deps: AutomationDeps,
  task: AutomationTask,
): Promise<{ error?: string }> {
  let agent: Agent;
  try {
    agent = deps.buildAgent({ provider: task.provider, model: task.model });
  } catch (e) {
    return { error: errorText(e) };
  }

  let conversation: Conversation;
  try {
    conversation = await loadConversation(deps, task);
  } catch (e) {
    return { error: errorText(e) };
  }
  conversation.messages.push(userMessage(task.prompt));

  try {
    await agent.run(conversation);
  } catch (e) {
    return { error: errorText(e) };
  }

  if (deps.store && task.conversation_id) {
    const metadata: ConversationMetadata = defaultMetadata();
    try {
      await deps.store.saveEnvelope(task.conversation_id, conversation, metadata);
    } catch (e) {
      return { error: errorText(e) };
    }
  }
  return {};
}

/**
 * Load the task's bound conversation, or a fresh one when no id is bound / no
 * store is configured / the id has no envelope yet. Mirrors Rust's
 * `load_conversation` (`unwrap_or_default`). Errors propagate to the caller.
 */
async function loadConversation(
  deps: AutomationDeps,
  task: AutomationTask,
): Promise<Conversation> {
  if (!task.conversation_id || !deps.store) return newConversation();
  const loaded = await deps.store.load(task.conversation_id);
  return loaded ?? newConversation();
}

// ---------- on-demand trigger ----------------------------------------------

/** Outcome of a manual-trigger attempt. Maps to the route's HTTP status. */
export type TriggerOutcome =
  | { kind: "accepted"; task: AutomationTask }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "error"; error: string };

/**
 * Reserve + spawn a manual run for `id`. Mirrors the ordering in Rust's
 * `run_automation_now`: load (→ not_found), reject when already `running`
 * (→ conflict), reserve the claim synchronously (→ conflict if a run is already
 * in flight, closing the race against a just-spawned scheduled run), then spawn.
 * Returns `accepted` with the (pre-mutation) task on success. The spawned run is
 * fire-and-forget unless `awaitRun` is set (test seam).
 */
export async function triggerAutomationNow(
  deps: AutomationDeps,
  id: string,
  opts: { awaitRun?: boolean; config?: AutomationSchedulerConfig } = {},
): Promise<TriggerOutcome> {
  let task: AutomationTask | undefined;
  try {
    task = await deps.automations.get(id);
  } catch (e) {
    return { kind: "error", error: errorText(e) };
  }
  if (!task) return { kind: "not_found" };
  if (isRunning(task)) return { kind: "conflict" };

  const release = claimsOf(deps).tryClaim(task.id);
  if (!release) return { kind: "conflict" };

  const run = runAutomation(deps, task, "manual", release, opts.config ?? {});
  if (opts.awaitRun) {
    await run;
  } else {
    // Surface (and swallow) a rejected run so it can't become an
    // unhandledRejection — runAutomation already logs its own failures.
    void run.catch(() => {});
  }
  return { kind: "accepted", task };
}

// ---------- background loop -------------------------------------------------

/** Handle to a running scheduler loop; call {@link SchedulerHandle.stop} to halt it. */
export interface SchedulerHandle {
  stop(): void;
}

/**
 * Spawn the background scheduler: a tick every `tickSeconds`, reaping stale runs
 * and spawning due ones. Returns a handle whose `stop()` clears the interval.
 * The timer is `unref`'d so it never keeps the process alive on its own.
 * Mirrors Rust's `spawn_automation_scheduler`; intended to be called once by
 * the composition root.
 */
export function spawnAutomationLoop(
  deps: AutomationDeps,
  config: AutomationSchedulerConfig = {},
): SchedulerHandle {
  const logger = deps.logger ?? DEFAULT_LOGGER;
  const tickSeconds = Math.max(1, config.tickSeconds ?? DEFAULT_AUTOMATION_TICK_SECONDS);
  const runTimeoutMs = Math.max(1, config.runTimeoutMs ?? DEFAULT_AUTOMATION_RUN_TIMEOUT_MS);
  const resolved: AutomationSchedulerConfig = { tickSeconds, runTimeoutMs };
  logger.info("automation scheduler started", {
    tick_seconds: tickSeconds,
    run_timeout_ms: runTimeoutMs,
    stale_threshold_ms: runTimeoutMs * RUNNING_STALE_MULTIPLIER,
  });

  let running = false;
  const handle = setInterval(() => {
    if (running) return; // never overlap ticks
    running = true;
    automationTick(deps, resolved)
      .catch((e) => logger.warn("automation tick failed", { error: errorText(e) }))
      .finally(() => {
        running = false;
      });
  }, tickSeconds * 1000);
  if (typeof handle.unref === "function") handle.unref();

  return { stop: () => clearInterval(handle) };
}
