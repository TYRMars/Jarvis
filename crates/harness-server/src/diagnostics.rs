//! Phase 5b — read-only diagnostics over the run / worktree state
//! that just shipped in Phases 3.5 / 5.
//!
//! v0 covers one shape only: **orphan worktrees**. A worktree is
//! "orphan" when a directory exists under `worktree_root/<id>` but
//! the matching `RequirementRun` row is not in the store — most
//! often because the run was deleted (or its store row was
//! dropped) without `DELETE /v1/runs/:id/worktree` being called
//! first, leaving the on-disk worktree behind.
//!
//! Future shapes (stuck runs, failed-run digests) need
//! `RequirementRunStore::list_all` which doesn't exist yet —
//! that's a Phase 5c trait extension.

use std::path::{Path, PathBuf};

use harness_core::{RequirementRun, RequirementRunStatus, RequirementRunStore};
use serde::Serialize;

use crate::worktree::remove_worktree;

/// One on-disk worktree directory whose run id has no matching
/// row in the [`RequirementRunStore`].
#[derive(Debug, Clone, Serialize)]
pub struct OrphanWorktree {
    /// Absolute path to the worktree directory.
    pub path: String,
    /// The run id derived from the directory name (basename).
    /// Just a hint — it's whatever the directory is called, which
    /// may not parse as a UUID if someone hand-created a dir
    /// under `worktree_root`.
    pub run_id: String,
    /// Sum of file sizes inside the worktree, in bytes. Helps
    /// the operator decide which orphans to clean up first
    /// (large stale builds, etc.). Best-effort: walking errors
    /// don't fail the listing — they just stop the size walk
    /// for that one directory.
    pub size_bytes: u64,
    /// Modified-time of the directory itself, RFC-3339. Useful
    /// for "anything older than X days" sweeps. Empty string
    /// when the metadata read fails.
    pub modified_at: String,
}

/// Walk every immediate subdirectory of `worktree_root`, probe
/// the matching id against `run_store`, and return the ones with
/// no row.
///
/// Returns an empty list when `worktree_root` doesn't exist
/// (worktree feature was never used) — callers don't need to
/// special-case "no orphans" vs "no feature".
pub async fn find_orphan_worktrees(
    worktree_root: &Path,
    run_store: &dyn RequirementRunStore,
) -> Result<Vec<OrphanWorktree>, std::io::Error> {
    let mut read_dir = match tokio::fs::read_dir(worktree_root).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut orphans = Vec::new();
    while let Some(entry) = read_dir.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let path = entry.path();
        let run_id = entry.file_name().to_string_lossy().into_owned();
        // Probe — if the store has no row for this id, it's an
        // orphan. Errors are treated as "skip and continue" so a
        // flaky DB doesn't make the whole sweep fail; the
        // operator just won't see those orphans this round.
        match run_store.get(&run_id).await {
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(_) => continue,
        }
        let size_bytes = walk_size(&path).await.unwrap_or(0);
        let modified_at = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let datetime: chrono::DateTime<chrono::Utc> = t.into();
                datetime.to_rfc3339()
            })
            .unwrap_or_default();
        orphans.push(OrphanWorktree {
            path: path.display().to_string(),
            run_id,
            size_bytes,
            modified_at,
        });
    }
    // Newest first — operators usually care about the recent ones
    // (might still be debuggable) before the old ones (cleanup
    // candidates).
    orphans.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(orphans)
}

