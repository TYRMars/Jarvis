//! Workspace diff endpoints — power the right-rail "review changes"
//! card and the future Create-PR flow.
//!
//! Two endpoints, both keyed off `AppState::workspace_root`:
//!
//! - `GET /v1/workspace/diff?base=<branch>` — small JSON: branch
//!   names, ahead/behind counts, aggregate +/- stat, per-file
//!   numstat + name-status. **No diff hunks** — those belong to the
//!   per-file endpoint so a 50k-line diff doesn't blow the initial
//!   payload.
//!
//! - `GET /v1/workspace/diff/file?base=<branch>&path=<rel>` —
//!   unified diff for one file, fetched lazily when the user
//!   expands a row. Path is sandboxed to the workspace root the
//!   same way the `git.*` tools do.
//!
//! Both endpoints shell out to `git -C <root> ...` with the same
//! `kill_on_drop` / timeout discipline as `routes::probe_git`. We
//! don't try to share code with `harness-tools::git` because that
//! crate's `run_git` is private and the policies (truncation cap,
//! arg validation) differ slightly from what the UI needs here.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::state::AppState;

/// Default base branch when the client doesn't pin one. Most of our
/// codebases use `main`; a future enhancement could probe
/// `git symbolic-ref refs/remotes/origin/HEAD` but it's not worth
/// the round-trip in v1.
const DEFAULT_BASE: &str = "main";

/// Hard cap on a single per-file diff. 1 MiB is comfortably enough
/// for any reasonable refactor; pathological cases (generated
/// `Cargo.lock` deltas, vendored bundles) get truncated with a
/// trailing sentinel so the UI can render *something*.
const MAX_FILE_DIFF_BYTES: usize = 1024 * 1024;

/// Cap on `git` invocation wall time. Diff stat for a typical PR is
/// well under a second; the cap is a safety net against a
/// pathological repository state.
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/workspace/diff", get(get_workspace_diff))
        .route("/v1/workspace/diff/file", get(get_workspace_diff_file))
        .route("/v1/workspace/commit", post(post_workspace_commit))
        .route("/v1/workspace/pr/preview", get(get_pr_preview))
        .route("/v1/workspace/pr", post(post_create_pr))
}

/// Wall-clock cap on a `git push` / `gh pr create`. These touch the
/// network so they need a more generous budget than read-only `git`
/// invocations.
const NET_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct DiffQuery {
    /// Base branch to diff against (defaults to `main`). Validated
    /// for safe characters before reaching `git`.
    base: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileDiffQuery {
    base: Option<String>,
    path: String,
}

#[derive(Debug, Serialize)]
struct DiffStat {
    added: u64,
    removed: u64,
    files: u64,
}

#[derive(Debug, Serialize)]
struct FileEntry {
    path: String,
    /// Single-letter `git diff --name-status` code: `M` modified,
    /// `A` added, `D` deleted, `R` renamed (we strip the score),
    /// `C` copied, `T` type-changed. `?` for untracked (only
    /// surfaces in the `uncommitted` block; tracked diff vs. base
    /// never produces `?`).
    status: String,
    added: u64,
    removed: u64,
    /// For a rename, the original path (`R`-status only). Lets the
    /// UI render `old → new`.
    #[serde(skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
}

/// Reject anything that could break out of `git -C <root> ...`. The
/// shell tool's `check_safe_arg` does this for the model; we do the
/// same here for HTTP query params.
fn safe_branch(name: &str) -> Result<&str, &'static str> {
    if name.is_empty() {
        return Err("branch name must not be empty");
    }
    if name.starts_with('-') {
        return Err("branch name must not start with `-`");
    }
    if name.contains(['\0', '\n', ' ', '\t', ';', '&', '|', '`', '$']) {
        return Err("branch name contains forbidden characters");
    }
    Ok(name)
}

/// Reject path traversal / absolute paths the same way `fs.*` tools
/// do via `sandbox::resolve_under`. We don't actually open the file
/// here (`git` does) but we still want to make sure
/// `../../etc/passwd` can't smuggle through.
fn safe_relative_path(path: &str) -> Result<&str, &'static str> {
    if path.is_empty() {
        return Err("path must not be empty");
    }
    if path.starts_with('/') {
        return Err("path must be relative to the workspace root");
    }
    if path.starts_with('-') {
        return Err("path must not start with `-`");
    }
    if path.contains(['\0', '\n']) {
        return Err("path contains forbidden characters");
    }
    for component in path.split('/') {
        if component == ".." {
            return Err("path must not contain `..`");
        }
    }
    Ok(path)
}

