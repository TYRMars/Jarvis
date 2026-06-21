// Scheduled-automation value types + due-computation helpers.
//
// Ported from crates/harness-automation/src/lib.rs. An `AutomationTask` is a
// prompt the scheduler re-runs on a `ScheduleSpec` (one-time or recurring).
// The wire shape mirrors the Rust struct's serde serialisation exactly —
// snake_case field names, `skip_serializing_if = "Option::is_none"` optional
// fields absent when unset, and serde-default fields (`status`, `run_count`)
// always present.
//
// Rust models the lifecycle as methods on `AutomationTask` / `ScheduleSpec`
// that mutate `self` and take a `now: DateTime<Utc>`. The Node port keeps the
// data plain (an interface, not a class) and ships the behaviour as standalone
// functions taking the task as the first argument + a `now` ISO-8601 string,
// mirroring the `touchProject(project)` idiom in @jarvis/project. Threading
// `now` as a string keeps tests deterministic (pass a fixed timestamp) and
// matches the rest of the port's RFC-3339-string timestamp convention.

// ---------- enums (serde rename_all = "snake_case") -----------------------

/**
 * Whether the scheduler considers a task for firing. Serialised snake_case.
 * `#[serde(default)]` → defaults to `"enabled"`; always present on the wire.
 */
export type AutomationStatus = "enabled" | "paused";

/** Default {@link AutomationStatus} (`enabled`). Mirrors `#[default]` in Rust. */
export const DEFAULT_AUTOMATION_STATUS: AutomationStatus = "enabled";

/**
 * Outcome of the most recent run. Serialised snake_case. Absent on the wire
 * until a task has been picked up at least once (`skip_serializing_if`).
 */
export type AutomationRunStatus = "running" | "succeeded" | "failed";

// ---------- ScheduleSpec (data-carrying → discriminated union) ------------

/**
 * When a task should fire.
 *
 * Rust models this as an externally-tagged enum with `rename_all = "snake_case"`,
 * which serialises to `{ "once": { "run_at": ... } }` /
 * `{ "interval": { "every_seconds": ..., "start_at"? } }`. The Node port keeps
 * that exact wire shape so JSON round-trips losslessly across the boundary.
 */
export type ScheduleSpec =
  | { once: { run_at: string } }
  | { interval: { every_seconds: number; start_at?: string } };

/** Construct a one-shot schedule firing at `runAt` (RFC-3339 string). */
export function scheduleOnce(runAt: string): ScheduleSpec {
  return { once: { run_at: runAt } };
}

/**
 * Construct a recurring schedule firing every `everySeconds`. `startAt` (when
 * given) anchors the first tick; otherwise the first tick is `now + interval`.
 */
export function scheduleInterval(everySeconds: number, startAt?: string): ScheduleSpec {
  return startAt === undefined
    ? { interval: { every_seconds: everySeconds } }
    : { interval: { every_seconds: everySeconds, start_at: startAt } };
}

// ---------- AutomationTask -------------------------------------------------

/**
 * A scheduled prompt the automation runtime re-runs on its {@link ScheduleSpec}.
 * The wire shape is the JSON serialisation of the Rust struct, so field names
 * + optionality are preserved EXACTLY.
 */
export interface AutomationTask {
  /** Stable internal identifier (UUID v4). */
  id: string;
  /** Human-readable label. */
  title: string;
  /** The prompt sent to the agent on each run. */
  prompt: string;
  /** When to fire. */
  schedule: ScheduleSpec;
  /** `#[serde(default)]` → always present; defaults to `"enabled"`. */
  status: AutomationStatus;
  /** Provider override for this task's runs. `skip_serializing_if` → optional. */
  provider?: string;
  /** Model override for this task's runs. `skip_serializing_if` → optional. */
  model?: string;
  /** Conversation this task threads into. `skip_serializing_if` → optional. */
  conversation_id?: string;
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp of the last mutation. */
  updated_at: string;
  /** Last time a run was started. `skip_serializing_if` → optional. */
  last_run_at?: string;
  /** Next scheduled fire time (`undefined` when the task will never fire again). */
  next_run_at?: string;
  /** Outcome of the most recent run. `skip_serializing_if` → optional. */
  last_run_status?: AutomationRunStatus;
  /** Error message from the most recent failed run. `skip_serializing_if` → optional. */
  last_error?: string;
  /** `#[serde(default)]` → always present; total completed runs. */
  run_count: number;
}

/** Input bundle for {@link newAutomationTask}. Mirrors Rust `NewAutomationTask`. */
export interface NewAutomationTask {
  title: string;
  prompt: string;
  schedule: ScheduleSpec;
  status?: AutomationStatus;
  provider?: string;
  model?: string;
  conversation_id?: string;
}

