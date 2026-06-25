// fs.patch — apply a unified diff inside the workspace sandbox.
//
// The model's primary mutation primitive when changing more than one place at
// a time. Strictly more powerful than `fs.edit` (multi-hunk, cross-file) but
// with the same safety posture:
//
// - Sandboxed — every target path resolves through `resolveUnder`; `..` and
//   absolute paths are rejected before any file is touched.
// - Atomic per-call — all hunks for all files are applied to in-memory copies
//   first; if any single hunk fails to apply cleanly (no fuzz, no
//   whitespace-tolerant matching), nothing is written to disk.
// - Text only — refuses git binary patches and the `Binary files differ`
//   sentinel.
// - No renames / mode-only changes — the v0 surface is just "edit text".
// - Approval-gated — `requiresApproval` is `true`. The approval card sees the
//   full diff, so the operator can review before any byte changes on disk.
// - Doesn't auto-stage — even in a git repo, the working tree is updated but
//   the index isn't touched.
//
// Returns a structured per-file summary so the model can confirm what landed:
//
//   applied 2 file(s):
//     M src/foo.ts   (+3 -1)
//     A src/bar.ts   (+12 -0)
//
// Ported faithfully from crates/harness-tools/src/patch.rs.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { ParsedDiff } from "diff";
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { resolveUnder } from "./sandbox.ts";

type ChangeKind = "created" | "modified" | "deleted";

interface PlannedWrite {
  rel: string;
  abs: string;
  kind: ChangeKind;
  /** New file content for create/modify; null for delete. */
  newText: string | null;
  added: number;
  removed: number;
}

// Per-path accumulator threading a file's evolving in-memory content across
// multiple blocks that target it within a single multi-file diff.
interface Accum {
  rel: string;
  abs: string;
  /** Did the file exist on disk before this whole `invoke` call? */
  existedBefore: boolean;
  /** Current in-memory content; `null` means absent/deleted. */
  content: string | null;
  added: number;
  removed: number;
}

type PatchAction =
  | { action: "create"; path: string }
  | { action: "delete"; path: string }
  | { action: "modify"; path: string };

export class FsPatchTool implements Tool {
  readonly name = "fs.patch";
  readonly requiresApproval = true;
  readonly category: ToolCategory = "write";
  readonly description =
    "Apply a unified diff to one or more files inside the workspace " +
    "sandbox. Accepts standard `--- a/<path>` / `+++ b/<path>` " +
    "headers (with or without `diff --git` prefix). All hunks must " +
    "apply cleanly — no fuzz, no whitespace tolerance — or the " +
    "whole patch is rejected. Supports multi-file diffs, file " +
    "creation (`--- /dev/null`), and file deletion " +
    "(`+++ /dev/null`). Refuses binary patches, renames, and " +
    "paths outside the sandbox root. Does not stage changes.";

  readonly #root: string;