#[allow(clippy::result_large_err)]
fn require_workspace(state: &AppState) -> Result<&PathBuf, Response> {
    state.workspace_root.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspace root not configured" })),
        )
            .into_response()
    })
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn server_error(msg: impl std::fmt::Display) -> Response {
    tracing::warn!(error = %msg, "workspace diff failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": msg.to_string() })),
    )
        .into_response()
}

/// Run `git -C <root> <args...>` capturing stdout. Returns
/// `Ok(stdout)` on a clean exit; `Err(stderr)` otherwise. Times out
/// after `GIT_TIMEOUT` and kills the child on drop so a flaky `git`
/// can't hang the request.
async fn run_git(root: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let fut = async {
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(if stderr.is_empty() {
                format!("git exited with status {}", out.status)
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };
    match tokio::time::timeout(GIT_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(format!("git timed out after {:?}", GIT_TIMEOUT)),
    }
}

/// Best-effort: if the requested base doesn't exist (yet, or is
/// the wrong shape), the caller falls back to a "no base" response
/// instead of 500ing. This makes fresh repos / detached-HEAD CI
/// boxes degrade gracefully.
async fn base_exists(root: &std::path::Path, base: &str) -> bool {
    run_git(root, &["rev-parse", "--verify", &format!("{base}^{{commit}}")])
        .await
        .is_ok()
}

// ----------------------------------------------------------------------
// GET /v1/workspace/diff
// ----------------------------------------------------------------------

async fn get_workspace_diff(
    State(state): State<AppState>,
    Query(q): Query<DiffQuery>,
) -> Response {
    let root = match require_workspace(&state) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let base = q.base.as_deref().unwrap_or(DEFAULT_BASE);
    let base = match safe_branch(base) {
        Ok(b) => b,
        Err(e) => return bad_request(e),
    };

    // Branch + dirty probe — same shape `GET /v1/workspace` exposes
    // so the client can render a header without a second request.
    let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let head = run_git(root, &["rev-parse", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if !base_exists(root, base).await {
        // Fresh repo or no `main` ref — return a meaningful response
        // instead of 500. Client can fall back to working-tree diff.
        return Json(json!({
            "branch": branch,
            "base": base,
            "base_exists": false,
            "head": head,
            "ahead": 0,
            "behind": 0,
            "stat": { "added": 0, "removed": 0, "files": 0 },
            "files": [],
            "uncommitted": uncommitted_summary(root).await,
        }))
        .into_response();
    }

    // ahead/behind counts via `rev-list --left-right --count`
    let (ahead, behind) = match run_git(
        root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...HEAD"),
        ],
    )
    .await
    {
        Ok(s) => parse_left_right(&s),
        Err(_) => (0, 0),
    };

    // Per-file numstat: "<added>\t<removed>\t<path>". Binary diffs
    // come back as "-\t-\t<path>" — we surface them with 0/0 stats.
    let numstat_raw = match run_git(root, &["diff", "--numstat", &format!("{base}...HEAD")]).await
    {
        Ok(s) => s,
        Err(e) => return server_error(e),
    };
    let mut files = parse_numstat(&numstat_raw);

    // Per-file name-status to fill in `M` / `A` / `D` / `R...`.
    // Missing-on-error is non-fatal — we keep the numstat-derived
    // default of `M` and skip the rename detail.
    let name_status = run_git(
        root,
        &["diff", "--name-status", &format!("{base}...HEAD")],
    )
    .await
    .unwrap_or_default();
    apply_name_status(&mut files, &name_status);

    let stat = aggregate_stat(&files);

    Json(json!({
        "branch": branch,
        "base": base,
        "base_exists": true,
        "head": head,
        "ahead": ahead,
        "behind": behind,
        "stat": stat,
        "files": files,
        "uncommitted": uncommitted_summary(root).await,
    }))
    .into_response()
}

fn parse_left_right(s: &str) -> (u64, u64) {
    let mut parts = s.split_whitespace();
    let behind = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    // `--left-right` with `<base>...HEAD` reports `<left>\t<right>`
    // where left = base-only commits (behind), right = HEAD-only
    // commits (ahead).
    (ahead, behind)
}

fn parse_numstat(raw: &str) -> Vec<FileEntry> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("0");
        let removed = parts.next().unwrap_or("0");
        let path = parts.next().unwrap_or("").trim();
        if path.is_empty() {
            continue;
        }
        // `-\t-\t<path>` for binary diffs.
        let added: u64 = if added == "-" { 0 } else { added.parse().unwrap_or(0) };
        let removed: u64 = if removed == "-" { 0 } else { removed.parse().unwrap_or(0) };

        // Renames in numstat come as `old => new` or with brace
        // expansion `dir/{old => new}`. Normalise to the new path
        // so the file rows match what `name-status` reports.
        let path = normalise_renamed_path(path);

        out.push(FileEntry {
            path,
            status: "M".to_string(),
            added,
            removed,
            old_path: None,
        });
    }
    out
}

fn normalise_renamed_path(raw: &str) -> String {
    // `dir/{old => new}` -> `dir/new`
    if let (Some(open), Some(close)) = (raw.find('{'), raw.find('}')) {
        if open < close {
            if let Some(arrow) = raw[open..close].find(" => ") {
                let prefix = &raw[..open];
                let new_part = &raw[open + arrow + 4..close];
                let suffix = &raw[close + 1..];
                return format!("{prefix}{new_part}{suffix}");
            }
        }
    }
    // Plain `old => new` (no brace).
    if let Some(arrow) = raw.find(" => ") {
        return raw[arrow + 4..].to_string();
    }
    raw.to_string()
}

fn apply_name_status(files: &mut [FileEntry], name_status: &str) {
    use std::collections::HashMap;
    let mut by_path: HashMap<String, (String, Option<String>)> = HashMap::new();
    for line in name_status.lines() {
        let mut parts = line.split('\t');
        let raw_status = parts.next().unwrap_or("");
        if raw_status.is_empty() {
            continue;
        }
        // `R100\told\tnew` for renames; `M\tpath` for everything else.
        let kind = raw_status.chars().next().unwrap_or('?').to_string();
        if kind == "R" || kind == "C" {
            let old = parts.next().unwrap_or("").trim().to_string();
            let new = parts.next().unwrap_or("").trim().to_string();
            if !new.is_empty() {
                by_path.insert(new, (kind, Some(old)));
            }
        } else {
            let p = parts.next().unwrap_or("").trim().to_string();
            if !p.is_empty() {
                by_path.insert(p, (kind, None));
            }
        }
    }
    for f in files.iter_mut() {
        if let Some((status, old)) = by_path.remove(&f.path) {
            f.status = status;
            f.old_path = old;
        }
    }
}

fn aggregate_stat(files: &[FileEntry]) -> Value {
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    for f in files {
        added = added.saturating_add(f.added);
        removed = removed.saturating_add(f.removed);
    }
    json!(DiffStat {
        added,
        removed,
        files: files.len() as u64,
    })
}

/// Working-tree diff summary (HEAD vs. unstaged + staged). Always
/// best-effort — failures degrade to empty.
async fn uncommitted_summary(root: &std::path::Path) -> Value {
    let raw = match run_git(root, &["diff", "--numstat", "HEAD"]).await {
        Ok(s) => s,
        Err(_) => return json!({ "added": 0, "removed": 0, "files": 0 }),
    };
    let mut added: u64 = 0;
    let mut removed: u64 = 0;
    let mut files: u64 = 0;
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let a = parts.next().unwrap_or("0");
        let r = parts.next().unwrap_or("0");
        let p = parts.next().unwrap_or("").trim();
        if p.is_empty() {
            continue;
        }
        added = added.saturating_add(if a == "-" { 0 } else { a.parse().unwrap_or(0) });
        removed = removed.saturating_add(if r == "-" { 0 } else { r.parse().unwrap_or(0) });
        files += 1;
    }
    json!({ "added": added, "removed": removed, "files": files })
}

