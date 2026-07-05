// `triage.scan_candidates` — surface follow-up Requirement candidates from
// passive workspace signals so the agent can propose work beyond what the user
// explicitly asked for. Ported from harness-tools/src/triage_scan.rs.
//
// v1.0 source:
//
// - `todo_comments`: walk the workspace `.gitignore`-aware (same traversal
//   intent as `code.grep`) and surface each `TODO|FIXME|XXX|HACK` line as a
//   candidate `{title, description, source: "todo_comment", path, line}`. The
//   leading marker plus a short comment forms a usable Requirement title
//   without further LLM massaging.
//
// Read-only: registered alongside `code.grep` (always on). The tool
// deliberately does NOT call `requirement.create` itself — surfacing
// candidates and committing them are separate steps. The agent decides which
// (if any) to write into the triage queue, where they land as
// `triage_state=ProposedByScan`.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import ignoreDefault from "ignore";
import type { Ignore } from "ignore";

// `ignore` is published as CommonJS (`module.exports = fn`) with an ESM-style
// `export default` in its `.d.ts`. Under NodeNext without `esModuleInterop`
// the default binding types as the module namespace, which TS sees as
// non-callable — so we re-expose it through a typed factory alias.
const ignore = ignoreDefault as unknown as (options?: {
  ignorecase?: boolean;
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}) => Ignore;
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { resolveUnder } from "./sandbox.ts";

const DEFAULT_MAX_CANDIDATES = 50;
const MAX_CANDIDATE_LIMIT = 200;
const COMMENT_TRIM = 200;
const TITLE_TRIM = 80;

interface Candidate {
  title: string;
  description: string;
  source: string;
  path: string;
  line: number;
}

interface TriageScanConfig {
  root: string;
}

export class TriageScanTool implements Tool {
  readonly name = "triage.scan_candidates";
  readonly category: ToolCategory = "read";
  readonly description =
    "Surface candidate follow-up requirements from passive workspace " +
    "signals. v1.0 source: `todo_comments` (TODO / FIXME / XXX / HACK " +
    "markers in source files). Returns a list of " +
    "`{title, description, source, path, line}` rows; the agent then " +
    "decides which to commit into the Triage queue via " +
    '`requirement.create(triage_state="proposed_by_scan")`. ' +
    "Read-only — does NOT itself write requirements. Optional `path` " +
    "narrows the scan to a subdirectory; `limit` caps the result count " +
    "(default 50, max 200).";

  readonly #root: string;

  constructor(config: TriageScanConfig) {
    this.#root = config.root;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: { type: "string", enum: ["todo_comments"] },
          description:
            "Which signal sources to include. Defaults to all known sources. " +
            "Unknown source names are silently ignored so a future build " +
            "adding a source doesn't break older callers.",
        },
        path: {
          type: "string",
          description:
            "Optional subdirectory under the workspace to scan. Sandboxed — " +
            "absolute paths and `..` rejected.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CANDIDATE_LIMIT,
          description: "Cap on candidates returned (default 50, max 200).",
        },
      },
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<
      string,
      JsonValue
    >;

    // sources: optional array of strings.
    let sources: string[] | undefined;
    if (obj.sources !== undefined && obj.sources !== null) {
      if (!Array.isArray(obj.sources) || !obj.sources.every((s) => typeof s === "string")) {
        throw new Error("triage.scan_candidates: bad args: `sources` must be an array of strings");
      }
      sources = obj.sources as string[];
    }

    // path: optional string.
    let relPath: string | undefined;
    if (obj.path !== undefined && obj.path !== null) {
      if (typeof obj.path !== "string") {
        throw new Error("triage.scan_candidates: bad args: `path` must be a string");
      }
      relPath = obj.path;
    }

    // limit: optional non-negative integer.
    let limitArg: number | undefined;
    if (obj.limit !== undefined && obj.limit !== null) {
      if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 0) {
        throw new Error("triage.scan_candidates: bad args: `limit` must be a non-negative integer");
      }
      limitArg = obj.limit;
    }

    const wantTodo = sources ? sources.some((s) => s === "todo_comments") : true;

    const limit = Math.min(limitArg ?? DEFAULT_MAX_CANDIDATES, MAX_CANDIDATE_LIMIT);

    const root = this.#root;
    const scopeRoot = relPath !== undefined ? resolveUnder(root, relPath) : root;

    let candidates: Candidate[] = [];
    if (wantTodo) {
      const found = await scanTodoComments(scopeRoot, root, limit);
      candidates = candidates.concat(found);
    }

    candidates = candidates.slice(0, limit);
    return JSON.stringify({
      candidates,
      count: candidates.length,
      sources: ["todo_comments"],
    });
  }
}

