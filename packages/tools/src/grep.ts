// Regex-based code search. Ported from harness-tools/src/grep.rs.
//
// Walks the sandbox root respecting `.gitignore` (root file) and skipping
// the `.git` directory and hidden dotfiles/dirs (mirroring the Rust `ignore`
// crate's standard filters), reads each candidate file as UTF-8, and reports
// lines matching the supplied regex. Binary / non-UTF-8 files are skipped
// silently — they would otherwise return garbage to the model.
//
// Read-only: registered by default.
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import ignoreDefault from "ignore";
import type { Ignore } from "ignore";

import type { Tool, ToolCategory } from "@jarvis/core";
import type { JsonValue } from "@jarvis/core";

import { resolveUnder } from "./sandbox.ts";

// The `ignore` package is CommonJS exporting a callable factory as its default.
// Under NodeNext with `verbatimModuleSyntax` the default binding's type
// collapses to the module namespace (not callable), so we re-type it once here.
// The runtime value is the factory function.
const ignore = ignoreDefault as unknown as (options?: { ignorecase?: boolean }) => Ignore;

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 240;

export interface CodeGrepOptions {
  /** Sandbox root the search is scoped under. */
  root: string;
  /** Cap on number of matching lines returned. Default 200. */
  maxResults?: number;
  /** Total output byte budget. Default 64 KiB. */
  maxBytes?: number;
}

/**
 * `code.grep` — regex over the sandbox, `.gitignore`-aware, with optional
 * `path` (relative subdir) and `glob` narrowers. Output is `path:lineno: line`
 * triples capped by `max_results` and a total byte budget.
 */
export class CodeGrepTool implements Tool {
  readonly name = "code.grep";
  readonly description =
    "Search files under the tool root for lines matching a regex. " +
    "Respects .gitignore / hidden-file filters. Optional `path` (relative " +
    "subdir) and `glob` (e.g. `*.ts`) narrow the search. Returns " +
    "`path:lineno: line` triples, capped by `max_results` and total bytes. " +
    "Lines longer than 240 chars are truncated.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  readonly #root: string;
  readonly #maxResults: number;
  readonly #maxBytes: number;

  constructor(options: CodeGrepOptions) {
    this.#root = options.root;
    this.#maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "JavaScript-flavoured regex.",
        },
        path: {
          type: "string",
          description: "Optional subdirectory under the root.",
        },
        glob: {
          type: "string",
          description: "Optional gitignore-style glob, e.g. `*.ts` or `src/**/*.ts`.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Case-insensitive match. Defaults to false.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          description: "Cap on number of matching lines returned.",
        },
      },
      required: ["pattern"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = isObject(args) ? args : {};

    const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
    if (pattern === undefined) {
      throw new Error("missing `pattern` argument");
    }

    const caseInsensitive =
      typeof obj.case_insensitive === "boolean" ? obj.case_insensitive : false;

    const maxResults =
      typeof obj.max_results === "number" && Number.isFinite(obj.max_results)
        ? Math.floor(obj.max_results)
        : this.#maxResults;

    const rel = typeof obj.path === "string" ? obj.path : undefined;
    // resolveUnder rejects absolute paths and `..` escapes (throws SandboxError).
    const scopeRoot = rel !== undefined ? resolveUnder(this.#root, rel) : this.#root;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch (e) {
      throw new Error(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    const glob = typeof obj.glob === "string" ? obj.glob : undefined;
    // Whitelist override (mirrors the Rust `OverrideBuilder`): the glob is the
    // sole *include* rule, so a file passes the filter iff the glob matches it.
    // We treat the glob as a gitignore pattern and read `ignores()` as "matches"
    // — only files matching are kept; directory traversal is governed separately
    // below so a deep glob like `src/**/*.ts` can still be reached.
    let globMatcher: Ignore | undefined;
    if (glob !== undefined) {
      try {
        globMatcher = ignore().add(glob);
      } catch (e) {
        throw new Error(`invalid glob: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Root .gitignore matcher (relative paths from the sandbox root).
    const gitignore = ignore();
    try {
      const content = await readFile(path.join(this.#root, ".gitignore"), "utf8");
      gitignore.add(content);
    } catch {
      // No .gitignore is fine.
    }

    let out = "";
    let count = 0;
    let truncated = false;
    const maxBytes = this.#maxBytes;

    // Iterative DFS over the scope root. Paths are tracked relative to the
    // sandbox root (display + .gitignore matching both want that).
    const stack: string[] = [scopeRoot];
    outer: while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }
      // Deterministic ordering for stable output.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        const name = entry.name;
        // Skip the VCS directory and hidden dotfiles/dirs (matches the Rust
        // `ignore` crate's standard filters: hidden=true, git-aware).
        if (name === ".git") continue;
        if (name.startsWith(".")) continue;

        const absPath = path.join(dir, name);
        const relPath = path.relative(this.#root, absPath);
        // Normalise to forward slashes for gitignore / glob matching.
        const posixRel = relPath.split(path.sep).join("/");

        if (entry.isDirectory()) {
          // `ignore` wants a trailing slash to match directory rules.
          if (gitignore.ignores(posixRel + "/") || gitignore.ignores(posixRel)) continue;
          stack.push(absPath);
          continue;
        }
        if (!entry.isFile()) continue;

        if (gitignore.ignores(posixRel)) continue;
        // Whitelist: skip files the glob does NOT match.
        if (globMatcher !== undefined && !globMatcher.ignores(posixRel)) continue;

        let contents: string;
        try {
          contents = await readFile(absPath, "utf8");
        } catch {
          continue;
        }
        // Skip likely-binary content (NUL byte) — mirrors Rust's
        // read_to_string failing on non-UTF-8.
        if (contents.includes(String.fromCharCode(0))) continue;

        const lines = splitLines(contents);
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx] as string;
          if (!regex.test(line)) continue;
          // Reset lastIndex defensively (no `g` flag, but be safe).
          regex.lastIndex = 0;

          const chars = [...line];
          const snippet =
            chars.length > MAX_LINE_CHARS
              ? chars.slice(0, MAX_LINE_CHARS).join("") + " …"
              : line;
          const formatted = `${posixRel}:${idx + 1}: ${snippet}\n`;

          if (Buffer.byteLength(out, "utf8") + Buffer.byteLength(formatted, "utf8") > maxBytes) {
            truncated = true;
            break outer;
          }
          out += formatted;
          count += 1;
          if (count >= maxResults) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    if (count === 0) {
      return "(no matches)";
    }
    if (truncated) {
      out += `\n[... truncated at ${count} results / ${maxBytes} bytes ...]`;
    }
    return out;
  }
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Split into lines the way Rust's `str::lines()` does (no trailing empty). */
function splitLines(s: string): string[] {
  const parts = s.split("\n");
  // Drop the trailing empty produced by a final newline.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  // Strip a trailing \r so CRLF files behave like Rust's lines().
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