// ----------------------------------------------------------------------
// GET /v1/workspace/diff/file
// ----------------------------------------------------------------------

async fn get_workspace_diff_file(
    State(state): State<AppState>,
    Query(q): Query<FileDiffQuery>,
) -> Response {
    let root = match require_workspace(&state) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let base = q.base.as_deref().unwrap_or(DEFAULT_BASE);
    let base = match safe_branch(base) {
        Ok(b) => b,
        Err(e) => return bad_request(e),
    };
    let path = match safe_relative_path(&q.path) {
        Ok(p) => p,
        Err(e) => return bad_request(e),
    };

    // `--` separator stops `git` from interpreting the path as a
    // revspec even if it shadows a branch name.
    let mut diff = match run_git(
        root,
        &["diff", &format!("{base}...HEAD"), "--", path],
    )
    .await
    {
        Ok(s) => s,
        Err(e) => return server_error(e),
    };
    if diff.len() > MAX_FILE_DIFF_BYTES {
        // Truncate at a line boundary if possible so the diffy /
        // unified-diff renderer doesn't choke on a half-hunk.
        let cut = diff[..MAX_FILE_DIFF_BYTES]
            .rfind('\n')
            .unwrap_or(MAX_FILE_DIFF_BYTES);
        diff.truncate(cut);
        diff.push_str("\n[... diff truncated; open the file directly to see the rest ...]\n");
    }
    Json(json!({
        "base": base,
        "path": path,
        "diff": diff,
    }))
    .into_response()
}

