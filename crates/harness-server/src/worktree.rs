//! Per-run git worktree helper.
//!
//! Phase 5. When `JARVIS_WORKTREE_MODE=per_run` and the workspace
//! is a git repo, [`crate::requirements_routes::start_run`] mints
//! a fresh worktree at `<worktree_root>/<run_id>` and stamps the
//! path onto the run. Any subsequent `/verify` invocation routes
//! its `sh -c <cmd>` cwd through that worktree instead of the
//! main checkout — so a verification command that mutates files
//! / commits / installs deps can't trash the user's working tree.
//!
//! v0 only supports the `per_run` mode (one worktree per
//! `RequirementRun`, lives until the run is deleted via
//! `/v1/runs/:id/worktree`). The `per_unit` mode (one worktree
//! per requirement, reused across runs) is a Phase 5b concern.
//!
//! ## Why shell out to `git`?
//!
//! We already do this for `git.status` / `git.diff` etc. in
//! `harness-tools::git`. Adding a libgit2/gix dependency just
//! for `git worktree add` is heavy for the value. The downside
//! is parsing `git worktree list --porcelain` for the orphan
//! detector (Phase 5b) — manageable.
//!
//! ## Safety
//!
//! - `create_worktree` refuses if the main checkout is dirty
//!   (`require_clean = true`). The default is true; set
//!   `JARVIS_WORKTREE_ALLOW_DIRTY=1` (handled in the caller) to
//!   flip it. Refusing to create a worktree off a dirty checkout
//!   matches the proposal's "create blocks the run" rule.
//! - `remove_worktree` only ever deletes paths inside
//!   `worktree_root`; an absolute path outside that scope is
//!   rejected. This stops a malicious / buggy run from passing
//!   `/Users/me` and having `git worktree remove --force` wipe it.

use std::path::{Path, PathBuf};

use tokio::process::Command;

/// Mode for the worktree subsystem. Mirrors
/// `JARVIS_WORKTREE_MODE`. Defaults to [`Off`](Self::Off) to
/// preserve historical behaviour (runs share the main checkout).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WorktreeMode {
    /// No worktree minting. Runs live in the main workspace
    /// checkout, same as Phases 3.5 / 4.
    #[default]
    Off,
    /// Mint a fresh worktree per [`RequirementRun`]
    /// (`<worktree_root>/<run_id>`). The path is stored on
    /// `RequirementRun.worktree_path`; verification commands route
    /// their cwd through it.
    PerRun,
}

impl WorktreeMode {
    /// Parse the env-var wire form. Returns `Off` for unknown /
    /// missing values so the binary's startup never fails on
    /// `JARVIS_WORKTREE_MODE=garbage` — the operator gets a
    /// `tracing::warn!` from the caller instead.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "off" | "" => Self::Off,
            "per_run" => Self::PerRun,
            _ => return None,
        })
    }
}

/// Outcome of a `git worktree add` attempt. Either `Created` with
/// the absolute worktree path, or `Refused` with a human-readable
/// reason (used by `start_run` to log + continue without a
/// worktree, not as a hard error).
#[derive(Debug, Clone)]
pub enum WorktreeOutcome {
    Created(PathBuf),
    Refused(String),
}

/// Cheap probe: is `path` inside a git repo?
pub async fn is_git_repo(path: &Path) -> bool {
    matches!(
        Command::new("git")
            .args(["-C"])
            .arg(path)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .await,
        Ok(out) if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true"
    )
}

/// `true` when `git status --porcelain` is empty (no staged,
/// unstaged, or untracked changes). Used as the safety gate for
/// `create_worktree` — minting a worktree off a dirty main
/// checkout would silently bring those uncommitted edits into
/// the new tree, which is surprising.
pub async fn is_clean_checkout(path: &Path) -> bool {
    let Ok(out) = Command::new("git")
        .args(["-C"])
        .arg(path)
        .args(["status", "--porcelain"])
        .output()
        .await
    else {
        return false;
    };
    out.status.success() && out.stdout.is_empty()
}

