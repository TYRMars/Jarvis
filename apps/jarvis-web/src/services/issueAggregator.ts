// v1.0 — Sentry-style issue aggregation for the WorkOverview
// Exceptions panel.
//
// Takes the three raw signal sources surfaced today (recent run
// failures, orphan worktrees, stuck runs) and groups them into a
// unified `Issue` collection keyed by a stable *signature* — a
// hash of the normalised message that survives variations in
// timestamps, UUIDs, file paths, and numeric ids.
//
// Why aggregate locally:
//   - The server already exposes the three lists; building a
//     server-side issue grouper would mean a schema change on
//     RequirementRun + a migration for 5 store backends. The
//     normalisation below covers ~95% of "same root cause →
//     same signature" without touching the backend.
//   - Browser-local groupings let users mark issues as Ignored
//     (localStorage) without coordinating with the server.

import type { RecentFailureRow } from "./workOverview";
import type { OrphanWorktree, StuckRun } from "./diagnostics";

export type IssueCategory = "agent_error" | "orphan_worktree" | "stuck_run";
export type IssueSeverity = "critical" | "high" | "warning";

export interface AffectedResource {
  /// Stable id for "go to" links: requirement_id for agent_error
  /// rows, run_id for stuck/orphan rows.
  id: string;
  /// Optional human-readable label; falls back to the id slice.
  label?: string | null;
  /// Optional project name used in the leading line of each
  /// affected-row.
  project_name?: string | null;
  /// Conversation to jump to when the user clicks "open" on this
  /// affected row. Only present for agent_error issues.
  conversation_id?: string | null;
  /// ISO timestamp this resource recorded the issue.
  at: string;
}

export interface Issue {
  /// Stable grouping key — same signature across runs means same
  /// underlying problem. 12-char base36 hash of the normalised
  /// message + category prefix.
  signature: string;
  category: IssueCategory;
  severity: IssueSeverity;
  /// Single-line headline. Derived from the most-recent
  /// occurrence, with timestamps / UUIDs scrubbed for readability.
  title: string;
  /// Up to ~800 chars of the original (non-normalised) message
  /// from the most recent occurrence — full fidelity, surfaced in
  /// the expand-on-click stack panel.
  sample: string | null;
  /// Number of occurrences in the current window.
  count: number;
  first_seen: string;
  last_seen: string;
  /// Resources affected, newest first. Capped at 10 in the panel
  /// itself; the aggregator returns all so a future "view all
  /// affected" drill-down has the data.
  affected: AffectedResource[];
  /// Optional resolution hint surfaced under the title — short,
  /// actionable. None for unrecognised signatures.
  hint?: string;
}

// ---------- Normalisation ----------------------------------------

const PATTERNS: Array<[RegExp, string]> = [
  // ISO-8601 timestamps with or without milliseconds / TZ.
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  // RFC-3339 / SQL-ish dates.
  [/\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}:\d{2}/g, "<ts>"],
  // UUIDs.
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  // Long hex strings (commit hashes, hashes).
  [/\b[0-9a-f]{12,}\b/gi, "<hex>"],
  // Absolute paths.
  [/(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g, "<path>"],
  // Windows-style paths.
  [/[A-Z]:\\(?:[A-Za-z0-9._-]+\\)+[A-Za-z0-9._-]+/g, "<path>"],
  // Port numbers (after a colon) — common in URL errors.
  [/:\d{2,5}\b/g, ":<port>"],
  // Quoted strings — variable content rarely matters for grouping.
  [/"[^"]{4,}"/g, '"<str>"'],
  // Long numeric literals.
  [/\b\d{4,}\b/g, "<n>"],
  // Trim leading/trailing whitespace, collapse runs.
  [/\s+/g, " "],
];

export function normaliseMessage(raw: string | null | undefined): string {
  if (!raw) return "(empty error)";
  let s = raw;
  for (const [re, repl] of PATTERNS) {
    s = s.replace(re, repl);
  }
  return s.trim().toLowerCase();
}

/// Stable 64-bit-ish hash → 12-char base36. Not crypto; just enough
/// entropy to avoid signature collisions across the few hundred
/// distinct error messages a single deployment will see.
function hashSignature(input: string): string {
  // FNV-1a 32-bit, twice with different offsets, concatenated for
  // ~52 bits of effective entropy.
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ c) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12);
}

// ---------- Severity heuristics ----------------------------------