// ----------------------------------------------------------------------
// POST /v1/workspace/commit
// ----------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CommitBody {
    /// Full commit message. Subject + optional `\n\n` body. Required.
    message: String,
    /// Whether to `git push` the branch to its tracked remote after
    /// committing. Optional — defaults to false. The UI surfaces a
    /// checkbox so the user explicitly opts in to a network action.
    #[serde(default)]
    push: bool,
}

async fn post_workspace_commit(
    State(state): State<AppState>,
    Json(body): Json<CommitBody>,
) -> Response {
    let root = match require_workspace(&state) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let message = body.message.trim();
    if message.is_empty() {
        return bad_request("commit message must not be empty");
    }
    // Reject NUL bytes — `git commit -m` would refuse anyway, but
    // failing fast here gives a cleaner error than the git stderr.
    if message.contains('\0') {
        return bad_request("commit message must not contain NUL bytes");
    }

    // Sanity check: are we even in a git repo?
    if run_git(root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .ok()
        .map(|s| s.trim() != "true")
        .unwrap_or(true)
    {
        return bad_request("workspace root is not a git repository");
    }

    // Stage everything tracked + untracked. Matches the UI's "all
    // working-tree changes go in this commit" expectation.
    if let Err(e) = run_git(root, &["add", "-A"]).await {
        return server_error(format!("git add -A: {e}"));
    }

    // Verify there's actually something staged so we don't make an
    // empty commit. `git diff --cached --quiet` exits 1 when the
    // staging area differs from HEAD — i.e. there IS something to
    // commit. We invert because `run_git` treats non-zero as Err.
    let nothing_staged = run_git(root, &["diff", "--cached", "--quiet"])
        .await
        .is_ok();
    if nothing_staged {
        return bad_request("nothing to commit (working tree matches HEAD)");
    }

    // Commit. `-m` plus an arg passes the message through argv,
    // so shell metachars in the message (`;`, `$()`, backticks,
    // newlines) cannot escape into a shell — we never invoke a
    // shell here.
    if let Err(e) = run_git(root, &["commit", "-m", message]).await {
        return server_error(format!("git commit failed: {e}"));
    }

    // Capture the new HEAD for the response so the UI can show it.
    let head = run_git(root, &["rev-parse", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut pushed = false;
    let mut push_error: Option<String> = None;
    if body.push {
        // Need the current branch name to push it.
        let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD");
        match branch {
            Some(b) => {
                // `-u` sets upstream tracking on first push so a future
                // `git push` works without an arg. Generous net timeout.
                match run_git_with_timeout(root, &["push", "-u", "origin", &b], NET_TIMEOUT).await {
                    Ok(_) => pushed = true,
                    Err(e) => push_error = Some(e),
                }
            }
            None => {
                push_error = Some("HEAD is detached; cannot push".into());
            }
        }
    }

    tracing::info!(
        head = head.as_deref().unwrap_or("?"),
        push = body.push,
        pushed,
        "workspace commit"
    );

    Json(json!({
        "ok": true,
        "head": head,
        "pushed": pushed,
        "push_error": push_error,
    }))
    .into_response()
}

// ----------------------------------------------------------------------
// GET /v1/workspace/pr/preview
// ----------------------------------------------------------------------

async fn get_pr_preview(
    State(state): State<AppState>,
    Query(q): Query<DiffQuery>,
) -> Response {
    let root = match require_workspace(&state) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let base = q.base.as_deref().unwrap_or(DEFAULT_BASE);
    let base = match safe_branch(base) {
        Ok(b) => b,
        Err(e) => return bad_request(e),
    };

    let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");

    let gh_available = gh_check().await.is_ok();

    // Title default: if branch has exactly one commit on top of base,
    // use that commit's subject. Otherwise fall back to a humanised
    // version of the branch name (`feat/jarvis-sidebar` → `feat: jarvis sidebar`).
    let suggested_title = best_pr_title(root, base, branch.as_deref()).await;

    // Body default: bullet list of commits in chronological order.
    let suggested_body = best_pr_body(root, base).await;

    Json(json!({
        "branch": branch,
        "base": base,
        "gh_available": gh_available,
        "suggested_title": suggested_title,
        "suggested_body": suggested_body,
    }))
    .into_response()
}

async fn best_pr_title(
    root: &std::path::Path,
    base: &str,
    branch: Option<&str>,
) -> String {
    // 1. Single commit on the branch → use its subject verbatim.
    if let Ok(out) = run_git(
        root,
        &[
            "log",
            "--pretty=format:%s",
            &format!("{base}..HEAD"),
        ],
    )
    .await
    {
        let subjects: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        if subjects.len() == 1 {
            return subjects[0].to_string();
        }
        if subjects.len() > 1 {
            // Use the most recent (top) commit subject as the title;
            // the body will list all of them.
            if let Some(first) = subjects.first() {
                return first.to_string();
            }
        }
    }
    // 2. Fallback: humanised branch name.
    branch
        .map(|b| {
            let trimmed = b
                .trim_start_matches("feat/")
                .trim_start_matches("fix/")
                .trim_start_matches("chore/")
                .trim_start_matches("refactor/")
                .trim_start_matches("docs/");
            trimmed.replace(['-', '_'], " ")
        })
        .unwrap_or_else(|| "Update".to_string())
}

async fn best_pr_body(root: &std::path::Path, base: &str) -> String {
    if let Ok(out) = run_git(
        root,
        &[
            "log",
            "--reverse",
            "--pretty=format:- %s",
            &format!("{base}..HEAD"),
        ],
    )
    .await
    {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            return format!("## Commits\n\n{trimmed}\n");
        }
    }
    String::new()
}

async fn gh_check() -> Result<(), String> {
    let mut cmd = Command::new("gh");
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(3), cmd.status()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("gh exited with status {status}")),
        Ok(Err(e)) => Err(format!("gh not on PATH: {e}")),
        Err(_) => Err("gh check timed out".into()),
    }
}

