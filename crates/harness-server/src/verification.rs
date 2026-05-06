//! Verification command executor — runs the [`VerificationPlan`]
//! shell commands sandboxed under the workspace root and captures
//! the result into a [`VerificationResult`].
//!
//! Phase 4 (closes the Phase 3.5 loop). The verification UI in the
//! kanban-card "Runs" drawer already renders `VerificationResult`s;
//! this module is what turns "the user clicks Run verification" into
//! "actually shell out, capture, aggregate, and broadcast".
//!
//! ## What this does
//!
//! - Runs each `command` in [`VerificationPlan::commands`] via
//!   `sh -c <command>` (or `cmd /C` on Windows) inside `workspace`.
//! - Captures stdout/stderr separately, truncated at 16 KiB each
//!   (matches the `CommandResult` shape and the `shell.exec` budget).
//! - Captures exit_code (`None` for timeouts / kill-on-drop).
//! - Captures wall-clock duration.
//! - Aggregates: status = `Failed` if **any** command exits non-zero,
//!   else `Passed`. Empty plan ⇒ `Passed`.
//!
//! ## What this does NOT do (deliberately, v0)
//!
//! - No approval gate. The caller already opted in by hitting the
//!   `/verify` endpoint — that's the consent moment. (Phase 4.5 may
//!   add a pre-execution approval prompt for production deployments.)
//! - No `git diff --stat` capture — `require_diff` is recognised on
//!   the type but not yet acted on. The caller can still POST a
//!   manually-computed `diff_summary` via the existing
//!   `set_run_verification` endpoint if they want one.
//! - No streaming — the executor blocks until the full plan
//!   completes. Matching the WS bridge's "frame on Done" pattern,
//!   the `Verified` frame fires once at the end.

use std::path::Path;
use std::time::{Duration, Instant};

use harness_core::{CommandResult, VerificationPlan, VerificationResult, VerificationStatus};
use tokio::process::Command;

/// Per-command output cap. Mirrors `harness_tools::shell::SHELL_OUTPUT_CAP`
/// so the bytes the user sees here match what they'd see invoking
/// `shell.exec` directly.
const OUTPUT_CAP_BYTES: usize = 16 * 1024;

/// Default per-command timeout when the plan doesn't specify one.
/// Matches `JARVIS_SHELL_TIMEOUT_MS`'s 30-second baseline. Keeping
/// the same number means a verification command that times out here
/// would also have timed out via `shell.exec` — there's no
/// surprising "looks fine in shell.exec but not in verify" case.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Execute every command in `plan` against `workspace`. Returns a
/// fully-populated [`VerificationResult`] with one `command_results`
/// entry per command in plan order.
pub async fn execute_plan(
    workspace: &Path,
    plan: &VerificationPlan,
    timeout_ms: u64,
) -> VerificationResult {
    let timeout_ms = if timeout_ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        timeout_ms
    };
    let mut command_results = Vec::with_capacity(plan.commands.len());
    let mut any_failed = false;
    let mut any_timeout = false;

    for cmd in &plan.commands {
        let result = run_one(workspace, cmd, timeout_ms).await;
        if result.exit_code.is_none() {
            any_timeout = true;
        } else if result.exit_code != Some(0) {
            any_failed = true;
        }
        command_results.push(result);
    }

    let status = if plan.commands.is_empty() {
        // Empty plan with no gates is a pass — caller asked for
        // "verify everything" with nothing to verify, so by
        // construction nothing failed.
        VerificationStatus::Passed
    } else if any_failed || any_timeout {
        VerificationStatus::Failed
    } else if plan.require_human_review {
        VerificationStatus::NeedsReview
    } else {
        VerificationStatus::Passed
    };

    VerificationResult {
        status,
        command_results,
        diff_summary: None,
        notes: None,
    }
}

async fn run_one(workspace: &Path, command: &str, timeout_ms: u64) -> CommandResult {
    let started = Instant::now();
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(workspace);
    cmd.kill_on_drop(true);

    let spawn = cmd.output();
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), spawn).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(output)) => CommandResult {
            command: command.to_string(),
            exit_code: output.status.code(),
            stdout: truncate(&output.stdout),
            stderr: truncate(&output.stderr),
            duration_ms: elapsed_ms,
        },
        Ok(Err(e)) => CommandResult {
            command: command.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: format!("verification: spawn failed: {e}"),
            duration_ms: elapsed_ms,
        },
        Err(_) => CommandResult {
            command: command.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: format!("verification: timed out after {timeout_ms}ms"),
            duration_ms: elapsed_ms,
        },
    }
}

fn truncate(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    if s.len() <= OUTPUT_CAP_BYTES {
        s.into_owned()
    } else {
        // Cut on a char boundary to avoid mid-codepoint splits.
        let mut end = OUTPUT_CAP_BYTES;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        let mut out = String::with_capacity(end + 32);
        out.push_str(&s[..end]);
        out.push_str("\n[... truncated ...]");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(commands: &[&str]) -> VerificationPlan {
        VerificationPlan {
            commands: commands.iter().map(|s| s.to_string()).collect(),
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        }
    }

    #[tokio::test]
    async fn empty_plan_passes() {
        let dir = std::env::temp_dir();
        let res = execute_plan(&dir, &plan(&[]), 5_000).await;
        assert_eq!(res.status, VerificationStatus::Passed);
        assert!(res.command_results.is_empty());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn all_zero_exits_pass() {
        let dir = std::env::temp_dir();
        let res = execute_plan(&dir, &plan(&["true", "echo hello"]), 5_000).await;
        assert_eq!(res.status, VerificationStatus::Passed, "got {res:?}");
        assert_eq!(res.command_results.len(), 2);
        assert_eq!(res.command_results[0].exit_code, Some(0));
        assert_eq!(res.command_results[1].exit_code, Some(0));
        assert!(res.command_results[1].stdout.contains("hello"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn any_nonzero_fails() {
        let dir = std::env::temp_dir();
        let res = execute_plan(&dir, &plan(&["true", "false"]), 5_000).await;
        assert_eq!(res.status, VerificationStatus::Failed);
        assert_eq!(res.command_results[1].exit_code, Some(1));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn timeout_marks_failed_with_no_exit_code() {
        let dir = std::env::temp_dir();
        let res = execute_plan(&dir, &plan(&["sleep 5"]), 200).await;
        assert_eq!(res.status, VerificationStatus::Failed);
        assert_eq!(res.command_results[0].exit_code, None);
        assert!(res.command_results[0].stderr.contains("timed out"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn require_human_review_downgrades_pass_to_needs_review() {
        let dir = std::env::temp_dir();
        let mut p = plan(&["true"]);
        p.require_human_review = true;
        let res = execute_plan(&dir, &p, 5_000).await;
        assert_eq!(res.status, VerificationStatus::NeedsReview);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn workspace_cwd_is_honored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "ok").unwrap();
        let res = execute_plan(dir.path(), &plan(&["cat marker.txt"]), 5_000).await;
        assert_eq!(res.status, VerificationStatus::Passed);
        assert!(res.command_results[0].stdout.contains("ok"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn stdout_truncation_marker_present_when_oversize() {
        let dir = std::env::temp_dir();
        // Print 32 KiB of `a` so we go past the 16 KiB cap.
        let res = execute_plan(&dir, &plan(&["yes a | head -c 32768"]), 5_000).await;
        assert_eq!(res.command_results[0].exit_code, Some(0));
        assert!(res.command_results[0]
            .stdout
            .contains("[... truncated ...]"));
    }
}
