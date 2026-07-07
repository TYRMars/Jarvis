// Work-mode dashboard aggregation routes.
//
// Ported from crates/harness-server/src/work_overview_routes.rs. Two
// endpoints, both pre-aggregating across the optional domain stores on
// AppState:
//
// - GET /v1/work/overview?since=<rfc3339>&window_days=<u32> — cheap roll-ups
//   (KPI cards, status counts, throughput by day, project leaderboard,
//   running runs, recent failures, blocked requirements).
// - GET /v1/work/quality?since=<rfc3339>&window_days=<u32> — slower
//   aggregations that walk verification payloads (top failing commands,
//   verification pass rate by day).
//
// Both endpoints tolerate partial store availability: each sub-aggregate that
// needs an unavailable store returns `null` and its name is reported in
// `missing_stores`. Only the RequirementRunStore is hard-required (the
// dashboard's core data source); when it's missing the endpoint returns 503.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type {
  Activity,
  ActivityKind,
  Project,
  Requirement,
  RequirementRun,
  RequirementRunStatus,
  RequirementRunStore,
  RequirementStatus,
  VerificationStatus,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

/** Default time window when neither `since` nor `window_days` is set. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Cap on the upstream `RequirementRunStore.listAll` scan. Keeps the dashboard
 * cheap on installations with millions of runs; surfaced via the response's
 * `truncated` flag so the UI can warn.
 */
const RUN_SCAN_LIMIT = 1000;

/**
 * Cap on the cross-project blocked-requirements scan (number of projects
 * considered).
 */
const BLOCKED_PROJECT_LIMIT = 20;

/**
 * Per-requirement activity scan depth when looking for the latest
 * blocked/unblocked transition.
 */
const ACTIVITY_PEEK = 50;

const MS_PER_DAY = 86_400_000;

// --------------------------- Query parsing -------------------------------

interface OverviewQuery {
  since?: string;
  window_days?: string;
}

