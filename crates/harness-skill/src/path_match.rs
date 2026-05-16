//! Path-glob matcher for the M3.3 skill auto-activation rule.
//!
//! Self-contained and dependency-free (no `glob` / `globset` crate
//! pull-in). The grammar is intentionally tiny — only the patterns
//! a SKILL.md author would reasonably write:
//!
//! - `?`  — one non-`/` character
//! - `*`  — any run of non-`/` characters within one segment
//! - `**` — any path fragment, crossing segment boundaries (incl.
//!   zero segments)
//! - any other character — literal match (case-sensitive)
//!
//! Backslashes in input paths are normalised to forward slashes so
//! the same pattern works on Windows without authors having to
//! double-escape.
//!
//! Implementation is a straightforward dynamic-programming match
//! over byte slices; pattern length and path length are both small
//! (paths bounded by filesystem limits, patterns are user-written
//! and rarely exceed a few dozen chars), so the O(n*m) cost is
//! noise.

/// True when `path` matches the glob `pattern`. Paths are
/// normalised by replacing `\` with `/` so callers don't have to
/// pre-normalise. Empty pattern matches only empty path; empty
/// path matches only patterns that reduce to nothing (e.g. `**`).
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let path = path.replace('\\', "/");
    let pat = pattern.as_bytes();
    let txt = path.as_bytes();
    matches_at(pat, 0, txt, 0)
}

/// True when any pattern in `patterns` matches `path`. Convenience
/// for the common "skill has 0..N globs" case.
pub fn any_glob_matches<S: AsRef<str>>(patterns: &[S], path: &str) -> bool {
    patterns.iter().any(|p| glob_matches(p.as_ref(), path))
}

fn matches_at(pat: &[u8], mut pi: usize, txt: &[u8], mut ti: usize) -> bool {
    while pi < pat.len() {
        match pat[pi] {
            b'*' if pat.get(pi + 1) == Some(&b'*') => {
                // `**` — match across path segments. Optionally
                // consume a trailing `/` so `**/foo` matches both
                // `foo` and `a/b/foo`.
                let mut next = pi + 2;
                if pat.get(next) == Some(&b'/') {
                    next += 1;
                }
                // Try matching the remainder at every position in
                // `txt` from current onward (including current).
                loop {
                    if matches_at(pat, next, txt, ti) {
                        return true;
                    }
                    if ti >= txt.len() {
                        return false;
                    }
                    ti += 1;
                }
            }
            b'*' => {
                // `*` — match any run of non-`/` within one segment.
                let next = pi + 1;
                loop {
                    if matches_at(pat, next, txt, ti) {
                        return true;
                    }
                    if ti >= txt.len() || txt[ti] == b'/' {
                        return false;
                    }
                    ti += 1;
                }
            }
            b'?' => {
                if ti >= txt.len() || txt[ti] == b'/' {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            c => {
                if ti >= txt.len() || txt[ti] != c {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == txt.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_matches() {
        assert!(glob_matches("Cargo.toml", "Cargo.toml"));
        assert!(!glob_matches("Cargo.toml", "Cargo.lock"));
    }

    #[test]
    fn star_matches_within_segment() {
        assert!(glob_matches("*.rs", "lib.rs"));
        assert!(!glob_matches("*.rs", "lib.rs.bak"));
        assert!(!glob_matches("*.rs", "src/lib.rs"));
    }

    #[test]
    fn double_star_crosses_segments() {
        assert!(glob_matches("**/*.tsx", "App.tsx"));
        assert!(glob_matches("**/*.tsx", "src/components/App.tsx"));
        assert!(!glob_matches("**/*.tsx", "App.ts"));
    }

    #[test]
    fn double_star_matches_zero_segments() {
        assert!(glob_matches("**/foo", "foo"));
        assert!(glob_matches("**/foo", "a/b/foo"));
        assert!(!glob_matches("**/foo", "foobar"));
    }

    #[test]
    fn question_mark_matches_one_char() {
        assert!(glob_matches("a?c", "abc"));
        assert!(!glob_matches("a?c", "ac"));
        assert!(!glob_matches("a?c", "abbc"));
        // Doesn't cross `/`.
        assert!(!glob_matches("a?c", "a/c"));
    }

    #[test]
    fn segment_in_middle_with_double_star() {
        assert!(glob_matches("src/**/*.rs", "src/lib.rs"));
        assert!(glob_matches("src/**/*.rs", "src/a/b/c.rs"));
        assert!(!glob_matches("src/**/*.rs", "tests/a.rs"));
    }

    #[test]
    fn backslashes_are_normalised() {
        // Author writes the pattern with `/`; matcher accepts a
        // Windows-style path with `\`.
        assert!(glob_matches("src/**/*.rs", "src\\foo\\bar.rs"));
    }

    #[test]
    fn empty_pattern_matches_only_empty() {
        assert!(glob_matches("", ""));
        assert!(!glob_matches("", "x"));
    }

    #[test]
    fn any_glob_matches_short_circuits() {
        let pats = vec!["*.lock".to_string(), "**/*.tsx".to_string()];
        assert!(any_glob_matches(&pats, "src/App.tsx"));
        assert!(any_glob_matches(&pats, "Cargo.lock"));
        assert!(!any_glob_matches(&pats, "src/lib.rs"));
    }
}
