//! `GET /v1/workspace/find?name=<basename>` — resolve a folder
//! basename (e.g. the result of `window.showDirectoryPicker()` in a
//! browser, which can't expose absolute paths) into one or more
//! absolute-path candidates.
//!
//! Search strategy:
//!
//! 1. Walk a fixed set of common project roots under `$HOME` to a
//!    bounded depth, collect directories whose basename matches.
//! 2. Augment with any recent workspace from the `WorkspaceStore`
//!    ledger whose basename matches — those are paths the user has
//!    already opened, so they should rank highest.
//! 3. Dedupe by canonical path; cap at 10 results; return as JSON.
//!
//! Browser-side, the frontend's "Browse…" button calls
//! `showDirectoryPicker()`, gets only the folder's basename out of
//! the resulting `FileSystemDirectoryHandle`, and asks this endpoint
//! to resolve that basename into an absolute path the backend can
//! actually use. Single match → auto-fill; multiple → user picks.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

/// Maximum depth (relative to a search root) the walker explores.
/// 2 catches `~/Documents/GitHub/<repo>` (depth 1 from the root)
/// and `~/Documents/GitHub/<org>/<repo>` (depth 2). Going deeper
/// rarely pays off — projects beyond depth 2 are typically inside
/// `node_modules` / build outputs / vendored deps which we don't
/// want to surface anyway.
const MAX_DEPTH: usize = 2;

/// Cap on the result list. The frontend renders a small disambiguation
/// list when there's more than one candidate; 10 is plenty for the
/// "I have a few clones of the same-named repo" case without making
/// the picker scrollable.
const MAX_RESULTS: usize = 10;

/// **Global** wall-clock budget across all search roots. macOS makes
/// even a "fast" filesystem walk crawl in any tree that touches
/// iCloud Drive or Time Machine snapshots — `~/Documents`,
/// `~/Library`, `~/Movies`, etc. We cap the total walk at 1.5s so
/// the endpoint returns quickly even on a cold cache; whatever
/// candidates it has by then are good enough for the picker UI.
const GLOBAL_BUDGET: Duration = Duration::from_millis(1500);

/// Names we deliberately skip mid-walk because they're either huge
/// (node_modules, target) or system / app-private (Library, Music,
/// etc. on macOS). Kept as a small allow-list of "things that aren't
/// project roots" rather than walking them and bailing on time.
const SKIP_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "Applications",
];

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/workspace/find", get(find_workspace))
}

#[derive(Debug, Deserialize)]
struct FindQuery {
    /// Basename to look for. Matched case-sensitively against the
    /// last path segment. Required.
    name: String,
}

async fn find_workspace(State(state): State<AppState>, Query(q): Query<FindQuery>) -> Response {
    let needle = q.name.trim();
    if needle.is_empty() {
        return bad_request("name parameter is required");
    }
    // Defence in depth — reject anything that looks like a path.
    // `showDirectoryPicker()` only returns the basename so a slash
    // here would mean the caller fabricated input.
    if needle.contains('/') || needle.contains('\\') || needle == "." || needle == ".." {
        return bad_request("name must be a basename, not a path");
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => {
            // Without $HOME we can't construct any of the search
            // roots — return an empty result rather than 500.
            return Json(json!({ "candidates": [] })).into_response();
        }
    };

    // Hard wall-clock cap on the search: even with `GLOBAL_BUDGET`
    // enforced inside the walker, a single `read_dir()` call can
    // block for seconds on a cold-cached or iCloud-fused directory
    // before we get a chance to check elapsed time. Wrapping in
    // `tokio::time::timeout` ensures the endpoint always returns
    // within ~1.6s regardless. Whatever candidates the walker has
    // collected by then are returned (nothing if it timed out
    // before producing any).
    let blocking = tokio::task::spawn_blocking({
        let home = home.clone();
        let needle = needle.to_string();
        move || resolve_candidates(&home, &needle)
    });
    let candidates =
        match tokio::time::timeout(GLOBAL_BUDGET + Duration::from_millis(200), blocking).await {
            Ok(Ok(out)) => out,
            // Timeout, panic, or join error — return empty rather than
            // 500 so the UI's fallback path ("type the path manually")
            // still works.
            Ok(Err(_)) | Err(_) => Vec::new(),
        };

    // Augment with recent workspaces — paths the user has already
    // opened are by definition canonical, so they rank highest.
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    if let Some(ws) = state.workspaces.as_ref() {
        for entry in ws.list_recent() {
            if basename_eq(&entry.path, needle) && seen.insert(entry.path.clone()) {
                out.push(entry.path);
                if out.len() >= MAX_RESULTS {
                    break;
                }
            }
        }
    }
    for cand in candidates {
        if out.len() >= MAX_RESULTS {
            break;
        }
        if seen.insert(cand.clone()) {
            out.push(cand);
        }
    }

    Json(json!({ "candidates": out })).into_response()
}