/**
 * Mint a new task with a fresh UUID v4 id and current timestamps. Seeds
 * `next_run_at` from the schedule (the first fire time). `now` is supplied as
 * an ISO-8601 string so the result is deterministic in tests; callers in
 * production pass `new Date().toISOString()`.
 */
export function newAutomationTask(input: NewAutomationTask, now: string = new Date().toISOString()): AutomationTask {
  const stamp = normalizeStamp(now);
  const nextRunAt = scheduleNextAfter(input.schedule, undefined, now);
  const task: AutomationTask = {
    id: crypto.randomUUID(),
    title: input.title,
    prompt: input.prompt,
    schedule: input.schedule,
    status: input.status ?? DEFAULT_AUTOMATION_STATUS,
    created_at: stamp,
    updated_at: stamp,
    run_count: 0,
  };
  if (input.provider !== undefined) task.provider = input.provider;
  if (input.model !== undefined) task.model = input.model;
  if (input.conversation_id !== undefined) task.conversation_id = input.conversation_id;
  if (nextRunAt !== undefined) task.next_run_at = nextRunAt;
  return task;
}

/**
 * True when the scheduler should fire this task at `now`: it must be enabled,
 * not already flagged `running`, and have a `next_run_at` at or before `now`.
 */
export function isDueAt(task: AutomationTask, now: string): boolean {
  if (task.status !== "enabled") return false;
  if (task.last_run_status === "running") return false;
  const next = parseTimestamp(task.next_run_at);
  return next !== undefined && next <= parseTimestamp(now)!;
}

/**
 * Flag a scheduled run as started: stamp `last_run_at`, advance `next_run_at`
 * one step past `now` (so the scheduler doesn't re-fire it), flip the status
 * to `running`, and clear the prior error.
 */
export function markRunning(task: AutomationTask, now: string): void {
  const stamp = normalizeStamp(now);
  task.last_run_at = stamp;
  setNextRunAt(task, scheduleNextAfter(task.schedule, now, now));
  task.last_run_status = "running";
  delete task.last_error;
  task.updated_at = stamp;
}

/**
 * Flag a *manual* run as started. Identical bookkeeping to {@link markRunning}:
 * we still advance `next_run_at`, otherwise the scheduler sees a non-running
 * task still due at/before `now` and fires it a second time (a `once` task runs
 * twice; an `interval` task re-fires immediately).
 */
export function markManualRunStarted(task: AutomationTask, now: string): void {
  const stamp = normalizeStamp(now);
  task.last_run_at = stamp;
  setNextRunAt(task, scheduleNextAfter(task.schedule, now, now));
  task.last_run_status = "running";
  delete task.last_error;
  task.updated_at = stamp;
}

/**
 * Record a run's completion. Bumps `run_count`, sets `last_run_status` to
 * `succeeded` / `failed`, and stores `error` on failure (clearing it on
 * success). `error === undefined` means success.
 */
export function markFinished(task: AutomationTask, now: string, error?: string): void {
  task.updated_at = normalizeStamp(now);
  // saturating add — JS numbers can't overflow into a wrong value the way u64 can,
  // but keep the intent explicit.
  task.run_count = task.run_count + 1;
  if (error === undefined) {
    task.last_run_status = "succeeded";
    delete task.last_error;
  } else {
    task.last_run_status = "failed";
    task.last_error = error;
  }
}

/**
 * Recompute `next_run_at` from the schedule as if the task had never run
 * (`previous = undefined`). Used after editing a task's schedule. Bumps
 * `updated_at`.
 */
export function recomputeNextRun(task: AutomationTask, now: string): void {
  setNextRunAt(task, scheduleNextAfter(task.schedule, undefined, now));
  task.updated_at = normalizeStamp(now);
}

/**
 * True when a task is still flagged `running` but its run started long enough
 * ago that the worker must have been lost (process restart, cancellation, or a
 * panic between {@link markRunning} and {@link markFinished}). `timeoutMs` is a
 * wall-clock budget against `last_run_at`; a `running` task with no start
 * timestamp is itself corrupt and is reclaimable. Without a reaper such a task
 * pins forever in `running` and {@link isDueAt} never reschedules it.
 */
export function isStaleRunning(task: AutomationTask, now: string, timeoutMs: number): boolean {
  if (task.last_run_status !== "running") return false;
  const started = parseTimestamp(task.last_run_at);
  if (started === undefined) return true; // running with no start timestamp → corrupt, reclaim
  const elapsedMs = parseTimestamp(now)! - started;
  return elapsedMs >= Math.max(1, timeoutMs);
}

