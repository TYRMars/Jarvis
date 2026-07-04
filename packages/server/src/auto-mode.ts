// Background scheduler that picks eligible Requirements, mints a fresh
// RequirementRun, drives the agent loop, advances status, and counts
// failures for retry budgeting.
//
// Ported from the load-bearing subset of crates/harness-server/src/auto_mode.rs
// (~4775 lines). The Rust file additionally carries: WORKFLOW.md front-matter
// parsing, declarative-workflow dispatch, project-memory / learning-memory
// capture, manifest builders, and the verification module wiring — all of
// which depend on Node crates that are not yet ported. Those are out of scope
// here and represented as injectable seams (see {@link AutoModeDeps}) so the
// scheduler's *guards* (the part the work-orchestration proposal calls "v1
// 受限 auto") can be ported and tested in isolation.
//
// The single design rule preserved verbatim from Rust: the picker is the only
// place the six eligibility guards live, and they fire in the same order:
//
//   1. status ∈ {backlog, in_progress, review}  (else: ineligible_status)
//   2. triage_state === "approved"               (else: not_approved)
//   3. depends_on gate — every dep reaches `done`, with self-dependency and
//      dependency-cycle detection surfacing a Blocked Activity ONCE (deduped,
//      reason self_dependency / dependency_cycle) instead of a silent skip
//   4. no in-flight (pending/running) run         (else: inflight_run)
//   5. consecutive failures since last success < maxRetries (else: retries_exceeded)
//   6. Review row under Human acceptance policy is skipped (acceptance gate)
//
// Then driveOne(req, deps) runs the agent over the requirement's seed
// conversation, advances status via completedRequirementTargetStatus, and the
// run row records success/failure for the next tick's retry budget.

import type { Approver, Conversation, Message, Usage } from "@jarvis/core";
import { newConversation, systemMessage, userMessage, usageIsEmpty } from "@jarvis/core";
import type { ConversationStore } from "@jarvis/store";
import type {
  Activity,
  ActivityActor,
  ActivityKind,
  ActivityStore,
  AcceptancePolicy,
  Project,
  ProjectMemoryStore,
  ProjectStore,
  Requirement,
  RequirementRun,
  RequirementRunStore,
  RequirementStatus,
  RequirementStore,
  VerificationStatus,
} from "@jarvis/project";
import {
  ensureExecutionChecklist,
  executionChecklistFailedOrBlocked,
  executionChecklistPassed,
  finishRequirementRun,
  linkConversation,
  newActivity,
  newRequirementRun,
  pushRequirementRunLog,
  requirementRunStatusIsTerminal,
  touchRequirement,
} from "@jarvis/project";

// ---------- AutoMode --------------------------------------------------------

/**
 * Top-level switch for the auto loop. Wire form is `off | auto`. Default
 * `off`. Mirrors Rust `AutoMode`.
 */
export type AutoMode = "off" | "auto";

/**
 * Parse the env-var wire form. `undefined` for unknown values so the binary's
 * startup can warn rather than fail. Blank / `"off"` → `"off"`.
 */
export function autoModeFromWire(s: string): AutoMode | undefined {
  const t = s.trim();
  if (t === "" || t === "off") return "off";
  if (t === "auto") return "auto";
  return undefined;
}

// ---------- AutoModeConfig --------------------------------------------------

/**
 * Knobs sourced from `JARVIS_WORK_*` env vars. Three orthogonal dials govern
 * the scheduler's appetite:
 *
 * - `tickSeconds` — how often the picker wakes up.
 * - `maxUnitsPerTick` — burst budget; cap on candidates spawned per tick.
 * - `maxConcurrent` — true global concurrency: each drive task acquires a
 *   {@link Semaphore} permit before calling the provider. Independent of the
 *   per-tick burst budget. This is the knob for "agents are stomping each
 *   other's rate limits".
 *
 * `maxRetries` is the ceiling on *consecutive* failed runs (since the last
 * success) before the picker stops re-picking. `runTimeoutMs` caps the agent
 * loop's wall-clock per pickup.
 */
export interface AutoModeConfig {
  mode: AutoMode;
  tickSeconds: number;
  maxUnitsPerTick: number;
  /** Global concurrency cap (permits-in-flight ceiling for the drive pool). */
  maxConcurrent: number;
  maxRetries: number;
  runTimeoutMs: number;
  /**
   * Opt-in: when set, Subagent-policy requirements whose work agent would flip
   * to Done instead pause at Review and dispatch the reviewer subagent
   * (`subagent.review`). The reviewer's terminal `requirement.review_verdict`
   * call flips Done (pass) / InProgress (fail). Default `false` so existing
   * deployments keep the pre-v1.0 auto-flip semantics. Sourced from
   * `JARVIS_REVIEWER_AUTO_ACCEPT`.
   */
  reviewerAutoAccept: boolean;
}