// ----------------------------------------------------------------------
// POST /v1/workspace/pr
// ----------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreatePrBody {
    title: String,
    #[serde(default)]
    body: String,
    /// Override base branch for the PR (defaults to the same one
    /// the diff endpoint defaulted to).
    #[serde(default)]
    base: Option<String>,
    /// Open as a draft PR. Defaults to true — that's the safer
    /// default since drafts don't trigger CODEOWNERS notifications.
    #[serde(default = "default_true")]
    draft: bool,
    /// Push the branch first if `gh` reports it doesn't exist on
    /// the remote. Defaults to true — a fresh branch is the most
    /// common case and the "missing remote" failure mode is
    /// confusing if we don't auto-handle it.
    #[serde(default = "default_true")]
    push: bool,
}

fn default_true() -> bool {
    true
}

async fn post_create_pr(
    State(state): State<AppState>,
    Json(body): Json<CreatePrBody>,
) -> Response {
    let root = match require_workspace(&state) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let title = body.title.trim();
    if title.is_empty() {
        return bad_request("PR title must not be empty");
    }
    if title.contains('\0') || body.body.contains('\0') {
        return bad_request("title / body must not contain NUL bytes");
    }
    let base = body.base.as_deref().unwrap_or(DEFAULT_BASE);
    let base = match safe_branch(base) {
        Ok(b) => b,
        Err(e) => return bad_request(e),
    };

    if let Err(e) = gh_check().await {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("gh CLI not available: {e}"),
                "hint": "install gh from https://cli.github.com and run `gh auth login`",
            })),
        )
            .into_response();
    }

    // Sanity check: are we in a git repo?
    if run_git(root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .ok()
        .map(|s| s.trim() != "true")
        .unwrap_or(true)
    {
        return bad_request("workspace root is not a git repository");
    }

    // Push the branch first when requested. `gh pr create` will
    // also try to push, but doing it here gives a clearer error
    // message when push fails (auth issue, no remote, etc.).
    if body.push {
        let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD");
        if let Some(b) = branch {
            if let Err(e) =
                run_git_with_timeout(root, &["push", "-u", "origin", &b], NET_TIMEOUT).await
            {
                return server_error(format!("git push failed: {e}"));
            }
        }
    }

    let mut argv: Vec<&str> = vec!["pr", "create", "--base", base, "--title", title];
    if !body.body.is_empty() {
        argv.push("--body");
        argv.push(&body.body);
    } else {
        // `gh` insists on either --body or --fill / --body-file.
        // Pass an explicit empty body so it doesn't open $EDITOR
        // (which would hang the request).
        argv.push("--body");
        argv.push("");
    }
    if body.draft {
        argv.push("--draft");
    }

    let pr_url = match run_gh_with_timeout(root, &argv, NET_TIMEOUT).await {
        Ok(out) => out
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("https://"))
            .map(str::to_string)
            .unwrap_or_else(|| out.trim().to_string()),
        Err(e) => return server_error(format!("gh pr create: {e}")),
    };

    tracing::info!(url = %pr_url, draft = body.draft, "PR created");
    Json(json!({
        "ok": true,
        "url": pr_url,
        "draft": body.draft,
    }))
    .into_response()
}