/**
 * Recover a task stuck in `running` (see {@link isStaleRunning}). Flips it to
 * `failed` with an explanatory error and recomputes `next_run_at` from the
 * schedule (anchored at the previous start) so an interval task resumes ticking
 * and a `once` task settles as done — rather than pinning forever.
 *
 * A reclaimed task was, by definition, already picked up (it was `running`), so
 * its run counts as "previous" for scheduling even when the start timestamp is
 * missing (the corrupt-row case `isStaleRunning` reclaims). We therefore anchor
 * at `last_run_at ?? now`: without this fallback, `scheduleNextAfter` sees
 * `previousRun === undefined` and a `once` schedule re-emits its original (now
 * past) `run_at`, resurrecting the one-shot so the scheduler re-fires it.
 */
export function markStaleReclaimed(task: AutomationTask, now: string): void {
  // `?? now`: treat a corrupt `running` row (no `last_run_at`) as having started
  // now, so a `once` task settles as done instead of re-firing its past run_at.
  const previousRunAt = task.last_run_at ?? now;
  setNextRunAt(task, scheduleNextAfter(task.schedule, previousRunAt, now));
  task.last_run_status = "failed";
  task.last_error = "run timed out; reclaimed by automation reaper (assumed abandoned)";
  task.updated_at = normalizeStamp(now);
}

// ---------- ScheduleSpec due computation ----------------------------------

/**
 * The next fire time at or after `now`, given the optional previous run.
 * Returns `undefined` when the task will never fire again (a completed `once`).
 *
 * - `once`: fires at `run_at` exactly once; `undefined` once it has run.
 * - `interval`: the first tick is `previousRun + interval`, else `start_at`,
 *   else `now + interval`; missed ticks are skipped forward so the result is
 *   always strictly after `now`.
 *
 * `previousRun` / `now` are ISO-8601 strings. The returned value is an
 * RFC-3339 string with millisecond precision (matches the rest of the port).
 */
export function scheduleNextAfter(
  schedule: ScheduleSpec,
  previousRun: string | undefined,
  now: string,
): string | undefined {
  const nowMs = parseTimestamp(now);
  if (nowMs === undefined) return undefined;

  if ("once" in schedule) {
    const runAt = parseTimestamp(schedule.once.run_at);
    if (runAt === undefined) return undefined;
    // Once it has run (previousRun present), it never fires again.
    return previousRun !== undefined ? undefined : toRfc3339(runAt);
  }

  // interval
  const seconds = Math.max(1, schedule.interval.every_seconds);
  const intervalMs = seconds * 1000;
  const prevMs = parseTimestamp(previousRun);
  const startMs = parseTimestamp(schedule.interval.start_at);

  let nextMs: number;
  if (prevMs !== undefined) {
    nextMs = prevMs + intervalMs;
  } else if (startMs !== undefined) {
    nextMs = startMs;
  } else {
    nextMs = nowMs + intervalMs;
  }
  // Skip past any missed ticks so the result is strictly after `now`.
  while (nextMs <= nowMs) {
    nextMs += intervalMs;
  }
  return toRfc3339(nextMs);
}

// ---------- timestamp helpers ---------------------------------------------

/**
 * Parse an RFC-3339 / ISO-8601 string to epoch-millis. Returns `undefined`
 * for `undefined` input or an unparseable string (mirrors Rust's
 * `parse_rfc3339` returning `Option`). The `Date` ctor already accepts the
 * RFC-3339 forms chrono emits (`Z` and `±hh:mm` offsets).
 */
export function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Format epoch-millis as an RFC-3339 string with millisecond precision and a
 * `Z` suffix — byte-for-byte what Rust's `to_rfc3339` produces (chrono's
 * `SecondsFormat::Millis` + `use_z = true`). `Date.toISOString()` already
 * yields `YYYY-MM-DDTHH:mm:ss.sssZ`.
 */
export function toRfc3339(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Normalise a timestamp string into the canonical RFC-3339 millis+`Z` wire
 * form before storing it on a task. Rust never stores a caller-supplied string
 * verbatim — every `created_at`/`updated_at`/`last_run_at` write goes through
 * `to_rfc3339(now: DateTime<Utc>)`, which always emits `…sss Z`. Mirroring that
 * here keeps the on-disk wire shape byte-identical regardless of the input's
 * precision (`…00Z` vs `…00.000Z`) and keeps `updated_at` list ordering stable
 * (the two forms sort differently lexicographically). An unparseable string is
 * passed through unchanged (Rust can't reach that case; we stay lossless).
 */
function normalizeStamp(value: string): string {
  const ms = parseTimestamp(value);
  return ms === undefined ? value : toRfc3339(ms);
}

// ---------- internal -------------------------------------------------------

/** Assign or clear `next_run_at` from an optional value (keeps the field absent when undefined). */
function setNextRunAt(task: AutomationTask, value: string | undefined): void {
  if (value === undefined) {
    delete task.next_run_at;
  } else {
    task.next_run_at = value;
  }
}