/** The Rust `AutoModeConfig::default()` values. */
export function defaultAutoModeConfig(): AutoModeConfig {
  return {
    mode: "off",
    tickSeconds: 30,
    maxUnitsPerTick: 1,
    // 2 = enough headroom that a slow agent doesn't gate the whole queue,
    // low enough that token / rate-limit budgets stay predictable.
    maxConcurrent: 2,
    // 3 (not 1): ride out a transient 1-2 minute LLM-transport blip while
    // backoff still keeps a stuck requirement from burning money.
    maxRetries: 3,
    runTimeoutMs: 10 * 60 * 1000,
    reviewerAutoAccept: false,
  };
}

// ---------- Semaphore -------------------------------------------------------

/**
 * A minimal async counting semaphore — the Node stand-in for
 * `tokio::sync::Semaphore`. `acquire()` resolves to a release function once a
 * permit is free; callers MUST call it exactly once when done. FIFO fairness:
 * waiters are served in arrival order so a backlog of drive tasks drains
 * predictably rather than starving.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, Math.floor(permits));
  }

  /** Snapshot of currently-available permits. Diagnostics only. */
  availablePermits(): number {
    return this.permits;
  }

  /**
   * Acquire one permit, waiting if none are free. Resolves to a release
   * function. Idempotent release: calling it more than once is a no-op so a
   * double-release can't inflate the permit count.
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const grant = () => {
        this.permits -= 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      };
      if (this.permits > 0) {
        grant();
      } else {
        this.waiters.push(grant);
      }
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter without bumping the
      // counter (grant() decrements again), keeping the count balanced.
      this.permits += 1;
      next();
    } else {
      this.permits += 1;
    }
  }
}

// ---------- AutoModeRuntime -------------------------------------------------

/**
 * Mutable, process-wide runtime state for the loop. Holds the enable flag
 * (operator-toggleable via REST), the per-requirement claim set (in-flight
 * dedup independent of the run store), the global concurrency semaphore, the
 * hot-reloadable maxRetries override, and the last-tick timestamp for the
 * dashboard liveness probe. Mirrors Rust `AutoModeRuntime`.
 */
export class AutoModeRuntime {
  private enabled: boolean;
  private readonly activeRequirements = new Set<string>();
  private readonly gate: Semaphore;
  private lastTickAtValue: string | undefined;
  /** Sentinel 0 means "no override; use the static config value". */
  private maxRetriesOverrideValue = 0;

  constructor(initial: AutoMode = "off", maxConcurrent: number = defaultAutoModeConfig().maxConcurrent) {
    this.enabled = initial === "auto";
    this.gate = new Semaphore(Math.max(1, maxConcurrent));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /** `undefined` means "use the static config value"; a number is the override. */
  maxRetriesOverride(): number | undefined {
    return this.maxRetriesOverrideValue === 0 ? undefined : this.maxRetriesOverrideValue;
  }

  /** `undefined` clears the override (picker falls back to config). */
  setMaxRetriesOverride(value: number | undefined): void {
    this.maxRetriesOverrideValue = value ?? 0;
  }

  /** Picker-facing accessor: prefer the runtime override, else static config. */
  effectiveMaxRetries(config: AutoModeConfig): number {
    return this.maxRetriesOverride() ?? config.maxRetries;
  }

  /**
   * Try to claim `requirementId` for this pickup. Returns a release function
   * when the claim succeeds (caller MUST call it when the drive completes), or
   * `undefined` when the requirement is already claimed by another in-flight
   * drive. Mirrors Rust's `try_claim_requirement` + `RequirementRunClaim` Drop.
   */
  tryClaimRequirement(requirementId: string): (() => void) | undefined {
    if (this.activeRequirements.has(requirementId)) {
      return undefined;
    }
    this.activeRequirements.add(requirementId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequirements.delete(requirementId);
    };
  }

  /** The shared concurrency gate handed to each spawned drive task. */
  concurrencyGate(): Semaphore {
    return this.gate;
  }

  availablePermits(): number {
    return this.gate.availablePermits();
  }

  lastTickAt(): string | undefined {
    return this.lastTickAtValue;
  }

  /** Stamp "now" as the latest observed tick (loop liveness, even when paused). */
  recordTick(): void {
    this.lastTickAtValue = new Date().toISOString();
  }
}

// ---------- AutoModeDeps ----------------------------------------------------

/**
 * The injectable surface `autoModeTick` / `driveOne` operate over. Stores are
 * required; the rest are seams the composition root (or a test) supplies.
 *
 * The Rust path reaches deep into `AppState` (manifest builders, verification
 * module, worktree module, project/learning memory). Those Node crates are not
 * yet ported, so they appear here as optional callbacks: a missing callback is
 * a no-op (worktree → use main checkout; reviewer dispatch → leave at Review).
 */
export interface AutoModeDeps {
  projects: ProjectStore;
  requirements: RequirementStore;
  requirementRuns: RequirementRunStore;
  /** Optional audit timeline. Blocked/StatusChange/Run* rows are skipped when absent. */
  activities?: ActivityStore;
  /** Optional project-memory store. Reserved for the failure-capture seam. */
  projectMemory?: ProjectMemoryStore;
  /** Optional conversation persistence. Seed + final conversations are saved when present. */
  store?: ConversationStore;