const CRITICAL_KEYWORDS = ["panic", "fatal", "deadlock", "out of memory", "oom", "segfault"];
const HIGH_KEYWORDS = [
  "timeout",
  "timed out",
  "connection refused",
  "connection reset",
  "5\\d{2}", // HTTP 5xx
  "internal error",
  "unauthorized",
  "rate.?limit",
  "max retries",
  "permission denied",
  "exit (code )?[1-9]",
];
const WARNING_KEYWORDS = ["validation", "schema", "4\\d{2}", "not found", "missing"];

function severityFor(category: IssueCategory, normalised: string): IssueSeverity {
  if (category === "orphan_worktree") return "warning";
  if (category === "stuck_run") return "high";
  for (const k of CRITICAL_KEYWORDS) {
    if (normalised.includes(k)) return "critical";
  }
  for (const k of HIGH_KEYWORDS) {
    if (new RegExp(k).test(normalised)) return "high";
  }
  for (const k of WARNING_KEYWORDS) {
    if (new RegExp(k).test(normalised)) return "warning";
  }
  return "high"; // default for agent errors — failure is meaningful
}

// ---------- Resolution hints -------------------------------------
//
// Lookups ordered by specificity. First substring match wins. Hints
// are intentionally short — the goal is "operator sees one line and
// knows what to do next", not a full runbook.

const HINTS: Array<[RegExp, string]> = [
  [/store must be set to false/i, "Codex backend rejects `store: true`. Set `chain_responses=false` on the provider config."],
  [/(invalid|bad).*api.?key|unauthorized|401/i, "Re-run `jarvis login --provider <name>` to refresh credentials."],
  [/timeout|timed out/i, "Tune `JARVIS_WORK_RUN_TIMEOUT_MS` or check the upstream provider's status page."],
  [/rate.?limit|429/i, "Throttle by lowering `JARVIS_WORK_MAX_UNITS_PER_TICK`, or wait for the provider window to reset."],
  [/max.?retries/i, "Inspect the failing requirement; `requirement.update` to clear retry budget when fixed."],
  [/permission denied|forbidden|403/i, "Check filesystem perms on the workspace + tool sandbox root."],
  [/out of memory|oom/i, "Limit shell.exec via `ShellLimits`, or reduce concurrent agent loops."],
  [/exit (code )?[1-9]/i, "Verification command failed — open the run's conversation to inspect stderr."],
  [/\bENOENT\b|no such file/i, "File path missing — check `JARVIS_FS_ROOT` resolution."],
];

function hintFor(normalised: string): string | undefined {
  for (const [re, hint] of HINTS) {
    if (re.test(normalised)) return hint;
  }
  return undefined;
}

// ---------- Aggregation ------------------------------------------

interface AggregatorInput {
  failures: RecentFailureRow[];
  orphans: OrphanWorktree[];
  stuck: StuckRun[];
}