/// Remove every orphan returned by [`find_orphan_worktrees`].
/// Each `git worktree remove --force` runs serially against the
/// main `repo` to avoid two `git` processes racing on
/// `.git/worktrees/`. Per-orphan failures are collected in the
/// returned `errors` list rather than aborting the sweep.
pub async fn remove_orphan_worktrees(
    repo: &Path,
    worktree_root: &Path,
    orphans: &[OrphanWorktree],
) -> CleanupReport {
    let mut removed = 0usize;
    let mut errors: Vec<CleanupError> = Vec::new();
    for o in orphans {
        let path = PathBuf::from(&o.path);
        match remove_worktree(repo, worktree_root, &path).await {
            Ok(()) => removed += 1,
            Err(reason) => errors.push(CleanupError {
                path: o.path.clone(),
                reason,
            }),
        }
    }
    CleanupReport {
        attempted: orphans.len(),
        removed,
        errors,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupReport {
    pub attempted: usize,
    pub removed: usize,
    pub errors: Vec<CleanupError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupError {
    pub path: String,
    pub reason: String,
}

// =====================================================================
// Phase 5c — stuck + recent-failure detectors over RequirementRunStore.
// Both walk the store via `list_all(limit)` (1000-row scan ceiling so a
// runaway store doesn't OOM the request) and filter in-process; the
// alternative — pushing predicates into SQL — would mean teaching every
// backend a new query for a feature that mostly runs once per minute.
// =====================================================================

/// One run that's been "in flight" longer than the operator's
/// patience threshold — most often because the WS that started
/// it disconnected without flipping the row to a terminal status.
/// The shape mirrors `RequirementRun` plus the computed
/// `age_seconds` so the UI doesn't have to do its own clock math.
#[derive(Debug, Clone, Serialize)]
pub struct StuckRun {
    #[serde(flatten)]
    pub run: RequirementRun,
    /// Wall-clock seconds between `started_at` and "now".
    pub age_seconds: i64,
}

/// Find every run whose status is `Pending` or `Running` and
/// whose `started_at` is older than `threshold_seconds`. `limit`
/// caps the upstream `list_all` scan; the caller can paginate by
/// raising it.
pub async fn stuck_runs(
    run_store: &dyn RequirementRunStore,
    threshold_seconds: i64,
    limit: u32,
) -> Result<Vec<StuckRun>, harness_core::BoxError> {
    let now = chrono::Utc::now();
    let rows = run_store.list_all(limit).await?;
    let mut out = Vec::new();
    for r in rows {
        if !matches!(
            r.status,
            RequirementRunStatus::Pending | RequirementRunStatus::Running
        ) {
            continue;
        }
        let Ok(started) = chrono::DateTime::parse_from_rfc3339(&r.started_at) else {
            continue;
        };
        let age = (now - started.with_timezone(&chrono::Utc)).num_seconds();
        if age >= threshold_seconds {
            out.push(StuckRun {
                run: r,
                age_seconds: age,
            });
        }
    }
    // Oldest-first — the longest-stuck rows are the ones that
    // most likely need manual cancellation.
    out.sort_by_key(|s| std::cmp::Reverse(s.age_seconds));
    Ok(out)
}

/// Recent failed runs, newest-first. `limit` caps both the
/// `list_all` scan and the returned slice.
pub async fn recent_failures(
    run_store: &dyn RequirementRunStore,
    limit: u32,
) -> Result<Vec<RequirementRun>, harness_core::BoxError> {
    // Scan a few times the limit so a request for "10 failures"
    // doesn't miss them when interleaved with successful runs.
    // 5x is arbitrary but keeps us well below the per-call cap.
    let scan = limit.saturating_mul(5).max(limit);
    let rows = run_store.list_all(scan).await?;
    let mut failed: Vec<RequirementRun> = rows
        .into_iter()
        .filter(|r| matches!(r.status, RequirementRunStatus::Failed))
        .collect();
    // `list_all` already sorts by started_at desc; for failures
    // we'd actually like to sort by finished_at desc when present
    // (more meaningful "when did it die"), falling back to
    // started_at otherwise.
    failed.sort_by(|a, b| {
        let a_key = a.finished_at.as_deref().unwrap_or(&a.started_at);
        let b_key = b.finished_at.as_deref().unwrap_or(&b.started_at);
        b_key.cmp(a_key)
    });
    failed.truncate(limit as usize);
    Ok(failed)
}

/// Iterative directory walk that sums file sizes. Permission
/// / IO errors at any descendant are swallowed (the size becomes
/// "what we could read"), matching the read-only / best-effort
/// nature of the diagnostics endpoint.
async fn walk_size(root: &Path) -> std::io::Result<u64> {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Some(entry) = rd.next_entry().await.transpose() {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if ft.is_symlink() {
                // Don't follow symlinks — could loop, and the
                // size we'd report wouldn't be "this worktree"'s
                // size anyway.
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata().await {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{RequirementRun, RequirementRunStatus};
    use harness_store::MemoryRequirementRunStore;
    use tokio::process::Command;

    /// Init a fresh git repo so `remove_worktree` calls have a
    /// real `.git` to work against. Same pattern used in
    /// `worktree.rs::tests`.
    async fn init_repo(dir: &Path) {
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "user.name", "test"],
        ] {
            let out = Command::new("git")
                .args(["-C"])
                .arg(dir)
                .args(&args)
                .output()
                .await
                .unwrap();
            assert!(out.status.success(), "git {args:?} failed: {out:?}");
        }
        std::fs::write(dir.join("seed.txt"), "hello").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-m", "seed"]] {
            let out = Command::new("git")
                .args(["-C"])
                .arg(dir)
                .args(&args)
                .output()
                .await
                .unwrap();
            assert!(out.status.success());
        }
    }

    #[tokio::test]
    async fn missing_root_returns_empty() {
        let store = MemoryRequirementRunStore::new();
        let res = find_orphan_worktrees(Path::new("/no/such/dir"), &store)
            .await
            .unwrap();
        assert!(res.is_empty());
    }

    #[tokio::test]
    async fn empty_root_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryRequirementRunStore::new();
        let res = find_orphan_worktrees(dir.path(), &store).await.unwrap();
        assert!(res.is_empty());
    }

    #[tokio::test]
    async fn detects_orphan_when_run_missing() {
        let dir = tempfile::tempdir().unwrap();
        // Plant two dirs: one we'll make a corresponding row for,
        // one we won't.
        std::fs::create_dir(dir.path().join("known-id")).unwrap();
        std::fs::create_dir(dir.path().join("orphan-id")).unwrap();
        std::fs::write(dir.path().join("orphan-id").join("a.txt"), "data").unwrap();

        let store = MemoryRequirementRunStore::new();
        let mut row = RequirementRun::new("req-x", "conv-x");
        row.id = "known-id".into();
        row.status = RequirementRunStatus::Completed;
        store.upsert(&row).await.unwrap();

        let orphans = find_orphan_worktrees(dir.path(), &store).await.unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].run_id, "orphan-id");
        assert_eq!(orphans[0].size_bytes, 4); // "data" = 4 bytes
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cleanup_removes_orphans_and_reports() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;

        // Create a real git worktree (so `git worktree remove`
        // doesn't fail with "not a working tree").
        let wt_root = tempfile::tempdir().unwrap();
        let wt_path = wt_root.path().join("orphan-1");
        let out = Command::new("git")
            .args(["-C"])
            .arg(repo.path())
            .args(["worktree", "add", "--detach"])
            .arg(&wt_path)
            .output()
            .await
            .unwrap();
        assert!(out.status.success());

        let store = MemoryRequirementRunStore::new(); // empty → orphan
        let orphans = find_orphan_worktrees(wt_root.path(), &store).await.unwrap();
        assert_eq!(orphans.len(), 1);

        let report = remove_orphan_worktrees(repo.path(), wt_root.path(), &orphans).await;
        assert_eq!(report.attempted, 1);
        assert_eq!(report.removed, 1);
        assert!(report.errors.is_empty(), "got: {:?}", report.errors);
        assert!(!wt_path.exists());
    }

    // ---- Phase 5c — stuck + recent-failure detectors -----------------

    use harness_core::VerificationResult;

    fn rfc3339_seconds_ago(secs: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339()
    }

    #[tokio::test]
    async fn stuck_runs_filters_by_status_and_age() {
        let store = MemoryRequirementRunStore::new();

        // 1. Old pending — should match.
        let mut old_pending = RequirementRun::new("req-a", "conv-1");
        old_pending.id = "old-pending".into();
        old_pending.started_at = rfc3339_seconds_ago(600);
        store.upsert(&old_pending).await.unwrap();

        // 2. Old running — should match.
        let mut old_running = RequirementRun::new("req-a", "conv-2");
        old_running.id = "old-running".into();
        old_running.status = RequirementRunStatus::Running;
        old_running.started_at = rfc3339_seconds_ago(1200);
        store.upsert(&old_running).await.unwrap();

        // 3. Old completed — should NOT match (terminal).
        let mut old_completed = RequirementRun::new("req-a", "conv-3");
        old_completed.id = "old-completed".into();
        old_completed.started_at = rfc3339_seconds_ago(900);
        old_completed.finish(RequirementRunStatus::Completed);
        store.upsert(&old_completed).await.unwrap();

        // 4. Recent pending — should NOT match (under threshold).
        let mut recent_pending = RequirementRun::new("req-a", "conv-4");
        recent_pending.id = "recent-pending".into();
        recent_pending.started_at = rfc3339_seconds_ago(10);
        store.upsert(&recent_pending).await.unwrap();

        let stuck = stuck_runs(&store, 60, 100).await.unwrap();
        let ids: Vec<&str> = stuck.iter().map(|s| s.run.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        // Sorted oldest-first → 1200s before 600s.
        assert_eq!(ids[0], "old-running");
        assert_eq!(ids[1], "old-pending");
        assert!(stuck[0].age_seconds >= 1200);
    }

    #[tokio::test]
    async fn recent_failures_returns_only_failed_newest_first() {
        let store = MemoryRequirementRunStore::new();

        let mut completed = RequirementRun::new("req-a", "conv-1");
        completed.id = "ok".into();
        completed.started_at = rfc3339_seconds_ago(300);
        completed.finish(RequirementRunStatus::Completed);
        store.upsert(&completed).await.unwrap();

        let mut early_fail = RequirementRun::new("req-a", "conv-2");
        early_fail.id = "early-fail".into();
        early_fail.started_at = rfc3339_seconds_ago(900);
        early_fail.finish(RequirementRunStatus::Failed);
        early_fail.verification = Some(VerificationResult {
            status: harness_core::VerificationStatus::Failed,
            command_results: vec![],
            diff_summary: None,
            notes: None,
        });
        store.upsert(&early_fail).await.unwrap();

        let mut late_fail = RequirementRun::new("req-a", "conv-3");
        late_fail.id = "late-fail".into();
        late_fail.started_at = rfc3339_seconds_ago(60);
        late_fail.finish(RequirementRunStatus::Failed);
        store.upsert(&late_fail).await.unwrap();

        let failed = recent_failures(&store, 10).await.unwrap();
        let ids: Vec<&str> = failed.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["late-fail", "early-fail"]);
    }

    #[tokio::test]
    async fn recent_failures_respects_limit() {
        let store = MemoryRequirementRunStore::new();
        for i in 0..5 {
            let mut r = RequirementRun::new("req", format!("c{i}"));
            r.id = format!("fail-{i}");
            r.started_at = rfc3339_seconds_ago((100 + i * 10) as i64);
            r.finish(RequirementRunStatus::Failed);
            store.upsert(&r).await.unwrap();
        }
        let failed = recent_failures(&store, 2).await.unwrap();
        assert_eq!(failed.len(), 2);
    }

    #[tokio::test]
    async fn skips_files_only_walks_dirs() {
        let dir = tempfile::tempdir().unwrap();
        // A loose file at the root shouldn't be considered an
        // orphan — only directories named after run ids count.
        std::fs::write(dir.path().join("stray.txt"), "hi").unwrap();
        let store = MemoryRequirementRunStore::new();
        let res = find_orphan_worktrees(dir.path(), &store).await.unwrap();
        assert!(res.is_empty());
    }
}