  /** Build the agent that drives one requirement. Mirrors `AppState.build_agent_with`. */
  createAgent(opts: { sessionWorkspace?: string; approver?: Approver }): {
    runWithUsage(conversation: Conversation): Promise<[unknown, Usage]>;
    /** Concrete model id targeted, persisted onto the run for cost attribution. */
    model?: string;
  };

  /** Process-wide runtime state (enable flag, claims, concurrency, overrides). */
  runtime: AutoModeRuntime;

  /**
   * Resolve the workspace path for a project. Default seam returns the
   * project's first workspace, else {@link AutoModeDeps.workspaceRoot}, else
   * `undefined`. Pinned onto the agent session scope so fs.* / shell.exec
   * resolve under the requirement's workspace.
   */
  resolveWorkspace?(project: Project): string | undefined;
  workspaceRoot?: string;

  /**
   * Optional per-run git worktree seam. Returns the worktree path on success,
   * `undefined` to fall back to the main checkout. Mirrors the
   * `WorktreeMode::PerRun` branch in Rust (off / unported → undefined).
   */
  createWorktree?(input: { workspace: string; runId: string }): Promise<string | undefined>;

  /**
   * Optional reviewer-subagent dispatch seam. Called when
   * `reviewerAutoAccept` is set and a Subagent-policy Review row is re-picked.
   * The implementation is expected to run an agent that calls
   * `requirement.review_verdict`, flipping the requirement to Done (pass) or
   * InProgress (fail). Returns the verdict so the scheduler can record it.
   * When absent, the row is left at Review (no autonomous acceptance).
   */
  dispatchReviewer?(input: {
    requirement: Requirement;
    run: RequirementRun;
  }): Promise<"pass" | "fail" | undefined>;

