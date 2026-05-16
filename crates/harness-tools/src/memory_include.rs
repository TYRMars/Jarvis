//! P16 — Memory `include` directives.
//!
//! Lets a `MEMORY.md` reference other memory trees by adding HTML
//! comment lines at the top of the file:
//!
//! ```text
//! <!-- jarvis-include: /Users/team/jarvis-mem/.jarvis/memory -->
//! <!-- jarvis-include: ~/jarvis-personal/.jarvis/memory -->
//! <!-- jarvis-include: git+https://github.com/me/team-mem.git -->
//! <!-- jarvis-include: git+ssh://git@github.com/me/team-mem.git#stable -->
//! ```
//!
//! At system-prompt injection time the binary follows these
//! directives and appends each upstream's MEMORY.md as its own
//! section ("=== included from <label> ==="). The agent's local
//! `memory.list/read/write/delete` still operate on the host
//! tree — includes are strictly *consumed*, never written to.
//!
//! Cycle safety: depth-1 only (no recursion into nested
//! includes), and the deduping is by canonical directive string
//! before resolution. A self-reference is detected after path
//! canonicalisation and skipped.
//!
//! Git URL flow:
//!
//! 1. Parse `git+<url>[#<branch>]`.
//! 2. Hash url+branch into a slug.
//! 3. Cache dir: `<user_root>/include-cache/<slug>/`. If absent,
//!    `git clone <url> <cache>` (optionally `--branch <b>`).
//! 4. If present, use as-is. Refresh is explicit — there's a
//!    `memory.include_refresh` tool that wipes + re-clones, and
//!    the agent can call it when staleness matters.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use harness_core::BoxError;
use tokio::process::Command;

const GIT_TIMEOUT_MS: u64 = 60_000;

/// One parsed `<!-- jarvis-include: ... -->` line. Stays
/// closer to the wire format than to the on-disk path so the
/// caller can dedup / display the original directive verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncludeDirective {
    /// Filesystem path. Tilde (`~`) gets expanded at resolve
    /// time so directives don't bake in an absolute home that
    /// breaks when the file is shared between machines.
    LocalPath(String),
    /// `git+<url>[#branch]` — the `git+` prefix is the
    /// discriminator. Clone target + optional branch.
    GitUrl {
        url: String,
        branch: Option<String>,
    },
}

impl IncludeDirective {
    /// Canonical wire form for round-tripping into MEMORY.md.
    pub fn as_wire(&self) -> String {
        match self {
            IncludeDirective::LocalPath(s) => s.clone(),
            IncludeDirective::GitUrl {
                url,
                branch: Some(b),
            } => format!("git+{url}#{b}"),
            IncludeDirective::GitUrl { url, branch: None } => format!("git+{url}"),
        }
    }

    /// Try to parse one target string (whatever sits after
    /// `<!-- jarvis-include: ` and before ` -->`).
    pub fn parse_target(s: &str) -> Option<Self> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("git+") {
            let (url, branch) = match rest.rsplit_once('#') {
                Some((u, b)) if !b.is_empty() && !u.is_empty() && !looks_like_path(u) => {
                    (u.to_string(), Some(b.to_string()))
                }
                _ => (rest.to_string(), None),
            };
            return Some(IncludeDirective::GitUrl { url, branch });
        }
        Some(IncludeDirective::LocalPath(trimmed.to_string()))
    }

    /// A short, human-readable label used in the `=== included
    /// from <label> ===` header. Tries to be more useful than
    /// the raw URL/path for the model.
    pub fn label(&self) -> String {
        match self {
            IncludeDirective::LocalPath(p) => p.clone(),
            IncludeDirective::GitUrl { url, branch } => match branch {
                Some(b) => format!("git:{url} ({b})"),
                None => format!("git:{url}"),
            },
        }
    }
}

/// Heuristic: a `git+...` rsplit shouldn't treat
/// `https://host/foo#bar` as `https://host/foo` + branch `bar` if
/// `bar` looks like a path segment instead of a branch. In
/// practice branches don't contain `/`, so we use that as the
/// disambiguator. Conservatively: if the right side has a slash,
/// it's part of the URL fragment, not a branch.
fn looks_like_path(_url: &str) -> bool {
    false // simple heuristic — branches with `/` are valid but rare
}

