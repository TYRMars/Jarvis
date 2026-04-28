// One-line summary chips for tool blocks.
//
// Daily heavy-coding turns can produce 10–20 tool calls. The
// `ToolBlock` collapsed header used to show only `name + status` —
// the user had to click each row to learn anything. This module
// derives a short teaser ("M:2 ?:1", "+15 −3 across 2 files",
// "5 matches in 3 files", ...) from the tool's output so the user
// can scan the entire turn without expanding individual cards.
//
// Design contract:
//   • PURE FUNCTIONS. No React, no module side effects. Safe to
//     import from anywhere; safe to call millions of times.
//   • EVERY parser is exception-safe. Outer try/catch in
//     `summarise()` is the last line of defence; a single broken
//     parser must NEVER blank the chat view.
//   • Returns `null` whenever there's nothing useful to show. The
//     caller renders no chip in that case.
//
// To add a summariser for a new built-in tool:
//   1. Add the tool name to `SUMMARISABLE_TOOLS` below.
//   2. Add a case in the `dispatch` switch.
//   3. Add an i18n key in `utils/i18n.ts` (zh + en).
// Skipping any of those is fine — the tool just won't get a chip.

import { t } from "../../utils/i18n";

/// Tools whose collapsed header should show a one-line teaser.
/// Read-only inspection where the user wants to scan the turn
/// without clicking. Names mirror the registered tool name.
export const SUMMARISABLE_TOOLS: ReadonlySet<string> = new Set([
  "workspace.context",
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
  "fs.read",
  "fs.list",
  "code.grep",
  "project.checks",
  "plan.update",
]);

/// Tools that mutate state (approval-gated). Default to OPEN after
/// completion in `ToolBlock` so the diff / output is visible without
/// an extra click. Adding a new gated tool is a one-liner here.
/// Must NOT overlap with `SUMMARISABLE_TOOLS` — there's a unit-test
/// guard that asserts the intersection is empty.
export const APPROVAL_GATED_TOOLS: ReadonlySet<string> = new Set([
  "fs.edit",
  "fs.write",
  "fs.patch",
  "shell.exec",
]);

/// Anything larger than this we refuse to scan. Massive grep dumps
/// or full-file fs.read outputs shouldn't tax the parser; the chip
/// is metadata anyway. 256 KiB matches the http.fetch / shell.exec
/// truncation cap on the server side.
const MAX_OUTPUT_BYTES = 256 * 1024;

/// One-line teaser for `(name, args, output)`. Returns `null` to
/// mean "render nothing" — the caller decides chip visibility.
///
/// Exception-safe: any throw inside a parser is caught here and
/// turned into `null` plus a one-shot console warning (deduped by
/// tool name so a broken parser doesn't spam DevTools).
export function summarise(
  name: string,
  args: unknown,
  output: string | null,
): string | null {
  if (!SUMMARISABLE_TOOLS.has(name)) return null;
  if (output != null && output.length > MAX_OUTPUT_BYTES) return null;
  try {
    return dispatch(name, args, output);
  } catch (err) {
    warnOnce(name, err);
    return null;
  }
}

const warned = new Set<string>();
function warnOnce(name: string, err: unknown): void {
  if (warned.has(name)) return;
  warned.add(name);
  // eslint-disable-next-line no-console
  console.warn(`toolSummaries: parser for "${name}" threw, suppressing future warnings`, err);
}

function dispatch(name: string, args: unknown, output: string | null): string | null {
  switch (name) {
    case "workspace.context":
      return summariseWorkspaceContext(output);
    case "git.status":
      return summariseGitStatus(output);
    case "git.diff":
      return summariseGitDiff(output);
    case "git.log":
      return summariseGitLog(output);
    case "git.show":
      return summariseGitShow(output);
    case "fs.read":
      return summariseFsRead(args, output);
    case "fs.list":
      return summariseFsList(output);
    case "code.grep":
      return summariseGrep(output);
    case "project.checks":
      return summariseChecks(output);
    case "plan.update":
      return summarisePlan(args, output);
    default:
      return null;
  }
}

// ---------------- helpers ----------------

function isBlank(s: string | null): boolean {
  return s == null || s.trim() === "";
}

function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------- per-tool parsers ----------------