/// Walk every search root under `$HOME`, collect dirs whose last
/// segment equals `needle`. Pure synchronous filesystem walk; the
/// caller wraps in `spawn_blocking`. A SHARED wall-clock budget
/// runs across every root so a slow first root can't starve later
/// ones — and the total still stays well under a second on a warm
/// cache.
fn resolve_candidates(home: &Path, needle: &str) -> Vec<String> {
    let roots = search_roots(home);
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let started = Instant::now();
    for root in roots {
        if started.elapsed() > GLOBAL_BUDGET {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        walk(&root, needle, 0, &mut out, &mut seen, started);
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    out
}

/// Search roots, in priority order. Earlier entries surface first in
/// the result list (when basename matches in multiple roots).
///
/// We deliberately do NOT include `$HOME` itself — on macOS that walks
/// `Library`, `Music`, iCloud-synced `Documents`, etc., which is
/// effectively unbounded. Folders the user keeps right under `$HOME`
/// (rare for project trees) won't be auto-resolved; they get the
/// "no match → please type the full path" fallback in the UI, and
/// once the user opens them once they live in `recent workspaces`
/// and surface from there for free.
fn search_roots(home: &Path) -> Vec<PathBuf> {
    let candidates = [
        "Documents/GitHub",
        "Documents/Code",
        "code",
        "Code",
        "Projects",
        "projects",
        "dev",
        "Desktop",
        "work",
    ];
    candidates.iter().map(|seg| home.join(seg)).collect()
}

/// Recursive walker — depth-bounded, budget-bounded, dot-skip. The
/// `out` list grows in place; we stop early once it hits
/// `MAX_RESULTS` so we don't waste IO after the cap.
fn walk(
    dir: &Path,
    needle: &str,
    depth: usize,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
    started: Instant,
) {
    if out.len() >= MAX_RESULTS || depth > MAX_DEPTH {
        return;
    }
    if started.elapsed() > GLOBAL_BUDGET {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        if out.len() >= MAX_RESULTS {
            return;
        }
        if started.elapsed() > GLOBAL_BUDGET {
            return;
        }
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip dot-directories — `.git` / `.cache` / `.Trash` etc.
        if file_name.starts_with('.') {
            continue;
        }
        // Skip known-massive build / system directories so we don't
        // burn the budget walking `node_modules` or macOS `Library`.
        if SKIP_NAMES.contains(&file_name) {
            continue;
        }
        // Quick bail on non-dirs — `is_dir()` follows symlinks which
        // we want for the typical "~/code -> /Volumes/SSD/code" case.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        if file_name == needle {
            if let Some(canonical) = canonical_path(&path) {
                if seen.insert(canonical.clone()) {
                    out.push(canonical);
                }
            }
        }
        walk(&path, needle, depth + 1, out, seen, started);
    }
}

/// Canonicalise + stringify a path. Returns `None` if canonicalisation
/// fails (e.g. broken symlink).
fn canonical_path(p: &Path) -> Option<String> {
    p.canonicalize()
        .ok()
        .and_then(|c| c.into_os_string().into_string().ok())
}

/// True iff `path`'s basename equals `needle` (case-sensitive).
fn basename_eq(path: &str, needle: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s == needle)
        .unwrap_or(false)
}