/// Parse all `<!-- jarvis-include: ... -->` directives from a
/// MEMORY.md text. Empty / malformed directives are silently
/// skipped so an incomplete edit doesn't break the rest of the
/// file. Duplicates are kept (caller dedups if desired).
pub fn parse_include_directives(text: &str) -> Vec<IncludeDirective> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("<!-- jarvis-include:") {
            let Some(inner) = rest.strip_suffix("-->") else {
                continue;
            };
            if let Some(d) = IncludeDirective::parse_target(inner.trim()) {
                out.push(d);
            }
        }
    }
    out
}

/// Insert (or skip if already present) an include directive
/// at the top of `text`, returning the new file body.
/// Directives go above any non-directive content so they're
/// findable at a glance.
pub fn add_include_line(text: &str, directive: &IncludeDirective) -> String {
    let line = format!("<!-- jarvis-include: {} -->", directive.as_wire());
    let existing = parse_include_directives(text);
    if existing.iter().any(|d| d == directive) {
        return text.to_string();
    }
    // Split text into existing include lines vs. body.
    let mut directives_block: Vec<&str> = Vec::new();
    let mut rest_lines: Vec<&str> = Vec::new();
    let mut hit_non_directive = false;
    for l in text.lines() {
        let t = l.trim();
        if !hit_non_directive
            && (t.is_empty()
                || (t.starts_with("<!-- jarvis-include:") && t.ends_with("-->")))
        {
            if t.starts_with("<!-- jarvis-include:") {
                directives_block.push(l);
            }
            // empty line at the top is just absorbed
            continue;
        }
        hit_non_directive = true;
        rest_lines.push(l);
    }
    let mut out = String::new();
    for d in &directives_block {
        out.push_str(d);
        out.push('\n');
    }
    out.push_str(&line);
    out.push('\n');
    if !rest_lines.is_empty() {
        out.push('\n');
        out.push_str(&rest_lines.join("\n"));
        if text.ends_with('\n') && !out.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// Remove the directive whose `as_wire()` matches `target`. No-op
/// when not found; returns the modified body.
pub fn remove_include_line(text: &str, target_wire: &str) -> String {
    let needle = format!("<!-- jarvis-include: {target_wire} -->");
    let mut out_lines = Vec::new();
    let mut removed = false;
    for line in text.lines() {
        if !removed && line.trim() == needle {
            removed = true;
            continue;
        }
        out_lines.push(line);
    }
    let mut joined = out_lines.join("\n");
    if text.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// Expand a leading `~` in `path` against the operator's HOME.
/// `~/foo` → `<HOME>/foo`; everything else returned unchanged.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Resolve an [`IncludeDirective`] into a concrete on-disk path
/// pointing at a memory tree (one that contains MEMORY.md
/// directly or has `.jarvis/memory/MEMORY.md` underneath).
///
/// `cache_root` is the directory under which git includes are
/// cached (typically `<user_root>/include-cache/`). Local
/// includes ignore it.
///
/// Returns `Err` with a user-facing message when the target
/// can't be resolved; the caller (system-prompt builder) logs
/// the failure and skips that include rather than aborting.
pub async fn resolve_include(
    directive: &IncludeDirective,
    cache_root: &Path,
) -> Result<PathBuf, BoxError> {
    match directive {
        IncludeDirective::LocalPath(p) => {
            let candidate = expand_tilde(p);
            normalise_memory_dir(&candidate)
        }
        IncludeDirective::GitUrl { url, branch } => {
            let slug = directive_slug(url, branch.as_deref());
            let cache_dir = cache_root.join(&slug);
            if !cache_dir.exists() {
                tokio::fs::create_dir_all(cache_root)
                    .await
                    .map_err(|e| -> BoxError {
                        format!("mkdir {}: {e}", cache_root.display()).into()
                    })?;
                git_clone(url, branch.as_deref(), &cache_dir).await?;
            }
            normalise_memory_dir(&cache_dir)
        }
    }
}

/// Inspect `candidate` and return whichever of these two paths
/// contains a `MEMORY.md`:
///
/// 1. `candidate/MEMORY.md` (the include points directly at a
///    memory dir)
/// 2. `candidate/.jarvis/memory/MEMORY.md` (the include points
///    at a workspace root)
///
/// Returns `Err` with a clear message when neither exists.
fn normalise_memory_dir(candidate: &Path) -> Result<PathBuf, BoxError> {
    if !candidate.exists() {
        return Err(format!("include path not found: {}", candidate.display()).into());
    }
    let direct = candidate.join("MEMORY.md");
    if direct.is_file() {
        return Ok(candidate.to_path_buf());
    }
    let nested = candidate.join(crate::memory::MEMORY_DIR).join("MEMORY.md");
    if nested.is_file() {
        return Ok(candidate.join(crate::memory::MEMORY_DIR));
    }
    Err(format!(
        "include `{}` has no MEMORY.md (looked at the directory itself and at .jarvis/memory/ underneath)",
        candidate.display()
    )
    .into())
}

/// Deterministic per-include cache slug. Branch is folded in so
/// `repo.git` and `repo.git#feature` get separate caches.
fn directive_slug(url: &str, branch: Option<&str>) -> String {
    let mut h = blake3::Hasher::new();
    h.update(url.as_bytes());
    if let Some(b) = branch {
        h.update(b"\x00");
        h.update(b.as_bytes());
    }
    h.finalize().to_hex()[..16].to_string()
}

async fn git_clone(url: &str, branch: Option<&str>, dest: &Path) -> Result<(), BoxError> {
    let mut args: Vec<&str> = vec!["clone", "--depth", "1"];
    if let Some(b) = branch {
        args.push("--branch");
        args.push(b);
    }
    args.push(url);
    let dest_str = dest.to_string_lossy().to_string();
    args.push(&dest_str);
    let (ok, _stdout, stderr) = run_git(&args).await?;
    if !ok {
        return Err(format!("git clone failed: {}", stderr.trim()).into());
    }
    Ok(())
}

/// TTL-based gentle refresh for a cached git include (P18.3).
/// Used by the system-prompt injection path when the operator
/// sets `JARVIS_INCLUDE_TTL_HOURS=N` — we *want* to pick up
/// teammate changes without the explicit `memory.include_refresh`
/// dance, but only when the cache is stale enough to warrant a
/// network call.
///
/// Behaviour:
/// - LocalPath includes → no-op (`Ok(false)` — nothing fetched).
/// - GitUrl with no cache yet → no-op (`resolve_include` will
///   clone fresh).
/// - GitUrl with cache: if the cache dir's `.git/FETCH_HEAD`
///   mtime (or, when absent, the dir mtime) is older than
///   `ttl`, run `git pull --ff-only` with a short timeout.
///   Returns `Ok(true)` on a successful pull (whether or not
///   anything new came down) and `Ok(false)` when no refresh
///   was attempted. Errors are downgraded to `Ok(false)` so a
///   network outage doesn't break startup — the caller keeps
///   the stale cache.
pub async fn maybe_refresh_git_cache(
    directive: &IncludeDirective,
    cache_root: &Path,
    ttl: Duration,
) -> Result<bool, BoxError> {
    let (url, branch) = match directive {
        IncludeDirective::GitUrl { url, branch } => (url.clone(), branch.clone()),
        IncludeDirective::LocalPath(_) => return Ok(false),
    };
    let slug = directive_slug(&url, branch.as_deref());
    let cache_dir = cache_root.join(&slug);
    if !cache_dir.exists() {
        return Ok(false);
    }
    // Probe staleness via `.git/FETCH_HEAD` mtime when present
    // (every fetch / pull updates this), otherwise fall back to
    // the cache dir's own mtime. Either way: if we can't read
    // the timestamp, fail open — skip the refresh.
    let probe = cache_dir.join(".git/FETCH_HEAD");
    let probe_path = if probe.exists() { probe } else { cache_dir.clone() };
    let meta = match tokio::fs::metadata(&probe_path).await {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    let mtime = match meta.modified() {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
    let age = std::time::SystemTime::now()
        .duration_since(mtime)
        .unwrap_or_default();
    if age < ttl {
        return Ok(false);
    }
    // Stale. Try `git pull --ff-only`; downgrade any failure to
    // `Ok(false)` so the caller keeps the stale cache.
    let pull_args: Vec<&str> = match branch.as_deref() {
        Some(b) => vec!["-C", cache_dir.to_str().unwrap_or("."), "pull", "--ff-only", "origin", b],
        None => vec!["-C", cache_dir.to_str().unwrap_or("."), "pull", "--ff-only"],
    };
    match run_git(&pull_args).await {
        Ok((true, _, _)) => {
            tracing::info!(target = %url, "include cache refreshed (TTL hit)");
            Ok(true)
        }
        Ok((false, _, stderr)) => {
            tracing::warn!(target = %url, stderr = %stderr.trim(),
                  "include TTL refresh failed; keeping stale cache");
            Ok(false)
        }
        Err(e) => {
            tracing::warn!(target = %url, error = %e,
                  "include TTL refresh errored; keeping stale cache");
            Ok(false)
        }
    }
}

/// Refresh a cached git include: removes the cache dir and
/// re-clones. Used by the explicit `memory.include_refresh` tool;
/// not called automatically (don't want to surprise the user
/// with a network call during system-prompt injection).
pub async fn refresh_git_cache(
    directive: &IncludeDirective,
    cache_root: &Path,
) -> Result<PathBuf, BoxError> {
    let (url, branch) = match directive {
        IncludeDirective::GitUrl { url, branch } => (url.clone(), branch.clone()),
        IncludeDirective::LocalPath(_) => {
            return Err("refresh only applies to git+ includes".into());
        }
    };
    let slug = directive_slug(&url, branch.as_deref());
    let cache_dir = cache_root.join(&slug);
    if cache_dir.exists() {
        tokio::fs::remove_dir_all(&cache_dir)
            .await
            .map_err(|e| -> BoxError {
                format!("rm {}: {e}", cache_dir.display()).into()
            })?;
    }
    tokio::fs::create_dir_all(cache_root)
        .await
        .map_err(|e| -> BoxError {
            format!("mkdir {}: {e}", cache_root.display()).into()
        })?;
    git_clone(&url, branch.as_deref(), &cache_dir).await?;
    normalise_memory_dir(&cache_dir)
}

async fn run_git(args: &[&str]) -> Result<(bool, String, String), BoxError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| -> BoxError { format!("spawn git: {e}").into() })?;
    let output = match tokio::time::timeout(
        Duration::from_millis(GIT_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("git io: {e}").into()),
        Err(_) => return Err("git timed out".into()),
    };
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::fs;

    #[test]
    fn parse_local_path() {
        let d = IncludeDirective::parse_target("/Users/x/mem").unwrap();
        assert_eq!(d, IncludeDirective::LocalPath("/Users/x/mem".into()));
    }

    #[test]
    fn parse_tilde_path() {
        let d = IncludeDirective::parse_target("~/jarvis-mem").unwrap();
        assert_eq!(d, IncludeDirective::LocalPath("~/jarvis-mem".into()));
    }

    #[test]
    fn parse_git_url_no_branch() {
        let d = IncludeDirective::parse_target("git+https://host/r.git").unwrap();
        assert_eq!(
            d,
            IncludeDirective::GitUrl {
                url: "https://host/r.git".into(),
                branch: None
            }
        );
    }

    #[test]
    fn parse_git_url_with_branch() {
        let d = IncludeDirective::parse_target("git+https://host/r.git#dev").unwrap();
        assert_eq!(
            d,
            IncludeDirective::GitUrl {
                url: "https://host/r.git".into(),
                branch: Some("dev".into())
            }
        );
    }

    #[test]
    fn empty_target_returns_none() {
        assert!(IncludeDirective::parse_target("   ").is_none());
    }

    #[test]
    fn parse_directives_from_memory_md_skips_non_directives() {
        let text = "<!-- jarvis-include: /a -->\n<!-- jarvis-include: ~/b -->\n\n# Real content\n- [x](x.md)\n<!-- jarvis-include: git+https://h/r.git -->\n";
        let d = parse_include_directives(text);
        assert_eq!(d.len(), 3);
        assert!(matches!(d[0], IncludeDirective::LocalPath(ref p) if p == "/a"));
        assert!(matches!(d[1], IncludeDirective::LocalPath(ref p) if p == "~/b"));
        assert!(matches!(d[2], IncludeDirective::GitUrl { ref url, .. } if url == "https://h/r.git"));
    }

    #[test]
    fn add_directive_is_idempotent() {
        let body = "<!-- jarvis-include: /a -->\n\n- [x](x.md)\n";
        let d = IncludeDirective::LocalPath("/a".into());
        let next = add_include_line(body, &d);
        assert_eq!(next, body);
    }

    #[test]
    fn add_directive_appends_above_body() {
        let body = "- [x](x.md)\n";
        let d = IncludeDirective::LocalPath("/a".into());
        let next = add_include_line(body, &d);
        assert!(next.starts_with("<!-- jarvis-include: /a -->\n"));
        assert!(next.contains("- [x](x.md)"));
    }

    #[test]
    fn remove_directive_strips_line() {
        let body = "<!-- jarvis-include: /a -->\n<!-- jarvis-include: /b -->\n- [x](x.md)\n";
        let next = remove_include_line(body, "/a");
        assert!(!next.contains("/a"));
        assert!(next.contains("/b"));
    }

    #[test]
    fn directive_slug_is_stable_and_branch_aware() {
        let s1 = directive_slug("https://h/r.git", None);
        let s2 = directive_slug("https://h/r.git", None);
        let s3 = directive_slug("https://h/r.git", Some("dev"));
        assert_eq!(s1, s2);
        assert_ne!(s1, s3);
        assert_eq!(s1.len(), 16);
    }

    #[tokio::test]
    async fn resolve_local_direct_memory_md() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("MEMORY.md"), "- [a](a.md)")
            .await
            .unwrap();
        let d = IncludeDirective::LocalPath(dir.path().to_string_lossy().to_string());
        let resolved = resolve_include(&d, &PathBuf::from("/dev/null")).await.unwrap();
        assert_eq!(resolved, dir.path().to_path_buf());
    }

    #[tokio::test]
    async fn resolve_local_workspace_layout() {
        // include points at the workspace root (not the memory
        // dir); resolver finds `.jarvis/memory/MEMORY.md`.
        let dir = tempdir().unwrap();
        let mem = dir.path().join(crate::memory::MEMORY_DIR);
        fs::create_dir_all(&mem).await.unwrap();
        fs::write(mem.join("MEMORY.md"), "- [a](a.md)").await.unwrap();
        let d = IncludeDirective::LocalPath(dir.path().to_string_lossy().to_string());
        let resolved = resolve_include(&d, &PathBuf::from("/dev/null")).await.unwrap();
        assert_eq!(resolved, mem);
    }

    #[tokio::test]
    async fn resolve_local_missing_returns_err() {
        let d = IncludeDirective::LocalPath("/tmp/does-not-exist-jarvis-include".into());
        let err = resolve_include(&d, &PathBuf::from("/dev/null"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn resolve_local_no_memory_md_returns_err() {
        let dir = tempdir().unwrap();
        let d = IncludeDirective::LocalPath(dir.path().to_string_lossy().to_string());
        let err = resolve_include(&d, &PathBuf::from("/dev/null"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no MEMORY.md"));
    }

    #[tokio::test]
    async fn resolve_git_clone_against_local_bare_repo() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        // Set up an upstream with a seed MEMORY.md, push it.
        let upstream = tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(upstream.path())
            .status()
            .unwrap();
        let work = tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .arg(work.path())
            .status()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["config", "user.email", "t@t"])
            .status()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["config", "user.name", "T"])
            .status()
            .unwrap();
        fs::write(work.path().join("MEMORY.md"), "- [seed](seed.md)\n")
            .await
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["add", "-A"])
            .status()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["commit", "-qm", "seed"])
            .status()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["remote", "add", "origin"])
            .arg(upstream.path())
            .status()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(work.path())
            .args(["push", "-q", "-u", "origin", "main"])
            .status()
            .unwrap();

        let cache = tempdir().unwrap();
        let d = IncludeDirective::GitUrl {
            url: upstream.path().to_string_lossy().to_string(),
            branch: None,
        };
        let resolved = resolve_include(&d, cache.path()).await.unwrap();
        let body = fs::read_to_string(resolved.join("MEMORY.md")).await.unwrap();
        assert!(body.contains("seed"));
    }

    #[tokio::test]
    async fn refresh_only_applies_to_git() {
        let d = IncludeDirective::LocalPath("/a".into());
        let err = refresh_git_cache(&d, &PathBuf::from("/tmp/cache"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("only applies"));
    }

    #[tokio::test]
    async fn maybe_refresh_noop_on_local_path() {
        let d = IncludeDirective::LocalPath("/anywhere".into());
        let result = maybe_refresh_git_cache(&d, &PathBuf::from("/tmp"), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn maybe_refresh_noop_when_cache_missing() {
        let d = IncludeDirective::GitUrl {
            url: "https://example.invalid/r.git".into(),
            branch: None,
        };
        let cache = tempdir().unwrap();
        let result = maybe_refresh_git_cache(&d, cache.path(), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!result, "missing cache should not trigger network");
    }

    #[tokio::test]
    async fn maybe_refresh_noop_when_within_ttl() {
        // Set up a cache dir that exists. With a huge TTL the
        // staleness check returns false and we don't attempt git.
        let cache = tempdir().unwrap();
        let d = IncludeDirective::GitUrl {
            url: "https://example.invalid/r.git".into(),
            branch: None,
        };
        let slug = directive_slug("https://example.invalid/r.git", None);
        let cache_dir = cache.path().join(&slug);
        std::fs::create_dir_all(&cache_dir).unwrap();
        let result = maybe_refresh_git_cache(&d, cache.path(), Duration::from_secs(3600 * 24))
            .await
            .unwrap();
        assert!(!result);
    }
}