/// `workspace.context` returns a JSON blob with vcs / branch / dirty
/// / manifests / instructions / top_level. We surface the three
/// most useful chips: VCS kind, branch, and dirty/clean status.
export function summariseWorkspaceContext(output: string | null): string | null {
  if (isBlank(output)) return null;
  const parsed = tryParseJson(output!);
  if (parsed == null || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const vcs = typeof v.vcs === "string" ? v.vcs : null;
  if (vcs && vcs !== "none") parts.push(vcs);
  if (typeof v.branch === "string" && v.branch.length > 0) parts.push(`⎇ ${v.branch}`);
  if (vcs === "git") parts.push(v.dirty === true ? "dirty" : "clean");
  if (parts.length === 0) return null;
  return t("toolSummaryWorkspace", parts.join(" · "));
}

/// `git.status` (porcelain v1 + branch) lines look like:
///   "## main...origin/main"      ← branch header, skip
///   " M crates/foo/src/bar.rs"   ← modified
///   "?? new.txt"                 ← untracked
///   "A  added.txt"               ← staged add
/// We count by leading two-char status code into M/A/D/?/R buckets
/// and produce e.g. "M:2 ?:1" or "clean" when nothing's pending.
export function summariseGitStatus(output: string | null): string | null {
  if (isBlank(output)) return null;
  // The tool returns "(not a git repository)" sentinel for non-git dirs.
  if (output!.includes("not a git repository")) return null;
  const buckets: Record<string, number> = { M: 0, A: 0, D: 0, R: 0, "?": 0 };
  for (const line of output!.split("\n")) {
    if (line.length < 2) continue;
    if (line.startsWith("##")) continue;
    const code = line.slice(0, 2);
    // Untracked files are "?? path"; treat both chars as `?`.
    if (code === "??") buckets["?"] += 1;
    // Otherwise the first non-space char in either column is the kind.
    else {
      const c = (code[0] !== " " ? code[0] : code[1]) ?? "";
      if (c in buckets) buckets[c] += 1;
    }
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (total === 0) return t("toolSummaryGitStatusClean");
  const parts = (["M", "A", "D", "R", "?"] as const)
    .filter((k) => buckets[k] > 0)
    .map((k) => `${k}:${buckets[k]}`);
  return parts.join(" ");
}

/// `git.diff` returns a unified diff. Count lines starting with a
/// single `+` or `-` (NOT `+++` / `---` file headers); count files
/// from the `diff --git` headers (or fall back to `+++ b/...`
/// counts when no `diff --git` preamble is present, e.g. piped
/// patch input).
///
/// Special case: the tool returns the literal "(no changes)" when
/// the working tree matches HEAD; mirror that as "no changes".
export function summariseGitDiff(output: string | null): string | null {
  if (isBlank(output)) return null;
  const trimmed = output!.trim();
  if (trimmed === "(no changes)") return t("toolSummaryGitDiffNone");
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of output!.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  if (files === 0) {
    // No `diff --git` headers — count files from `+++ b/<path>` lines.
    for (const line of output!.split("\n")) {
      if (line.startsWith("+++ b/")) files += 1;
    }
  }
  if (added === 0 && removed === 0 && files === 0) return null;
  return t("toolSummaryGitDiff", added, removed, files);
}

/// `git.log --pretty=format:%h %s` — one line per commit.
export function summariseGitLog(output: string | null): string | null {
  if (isBlank(output)) return null;
  const lines = output!
    .split("\n")
    .filter((l) => l.trim().length > 0 && /^[0-9a-f]{6,}\s/.test(l));
  if (lines.length === 0) return null;
  return t("toolSummaryGitLog", lines.length);
}

/// `git.show` typically starts with `commit <sha>` followed by
/// metadata, blank line, subject, blank line, and a unified diff.
/// We surface the short SHA + file count when a diff is present;
/// metadata-only invocations get just the SHA.
export function summariseGitShow(output: string | null): string | null {
  if (isBlank(output)) return null;
  const m = output!.match(/^commit\s+([0-9a-f]+)/m);
  if (!m) return null;
  const sha = m[1].slice(0, 7);
  let files = 0;
  for (const line of output!.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
  }
  if (files === 0) return sha;
  return t("toolSummaryGitShow", sha, files);
}

/// `fs.read` returns the raw file content. Args carries `path`.
export function summariseFsRead(args: unknown, output: string | null): string | null {
  if (output == null) return null;
  const lines = output.length === 0 ? 0 : output.split("\n").length;
  const path =
    args && typeof args === "object" && typeof (args as any).path === "string"
      ? (args as any).path
      : null;
  if (path) return t("toolSummaryFsRead", path, lines);
  return t("toolSummaryFsReadNoPath", lines);
}

/// `fs.list` returns a JSON array of `{name, kind}` entries.
export function summariseFsList(output: string | null): string | null {
  if (isBlank(output)) return null;
  const parsed = tryParseJson(output!);
  if (!Array.isArray(parsed)) return null;
  return t("toolSummaryFsList", parsed.length);
}

/// `code.grep` returns one match per line in the form
///   `<rel-path>:<line-no>: <snippet>`
/// followed by an optional `[... truncated ...]` footer. We count
/// total matches and unique paths.
export function summariseGrep(output: string | null): string | null {
  if (isBlank(output)) return null;
  let matches = 0;
  const paths = new Set<string>();
  for (const line of output!.split("\n")) {
    if (!line || line.startsWith("[")) continue;
    const m = line.match(/^([^:]+):\d+:/);
    if (m) {
      matches += 1;
      paths.add(m[1]);
    }
  }
  if (matches === 0) return null;
  return t("toolSummaryGrep", matches, paths.size);
}

/// `project.checks` returns `{suggestions: [...]}`.
export function summariseChecks(output: string | null): string | null {
  if (isBlank(output)) return null;
  const parsed = tryParseJson(output!);
  if (parsed == null || typeof parsed !== "object") return null;
  const arr = (parsed as any).suggestions;
  if (!Array.isArray(arr)) return null;
  if (arr.length === 0) return t("toolSummaryChecksEmpty");
  return t("toolSummaryChecks", arr.length);
}

/// `plan.update` is a snapshot tool — args carries `items: [...]`.
/// Output is just `"ok"` (the harness loop relays via task-local
/// channel; the tool's return is decorative). We summarise from
/// args because that's where the plan actually lives.
export function summarisePlan(args: unknown, _output: string | null): string | null {
  if (args == null || typeof args !== "object") return null;
  const items = (args as any).items;
  if (!Array.isArray(items)) return t("toolSummaryPlanFallback");
  let done = 0;
  for (const it of items) {
    if (it && typeof it === "object" && (it as any).status === "completed") done += 1;
  }
  return t("toolSummaryPlan", items.length, done);
}
