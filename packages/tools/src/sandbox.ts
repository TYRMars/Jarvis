// Path-sandbox helpers shared by the `fs.*` and `shell.exec` tools. Every
// tool that takes a path argument from the model resolves it through
// `resolveUnder` so absolute paths and `..` components are rejected before
// the path ever reaches the OS.
//
// Ported faithfully from crates/harness-tools/src/sandbox.rs.

import { realpathSync } from "node:fs";
import * as path from "node:path";

/** Sandbox-violation error. Thrown by `resolveUnder` on any escape attempt. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Join `relPath` onto `root`, rejecting absolute paths and any `..`
 * components, then canonicalize the result and verify it still lives under
 * `root`. The second step matters because the lexical checks only inspect the
 * textual path — a symlink that lives *inside* `root` but points outside it
 * would otherwise be followed transparently, escaping the sandbox (the
 * read-side tools `fs.read` / `fs.list` / `code.grep` are not approval-gated,
 * so this would be a no-prompt host-file read).
 *
 * Returns an absolute (non-canonicalized) path within `root`. Throws
 * `SandboxError` on violation.
 */
export function resolveUnder(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new SandboxError("path must be relative to the tool root");
  }
  // Inspect each lexical component for `..` / root / drive prefixes. Splitting
  // on both separators keeps Windows-style inputs honest on every platform.
  for (const comp of relPath.split(/[/\\]+/)) {
    if (comp === "..") {
      throw new SandboxError("`..` components are not allowed");
    }
    // A drive prefix like `C:` only appears as the first component of an
    // absolute Windows path; `path.isAbsolute` already caught those on
    // Windows, but guard defensively for cross-platform inputs.
    if (/^[A-Za-z]:$/.test(comp)) {
      throw new SandboxError("absolute path components are not allowed");
    }
  }

  const candidate = path.join(root, relPath);

  // Resolve symlinks on both sides before comparing. The target may not exist
  // yet (e.g. `fs.write` creating a new file), so canonicalize the longest
  // existing prefix and re-append the not-yet-created tail — those trailing
  // components don't exist on disk and therefore can't be symlinks.
  const canonicalRoot = canonicalizeExistingPrefix(root);
  const resolved = canonicalizeExistingPrefix(candidate);
  if (!isUnder(resolved, canonicalRoot)) {
    throw new SandboxError("path escapes the tool root via a symlink");
  }

  return candidate;
}

/**
 * Canonicalize the longest existing ancestor of `p` (resolving any symlinks
 * along the way) and re-append the trailing components that don't exist yet.
 * Falls back to the lexical path when nothing canonicalizes.
 */
function canonicalizeExistingPrefix(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const canonical = realpathSync(cur);
      let result = canonical;
      for (let i = tail.length - 1; i >= 0; i--) {
        result = path.join(result, tail[i]!);
      }
      return result;
    } catch {
      // `cur` doesn't exist (or isn't readable) — peel off the last component
      // and try its parent.
    }
    const name = path.basename(cur);
    if (name === "") {
      return path.resolve(p);
    }
    tail.push(name);
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.resolve(p);
    }
    cur = parent;
  }
}

/** True when `child` is `root` itself or a descendant of it. */
function isUnder(child: string, root: string): boolean {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
