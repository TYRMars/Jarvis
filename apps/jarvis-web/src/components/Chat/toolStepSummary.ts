// Verb-based summary for a group of tool calls that ran in one
// agent step. Mirrors the Claude Code "Ran 3 commands, edited a
// file, updated todos >" pattern: each *kind* of action gets one
// phrase, multiple of the same kind get pluralised with a count,
// and a single call with a clear target inlines the target name +
// any natural stat (e.g. `+429 −0`) so the user can scan the turn
// without expanding a single row.
//
// Pure functions only — safe to import from anywhere; no React.

import type { ToolBlockEntry } from "../../store/appStore";

interface VerbSpec {
  /// Past-tense verb shown in the row. EN-only here; the chrome
  /// component i18n's the connectors / pluralisation rules.
  verb: string;
  /// Singular noun appended when there's exactly one of this kind
  /// (and no nicer single-call inline target — see `singleInline`).
  noun: string;
  /// Plural noun used when count > 1, paired with the count.
  nounPlural: string;
}

/// Tool name → how to describe a single occurrence in past tense.
/// Tools missing from the table fall back to a generic "Used <tool>"
/// phrase via `verbForUnknown` so a brand-new MCP tool still renders
/// something sensible without code changes.
const VERB_TABLE: Record<string, VerbSpec> = {
  "fs.read":           { verb: "Read",      noun: "file",      nounPlural: "files" },
  "fs.list":           { verb: "Listed",    noun: "directory", nounPlural: "directories" },
  "fs.edit":           { verb: "Edited",    noun: "file",      nounPlural: "files" },
  "fs.write":          { verb: "Wrote",     noun: "file",      nounPlural: "files" },
  "fs.patch":          { verb: "Patched",   noun: "file",      nounPlural: "files" },
  "shell.exec":        { verb: "Ran",       noun: "command",   nounPlural: "commands" },
  "code.grep":         { verb: "Searched",  noun: "pattern",   nounPlural: "patterns" },
  "git.status":        { verb: "Inspected", noun: "git status", nounPlural: "git status" },
  "git.diff":          { verb: "Inspected", noun: "diff",      nounPlural: "diffs" },
  "git.log":           { verb: "Read",      noun: "git log",   nounPlural: "git log" },
  "git.show":          { verb: "Showed",    noun: "commit",    nounPlural: "commits" },
  "workspace.context": { verb: "Inspected", noun: "workspace", nounPlural: "workspace" },
  "project.checks":    { verb: "Suggested", noun: "check",     nounPlural: "checks" },
  "plan.update":       { verb: "Updated",   noun: "plan",      nounPlural: "plan" },
  "exit_plan":         { verb: "Proposed",  noun: "plan",      nounPlural: "plan" },
  "http.fetch":        { verb: "Fetched",   noun: "URL",       nounPlural: "URLs" },
  "time.now":          { verb: "Checked",   noun: "time",      nounPlural: "time" },
  "echo":              { verb: "Echoed",    noun: "value",     nounPlural: "values" },
};

function verbForUnknown(name: string): VerbSpec {
  return { verb: "Used", noun: name, nounPlural: name };
}

function specFor(name: string): VerbSpec {
  return VERB_TABLE[name] ?? verbForUnknown(name);
}

/// Pull a short, render-friendly target string out of a tool's args
/// for the single-call inline form. `null` when the tool has no
/// natural single-noun target (workspace.context, plan.update, etc.).
function singleInlineTarget(name: string, args: any): string | null {
  if (!args || typeof args !== "object") return null;
  switch (name) {
    case "fs.read":
    case "fs.list":
    case "fs.edit":
    case "fs.write":
      return typeof args.path === "string" ? args.path : null;
    case "fs.patch": {
      // Patch carries a unified diff; pull the first `+++ b/<path>`.
      if (typeof args.diff !== "string") return null;
      const m = args.diff.match(/\+\+\+ b\/([^\s]+)/);
      return m ? m[1] : null;
    }
    case "shell.exec": {
      if (typeof args.command !== "string") return null;
      // First token (the actual program name) plus the next chunk
      // up to ~28 chars total — enough for `cargo test` /
      // `npm run build` while staying short.
      const trimmed = args.command.trim();
      if (trimmed.length === 0) return null;
      return trimmed.length > 32 ? trimmed.slice(0, 30) + "…" : trimmed;
    }
    case "code.grep":
      return typeof args.pattern === "string" ? `\`${args.pattern}\`` : null;
    case "git.show":
      return typeof args.revision === "string" ? args.revision : null;
    default:
      return null;
  }
}