  /** Clock seam for deterministic backoff tests. Defaults to `Date.now`. */
  now?(): number;
}

function nowMs(deps: AutoModeDeps): number {
  return (deps.now ?? Date.now)();
}

function resolveProjectWorkspace(project: Project, deps: AutoModeDeps): string | undefined {
  if (deps.resolveWorkspace) return deps.resolveWorkspace(project);
  return project.workspaces[0]?.path ?? deps.workspaceRoot;
}

// ---------- pure guard helpers ----------------------------------------------

const ELIGIBLE_STATUSES: ReadonlySet<RequirementStatus> = new Set<RequirementStatus>([
  "backlog",
  "in_progress",
  "review",
]);

/**
 * Compute the set of requirement ids that can NEVER satisfy their depends_on
 * gate because they sit on — or transitively behind — a dependency cycle
 * within the project. Only in-project edges count: a dep id pointing outside
 * `reqs` (deleted / cross-project) is dropped so it can't close a cycle.
 *
 * Kahn-style peel: a requirement "settles" once every in-project dep it lists
 * has settled. Whatever can't settle is stuck behind a cycle — self-loops
 * (A→A) and mutual cycles (A→B→A) included. Mirrors Rust
 * `cycle_blocked_requirement_ids`.
 */
export function cycleBlockedRequirementIds(reqs: readonly Requirement[]): Set<string> {
  const ids = new Set(reqs.map((r) => r.id));
  const pending = new Map<string, Set<string>>();
  for (const r of reqs) {
    const deps = new Set<string>();
    for (const d of r.depends_on ?? []) {
      if (ids.has(d)) deps.add(d);
    }
    pending.set(r.id, deps);
  }
  for (;;) {
    const settled: string[] = [];
    for (const [id, deps] of pending) {
      if (deps.size === 0) settled.push(id);
    }
    if (settled.length === 0) break;
    for (const id of settled) pending.delete(id);
    for (const deps of pending.values()) {
      for (const id of settled) deps.delete(id);
    }
  }
  return new Set(pending.keys());
}

/**
 * Count `failed` runs in `history` (newest-first by store contract) up to and
 * excluding the most recent `completed` run. `cancelled` / `pending` /
 * `running` rows are skipped (neither success nor failure for retry budget).
 * Mirrors Rust `consecutive_failed_since_last_success`.
 */
export function consecutiveFailedSinceLastSuccess(history: readonly RequirementRun[]): number {
  let count = 0;
  for (const run of history) {
    if (run.status === "failed") {
      count += 1;
    } else if (run.status === "completed") {
      break;
    }
    // cancelled / pending / running → skip
  }
  return count;
}

/** Most recent `failed` run, or undefined. Relies on newest-first ordering. */
export function mostRecentFailedRun(history: readonly RequirementRun[]): RequirementRun | undefined {
  return history.find((r) => r.status === "failed");
}

/** Hard ceiling on the failure backoff window (1 hour). */
export const FAILURE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Floor on the per-failure base delay (30 s) so tick_seconds=1 doesn't hammer. */
export const FAILURE_BACKOFF_BASE_FLOOR_MS = 30_000;

/**
 * Failure backoff window for `consecutive` failures: doubles per failure from
 * a `tickSeconds`-derived base, capped at {@link FAILURE_BACKOFF_MAX_MS}.
 * `consecutive === 0` → 0 (no backoff for a fresh / post-success requirement).
 * Mirrors Rust `failure_backoff_ms`.
 */
export function failureBackoffMs(consecutive: number, tickSeconds: number): number {
  if (consecutive <= 0) return 0;
  const base = Math.max(tickSeconds * 1000, FAILURE_BACKOFF_BASE_FLOOR_MS);
  const shift = Math.min(consecutive - 1, 16);
  return Math.min(base * 2 ** shift, FAILURE_BACKOFF_MAX_MS);
}

/**
 * Remaining backoff in ms for a `failed` run. `undefined` when the window has
 * elapsed, `backoffMs === 0`, or the timestamp is unparseable / in the future
 * (clock skew → don't pin forever). Mirrors Rust `failure_backoff_remaining_ms`.
 */
export function failureBackoffRemainingMs(
  run: RequirementRun,
  backoffMs: number,
  now: number,
): number | undefined {
  if (backoffMs === 0) return undefined;
  const reference = run.finished_at ?? run.started_at;
  const parsed = Date.parse(reference);
  if (Number.isNaN(parsed)) return undefined;
  const ageMs = now - parsed;
  if (ageMs < 0) return undefined;
  const remaining = backoffMs - ageMs;
  return remaining > 0 ? remaining : undefined;
}

/**
 * The target status after a run, or `undefined` for no transition. Honours the
 * execution checklist completion gate + verification NeedsReview + the
 * acceptance policy. Mirrors Rust `completed_requirement_target_status` with
 * the Human-policy gate folded in (Subagent default flips Review→Done; Human
 * holds at Review).
 *
 * - Non-`completed` run → no transition.
 * - Checklist failed/blocked → back to in_progress.
 * - in_progress + verification needs_review → review.
 * - in_progress / review + checklist passed → done (Subagent) / review (Human).
 * - otherwise → review.
 */
export function completedRequirementTargetStatus(
  requirement: Requirement,
  run: RequirementRun,
  acceptancePolicy: AcceptancePolicy,
): RequirementStatus | undefined {
  if (run.status !== "completed") return undefined;

  const needsReview = run.verification?.status === ("needs_review" as VerificationStatus);

  if (executionChecklistFailedOrBlocked(requirement)) {
    return "in_progress";
  }

  switch (requirement.status) {
    case "in_progress":
      if (needsReview) return "review";
    // fallthrough
    case "review": {
      if (executionChecklistPassed(requirement)) {
        // Human policy never auto-accepts to Done — hold at Review.
        return acceptancePolicy === "human" ? "review" : "done";
      }
      return "review";
    }
    default:
      return undefined;
  }
}

/** Effective acceptance policy for a requirement (defaults to `subagent`). */
function acceptanceOf(req: Requirement): AcceptancePolicy {
  return req.acceptance_policy ?? "subagent";
}

// ---------- activity helpers ------------------------------------------------

export async function recordActivity(
  deps: AutoModeDeps,
  requirementId: string,
  kind: ActivityKind,
  actor: ActivityActor,
  body: unknown,
): Promise<void> {
  const store = deps.activities;
  if (!store) return;
  const activity: Activity = newActivity(requirementId, kind, actor, body as Activity["body"]);
  try {
    await store.append(activity);
  } catch {
    // Best-effort: a failed activity append must never abort the loop.
  }
}

/**
 * Append a `blocked` Activity row for a permanently-deadlocked requirement,
 * but only when the newest existing row isn't already the same block — so the
 * per-tick scheduler surfaces the stall ONCE rather than spamming the timeline
 * every tick. A later intervening event (run, status change) lets a recurring
 * block re-emit. Mirrors Rust `record_blocked_once`.
 */
export async function recordBlockedOnce(
  deps: AutoModeDeps,
  requirementId: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const store = deps.activities;
  if (!store) return;
  try {
    const rows = await store.listForRequirement(requirementId);
    const latest = rows[0];
    if (
      latest &&
      latest.kind === "blocked" &&
      typeof latest.body === "object" &&
      latest.body !== null &&
      (latest.body as Record<string, unknown>).reason === reason
    ) {
      return; // already the newest row → dedup
    }
  } catch {
    // Better a possible duplicate than a silent stall: fall through and emit.
  }
  await recordActivity(deps, requirementId, "blocked", { type: "system" }, { ...detail, reason });
}

// ---------- the picker ------------------------------------------------------

/**
 * One scheduler tick. Returns the number of requirements picked (spawned to
 * drive) so callers / tests know whether anything happened.
 *
 * Applies the six eligibility guards per project, in the same order as Rust,
 * respecting the per-tick burst budget (`maxUnitsPerTick`). Each pick is
 * claimed (in-flight dedup), then driven under the global concurrency
 * semaphore. The drive is awaited inside a fire-and-forget task; `awaitDrives`
 * (test seam, default true) controls whether the tick resolves only after the
 * spawned drives settle — convenient for assertions without polling.
 */
export async function autoModeTick(
  deps: AutoModeDeps,
  config: AutoModeConfig,
  opts: { awaitDrives?: boolean } = {},
): Promise<number> {
  const awaitDrives = opts.awaitDrives ?? true;
  const projectRows = await deps.projects.list(false, 200);
  let picked = 0;
  const drives: Promise<void>[] = [];

  for (const project of projectRows) {
    if (picked >= config.maxUnitsPerTick) break;
    if (project.automation && project.automation.auto_mode_enabled === false) {
      continue; // project_auto_mode_disabled
    }

    const reqs = await deps.requirements.list(project.id);
    // Pre-index dep statuses so the depends_on check is O(1) per dep.
    const depIndex = new Map<string, RequirementStatus>(reqs.map((r) => [r.id, r.status]));
    const cycleBlocked = cycleBlockedRequirementIds(reqs);

    for (const req of reqs) {
      if (picked >= config.maxUnitsPerTick) break;

      // (1) eligibility filter — status must be a working column.
      if (!ELIGIBLE_STATUSES.has(req.status)) continue;

      // (2) triage gate — only user-approved work runs unattended.
      if ((req.triage_state ?? "approved") !== "approved") continue;

      // (3) depends_on gate. Self-dependency + dependency-cycle are permanent
      // deadlocks surfaced once as a Blocked Activity; unknown ids stay a
      // silent skip (fail-safe block).
      const dependsOn = req.depends_on ?? [];
      if (dependsOn.some((d) => d === req.id)) {
        await recordBlockedOnce(deps, req.id, "self_dependency", { dep: req.id });
        continue;
      }
      if (cycleBlocked.has(req.id)) {
        await recordBlockedOnce(deps, req.id, "dependency_cycle", { depends_on: dependsOn });
        continue;
      }
      const blockingDep = dependsOn.find((depId) => depIndex.get(depId) !== "done");
      if (blockingDep !== undefined) continue; // dep_not_done

      // (4) in-flight guard.
      const history = await deps.requirementRuns.listForRequirement(req.id);
      const hasInflight = history.some((r) => r.status === "pending" || r.status === "running");
      if (hasInflight) continue;

      // (6) acceptance gate at Review. Under default acceptance
      // (reviewerAutoAccept = false), a Review row whose latest run completed
      // cleanly has no autonomous path to Done — skip to avoid burning LLM
      // cycles. A Human-policy Review row is likewise held (never auto-driven
      // to Done). When reviewerAutoAccept is set, a Review row IS re-picked so
      // the reviewer subagent can dispatch.
      if (req.status === "review") {
        const policy = acceptanceOf(req);
        const completedExists = history.some((r) => r.status === "completed");
        const reviewerWillDispatch = config.reviewerAutoAccept && policy === "subagent";
        if (policy === "human") {
          continue; // Human keeps the row at Review
        }
        if (completedExists && !reviewerWillDispatch) {
          continue; // review_completed_awaiting_acceptance
        }
      }

      // (5) retry cap — consecutive failures since last success.
      const consecutiveFailed = consecutiveFailedSinceLastSuccess(history);
      const maxRetries = deps.runtime.effectiveMaxRetries(config);
      if (consecutiveFailed >= maxRetries) continue; // retries_exceeded

      // Exponential backoff between consecutive failures.
      const backoffMs = failureBackoffMs(consecutiveFailed, config.tickSeconds);
      const latestFailed = mostRecentFailedRun(history);
      if (latestFailed && failureBackoffRemainingMs(latestFailed, backoffMs, nowMs(deps)) !== undefined) {
        continue; // failure_backoff
      }

      // Claim the requirement (in-flight dedup independent of the run store).
      const release = deps.runtime.tryClaimRequirement(req.id);
      if (!release) continue; // claim_taken

      picked += 1;
      const reqClone: Requirement = structuredClone(req);
      const workspace = resolveProjectWorkspace(project, deps);
      const gate = deps.runtime.concurrencyGate();

      const drive = (async () => {
        const permitRelease = await gate.acquire();
        try {
          await driveOne(reqClone, deps, config, { workspaceOverride: workspace });
        } catch {
          // Errors are recorded on the run row; never propagate.
        } finally {
          permitRelease();
          release();
        }
      })();
      drives.push(drive);
    }
  }

  if (awaitDrives) {
    await Promise.all(drives);
  }
  return picked;
}

// ---------- the driver ------------------------------------------------------

/** One-line truncation for run summaries (Rust `truncate_one_line`). */
function truncateOneLine(s: string, cap: number): string {
  const one = (s.split("\n")[0] ?? "").trim();
  const chars = [...one];
  if (chars.length > cap) return chars.slice(0, cap).join("") + "…";
  return one;
}

/** Compose the seed user message from the requirement title + description + todos. */
export function seedPrompt(req: Requirement): string {
  let out = "Please complete this requirement and reply with a one-line summary of what you did.\n\n";
  out += req.title;
  const desc = req.description?.trim();
  if (desc) {
    out += "\n\n" + desc;
  }
  const todos = req.todos ?? [];
  if (todos.length > 0) {
    out += "\n\nStructured TODO/checklist items to complete or update with evidence:\n";
    for (const todo of todos) {
      out += `- [${todo.status}] ${todo.kind}: ${todo.title}`;
      const command = todo.command?.trim();
      if (command) out += ` — command: \`${command}\``;
      if (todo.depends_on && todo.depends_on.length > 0) {
        out += ` — depends_on: ${todo.depends_on.join(", ")}`;
      }
      out += "\n";
    }
  }
  return out;
}

/** Most recent non-empty assistant text in the conversation, for the run summary. */
function lastAssistantSummary(conv: Conversation): string {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m: Message | undefined = conv.messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "") {
      return m.content;
    }
  }
  return "";
}