/// Long-form `run_git` that takes a custom timeout. Used for
/// commands that touch the network (`push`).
async fn run_git_with_timeout(
    root: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let fut = async {
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(if stderr.is_empty() {
                format!("git exited with status {}", out.status)
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(format!("git timed out after {:?}", timeout)),
    }
}

async fn run_gh_with_timeout(
    root: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    // `gh` reads the repo from `cwd`, not from a `-C` flag like git.
    cmd.current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let fut = async {
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("spawn gh: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(if stderr.is_empty() {
                format!("gh exited with status {}", out.status)
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(format!("gh timed out after {:?}", timeout)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_numstat_handles_binary() {
        let raw = "10\t5\tsrc/foo.rs\n-\t-\tassets/logo.png\n";
        let files = parse_numstat(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/foo.rs");
        assert_eq!(files[0].added, 10);
        assert_eq!(files[0].removed, 5);
        assert_eq!(files[1].path, "assets/logo.png");
        assert_eq!(files[1].added, 0);
        assert_eq!(files[1].removed, 0);
    }

    #[test]
    fn parse_numstat_handles_brace_rename() {
        let raw = "5\t3\tcrates/{old_name => new_name}/src/lib.rs\n";
        let files = parse_numstat(raw);
        assert_eq!(files[0].path, "crates/new_name/src/lib.rs");
    }

    #[test]
    fn parse_numstat_handles_plain_rename() {
        let raw = "5\t3\told_name => new_name\n";
        let files = parse_numstat(raw);
        assert_eq!(files[0].path, "new_name");
    }

    #[test]
    fn parse_left_right_correct_order() {
        // `git rev-list --left-right --count <base>...HEAD` outputs
        // "<left-only>\t<right-only>" — i.e. behind \t ahead.
        assert_eq!(parse_left_right("3\t12"), (12, 3));
    }

    #[test]
    fn apply_name_status_overrides_default_letter() {
        let mut files = vec![
            FileEntry {
                path: "a.rs".into(),
                status: "M".into(),
                added: 0,
                removed: 0,
                old_path: None,
            },
            FileEntry {
                path: "new.rs".into(),
                status: "M".into(),
                added: 0,
                removed: 0,
                old_path: None,
            },
        ];
        let raw = "A\ta.rs\nR100\told.rs\tnew.rs\n";
        apply_name_status(&mut files, raw);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].old_path, None);
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].old_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn safe_branch_rejects_dangerous_chars() {
        assert!(safe_branch("main").is_ok());
        assert!(safe_branch("feat/foo").is_ok());
        assert!(safe_branch("").is_err());
        assert!(safe_branch("--upload-pack=evil").is_err());
        assert!(safe_branch("main; rm -rf /").is_err());
        assert!(safe_branch("main\nnewline").is_err());
    }

    #[test]
    fn safe_relative_path_blocks_traversal() {
        assert!(safe_relative_path("src/foo.rs").is_ok());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("../etc/passwd").is_err());
        assert!(safe_relative_path("src/../../../etc").is_err());
        assert!(safe_relative_path("--upload-pack=evil").is_err());
        assert!(safe_relative_path("").is_err());
    }
}