interface ResolvedWindow {
  /** Epoch millis (UTC) of "now". */
  asOf: number;
  /** Epoch millis (UTC) lower bound for the window. */
  since: number;
  windowDays: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Resolve the time window. Mirrors Rust `resolve_window`: `window_days`
 * defaults to 7 and is clamped to `[1, 365]`; `since` defaults to
 * `now - window_days`. An unparseable `since` yields a 400 (returned as a
 * string error reason, distinguishing the failure from a successful window).
 */
function resolveWindow(q: OverviewQuery): ResolvedWindow | { badSince: string } {
  const asOf = Date.now();
  const rawDays = q.window_days !== undefined ? Number.parseInt(q.window_days, 10) : NaN;
  const windowDays = clamp(Number.isFinite(rawDays) ? rawDays : DEFAULT_WINDOW_DAYS, 1, 365);
  let since: number;
  if (q.since !== undefined) {
    const parsed = parseTs(q.since);
    if (parsed === undefined) {
      return { badSince: `invalid \`since\`: ${q.since}` };
    }
    // Floor the explicit `since` to the same 365-day ceiling the `window_days`
    // path enforces, so a far-past `since` can't seed tens of thousands of
    // day-buckets in `seedDayKeys` (request/response amplification). Also reject
    // a future `since` (would produce an empty/negative window).
    if (parsed > asOf) {
      return { badSince: `\`since\` is in the future: ${q.since}` };
    }
    since = Math.max(parsed, asOf - 365 * MS_PER_DAY);
  } else {
    since = asOf - windowDays * MS_PER_DAY;
  }
  return { asOf, since, windowDays };
}

// --------------------------- Helpers -------------------------------------

/** Return the run store, or send a 503 and return undefined. */
function requireRunStore(state: AppState, reply: FastifyReply): RequirementRunStore | undefined {
  if (!state.requirementRuns) {
    reply.code(503).send({ error: "requirement run store not configured" });
    return undefined;
  }
  return state.requirementRuns;
}

/**
 * Parse an RFC-3339 / ISO-8601 timestamp to epoch millis. Returns `undefined`
 * for unparseable input — callers fold those rows back to "no contribution"
 * rather than failing the whole aggregate. Mirrors Rust `parse_ts`.
 */
function parseTs(s: string): number | undefined {
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** UTC calendar day (`YYYY-MM-DD`) of an epoch-millis instant. */
function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Normalise a verification command for top-failing-commands grouping.
 * `cargo test -p foo --lib` and `cargo test -p bar --features x` both reduce
 * to `cargo test`. Empty input yields `"<empty>"`. Mirrors `normalise_command`.
 */
function normaliseCommand(cmd: string): string {
  const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "<empty>";
  if (tokens.length === 1) return tokens[0]!;
  return `${tokens[0]} ${tokens[1]}`;
}

/**
 * Seed an empty bucket for every UTC day in `[since, asOf]` so empty days
 * still render zeros. Mirrors Rust `seed_buckets` / `seed_verification_buckets`.
 */
function seedDayKeys(since: number, asOf: number): string[] {
  const keys: string[] = [];
  // Walk by calendar day starting from the UTC midnight of `since`.
  const start = Date.parse(`${dayKey(since)}T00:00:00.000Z`);
  const endKey = dayKey(asOf);
  for (let t = start; ; t += MS_PER_DAY) {
    const k = dayKey(t);
    keys.push(k);
    if (k >= endKey) break;
  }
  return keys;
}

interface ThroughputBucket {
  runs_started: number;
  runs_completed: number;
  runs_failed: number;
  requirements_completed: number;
}

interface VerificationBucket {
  passed: number;
  failed: number;
  needs_review: number;
}

interface FailingCmd {
  fail_count: number;
  sample_stderr: string;
  last_seen?: string;
}

// --------------------------- Overview handler ----------------------------

async function getOverview(state: AppState, q: OverviewQuery, reply: FastifyReply): Promise<unknown> {
  const window = resolveWindow(q);
  if ("badSince" in window) {
    return reply.code(400).send({ error: window.badSince });
  }
  const runsStore = requireRunStore(state, reply);
  if (!runsStore) return reply;

  const missingStores: string[] = [];

  let runs: RequirementRun[];
  try {
    runs = await runsStore.listAll(RUN_SCAN_LIMIT);
  } catch (e) {
    return reply.code(500).send({ error: errorText(e) });
  }
  const truncated = runs.length >= RUN_SCAN_LIMIT;

  // ---- projects --------------------------------------------------------
  let projects: Project[] | undefined;
  if (state.projects) {
    try {
      projects = await state.projects.list(false, 500);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  } else {
    missingStores.push("projects");
  }

  // ---- requirements (needs both the requirement store + a project list) -
  let requirements: Requirement[] | undefined;
  if (state.requirements && projects) {
    const all: Requirement[] = [];
    try {
      for (const p of projects) {
        all.push(...(await state.requirements.list(p.id)));
      }
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    requirements = all;
  } else {
    // Either no requirement store, or one but no project store to enumerate
    // projects with. Skip rather than fail.
    missingStores.push("requirements");
  }

  // ---- requirement_status_counts --------------------------------------
  let requirementStatusCounts: Record<RequirementStatus, number> | null = null;
  if (requirements) {
    const counts = { backlog: 0, in_progress: 0, review: 0, done: 0 };
    for (const r of requirements) counts[r.status] += 1;
    requirementStatusCounts = counts;
  }

  // ---- index requirements + projects for joins ------------------------
  const reqIndex = new Map<string, Requirement>();
  if (requirements) for (const r of requirements) reqIndex.set(r.id, r);
  const projIndex = new Map<string, Project>();
  if (projects) for (const p of projects) projIndex.set(p.id, p);

  // ---- running_now ----------------------------------------------------
  const runningNow = runs
    .filter((r) => r.status === ("running" as RequirementRunStatus))
    .map((r) => {
      const req = reqIndex.get(r.requirement_id);
      const proj = req ? projIndex.get(req.project_id) : undefined;
      const started = parseTs(r.started_at);
      const durationMs = started !== undefined ? Math.max(window.asOf - started, 0) : null;
      return {
        id: r.id,
        requirement_id: r.requirement_id,
        requirement_title: req?.title ?? null,
        project_id: req?.project_id ?? null,
        project_name: proj?.name ?? null,
        started_at: r.started_at,
        conversation_id: r.conversation_id,
        duration_ms: durationMs,
      };
    });

  // ---- window-scoped run rollups --------------------------------------
  const runStatusCounts = { completed: 0, failed: 0, cancelled: 0 };
  const throughput = new Map<string, ThroughputBucket>();
  for (const k of seedDayKeys(window.since, window.asOf)) {
    throughput.set(k, { runs_started: 0, runs_completed: 0, runs_failed: 0, requirements_completed: 0 });
  }
  const bucketFor = (key: string): ThroughputBucket => {
    let b = throughput.get(key);
    if (!b) {
      b = { runs_started: 0, runs_completed: 0, runs_failed: 0, requirements_completed: 0 };
      throughput.set(key, b);
    }
    return b;
  };

  let verificationPassed = 0;
  let verificationTotal = 0;
  const recentFailures: RequirementRun[] = [];

  for (const run of runs) {
    // Skip runs whose parent requirement no longer exists — counting them
    // surfaces ghost rows the user can't click into.
    if (requirements !== undefined && !reqIndex.has(run.requirement_id)) {
      continue;
    }
    const started = parseTs(run.started_at);
    if (started === undefined) continue;
    if (started < window.since || started > window.asOf) continue;
    const bucket = bucketFor(dayKey(started));
    bucket.runs_started += 1;

    switch (run.status) {
      case "completed": {
        runStatusCounts.completed += 1;
        bucket.runs_completed += 1;
        if (run.verification) {
          verificationTotal += 1;
          if (run.verification.status === ("passed" as VerificationStatus)) {
            verificationPassed += 1;
          }
        }
        break;
      }
      case "failed": {
        runStatusCounts.failed += 1;
        bucket.runs_failed += 1;
        recentFailures.push(run);
        break;
      }
      case "cancelled": {
        runStatusCounts.cancelled += 1;
        break;
      }
      default:
        break;
    }
  }

  // requirements_completed per day (in window) — derived from a Done
  // requirement's updated_at. Best-effort.
  if (requirements) {
    for (const r of requirements) {
      if (r.status !== ("done" as RequirementStatus)) continue;
      const updated = parseTs(r.updated_at);
      if (updated === undefined) continue;
      if (updated < window.since || updated > window.asOf) continue;
      bucketFor(dayKey(updated)).requirements_completed += 1;
    }
  }

  const throughputByDay = [...throughput.entries()]
    .map(([date, b]) => ({
      date,
      runs_started: b.runs_started,
      runs_completed: b.runs_completed,
      runs_failed: b.runs_failed,
      requirements_completed: b.requirements_completed,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // recent_failures, newest-first, top 10
  const failKey = (r: RequirementRun): string => r.finished_at ?? r.started_at;
  recentFailures.sort((a, b) => {
    const ka = failKey(a);
    const kb = failKey(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  const recentFailuresOut = recentFailures.slice(0, 10).map((r) => {
    const req = reqIndex.get(r.requirement_id);
    const proj = req ? projIndex.get(req.project_id) : undefined;
    return {
      id: r.id,
      requirement_id: r.requirement_id,
      requirement_title: req?.title ?? null,
      project_id: req?.project_id ?? null,
      project_name: proj?.name ?? null,
      error: r.error ?? null,
      finished_at: r.finished_at ?? null,
      conversation_id: r.conversation_id,
    };
  });

  const verificationPassRate = verificationTotal > 0 ? verificationPassed / verificationTotal : null;

  // ---- project leaderboard --------------------------------------------
  let projectLeaderboard: unknown[] | null = null;
  if (projects) {
    const tally = new Map<string, { runs: number; completed: number }>();
    for (const run of runs) {
      const req = reqIndex.get(run.requirement_id);
      if (!req) continue;
      const started = parseTs(run.started_at);
      if (started === undefined) continue;
      if (started < window.since || started > window.asOf) continue;
      let entry = tally.get(req.project_id);
      if (!entry) {
        entry = { runs: 0, completed: 0 };
        tally.set(req.project_id, entry);
      }
      entry.runs += 1;
      if (run.status === ("completed" as RequirementRunStatus)) entry.completed += 1;
    }
    const board = projects
      .map((p) => {
        const entry = tally.get(p.id);
        if (!entry) return undefined;
        const completionRate = entry.runs > 0 ? entry.completed / entry.runs : 0.0;
        return {
          project_id: p.id,
          project_name: p.name,
          runs_in_window: entry.runs,
          completion_rate: completionRate,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
    board.sort((a, b) => b.runs_in_window - a.runs_in_window);
    projectLeaderboard = board.slice(0, 5);
  }

  // ---- blocked_requirements -------------------------------------------
  let blockedRequirements: unknown[] | null = null;
  let blockedTruncated = false;
  if (state.activities && requirements && projects) {
    const scannedProjects = projects.slice(0, BLOCKED_PROJECT_LIMIT);
    const scannedIds = new Set(scannedProjects.map((p) => p.id));
    blockedTruncated = projects.length > scannedProjects.length;
    const blocked: { id: string; project_id: string; project_name: string | null; title: string; blocked_since: string; reason: string | null }[] = [];
    for (const r of requirements) {
      if (!scannedIds.has(r.project_id)) continue;
      let activities: Activity[];
      try {
        activities = await state.activities.listForRequirement(r.id);
      } catch {
        continue;
      }
      // activities are newest-first; find the latest blocked and check
      // whether a later unblocked has happened.
      let latestBlock: { ts: string; body: unknown } | undefined;
      let latestUnblockTs: string | undefined;
      for (const a of activities.slice(0, ACTIVITY_PEEK)) {
        const kind: ActivityKind = a.kind;
        if (kind === "blocked" && latestBlock === undefined) {
          latestBlock = { ts: a.created_at, body: a.body };
        } else if (kind === "unblocked" && latestUnblockTs === undefined) {
          latestUnblockTs = a.created_at;
        }
      }
      if (latestBlock !== undefined) {
        const unblockedAfter = latestUnblockTs !== undefined && latestUnblockTs > latestBlock.ts;
        if (!unblockedAfter) {
          const projectName = projIndex.get(r.project_id)?.name ?? null;
          const body = latestBlock.body;
          const reason =
            body !== null && typeof body === "object" && "reason" in body && typeof (body as { reason?: unknown }).reason === "string"
              ? ((body as { reason: string }).reason)
              : null;
          blocked.push({
            id: r.id,
            project_id: r.project_id,
            project_name: projectName,
            title: r.title,
            blocked_since: latestBlock.ts,
            reason,
          });
        }
      }
    }
    blocked.sort((a, b) => (a.blocked_since < b.blocked_since ? 1 : a.blocked_since > b.blocked_since ? -1 : 0));
    blockedRequirements = blocked;
  } else if (!state.activities) {
    missingStores.push("activities");
  }

  return reply.send({
    as_of: new Date(window.asOf).toISOString(),
    since: new Date(window.since).toISOString(),
    window_days: window.windowDays,
    missing_stores: missingStores,
    truncated,
    blocked_truncated: blockedTruncated,
    requirement_status_counts: requirementStatusCounts,
    running_now: runningNow,
    blocked_requirements: blockedRequirements,
    run_status_counts: runStatusCounts,
    verification_pass_rate: verificationPassRate,
    recent_failures: recentFailuresOut,
    throughput_by_day: throughputByDay,
    project_leaderboard: projectLeaderboard,
    // v1: cross-project actor breakdown needs an ActivityStore index we don't
    // have. Field stays present + null so clients can render an "unavailable"
    // state without conditional shape.
    actor_breakdown: null,
  });
}

// --------------------------- Quality handler -----------------------------

async function getQuality(state: AppState, q: OverviewQuery, reply: FastifyReply): Promise<unknown> {
  const window = resolveWindow(q);
  if ("badSince" in window) {
    return reply.code(400).send({ error: window.badSince });
  }
  const runsStore = requireRunStore(state, reply);
  if (!runsStore) return reply;

  let runs: RequirementRun[];
  try {
    runs = await runsStore.listAll(RUN_SCAN_LIMIT);
  } catch (e) {
    return reply.code(500).send({ error: errorText(e) });
  }
  const truncated = runs.length >= RUN_SCAN_LIMIT;

  const tally = new Map<string, FailingCmd>();
  const verificationBuckets = new Map<string, VerificationBucket>();
  for (const k of seedDayKeys(window.since, window.asOf)) {
    verificationBuckets.set(k, { passed: 0, failed: 0, needs_review: 0 });
  }
  const verifBucketFor = (key: string): VerificationBucket => {
    let b = verificationBuckets.get(key);
    if (!b) {
      b = { passed: 0, failed: 0, needs_review: 0 };
      verificationBuckets.set(key, b);
    }
    return b;
  };

  for (const run of runs) {
    const verification = run.verification;
    if (!verification) continue;
    const started = parseTs(run.started_at);
    if (started === undefined) continue;
    if (started < window.since || started > window.asOf) continue;
    const bucket = verifBucketFor(dayKey(started));
    switch (verification.status) {
      case "passed":
        bucket.passed += 1;
        break;
      case "failed":
        bucket.failed += 1;
        break;
      case "needs_review":
        bucket.needs_review += 1;
        break;
      case "skipped":
        break;
    }

    for (const cr of verification.command_results) {
      const failed = cr.exit_code !== undefined ? cr.exit_code !== 0 : true;
      if (!failed) continue;
      const key = normaliseCommand(cr.command);
      let entry = tally.get(key);
      if (!entry) {
        entry = { fail_count: 0, sample_stderr: "" };
        tally.set(key, entry);
      }
      entry.fail_count += 1;
      const stderr = cr.stderr ?? "";
      if (entry.sample_stderr.length === 0 && stderr.length > 0) {
        entry.sample_stderr = stderr.slice(0, 512);
      }
      // last_seen tracked as max started_at (RFC-3339 strings sort correctly).
      if (entry.last_seen === undefined || run.started_at > entry.last_seen) {
        entry.last_seen = run.started_at;
      }
    }
  }

  const topFailingCommands = [...tally.entries()]
    .map(([command_normalized, v]) => ({
      command_normalized,
      fail_count: v.fail_count,
      sample_stderr: v.sample_stderr,
      last_seen: v.last_seen ?? null,
    }))
    .sort((a, b) => b.fail_count - a.fail_count)
    .slice(0, 15);

  const verificationPassRateByDay = [...verificationBuckets.entries()]
    .map(([date, b]) => ({ date, passed: b.passed, failed: b.failed, needs_review: b.needs_review }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return reply.send({
    as_of: new Date(window.asOf).toISOString(),
    since: new Date(window.since).toISOString(),
    window_days: window.windowDays,
    truncated,
    top_failing_commands: topFailingCommands,
    verification_pass_rate_by_day: verificationPassRateByDay,
  });
}

// --------------------------- Registration --------------------------------

export function registerWorkRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/work/overview", (req, reply) => getOverview(state, req.query as OverviewQuery, reply));
  app.get("/v1/work/quality", (req, reply) => getQuality(state, req.query as OverviewQuery, reply));
}