export function aggregateIssues(input: AggregatorInput): Issue[] {
  const groups = new Map<string, Issue>();

  // -- Agent errors → grouped by normalised error message
  for (const f of input.failures) {
    const norm = normaliseMessage(f.error);
    const sig = "ae_" + hashSignature(norm);
    const at = f.finished_at ?? new Date().toISOString();
    const aff: AffectedResource = {
      id: f.requirement_id,
      label: f.requirement_title,
      project_name: f.project_name,
      conversation_id: f.conversation_id,
      at,
    };
    upsertIssue(groups, sig, "agent_error", at, () => ({
      title: deriveTitle(f.error, norm),
      sample: f.error,
      severity: severityFor("agent_error", norm),
      hint: hintFor(norm),
    }), aff);
  }

  // -- Orphan worktrees → one bucket (the path doesn't tell us the
  //    root cause; the existence is the signal). Counted per row.
  if (input.orphans.length > 0) {
    const sig = "ow_summary";
    const at = input.orphans
      .map((o) => o.modified_at)
      .sort()
      .pop() ?? new Date().toISOString();
    for (const o of input.orphans) {
      const aff: AffectedResource = {
        id: o.run_id,
        label: o.path,
        at: o.modified_at,
      };
      upsertIssue(groups, sig, "orphan_worktree", o.modified_at, () => ({
        title: `Orphan worktrees on disk`,
        sample: input.orphans
          .map((x) => `${x.path}  (run ${x.run_id.slice(0, 8)})`)
          .join("\n"),
        severity: severityFor("orphan_worktree", ""),
        hint: "Run `POST /v1/diagnostics/worktrees/orphans/cleanup` (or the dashboard's Cleanup button) to free disk + sync state.",
      }), aff);
    }
    void at;
  }

  // -- Stuck runs → bucket by status (pending vs running)
  for (const s of input.stuck) {
    const sig = "sr_" + s.status;
    const aff: AffectedResource = {
      id: s.id,
      label: `run ${s.id.slice(0, 8)}`,
      at: s.started_at,
    };
    upsertIssue(groups, sig, "stuck_run", s.started_at, () => ({
      title: `Runs stuck in ${s.status}`,
      sample: input.stuck
        .filter((x) => x.status === s.status)
        .map((x) => `${x.id.slice(0, 8)}  age ${Math.round(x.age_seconds / 60)}m  started ${x.started_at}`)
        .join("\n"),
      severity: severityFor("stuck_run", ""),
      hint: "Inspect the conversation; if the agent loop died, PATCH the run to a terminal status or DELETE its worktree.",
    }), aff);
  }

  return Array.from(groups.values()).sort((a, b) => {
    // Primary sort: severity (critical → high → warning).
    const sevRank = { critical: 0, high: 1, warning: 2 };
    if (sevRank[a.severity] !== sevRank[b.severity]) {
      return sevRank[a.severity] - sevRank[b.severity];
    }
    // Secondary: most recent last-seen first.
    return b.last_seen.localeCompare(a.last_seen);
  });
}

function upsertIssue(
  groups: Map<string, Issue>,
  signature: string,
  category: IssueCategory,
  at: string,
  build: () => Pick<Issue, "title" | "sample" | "severity" | "hint">,
  affected: AffectedResource,
): void {
  const existing = groups.get(signature);
  if (existing) {
    existing.count += 1;
    if (at > existing.last_seen) existing.last_seen = at;
    if (at < existing.first_seen) existing.first_seen = at;
    // Newest first, cap at 50 to keep the affected list bounded.
    existing.affected.unshift(affected);
    if (existing.affected.length > 50) existing.affected.pop();
    return;
  }
  const built = build();
  groups.set(signature, {
    signature,
    category,
    severity: built.severity,
    title: built.title,
    sample: built.sample,
    count: 1,
    first_seen: at,
    last_seen: at,
    affected: [affected],
    hint: built.hint,
  });
}

/// Pull a one-line title out of a raw error. Strategy: take the
/// first sentence of the *original* (un-normalised) string up to ~80
/// chars, but if the whole thing is a single long line, use the
/// normalised form so timestamps/uuids don't clutter the title.
function deriveTitle(raw: string | null | undefined, normalised: string): string {
  if (!raw) return "(empty error)";
  // Strip the standard "tool error: " prefix the agent loop adds so
  // the title leads with the actual cause.
  const stripped = raw.replace(/^tool error:\s*/i, "");
  const firstLine = stripped.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length > 0 && firstLine.length <= 100) {
    return firstLine;
  }
  // Fall back to the normalised sentence-ish slice.
  return normalised.split(/[.!?]/)[0].slice(0, 80);
}

// ---------- Ignore list (localStorage) ---------------------------

const IGNORE_KEY = "jarvis.issues.ignored.v1";

interface IgnoreState {
  signatures: string[];
}

function readIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as IgnoreState;
    return new Set(parsed.signatures ?? []);
  } catch {
    return new Set();
  }
}

function writeIgnored(set: Set<string>): void {
  try {
    const payload: IgnoreState = { signatures: Array.from(set) };
    localStorage.setItem(IGNORE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota errors
  }
}

const ignoreSubscribers = new Set<() => void>();

export function ignoredSignatures(): Set<string> {
  return readIgnored();
}

export function ignoreIssue(signature: string): void {
  const s = readIgnored();
  s.add(signature);
  writeIgnored(s);
  for (const cb of ignoreSubscribers) cb();
}

export function unignoreIssue(signature: string): void {
  const s = readIgnored();
  s.delete(signature);
  writeIgnored(s);
  for (const cb of ignoreSubscribers) cb();
}

export function subscribeIgnored(cb: () => void): () => void {
  ignoreSubscribers.add(cb);
  return () => {
    ignoreSubscribers.delete(cb);
  };
}
