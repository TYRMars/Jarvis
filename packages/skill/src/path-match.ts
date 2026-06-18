// Path-glob matcher for the skill path-based auto-activation rule.
//
// Ported from crates/harness-skill/src/path_match.rs.
//
// Self-contained and dependency-free. The grammar is intentionally tiny —
// only the patterns a SKILL.md author would reasonably write:
//
// - `?`  — one non-`/` character
// - `*`  — any run of non-`/` characters within one segment
// - `**` — any path fragment, crossing segment boundaries (incl. zero
//   segments)
// - any other character — literal match (case-sensitive)
//
// Backslashes in input paths are normalised to forward slashes so the same
// pattern works on Windows without authors having to double-escape.
//
// Implementation is a straightforward recursive match over UTF-8 byte arrays
// (mirrors the Rust byte-slice walk), so multi-byte characters behave
// identically across the two ports.

/**
 * True when `path` matches the glob `pattern`. Paths are normalised by
 * replacing `\` with `/` so callers don't have to pre-normalise. Empty pattern
 * matches only empty path; empty path matches only patterns that reduce to
 * nothing (e.g. `**`).
 */
export function globMatches(pattern: string, path: string): boolean {
  const normalised = path.replace(/\\/g, "/");
  const enc = new TextEncoder();
  const pat = enc.encode(pattern);
  const txt = enc.encode(normalised);
  return matchesAt(pat, 0, txt, 0);
}

/**
 * True when any pattern in `patterns` matches `path`. Convenience for the
 * common "skill has 0..N globs" case.
 */
export function anyGlobMatches(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => globMatches(p, path));
}

const STAR = 0x2a; // *
const SLASH = 0x2f; // /
const QUESTION = 0x3f; // ?

function matchesAt(pat: Uint8Array, piStart: number, txt: Uint8Array, tiStart: number): boolean {
  let pi = piStart;
  let ti = tiStart;
  while (pi < pat.length) {
    const c = pat[pi];
    if (c === STAR && pat[pi + 1] === STAR) {
      // `**` — match across path segments. Optionally consume a trailing `/`
      // so `**/foo` matches both `foo` and `a/b/foo`.
      let next = pi + 2;
      if (pat[next] === SLASH) next += 1;
      // Try matching the remainder at every position from current onward.
      for (;;) {
        if (matchesAt(pat, next, txt, ti)) return true;
        if (ti >= txt.length) return false;
        ti += 1;
      }
    }
    if (c === STAR) {
      // `*` — match any run of non-`/` within one segment.
      const next = pi + 1;
      for (;;) {
        if (matchesAt(pat, next, txt, ti)) return true;
        if (ti >= txt.length || txt[ti] === SLASH) return false;
        ti += 1;
      }
    }
    if (c === QUESTION) {
      if (ti >= txt.length || txt[ti] === SLASH) return false;
      pi += 1;
      ti += 1;
      continue;
    }
    // Literal byte.
    if (ti >= txt.length || txt[ti] !== c) return false;
    pi += 1;
    ti += 1;
  }
  return ti === txt.length;
}
