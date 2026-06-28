// Filename-glob file search.
//
// Walks the sandbox root respecting `.gitignore` / `.ignore` / hidden-file /
// `.git` filters (the standard "VCS / build artifact" filters), and lists the
// *paths* of files whose name matches a gitignore-style glob — the read-only
// counterpart to the grep tool that searches by name rather than by content.
//
// Read-only: registered by default. Ported faithfully from
// crates/harness-tools/src/fs_find.rs. The Rust uses the `ignore` crate's
// WalkBuilder + OverrideBuilder; here we walk by hand and reuse the `ignore`
// npm package for both the standard gitignore filters and the glob whitelist.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { resolveUnder } from "./sandbox.ts";
import { loadIgnoreFiles } from "./ignore-walk.ts";

// The `ignore` package is CommonJS exporting a callable factory as its default.
// Under NodeNext without `esModuleInterop` the default binding's type collapses
// to the module namespace (not callable), so we re-type it once here. The
// runtime value is the factory function (verified at runtime).
const ignoreFactory = ignore as unknown as (options?: { ignorecase?: boolean }) => Ignore;

const DEFAULT_MAX_RESULTS = 500;

// Standard filters the `ignore` crate applies via `standard_filters(true)`:
// hidden files (dotfiles) and the `.git` directory are skipped, in addition
// to `.gitignore` / `.ignore` rules discovered while walking.
const STANDARD_IGNORE_PATTERNS = [".git/", ".*"];

/** Configuration for `fs.find`. */
export interface FsFindConfig {
  /** Sandbox root; the search is scoped under it. */
  root: string;
  /** Cap on the number of paths returned. Defaults to 500. */
  maxResults?: number;
}

function asObject(args: JsonValue): { [key: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }
  return {};
}

export class FsFindTool implements Tool {
  readonly name = "fs.find";
  readonly description =
    "Find files under the tool root whose path matches a gitignore-style " +
    "glob (e.g. `**/*.rs` or `src/**/*.ts`). Respects " +
    ".gitignore / .ignore / hidden-file filters. Optional `path` " +
    "(relative subdir) narrows the search. Returns one relative file " +
    "path per line, capped by `max_results`.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  #root: string;
  #maxResults: number;

  constructor(config: FsFindConfig) {
    this.#root = config.root;
    this.#maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        glob: {
          type: "string",
          description: "Gitignore-style glob, e.g. `**/*.rs` or `src/**/*.ts`.",
        },
        path: {
          type: "string",
          description: "Optional subdirectory under the root.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          description: "Cap on number of file paths returned.",
        },
      },
      required: ["glob"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const globRaw = obj.glob;
    if (typeof globRaw !== "string") {
      throw new Error("missing `glob` argument");
    }
    const glob = globRaw;

    const maxRaw = obj.max_results;
    const maxResults =
      typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw >= 1
        ? Math.floor(maxRaw)
        : this.#maxResults;

    const root = this.#root;
    const pathRaw = obj.path;
    const scopeRoot =
      typeof pathRaw === "string" ? resolveUnder(root, pathRaw) : root;

    // Whitelist matcher built from the glob. `ignore` follows gitignore
    // semantics, where an added pattern matches paths — so a file is a match
    // when this matcher reports it as "ignored".
    let globMatcher: Ignore;
    try {
      globMatcher = ignoreFactory().add(glob);
    } catch (e) {
      throw new Error(`invalid glob: ${e instanceof Error ? e.message : String(e)}`);
    }

    const lines: string[] = [];
    let count = 0;
    let truncated = false;

    // A single cumulative matcher. Every pattern is anchored relative to the
    // scope root (see `anchorPatterns`), and all paths handed to it are scope-
    // root-relative, so one matcher covers the whole subtree. Nested ignore
    // files are layered on as we descend. The emitted paths are relative to
    // `root` (the display root), which may differ from `scopeRoot`.
    const ig = ignoreFactory().add(STANDARD_IGNORE_PATTERNS);
    await loadIgnoreFiles(ig, scopeRoot, "");

    type Frame = { dir: string; relFromScope: string };
    const stack: Frame[] = [{ dir: scopeRoot, relFromScope: "" }];

    while (stack.length > 0 && !truncated) {
      const frame = stack.pop()!;
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(frame.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Deterministic order (the Rust walker yields a stable order too).
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      const subdirs: Frame[] = [];
      for (const entry of dirents) {
        const childRelScope = frame.relFromScope
          ? `${frame.relFromScope}/${entry.name}`
          : entry.name;

        if (entry.isDirectory()) {
          // Directories are tested with a trailing slash so gitignore dir
          // rules apply.
          if (ig.ignores(`${childRelScope}/`) || ig.ignores(childRelScope)) {
            continue;
          }
          const childDir = path.join(frame.dir, entry.name);
          await loadIgnoreFiles(ig, childDir, childRelScope);
          subdirs.push({ dir: childDir, relFromScope: childRelScope });
        } else if (entry.isFile()) {
          if (ig.ignores(childRelScope)) {
            continue;
          }
          if (!globMatcher.ignores(childRelScope)) {
            continue;
          }
          const abs = path.join(frame.dir, entry.name);
          const relFromDisplay = path.relative(root, abs);
          lines.push(relFromDisplay);
          count += 1;
          if (count >= maxResults) {
            truncated = true;
            break;
          }
        }
        // Symlinks and other entry kinds are skipped (the Rust walker does not
        // follow symlinks by default and only emits regular files).
      }

      if (truncated) break;
      // Push subdirs in reverse so the sorted order is preserved on pop.
      for (let i = subdirs.length - 1; i >= 0; i--) {
        stack.push(subdirs[i]!);
      }
    }

    if (count === 0) {
      return "(no matches)";
    }
    let out = lines.join("\n") + "\n";
    if (truncated) {
      out += `\n[... truncated at ${count} results ...]`;
    }
    return out;
  }
}