  constructor(config: { root: string }) {
    this.#root = config.root;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description:
            "Unified diff. Multi-file diffs are split on `diff --git` " +
            "markers (or on `--- ` headers when those are absent).",
        },
      },
      required: ["diff"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const root = this.#root;
    const diff =
      args !== null && typeof args === "object" && !Array.isArray(args) && typeof args.diff === "string"
        ? args.diff
        : undefined;
    if (diff === undefined) {
      throw new Error("missing `diff` argument");
    }

    if (diff.includes("GIT binary patch") || diff.includes("Binary files")) {
      throw new Error("binary patches are not supported");
    }
    if (diff.includes("\nrename from ") || diff.includes("\nrename to ")) {
      throw new Error("rename patches are not supported (v0)");
    }

    const blocks = splitMultiFile(diff);
    if (blocks.length === 0) {
      throw new Error("no patch blocks found in `diff`");
    }

    // Phase 1: parse + apply against in-memory copies. Nothing touches disk
    // until every block succeeds.
    //
    // Blocks are accumulated per resolved target path so that two or more
    // sections of one multi-file diff that touch the SAME file compose
    // cumulatively instead of clobbering: each block applies against the prior
    // block's in-memory result (its `content`), never a fresh on-disk read.
    // Without this, Phase 2 would write each block's independently-derived
    // result in turn and the last one would silently overwrite the earlier
    // edits (data loss with no error).
    const accums = new Map<string, Accum>();
    for (const block of blocks) {
      const parsed = parsePatch(block);
      if (parsed.length === 0) {
        throw new Error("parse patch: no hunks found in patch block");
      }
      const patch = parsed[0]!;

      const action = classify(patch.oldFileName, patch.newFileName);
      const path = action.path;
      const abs = resolveTarget(root, path);
      const prior = accums.get(abs);
      const { added, removed } = countLines(block);

      switch (action.action) {
        case "create": {
          // "Exists" is the cumulative view: a prior block in this same call may
          // have already created (or deleted) the path in memory.
          const existsNow = prior ? prior.content !== null : await pathExists(abs);
          if (existsNow) {
            throw new Error(`create patch targets existing file \`${path}\``);
          }
          const newText = applyOrThrow("", patch, `apply create patch on \`${path}\``);
          accums.set(abs, {
            rel: prior?.rel ?? path,
            abs,
            existedBefore: prior?.existedBefore ?? false,
            content: newText,
            added: (prior?.added ?? 0) + added,
            removed: (prior?.removed ?? 0) + removed,
          });
          break;
        }
        case "delete": {
          const original = await currentContent(prior, abs, `read \`${path}\` to delete`);
          if (original === null) {
            throw new Error(`delete patch targets missing file \`${path}\``);
          }
          // Sanity-check: the patch's "after" should be empty.
          const result = applyOrThrow(original, patch, `apply delete patch on \`${path}\``);
          if (result !== "") {
            throw new Error(`delete patch on \`${path}\` left non-empty content`);
          }
          accums.set(abs, {
            rel: prior?.rel ?? path,
            abs,
            existedBefore: prior?.existedBefore ?? true,
            content: null,
            added: (prior?.added ?? 0) + added,
            removed: (prior?.removed ?? 0) + removed,
          });
          break;
        }
        case "modify": {
          const original = await currentContent(prior, abs, `read \`${path}\` to modify`);
          if (original === null) {
            throw new Error(`modify patch targets missing file \`${path}\``);
          }
          const newText = applyOrThrow(original, patch, `apply patch on \`${path}\``);
          accums.set(abs, {
            rel: prior?.rel ?? path,
            abs,
            existedBefore: prior?.existedBefore ?? true,
            content: newText,
            added: (prior?.added ?? 0) + added,
            removed: (prior?.removed ?? 0) + removed,
          });
          break;
        }
      }
    }

    // Collapse each path's accumulated state into a single planned write (Map
    // preserves first-touch insertion order). A file that was created and then
    // deleted within the same call nets to nothing and is dropped.
    const planned: PlannedWrite[] = [];
    for (const a of accums.values()) {
      if (a.content === null) {
        if (!a.existedBefore) continue; // created then deleted → no-op
        planned.push({ rel: a.rel, abs: a.abs, kind: "deleted", newText: null, added: a.added, removed: a.removed });
      } else {
        const kind: ChangeKind = a.existedBefore ? "modified" : "created";
        planned.push({ rel: a.rel, abs: a.abs, kind, newText: a.content, added: a.added, removed: a.removed });
      }
    }

    // Phase 2: commit to disk. The contract is "atomic per call", so before
    // touching anything we snapshot each target's prior state, then roll every
    // committed entry back if any write or delete fails mid-batch.
    const snapshots: (string | null)[] = [];
    for (const w of planned) {
      // `null` means the file did not exist before this call; a string is its
      // prior content to restore on rollback.
      snapshots.push(await readTextOrNull(w.abs));
    }

    let committed = 0;
    let commitErr: Error | undefined;
    for (const w of planned) {
      try {
        if (w.kind === "created" || w.kind === "modified") {
          const parent = dirname(w.abs);
          try {
            await mkdir(parent, { recursive: true });
          } catch (e) {
            throw new Error(`mkdir for \`${w.rel}\`: ${msg(e)}`);
          }
          try {
            await writeFile(w.abs, w.newText ?? "");
          } catch (e) {
            throw new Error(`write \`${w.rel}\`: ${msg(e)}`);
          }
        } else {
          try {
            await rm(w.abs, { force: false });
          } catch (e) {
            throw new Error(`delete \`${w.rel}\`: ${msg(e)}`);
          }
        }
      } catch (e) {
        commitErr = e instanceof Error ? e : new Error(String(e));
        break;
      }
      committed += 1;
    }

    if (commitErr) {
      // Roll back every entry we already committed, restoring its snapshot.
      // Best-effort: collect restore failures so the returned error names both
      // the original fault and any file we couldn't fully revert.
      const restoreErrs: string[] = [];
      for (let i = 0; i < committed; i += 1) {
        const w = planned[i]!;
        const prior = snapshots[i]!;
        try {
          if (prior !== null) {
            try {
              await mkdir(dirname(w.abs), { recursive: true });
            } catch {
              // ignore — restore is best-effort
            }
            await writeFile(w.abs, prior);
          } else {
            try {
              await rm(w.abs, { force: false });
            } catch (e) {
              // Already gone is fine.
              if (!isNotFound(e)) throw e;
            }
          }
        } catch (re) {
          restoreErrs.push(`${w.rel}: ${msg(re)}`);
        }
      }
      if (restoreErrs.length === 0) {
        throw new Error(`${commitErr.message} (rolled back all changes; working tree unchanged)`);
      }
      throw new Error(
        `${commitErr.message} (rollback incomplete — could not restore: ${restoreErrs.join(", ")})`,
      );
    }

    // Build the human-readable summary.
    let summary = `applied ${planned.length} file(s):\n`;
    for (const w of planned) {
      const marker = w.kind === "created" ? "A" : w.kind === "modified" ? "M" : "D";
      summary += `  ${marker} ${w.rel}   (+${w.added} -${w.removed})\n`;
    }
    return summary;
  }
}