/// Mint a worktree at `<worktree_root>/<run_id>` from `repo`'s
/// HEAD.
///
/// - Creates `worktree_root` if it doesn't exist.
/// - Refuses if `repo` isn't a git repo, or if `require_clean`
///   is set and the checkout is dirty.
/// - Refuses (Refused) if a worktree already exists at the
///   target path — caller can either reuse or pick a new id.
///
/// Returns the absolute path on success; the caller stamps it
/// onto `RequirementRun.worktree_path`.
pub async fn create_worktree(
    repo: &Path,
    worktree_root: &Path,
    run_id: &str,
    require_clean: bool,
) -> WorktreeOutcome {
    if !is_git_repo(repo).await {
        return WorktreeOutcome::Refused(format!(
            "workspace `{}` is not a git repo",
            repo.display()
        ));
    }
    if require_clean && !is_clean_checkout(repo).await {
        return WorktreeOutcome::Refused(format!(
            "workspace `{}` has uncommitted changes; commit/stash or set \
             JARVIS_WORKTREE_ALLOW_DIRTY=1 to override",
            repo.display()
        ));
    }
    if let Err(e) = tokio::fs::create_dir_all(worktree_root).await {
        return WorktreeOutcome::Refused(format!(
            "failed to create worktree root `{}`: {e}",
            worktree_root.display()
        ));
    }
    let target = worktree_root.join(run_id);
    if target.exists() {
        return WorktreeOutcome::Refused(format!(
            "worktree path already exists: `{}`",
            target.display()
        ));
    }
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo)
        .args(["worktree", "add", "--detach"])
        .arg(&target)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => WorktreeOutcome::Created(target),
        Ok(o) => WorktreeOutcome::Refused(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => WorktreeOutcome::Refused(format!("git worktree add: spawn failed: {e}")),
    }
}

/// Mint a worktree at `target` checked out to `branch`.
///
/// Differs from [`create_worktree`] in three ways:
/// 1. Caller picks the absolute target path (not `<root>/<run_id>`),
///    so the HTTP layer can derive a human-readable folder name from
///    the branch (e.g. `<root>/<branch-slug>-<short-id>`).
/// 2. The new tree is checked out to `branch`, not detached at HEAD —
///    matches the user's "use this branch" intent.
/// 3. The clean check is opt-out (`require_clean=false` lets the
///    caller bypass it; the auto-loop scheduler should keep its
///    safety gate by passing `true`, but interactive
///    `POST /v1/projects/:id/workspaces/switch` defaults to `false`
///    because dirty work in the source tree doesn't follow the branch).
///
/// The parent of `target` is created if missing. Refuses if `target`
/// already exists (caller picks a fresh suffix and retries) or if
/// `repo` isn't a git repo. The branch must already exist locally;
/// new branches are out of scope for the chip popover.
pub async fn create_worktree_for_branch(
    repo: &Path,
    target: &Path,
    branch: &str,
    require_clean: bool,
) -> WorktreeOutcome {
    if !is_git_repo(repo).await {
        return WorktreeOutcome::Refused(format!(
            "workspace `{}` is not a git repo",
            repo.display()
        ));
    }
    if require_clean && !is_clean_checkout(repo).await {
        return WorktreeOutcome::Refused(format!(
            "workspace `{}` has uncommitted changes",
            repo.display()
        ));
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return WorktreeOutcome::Refused(format!(
                "failed to create worktree parent `{}`: {e}",
                parent.display()
            ));
        }
    }
    if target.exists() {
        return WorktreeOutcome::Refused(format!(
            "worktree path already exists: `{}`",
            target.display()
        ));
    }
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo)
        .args(["worktree", "add"])
        .arg(target)
        .arg(branch)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => WorktreeOutcome::Created(target.to_path_buf()),
        Ok(o) => WorktreeOutcome::Refused(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => WorktreeOutcome::Refused(format!("git worktree add: spawn failed: {e}")),
    }
}

