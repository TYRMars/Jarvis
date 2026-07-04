// Typed value types and broadcast events for Requirement execution runs.
//
// Ported from crates/harness-project/src/requirement_run.rs. Sibling to
// requirement.ts: that module owns the kanban row shape; this one owns the
// per-run records (status, summary, verification result) plus the
// RequirementRunEvent broadcast shape used by the WS bridge.
import type { JsonValue, Usage } from "@jarvis/core";

// ---------- RequirementRunStatus ------------------------------------------

/**
 * Lifecycle of a {@link RequirementRun}. Serialised snake_case wire strings.
 */
export type RequirementRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

const REQUIREMENT_RUN_STATUSES: readonly RequirementRunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

/** Parse a wire string. `undefined` for unrecognised values. */
export function requirementRunStatusFromWire(s: string): RequirementRunStatus | undefined {
  return (REQUIREMENT_RUN_STATUSES as readonly string[]).includes(s)
    ? (s as RequirementRunStatus)
    : undefined;
}

/**
 * Terminal states cannot transition further (no zombie runs re-entering
 * `Running`).
 */
export function requirementRunStatusIsTerminal(s: RequirementRunStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

// ---------- RequirementRunLog ---------------------------------------------

/** Severity / semantic class for {@link RequirementRunLog}. */
export type RequirementRunLogLevel = "info" | "warn" | "error" | "success";

/** One durable operator-facing log line for a {@link RequirementRun}. */
export interface RequirementRunLog {
  /** Stable identifier so clients can render logs without index-based keys. */
  id: string;
  /** Severity / semantic class for UI styling. */
  level: RequirementRunLogLevel;
  /** Human-readable message. */
  message: string;
  /**
   * Optional structured details (workspace, command, exit code, duration,
   * short output excerpts). `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  data?: JsonValue;
  /** RFC-3339 / ISO-8601 timestamp. */
  created_at: string;
}

// ---------- VerificationPlan / Result -------------------------------------

/**
 * What success looks like for the run, expressed as commands the host should
 * execute and policy gates the user / harness should honour.
 */
export interface VerificationPlan {
  /** Shell-style commands to run after the agent finishes. `#[serde(default)]`. */
  commands: string[];
  /**
   * Require the run to produce a non-empty `git diff` before passing?
   * `#[serde(skip_serializing_if = "is_false")]` → omitted when false.
   */
  require_diff?: boolean;
  /**
   * Require the agent to declare which tests it ran?
   * `#[serde(skip_serializing_if = "is_false")]` → omitted when false.
   */
  require_tests?: boolean;
  /**
   * Hold for human review before flipping the parent Requirement to `done`?
   * `#[serde(skip_serializing_if = "is_false")]` → omitted when false.
   */
  require_human_review?: boolean;
}

/** Aggregate verification outcome. Wire form snake_case. */
export type VerificationStatus = "passed" | "failed" | "needs_review" | "skipped";

/** One row of the per-command results table. */
export interface CommandResult {
  /** The command string (verbatim from the plan). */
  command: string;
  /**
   * Process exit code. Absent for commands that didn't reach a clean exit.
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  exit_code?: number;
  /** Truncated stdout (≤ 16 KiB). `#[serde(skip_serializing_if = "String::is_empty")]`. */
  stdout?: string;
  /** Truncated stderr (≤ 16 KiB). `#[serde(skip_serializing_if = "String::is_empty")]`. */
  stderr?: string;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
}

/** Outcome of executing a {@link VerificationPlan} against a {@link RequirementRun}. */
export interface VerificationResult {
  /** Aggregate outcome — derived from the per-command results plus gates. */
  status: VerificationStatus;
  /** One entry per command in the plan, in the same order. `#[serde(default)]`. */
  command_results: CommandResult[];
  /**
   * `git diff --stat` output captured at run end, if the run asked for
   * `require_diff`. `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  diff_summary?: string;
  /** Free-form notes. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  notes?: string;
}

// ---------- RequirementRun ------------------------------------------------

/**
 * One execution attempt against a Requirement. A Requirement can have many
 * runs. This struct only holds run-level metadata; the conversation row is
 * authoritative for messages.
 */
export interface RequirementRun {
  /** Stable identifier (UUID v4). */
  id: string;
  /** The Requirement this run targets. */
  requirement_id: string;
  /** Conversation that drove the run. */
  conversation_id: string;
  /** Lifecycle state. */
  status: RequirementRunStatus;
  /** One-line summary. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  summary?: string;
  /** Free-form error string if the run failed. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  error?: string;
  /** Optional verification result. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  verification?: VerificationResult;
  /** Chronological, durable run log. `#[serde(skip_serializing_if = "Vec::is_empty")]`. */
  logs?: RequirementRunLog[];
  /** Absolute path to the per-run git worktree, if one was minted. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  worktree_path?: string;
  /** Aggregated provider-reported token usage. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  usage?: Usage;
  /** Concrete model id this run targeted. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  model?: string;
  /** RFC-3339 / ISO-8601 timestamp of run creation. */
  started_at: string;
  /** RFC-3339 timestamp of completion. Absent while in flight. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  finished_at?: string;
}

/**
 * Mint a new run with a fresh UUID, current timestamp, and status `pending`.
 */
export function newRequirementRun(requirementId: string, conversationId: string): RequirementRun {
  return {
    id: crypto.randomUUID(),
    requirement_id: requirementId,
    conversation_id: conversationId,
    status: "pending",
    started_at: new Date().toISOString(),
  };
}

/**
 * Mark the run finished (status + finished_at). Terminal is sticky — a late or
 * duplicate `finish` (cancel, reaper sweep, double transition) leaves both the
 * status AND `finished_at` untouched, so the recorded completion time stays at
 * the real first finish rather than being re-stamped later (which would inflate
 * any reported `finished_at − started_at` duration).
 */
export function finishRequirementRun(run: RequirementRun, status: RequirementRunStatus): void {
  if (!requirementRunStatusIsTerminal(run.status)) {
    run.status = status;
    run.finished_at = new Date().toISOString();
  }
}

/** Append one durable operator-facing log line. */
export function pushRequirementRunLog(
  run: RequirementRun,
  level: RequirementRunLogLevel,
  message: string,
  data?: JsonValue,
): void {
  const log: RequirementRunLog = {
    id: crypto.randomUUID(),
    level,
    message,
    created_at: new Date().toISOString(),
  };
  if (data !== undefined) {
    log.data = data;
  }
  if (run.logs === undefined) {
    run.logs = [];
  }
  run.logs.push(log);
}

// ---------- RequirementRunEvent -------------------------------------------

/**
 * Per-run lifecycle event. Sibling to AgentEvent: those describe the agent
 * loop's internal progress; this describes the run's state transitions.
 *
 * Serde shape: `#[serde(tag = "type", rename_all = "snake_case")]`. The
 * tuple variants `Started(run)` / `Finished(run)` serialise as the run's
 * fields flattened next to `type`, so we model them with the run fields
 * inlined.
 */
export type RequirementRunEvent =
  | ({ type: "started" } & RequirementRun)
  | ({ type: "finished" } & RequirementRun)
  | { type: "verified"; run_id: string; result: VerificationResult };

/** Run id the event targets — useful for WS-layer filtering. */
export function requirementRunEventRunId(ev: RequirementRunEvent): string {
  switch (ev.type) {
    case "started":
    case "finished":
      return ev.id;
    case "verified":
      return ev.run_id;
  }
}