// Marker must be at a word boundary and followed by `:`, `-`, ` `, or end of
// line so prose containing the word "todo" doesn't count. Mirrors the Rust
// regex `(?i)\b(TODO|FIXME|XXX|HACK)\b\s*[:\-]?\s*(.{0,300})`.
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b\s*[:-]?\s*(.{0,300})/i;

/**
 * Walk `scopeRoot` looking for `TODO|FIXME|XXX|HACK` markers in text files.
 * Returns one candidate per match. Standard ignore filters (hidden files,
 * `.gitignore`, the `.git` dir) are applied — even when there's no `.git`
 * directory in the tree — so we never surface a marker from `node_modules/`,
 * `target/`, or vendored deps. Binary / non-UTF-8 files are skipped silently.
 */
async function scanTodoComments(
  scopeRoot: string,
  displayRoot: string,
  limit: number,
): Promise<Candidate[]> {
  const out: Candidate[] = [];

  // Cycle guard: we follow symlinked directories (unlike `fs.find`), so a
  // symlink loop (`loop -> .`, `a/b -> a`) would recurse until the call stack
  // overflows. Track the resolved real path of every directory we descend into
  // and skip any we've already seen.
  const visited = new Set<string>();

  // Hierarchical .gitignore: each directory inherits its ancestors' rules and
  // may add its own. We build a per-directory `ignore` matcher seeded from the
  // parent's accumulated patterns.
  async function walk(dir: string, ig: Ignore): Promise<boolean> {
    // Resolve symlinks so a directory reached via two paths (or a cycle) is
    // only walked once. If it can't be resolved, skip it rather than crash.
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return false;
    }
    if (visited.has(real)) return false;
    visited.add(real);

    // Load this directory's .gitignore (if any) onto a fresh matcher that also
    // carries inherited rules.
    const localIg = ignore().add(ig as unknown as Ignore);
    const gitignorePath = path.join(dir, ".gitignore");
    try {
      const gi = await readFile(gitignorePath, "utf8");
      localIg.add(gi);
    } catch {
      // No .gitignore here — inherit only.
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    // Deterministic order so `limit` truncation is stable across runs.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const name = entry.name;
      // Hidden-file filter (the `ignore` crate's standard_filters skips
      // dotfiles), and always skip the VCS dir.
      if (name.startsWith(".")) continue;

      const abs = path.join(dir, name);
      // Path relative to the scan root, used for .gitignore matching.
      const relToScope = path.relative(scopeRoot, abs).split(path.sep).join("/");

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Resolve the link to decide file vs dir; broken links are skipped.
        try {
          const st = await stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        // .gitignore directory patterns may or may not carry a trailing slash;
        // test both the path and the path-with-slash form.
        if (localIg.ignores(relToScope) || localIg.ignores(relToScope + "/")) continue;
        const done = await walk(abs, localIg);
        if (done) return true;
        continue;
      }

      if (!isFile) continue;
      if (localIg.ignores(relToScope)) continue;

      let contents: string;
      try {
        contents = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      // Skip likely-binary files (NUL byte) — readFile won't throw on them.
      if (contents.includes("\u0000")) continue;

      const rel = path.relative(displayRoot, abs).split(path.sep).join("/");
      const lines = contents.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx]!;
        const caps = MARKER_RE.exec(line);
        if (!caps) continue;
        const marker = (caps[1] ?? "").toUpperCase();
        const body = (caps[2] ?? "").trim();
        // Skip empty markers ("// TODO" with no text) — those generate noise
        // without telling us what to do.
        if (body.length === 0) continue;
        const trimmedBody = takeChars(body, COMMENT_TRIM);
        // Keep titles short; the description carries the full line + path/line
        // for context.
        const titleBody = takeChars(trimmedBody, TITLE_TRIM);
        const title = `${marker}: ${titleBody}`;
        out.push({
          title,
          description: `Source: \`${rel}:${idx + 1}\`\n\n\`\`\`\n${trimmedBody}\n\`\`\``,
          source: "todo_comment",
          path: rel,
          line: idx + 1,
        });
        if (out.length >= limit) return true;
      }
    }
    return false;
  }

  await walk(scopeRoot, ignore());
  return out;
}

/** Take the first `n` Unicode code points (matches Rust `chars().take(n)`). */
function takeChars(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}