/// Remove a worktree at `path`. Only paths *inside*
/// `worktree_root` are permitted — anything else is an error.
/// Forces removal (`--force`) so a worktree that has accumulated
/// build artifacts / untracked files can still be cleaned up.
pub async fn remove_worktree(
    repo: &Path,
    worktree_root: &Path,
    path: &Path,
) -> Result<(), String> {
    let canon_root = match worktree_root.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("worktree root canonicalize: {e}")),
    };
    let canon_target = match path.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("worktree path canonicalize: {e}")),
    };
    if !canon_target.starts_with(&canon_root) {
        return Err(format!(
            "refused: worktree `{}` is outside root `{}`",
            canon_target.display(),
            canon_root.display()
        ));
    }
    let out = Command::new("git")
        .args(["-C"])
        .arg(repo)
        .args(["worktree", "remove", "--force"])
        .arg(&canon_target)
        .output()
        .await
        .map_err(|e| format!("git worktree remove: spawn: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Init a fresh git repo in a temp dir and commit one file so
    /// HEAD exists (a worktree off a repo with no commits errors).
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
        for args in [
            vec!["add", "."],
            vec!["commit", "-m", "seed"],
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
    }

    #[test]
    fn parse_wire_modes() {
        assert_eq!(WorktreeMode::from_wire(""), Some(WorktreeMode::Off));
        assert_eq!(WorktreeMode::from_wire("off"), Some(WorktreeMode::Off));
        assert_eq!(WorktreeMode::from_wire("per_run"), Some(WorktreeMode::PerRun));
        assert_eq!(WorktreeMode::from_wire("nonsense"), None);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn is_git_repo_detects_repo_vs_plain_dir() {
        let plain = tempfile::tempdir().unwrap();
        assert!(!is_git_repo(plain.path()).await);

        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        assert!(is_git_repo(repo.path()).await);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_happy_path() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let wt_root = tempfile::tempdir().unwrap();

        let outcome = create_worktree(repo.path(), wt_root.path(), "run-abc", true).await;
        match outcome {
            WorktreeOutcome::Created(p) => {
                assert!(p.exists());
                assert!(p.join("seed.txt").exists(), "worktree should have seed file");
            }
            WorktreeOutcome::Refused(r) => panic!("expected Created, got Refused: {r}"),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_refuses_dirty_when_required() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("dirty.txt"), "uncommitted").unwrap();
        let wt_root = tempfile::tempdir().unwrap();

        match create_worktree(repo.path(), wt_root.path(), "run-x", true).await {
            WorktreeOutcome::Refused(reason) => {
                assert!(reason.contains("uncommitted"));
            }
            WorktreeOutcome::Created(_) => panic!("dirty checkout should have been refused"),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_succeeds_dirty_when_override_used() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        std::fs::write(repo.path().join("dirty.txt"), "uncommitted").unwrap();
        let wt_root = tempfile::tempdir().unwrap();

        match create_worktree(repo.path(), wt_root.path(), "run-x", false).await {
            WorktreeOutcome::Created(_) => {}
            WorktreeOutcome::Refused(r) => panic!("override should have allowed dirty: {r}"),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_then_remove_round_trip() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let wt_root = tempfile::tempdir().unwrap();

        let target = match create_worktree(repo.path(), wt_root.path(), "run-r", true).await {
            WorktreeOutcome::Created(p) => p,
            WorktreeOutcome::Refused(r) => panic!("{r}"),
        };
        remove_worktree(repo.path(), wt_root.path(), &target)
            .await
            .unwrap();
        assert!(!target.exists());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn remove_worktree_refuses_outside_root() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let wt_root = tempfile::tempdir().unwrap();
        let escapee = tempfile::tempdir().unwrap();

        let err = remove_worktree(repo.path(), wt_root.path(), escapee.path())
            .await
            .unwrap_err();
        assert!(err.contains("outside root"), "got: {err}");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_refuses_existing_target() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let wt_root = tempfile::tempdir().unwrap();
        match create_worktree(repo.path(), wt_root.path(), "dup", true).await {
            WorktreeOutcome::Created(_) => {}
            WorktreeOutcome::Refused(r) => panic!("{r}"),
        }
        match create_worktree(repo.path(), wt_root.path(), "dup", true).await {
            WorktreeOutcome::Refused(reason) => {
                assert!(reason.contains("already exists"));
            }
            WorktreeOutcome::Created(_) => panic!("second create should be refused"),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_for_branch_checks_out_named_branch() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        // Create a second branch off the seed commit.
        let out = Command::new("git")
            .args(["-C"])
            .arg(repo.path())
            .args(["branch", "feature-x"])
            .output()
            .await
            .unwrap();
        assert!(out.status.success());

        let wt_root = tempfile::tempdir().unwrap();
        let target = wt_root.path().join("feature-x-abcd1234");
        let outcome = create_worktree_for_branch(repo.path(), &target, "feature-x", false).await;
        match outcome {
            WorktreeOutcome::Created(p) => {
                assert_eq!(p, target);
                assert!(p.join("seed.txt").exists());
                // Confirm the new tree is on `feature-x`, not detached.
                let head = Command::new("git")
                    .args(["-C"])
                    .arg(&p)
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .output()
                    .await
                    .unwrap();
                let branch = String::from_utf8_lossy(&head.stdout).trim().to_string();
                assert_eq!(branch, "feature-x");
            }
            WorktreeOutcome::Refused(r) => panic!("{r}"),
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn create_worktree_for_branch_refuses_existing_target() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path()).await;
        let wt_root = tempfile::tempdir().unwrap();
        let target = wt_root.path().join("dup");
        std::fs::create_dir_all(&target).unwrap();
        match create_worktree_for_branch(repo.path(), &target, "main", false).await {
            WorktreeOutcome::Refused(r) => assert!(r.contains("already exists")),
            WorktreeOutcome::Created(_) => panic!("existing target should be refused"),
        }
    }

    #[tokio::test]
    async fn create_worktree_refuses_non_git_workspace() {
        let plain = tempfile::tempdir().unwrap();
        let wt_root = tempfile::tempdir().unwrap();
        match create_worktree(plain.path(), wt_root.path(), "x", true).await {
            WorktreeOutcome::Refused(reason) => {
                assert!(reason.contains("not a git repo"));
            }
            WorktreeOutcome::Created(_) => panic!("non-git should be refused"),
        }
    }
}