function classify(original: string | undefined, modified: string | undefined): PatchAction {
  // Standard `a/` and `b/` prefixes the diff toolchain injects; strip them so
  // the path round-trips against the sandbox root.
  const strip = (s: string): string => {
    if (s.startsWith("a/")) return s.slice(2);
    if (s.startsWith("b/")) return s.slice(2);
    return s;
  };

  const origIsNull = original !== undefined && isDevNull(original);
  const modIsNull = modified !== undefined && isDevNull(modified);

  if (original !== undefined && modified !== undefined) {
    if (origIsNull) return { action: "create", path: strip(modified) };
    if (modIsNull) return { action: "delete", path: strip(original) };
    // Modify: trust `+++ b/<path>` (the destination), since `--- a/<path>` is
    // sometimes a build-tree path that doesn't exist locally.
    return { action: "modify", path: strip(modified) };
  }
  if (original !== undefined && modified === undefined) {
    return { action: "modify", path: strip(original) };
  }
  throw new Error("patch missing both `---` and `+++` headers");
}

function isDevNull(p: string): boolean {
  const t = p.trim();
  return t === "/dev/null" || t === "a/dev/null" || t === "b/dev/null";
}

function resolveTarget(root: string, rel: string): string {
  // The header may include a tab-separated timestamp (`b/foo.ts\t2024-01-01
  // ...`). Trim everything after a tab before sandbox resolution.
  const cleaned = (rel.split("\t")[0] ?? rel).trim();
  if (cleaned === "") {
    throw new Error("patch path is empty");
  }
  return resolveUnder(root, cleaned);
}

// Count `+` / `-` lines inside a single-file patch block, ignoring `+++` /
// `---` headers. Pure cosmetic — used in the summary string only.
function countLines(block: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const c = line.charAt(0);
    if (c === "+") added += 1;
    else if (c === "-") removed += 1;
  }
  return { added, removed };
}

// Split a multi-file unified diff into per-file blocks. Each returned block is
// a complete, single-file patch. The split is conservative:
//
// 1. If any `diff --git ` line is present, split on those (the canonical git
//    multi-file form).
// 2. Otherwise, split on `--- ` lines that are immediately followed by a
//    `+++ ` line (the bare-diff multi-file form).
//
// Lines before the first split marker are dropped (typical preamble: PR
// description, hunk-zero metadata).
function splitMultiFile(diff: string): string[] {
  const lines = diff.split("\n");

  let splitIndices: number[];
  if (lines.some((l) => l.startsWith("diff --git "))) {
    splitIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.startsWith("diff --git ")) splitIndices.push(i);
    }
  } else {
    splitIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.startsWith("--- ")) continue;
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith("+++ ")) splitIndices.push(i);
    }
  }

  if (splitIndices.length === 0) {
    // No headers at all — caller will get a parse error with a useful
    // diagnostic.
    return [];
  }

  const blocks: string[] = [];
  for (let n = 0; n < splitIndices.length; n += 1) {
    const start = splitIndices[n]!;
    const end = n + 1 < splitIndices.length ? splitIndices[n + 1]! : lines.length;
    const block = lines.slice(start, end).join("\n");
    // Parsing expects a trailing newline for predictable hunk parsing.
    blocks.push(`${block}\n`);
  }
  return blocks;
}

// Apply with no fuzz / no whitespace tolerance. `applyPatch` returns `false`
// when a hunk fails to match cleanly — surface that as an error matching the
// Rust `diffy::apply` failure path.
function applyOrThrow(source: string, patch: ParsedDiff, context: string): string {
  const result = applyPatch(source, patch, { fuzzFactor: 0 });
  if (result === false) {
    throw new Error(`${context}: hunk did not apply cleanly`);
  }
  return result;
}

// Current in-memory content for a target: the prior block's result if this
// path was already touched in this call, otherwise the on-disk original.
// Returns `null` when the file is absent (never existed, or deleted by a prior
// block) so callers can reject modify/delete-after-delete uniformly.
async function currentContent(
  prior: Accum | undefined,
  abs: string,
  context: string,
): Promise<string | null> {
  if (prior !== undefined) return prior.content;
  if (!(await isFile(abs))) return null;
  return readText(abs, context);
}

async function readText(abs: string, context: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch (e) {
    throw new Error(`${context}: ${msg(e)}`);
  }
}

async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

// Mirrors Rust `Path::exists()`: a stat that errors (ENOENT, ENOTDIR, …) means
// the path does not resolve to an existing entry.
async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function isFile(abs: string): Promise<boolean> {
  try {
    const s = await stat(abs);
    return s.isFile();
  } catch {
    return false;
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
