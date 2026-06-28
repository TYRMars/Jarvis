// Shared gitignore-walk helpers for the read-only filesystem tools
// (`fs.find`, `code.grep`).
//
// Both tools walk the sandbox respecting `.gitignore` / `.ignore` files
// discovered *at every directory* (not just the root), mirroring the Rust
// `ignore` crate's per-directory ignore-stack behaviour. The anchoring logic
// is subtle enough that it belongs in one place rather than copied per tool.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Ignore } from "ignore";

/** Ignore files honoured while walking, in the `ignore` crate's order. */
export const IGNORE_FILES = [".gitignore", ".ignore"];

/**
 * Add the contents of any `.gitignore` / `.ignore` files found in `dir` to
 * `ig`, anchoring relative to `relPrefix` (the dir's path relative to the
 * matcher's base) so nested ignore rules match correctly.
 */
export async function loadIgnoreFiles(
  ig: Ignore,
  dir: string,
  relPrefix: string,
): Promise<void> {
  for (const fname of IGNORE_FILES) {
    try {
      const raw = await fs.readFile(path.join(dir, fname), "utf8");
      const anchored = anchorPatterns(raw, relPrefix);
      if (anchored.length > 0) ig.add(anchored);
    } catch {
      // No such ignore file in this directory.
    }
  }
}

/**
 * Anchor gitignore patterns from a file located at `relPrefix` so they match
 * paths relative to the matcher's base. Patterns without a leading `/` or
 * interior slash apply to any depth (gitignore semantics) so they're left
 * as-is; a rooted or pathful pattern is prepended with the prefix so it stays
 * scoped to the subtree it was declared in.
 */
export function anchorPatterns(raw: string, relPrefix: string): string[] {
  const out: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    if (!relPrefix) {
      out.push(line);
      continue;
    }
    let negate = false;
    let body = line;
    if (body.startsWith("!")) {
      negate = true;
      body = body.slice(1);
    }
    // A pattern that is rooted (leading `/`) or contains an interior slash is
    // relative to the directory the ignore file lives in; anchor it under the
    // prefix. A bare-name pattern applies at any depth, so leave it global.
    const rooted = body.startsWith("/");
    const hasInteriorSlash = body.replace(/\/$/, "").includes("/");
    let anchored: string;
    if (rooted) {
      anchored = `${relPrefix}${body}`;
    } else if (hasInteriorSlash) {
      anchored = `${relPrefix}/${body}`;
    } else {
      anchored = body;
    }
    out.push(negate ? `!${anchored}` : anchored);
  }
  return out;
}