/// Pull a tiny stat suffix from the tool's *output* for the single-
/// call form. Mirrors what `toolSummaries.ts` produces for the
/// header chip but kept independent because the summarisable rule
/// set differs (e.g. fs.edit has a target+stat in its OUTPUT we'd
/// like to inline, but it's an approval-gated tool so it's NOT in
/// the SUMMARISABLE_TOOLS set — by design they're separate
/// surfaces).
function singleInlineStat(
  name: string,
  args: any,
  output: string | null,
): string | null {
  if (output == null) return null;
  switch (name) {
    case "fs.read": {
      if (output.length === 0) return null;
      const lines = output.split("\n").length;
      return `${lines} line${lines === 1 ? "" : "s"}`;
    }
    case "fs.edit":
    case "fs.write":
    case "fs.patch":
      // Tool output is a free-form summary; we don't try to parse
      // it here. The expanded ToolBlock has the full diff card.
      return null;
    case "code.grep": {
      let n = 0;
      for (const line of output.split("\n")) {
        if (/^[^:]+:\d+:/.test(line)) n += 1;
      }
      return n > 0 ? `${n} match${n === 1 ? "" : "es"}` : null;
    }
    case "git.diff": {
      const trimmed = output.trim();
      if (trimmed === "(no changes)") return "no changes";
      let added = 0;
      let removed = 0;
      for (const line of output.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
      if (added + removed === 0) return null;
      return `+${added} −${removed}`;
    }
    case "git.status": {
      let modified = 0;
      let untracked = 0;
      for (const line of output.split("\n")) {
        if (line.startsWith("##")) continue;
        if (line.startsWith("??")) untracked += 1;
        else if (line.length >= 2 && /[MADR]/.test(line[0] + line[1])) modified += 1;
      }
      const parts: string[] = [];
      if (modified > 0) parts.push(`M:${modified}`);
      if (untracked > 0) parts.push(`?:${untracked}`);
      return parts.length > 0 ? parts.join(" ") : "clean";
    }
    default:
      return null;
  }
}

/// True when the entry's status indicates the tool ran cleanly —
/// step rows aggregate failures separately so the row label stays
/// honest when 1 of 3 tools blew up.
function isOk(s: ToolBlockEntry["status"]): boolean {
  return s === "ok";
}

interface PhraseGroup {
  /// Same `verb` for everything in the group.
  verb: string;
  /// Always-present single-noun (singular form) — used when count===1
  /// without a nicer inline target.
  noun: string;
  nounPlural: string;
  blocks: ToolBlockEntry[];
}

function groupByVerb(blocks: ToolBlockEntry[]): PhraseGroup[] {
  const out: PhraseGroup[] = [];
  for (const b of blocks) {
    const spec = specFor(b.name);
    // Group by (verb, noun) so "Inspected git status" + "Inspected diff"
    // don't accidentally get coalesced into "Inspected 2 things".
    const key = `${spec.verb}|${spec.noun}`;
    let g = out.find((x) => `${x.verb}|${x.noun}` === key);
    if (!g) {
      g = { verb: spec.verb, noun: spec.noun, nounPlural: spec.nounPlural, blocks: [] };
      out.push(g);
    }
    g.blocks.push(b);
  }
  return out;
}

/// Build the verb phrase for one group:
///   1 block + clear target → "Read README.md (298 lines)"
///   1 block + no target    → "Inspected workspace"
///   N blocks               → "Read 3 files"
function describeGroup(g: PhraseGroup): string {
  if (g.blocks.length === 1) {
    const b = g.blocks[0];
    const target = singleInlineTarget(b.name, b.args);
    const stat = singleInlineStat(b.name, b.args, b.output);
    if (target != null) {
      return stat
        ? `${g.verb} ${target} (${stat})`
        : `${g.verb} ${target}`;
    }
    if (stat != null) return `${g.verb} ${g.noun} (${stat})`;
    // Mass nouns ("workspace", "git status", "git log", "plan") read
    // better without the article. Heuristic: the singular and plural
    // nouns are identical → mass noun.
    if (g.noun === g.nounPlural) return `${g.verb} ${g.noun}`;
    return `${g.verb} a ${g.noun}`;
  }
  return `${g.verb} ${g.blocks.length} ${g.nounPlural}`;
}

/// Produce the top-line summary string for a step row.
///
/// Special cases:
///   • All blocks `running` and none completed yet → "Running N tool(s)…"
///   • Mixed in-flight + done → fall through to the verb summary so
///     the user sees what's already landed; the row's status badge
///     covers the still-running indicator separately.
///   • Some `error` / `denied` → append a "(M failed)" suffix.
export function describeStep(blocks: ToolBlockEntry[]): string {
  if (blocks.length === 0) return "";

  const allRunning = blocks.every((b) => b.status === "running");
  if (allRunning) {
    const last = blocks[blocks.length - 1];
    return `Running ${blocks.length} tool${blocks.length === 1 ? "" : "s"} (${last.name})…`;
  }

  // Build verb groups from the completed/failed blocks. Running
  // blocks contribute their verb but not a stat — they'll keep
  // animating their own status badge in the expanded view.
  const phrases = groupByVerb(blocks).map(describeGroup);
  // Claude Code pattern: only the first phrase keeps its capitalised
  // verb; everything after a comma is lowercased so the row reads
  // as one sentence ("Edited a file, ran a command, updated todos").
  const out = phrases
    .map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)))
    .join(", ");

  const failed = blocks.filter((b) => !isOk(b.status) && b.status !== "running").length;
  if (failed > 0) {
    return `${out} (${failed} failed)`;
  }
  return out;
}

/// Aggregate status for the whole step. Drives the row's badge:
///   • any running   → "running"
///   • any error     → "error"
///   • any denied    → "denied" (only if no error — error wins)
///   • everything ok → "ok"
export function aggregateStepStatus(
  blocks: ToolBlockEntry[],
): "running" | "ok" | "error" | "denied" | "empty" {
  if (blocks.length === 0) return "empty";
  let hasRunning = false;
  let hasError = false;
  let hasDenied = false;
  for (const b of blocks) {
    if (b.status === "running") hasRunning = true;
    else if (b.status === "error") hasError = true;
    else if (b.status === "denied") hasDenied = true;
  }
  if (hasRunning) return "running";
  if (hasError) return "error";
  if (hasDenied) return "denied";
  return "ok";
}