/**
 * One end-to-end pickup: mint the seed conversation, advance Backlog→InProgress,
 * seed the execution checklist, mint a Running RequirementRun (with an optional
 * worktree), drive the agent loop under a timeout, persist the outcome, advance
 * status via {@link completedRequirementTargetStatus}, and — when
 * `reviewerAutoAccept` is set and the row lands at Review under Subagent policy
 * — dispatch the reviewer seam.
 *
 * Errors are recorded on the run row and returned-as-resolved (never thrown to
 * the caller) so a single failed pickup can't take down the tick.
 */
export async function driveOne(
  requirement: Requirement,
  deps: AutoModeDeps,
  config: AutoModeConfig,
  opts: { workspaceOverride?: string } = {},
): Promise<void> {
  const reqStore = deps.requirements;
  const runStore = deps.requirementRuns;
  const convoStore = deps.store ?? undefined;
  const workspace = opts.workspaceOverride ?? deps.workspaceRoot;

  // Local mutable copy — the picker handed us a clone already, but driveOne is
  // also callable directly, so guard against mutating the caller's object.
  let req: Requirement = structuredClone(requirement);
  const policy = acceptanceOf(req);

  // 1. Mint conversation: system (placeholder manifest) + user (seed prompt).
  const conversationId = crypto.randomUUID();
  const conv = newConversation();
  conv.messages.push(systemMessage(`=== requirement ===\n${req.title}`));
  conv.messages.push(userMessage(seedPrompt(req)));
  if (convoStore) {
    try {
      await convoStore.save(conversationId, conv);
    } catch {
      // best-effort
    }
  }

  // 2. Advance Backlog→InProgress + seed the execution checklist + link convo.
  const advanced = req.status === "backlog";
  if (advanced) {
    req.status = "in_progress";
    touchRequirement(req);
  }
  ensureExecutionChecklist(req);
  linkConversation(req, conversationId);
  await reqStore.upsert(req);

  // 3. Mint run + optional worktree.
  const run = newRequirementRun(req.id, conversationId);
  run.status = "running";
  pushRequirementRunLog(run, "info", "Auto run started", {
    workspace: workspace ?? null,
    conversation_id: conversationId,
    project_id: req.project_id,
  });
  let workspaceForRun = workspace;
  if (deps.createWorktree && workspace) {
    try {
      const path = await deps.createWorktree({ workspace, runId: run.id });
      if (path) {
        run.worktree_path = path;
        workspaceForRun = path;
        pushRequirementRunLog(run, "success", "Worktree created", { path });
      } else {
        pushRequirementRunLog(run, "warn", "Worktree creation refused; using main checkout", {});
      }
    } catch {
      pushRequirementRunLog(run, "warn", "Worktree creation failed; using main checkout", {});
    }
  }
  await runStore.upsert(run);

  // 4. Audit rows for the auto pickup.
  await recordActivity(deps, req.id, "run_started", { type: "system" }, {
    run_id: run.id,
    conversation_id: conversationId,
    auto: true,
  });
  if (advanced) {
    await recordActivity(deps, req.id, "status_change", { type: "system" }, {
      from: "backlog",
      to: "in_progress",
      reason: "auto_run_started",
    });
  }

  // 5. Build the agent and drive the loop under a wall-clock timeout.
  pushRequirementRunLog(run, "info", "Agent loop started", { timeout_ms: config.runTimeoutMs });
  await runStore.upsert(run);

  let finalConv = conv;
  let usage: Usage | undefined;
  let runError: string | undefined;
  try {
    const agent = deps.createAgent({ sessionWorkspace: workspaceForRun });
    run.model = agent.model;
    const convForRun: Conversation = structuredClone(conv);
    const result = await withTimeout(agent.runWithUsage(convForRun), config.runTimeoutMs);
    finalConv = convForRun;
    usage = result[1];
  } catch (e) {
    runError =
      e instanceof TimeoutError
        ? `agent timed out after ${config.runTimeoutMs}ms`
        : `agent error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 6. Mark run terminal + persist.
  if (runError === undefined) {
    if (usage && !usageIsEmpty(usage)) run.usage = usage;
    if (convoStore) {
      try {
        await convoStore.save(conversationId, finalConv);
      } catch {
        // best-effort
      }
    }
    const summary = lastAssistantSummary(finalConv);
    run.summary = summary.trim() === "" ? undefined : truncateOneLine(summary, 240);
    pushRequirementRunLog(run, "success", "Agent loop completed", { summary: run.summary ?? null });
    finishRequirementRun(run, "completed");
  } else {
    pushRequirementRunLog(run, "error", "Agent loop failed", { error: runError });
    run.error = runError;
    finishRequirementRun(run, "failed");
  }
  const runCompleted = runError === undefined;
  await runStore.upsert(run);

  // The agent can mutate the checklist via requirement.* tools mid-run; reload
  // before judging completion so we use the durable checklist, not the clone.
  const latest = await reqStore.get(req.id);
  if (latest) req = latest;

  // 7. Advance status.
  await advanceCompletedRequirement(deps, req, run, policy);

  // 8. Reviewer-subagent dispatch (opt-in). When the row landed at Review under
  // Subagent policy and reviewerAutoAccept is set, dispatch the reviewer seam;
  // its terminal verdict flips Done (pass) / InProgress (fail).
  if (config.reviewerAutoAccept && policy === "subagent" && runCompleted && deps.dispatchReviewer) {
    const reloaded = (await reqStore.get(req.id)) ?? req;
    const priorStatus: RequirementStatus = reloaded.status;
    if (priorStatus === "review") {
      const verdict = await deps.dispatchReviewer({ requirement: reloaded, run });
      if (verdict === "pass" || verdict === "fail") {
        const target: RequirementStatus = verdict === "pass" ? "done" : "in_progress";
        reloaded.status = target;
        touchRequirement(reloaded);
        await reqStore.upsert(reloaded);
        await recordActivity(deps, reloaded.id, "status_change", { type: "system" }, {
          from: priorStatus,
          to: target,
          auto: true,
          run_id: run.id,
          reviewer: verdict,
        });
      }
    }
  }

  // 9. Final run-finished audit row.
  await recordActivity(deps, req.id, "run_finished", { type: "system" }, {
    run_id: run.id,
    status: run.status,
    auto: true,
  });
}

/**
 * Advance a requirement to the target status implied by a completed run, and
 * record a status_change Activity. No-op when there's no transition. Mirrors
 * Rust `advance_completed_requirement`.
 */
export async function advanceCompletedRequirement(
  deps: AutoModeDeps,
  requirement: Requirement,
  run: RequirementRun,
  acceptancePolicy: AcceptancePolicy,
): Promise<void> {
  const target = completedRequirementTargetStatus(requirement, run, acceptancePolicy);
  if (target === undefined) return;
  if (requirement.status === target) return;

  const prior = requirement.status;
  requirement.status = target;
  touchRequirement(requirement);
  try {
    await deps.requirements.upsert(requirement);
  } catch {
    return;
  }
  await recordActivity(deps, requirement.id, "status_change", { type: "system" }, {
    from: prior,
    to: target,
    auto: true,
    run_id: run.id,
  });
}

// ---------- timeout helper --------------------------------------------------

export class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a wall-clock budget. Rejects with {@link TimeoutError}
 * when the budget elapses first. The underlying promise is not cancelled (Node
 * has no cancellation primitive); the loop's own checks bound it eventually.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------- background loop -------------------------------------------------

/**
 * Spawn the background tick loop. The runtime enable flag gates each tick — when
 * disabled, the tick is skipped without touching any store, so an operator can
 * flip auto on at runtime. Returns a stop function that clears the interval.
 * Mirrors Rust `spawn` (minus the stale-run reaper, which depends on unported
 * timestamp plumbing).
 */
export function spawnAutoModeLoop(deps: AutoModeDeps, config: AutoModeConfig): () => void {
  const periodMs = Math.max(1, config.tickSeconds) * 1000;
  let running = false;
  const timer = setInterval(() => {
    deps.runtime.recordTick();
    if (!deps.runtime.isEnabled()) return;
    if (running) return; // never overlap ticks
    running = true;
    autoModeTick(deps, config).finally(() => {
      running = false;
    });
  }, periodMs);
  // Don't keep the process alive solely for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ---------- REST routes -----------------------------------------------------

/**
 * Register the runtime auto-mode toggle routes. Ported from
 * crates/harness-server/src/auto_mode_routes.rs:
 *
 * - `GET  /v1/auto-mode` → status snapshot. Always 200. When no runtime is
 *   wired, `configured: false` is returned and config/permits fields are
 *   omitted. When configured, the response carries the resolved config numbers
 *   plus live runtime state (`available_permits`, `last_tick_at`,
 *   `effective_mode`, `effective_max_retries`, optional `max_retries_override`).
 * - `POST /v1/auto-mode` body `{enabled?, max_retries?}` flips the flag and/or
 *   hot-reloads the retry cap (sentinel 0 clears the override). 503 when no
 *   runtime is wired.
 *
 * Reads `state.autoModeRuntime` + `state.autoModeConfig`.
 */
export function registerAutoModeRoutes(
  app: {
    get(path: string, handler: (req: unknown, reply: AutoModeReply) => unknown): void;
    post(path: string, handler: (req: AutoModeRequest, reply: AutoModeReply) => unknown): void;
  },
  state: { autoModeRuntime?: AutoModeRuntime; autoModeConfig?: AutoModeConfig },
): void {
  app.get("/v1/auto-mode", (_req, reply) => {
    const runtime = state.autoModeRuntime;
    const config = state.autoModeConfig;
    const configured = runtime !== undefined;
    const enabled = runtime?.isEnabled() ?? false;
    const body: Record<string, unknown> = {
      configured,
      enabled,
      // effective_mode = "is the scheduler picking work right now?" — the ANDed
      // view of configured && enabled. The static `mode` (below) reflects
      // startup config and diverges as soon as POST flips the flag.
      effective_mode: configured && enabled ? "auto" : "off",
    };
    if (runtime) {
      body.available_permits = runtime.availablePermits();
      body.last_tick_at = runtime.lastTickAt() ?? null;
    }
    if (config) {
      body.mode = config.mode;
      body.tick_seconds = config.tickSeconds;
      body.max_units_per_tick = config.maxUnitsPerTick;
      body.max_concurrent_units = config.maxConcurrent;
      body.max_retries = config.maxRetries;
      body.effective_max_retries = runtime ? runtime.effectiveMaxRetries(config) : config.maxRetries;
      if (runtime) {
        const override = runtime.maxRetriesOverride();
        if (override !== undefined) body.max_retries_override = override;
      }
      body.run_timeout_ms = config.runTimeoutMs;
    }
    return reply.send(body);
  });

  app.post("/v1/auto-mode", (req, reply) => {
    const runtime = state.autoModeRuntime;
    if (!runtime) {
      return reply.code(503).send({ error: "auto-mode runtime not configured" });
    }
    const rawBody = (req.body ?? {}) as { enabled?: unknown; max_retries?: unknown };
    if (typeof rawBody.enabled === "boolean") {
      runtime.setEnabled(rawBody.enabled);
    }
    if (typeof rawBody.max_retries === "number" && Number.isFinite(rawBody.max_retries)) {
      // 0 is the "clear override" sentinel; anything else sets the new ceiling.
      const value = Math.trunc(rawBody.max_retries);
      // A negative ceiling makes the tick guard `consecutiveFailed >= maxRetries`
      // true for every requirement (even 0 failures), silently disabling the
      // whole scheduler. Reject it rather than storing an inert override.
      if (value < 0) {
        return reply.code(400).send({ error: "max_retries must be >= 0" });
      }
      runtime.setMaxRetriesOverride(value === 0 ? undefined : value);
    }
    const response: Record<string, unknown> = {
      configured: true,
      enabled: runtime.isEnabled(),
    };
    const config = state.autoModeConfig;
    if (config) {
      response.effective_max_retries = runtime.effectiveMaxRetries(config);
    }
    const override = runtime.maxRetriesOverride();
    if (override !== undefined) response.max_retries_override = override;
    return reply.send(response);
  });
}

/** Minimal Fastify-reply surface the routes use (kept structural to avoid a hard fastify dep here). */
interface AutoModeReply {
  code(status: number): AutoModeReply;
  send(payload: unknown): unknown;
}

/** Minimal Fastify-request surface (just the parsed JSON body). */
interface AutoModeRequest {
  body?: unknown;
}