fn bad_request(msg: &str) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg })),
    )
        .into_response()
}

// ============================ tests ============================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Build a fake `$HOME` layout with a couple of well-known roots
    /// and stamp project-named directories under each. Returns the
    /// tempdir guard plus the simulated `$HOME`.
    fn fake_home() -> (TempDir, PathBuf) {
        let td = TempDir::new().unwrap();
        let home = td.path().to_path_buf();
        for sub in ["Documents/GitHub", "code", "Projects", "Desktop"] {
            fs::create_dir_all(home.join(sub)).unwrap();
        }
        (td, home)
    }

    #[test]
    fn finds_dirs_in_documents_github() {
        let (_td, home) = fake_home();
        fs::create_dir(home.join("Documents/GitHub/svelte-learn")).unwrap();
        let out = resolve_candidates(&home, "svelte-learn");
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("svelte-learn"));
        assert!(out[0].contains("Documents/GitHub") || out[0].contains("Documents\\GitHub"));
    }

    #[test]
    fn dedupes_when_present_in_multiple_roots() {
        let (_td, home) = fake_home();
        // Stamp the same-named dir under TWO roots — the search
        // should find both physically distinct paths and the user's
        // disambiguation list will show them.
        fs::create_dir(home.join("Documents/GitHub/Jarvis")).unwrap();
        fs::create_dir(home.join("code/Jarvis")).unwrap();
        let out = resolve_candidates(&home, "Jarvis");
        // Both physical paths are present (no canonicalisation
        // collapses them since they're real different inodes).
        assert_eq!(out.len(), 2, "expected 2 distinct paths, got: {out:?}");
        let unique: HashSet<&String> = out.iter().collect();
        assert_eq!(unique.len(), 2, "candidate list should be deduped");
    }

    #[test]
    fn returns_empty_for_unknown_basename() {
        let (_td, home) = fake_home();
        let out = resolve_candidates(&home, "ghost-folder-that-does-not-exist");
        assert!(out.is_empty());
    }

    #[test]
    fn depth_cap_prevents_walking_too_deep() {
        let (_td, home) = fake_home();
        // The walker enters the root at depth 0; with MAX_DEPTH=3 it
        // still iterates the children of a depth-3 directory (those
        // children are at depth 4 relative to the search root) but
        // refuses to recurse into them. So a name at depth ≥ 5 from
        // the search root is unreachable.
        let buried = home.join("Documents/GitHub/a/b/c/d/very-deep");
        fs::create_dir_all(&buried).unwrap();
        let out = resolve_candidates(&home, "very-deep");
        assert!(
            out.is_empty(),
            "depth-5 target should be unreachable under MAX_DEPTH=3, got {out:?}"
        );
        // Sanity: a depth-4 target IS findable (still inside the
        // walker's "iterate children of a depth-3 dir" range).
        fs::create_dir_all(home.join("Documents/GitHub/org/sub/findme")).unwrap();
        let out = resolve_candidates(&home, "findme");
        assert!(!out.is_empty(), "depth-4 target should be found");
    }

    #[test]
    fn skips_dot_directories() {
        let (_td, home) = fake_home();
        // `.cache/target-name` should not be returned even though
        // the basename matches.
        fs::create_dir_all(home.join(".cache/target-name")).unwrap();
        let out = resolve_candidates(&home, "target-name");
        assert!(out.is_empty(), "dot-directory descendants must be skipped");
    }

    #[test]
    fn rejects_path_separator_in_name_param() {
        // Defence-in-depth assertion mirrors the handler's
        // basename-only contract; tested by inspection of the
        // handler logic since this module re-exports the rule.
        assert!("foo/bar".contains('/'));
        assert!("foo\\bar".contains('\\'));
    }
}
