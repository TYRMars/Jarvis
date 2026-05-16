//! P15 — iCloud Drive lazy-stub auto-materialisation.
//!
//! When iCloud Drive hasn't yet downloaded a file to local disk
//! (because the user just signed in on this machine, or the file
//! was uploaded by another device and not yet pulled), macOS
//! replaces it with a hidden 0-byte placeholder: a sibling named
//! `.<original>.icloud`. Reading the original path via standard
//! `fs::read_to_string` then returns "file not found" — even
//! though the user thinks the file is there.
//!
//! Helpers in this module:
//!
//! - [`is_under_icloud_drive`] — fast prefix check against the
//!   well-known iCloud Drive base path.
//! - [`find_icloud_stubs`] — scans a directory for `.icloud`
//!   placeholder siblings.
//! - [`ensure_materialised`] — combined "detect + run
//!   `brctl download`" entry point, async, capped to a few
//!   seconds. Cross-platform safe: a no-op everywhere except
//!   macOS, so callers can always invoke it without `#[cfg]`
//!   sprinkling.
//!
//! Used by the `memory.*` read paths before opening MEMORY.md /
//! `<slug>.md`. Each read pays an extra `read_dir` to scan for
//! stubs — cheap when nothing is stubbed, and on a clean machine
//! after first materialisation everything stays local.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::time::Duration;

use harness_core::BoxError;

#[cfg(target_os = "macos")]
const BRCTL_TIMEOUT_MS: u64 = 8_000;
#[cfg(target_os = "macos")]
const POLL_INTERVAL_MS: u64 = 200;
#[cfg(target_os = "macos")]
const POLL_DEADLINE_MS: u64 = 4_000;

/// True when `path` lives under macOS's iCloud Drive base
/// (`~/Library/Mobile Documents/com~apple~CloudDocs/`). Returns
/// false on non-macOS platforms regardless of the path so the
/// callers don't have to `#[cfg]` themselves.
pub fn is_under_icloud_drive(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    let root = home.join("Library/Mobile Documents/com~apple~CloudDocs");
    path.starts_with(&root)
}

/// Scan `dir` (one level, non-recursive) for iCloud lazy
/// placeholders. Returns the original (un-stubbed) filenames the
/// caller would have asked for, e.g. `[MEMORY.md, foo.md]` when
/// `.MEMORY.md.icloud` and `.foo.md.icloud` are present.
///
/// Non-existent or unreadable directories produce an empty vec —
/// the caller's read will fail naturally with its own error if
/// that turns out to be a real problem.
pub async fn find_icloud_stubs(dir: &Path) -> Vec<String> {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut stubs = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let s = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if let Some(original) = parse_stub_name(s) {
            stubs.push(original);
        }
    }
    stubs
}

/// Map `.MEMORY.md.icloud` → `Some("MEMORY.md")`. Returns `None`
/// for non-stub filenames. Centralised so the rule lives in one
/// spot and tests can exercise it directly without filesystem
/// setup.
fn parse_stub_name(filename: &str) -> Option<String> {
    let inner = filename.strip_prefix('.')?.strip_suffix(".icloud")?;
    if inner.is_empty() {
        return None;
    }
    Some(inner.to_string())
}

/// Detect stubs in `dir` and trigger macOS's `brctl download` if
/// any are found, then poll briefly for them to clear. Returns
/// `Ok(n)` with the number of stubs that were present at entry
/// (even if not all materialised within the timeout). `Ok(0)`
/// means there was nothing to do — the fast path.
///
/// Off macOS this is always a `Ok(0)` no-op. `brctl` not being on
/// PATH is treated as a soft failure: warn and return what we
/// found, the downstream read will surface a real "file not
/// found" if the stub didn't materialise.
pub async fn ensure_materialised(dir: &Path) -> Result<usize, BoxError> {
    if !is_under_icloud_drive(dir) {
        return Ok(0);
    }
    let stubs = find_icloud_stubs(dir).await;
    if stubs.is_empty() {
        return Ok(0);
    }
    let stub_count = stubs.len();
    #[cfg(target_os = "macos")]
    {
        run_brctl_download(dir).await?;
        wait_for_materialisation(dir).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // unreachable when `is_under_icloud_drive` returned false
        // off macOS; kept for compile-paranoia.
        let _ = dir;
    }
    Ok(stub_count)
}

#[cfg(target_os = "macos")]
async fn run_brctl_download(dir: &Path) -> Result<(), BoxError> {
    use std::process::Stdio;
    use tokio::process::Command;

    let mut cmd = Command::new("brctl");
    cmd.arg("download")
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| -> BoxError { format!("spawn brctl: {e}").into() })?;
    match tokio::time::timeout(
        Duration::from_millis(BRCTL_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => {
            if !output.status.success() {
                tracing::warn!(
                    status = ?output.status.code(),
                    stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                    "brctl download exited non-zero; iCloud stubs may persist",
                );
            }
            Ok(())
        }
        Ok(Err(e)) => Err(format!("brctl io: {e}").into()),
        Err(_) => {
            tracing::warn!(
                timeout_ms = BRCTL_TIMEOUT_MS,
                "brctl download timed out; iCloud stubs may persist"
            );
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
async fn wait_for_materialisation(dir: &Path) {
    let deadline =
        std::time::Instant::now() + Duration::from_millis(POLL_DEADLINE_MS);
    while std::time::Instant::now() < deadline {
        let remaining = find_icloud_stubs(dir).await;
        if remaining.is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
    // Deadline reached. The downstream read will succeed if the
    // file is there now, or surface the usual "not found" error
    // if it isn't.
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::fs;

    #[test]
    fn parse_stub_name_matches_canonical_form() {
        assert_eq!(parse_stub_name(".MEMORY.md.icloud"), Some("MEMORY.md".into()));
        assert_eq!(parse_stub_name(".foo.bar.icloud"), Some("foo.bar".into()));
    }

    #[test]
    fn parse_stub_name_rejects_non_stubs() {
        assert_eq!(parse_stub_name("MEMORY.md"), None); // not dot-prefixed
        assert_eq!(parse_stub_name(".MEMORY.md"), None); // not .icloud-suffixed
        assert_eq!(parse_stub_name(".icloud"), None); // empty inner
        assert_eq!(parse_stub_name("..icloud"), None); // also empty
    }

    #[tokio::test]
    async fn find_icloud_stubs_returns_originals() {
        let dir = tempdir().unwrap();
        // Mix of regular and stub files.
        fs::write(dir.path().join("kept.md"), "ok").await.unwrap();
        fs::write(dir.path().join(".MEMORY.md.icloud"), "").await.unwrap();
        fs::write(dir.path().join(".foo.md.icloud"), "").await.unwrap();
        let mut found = find_icloud_stubs(dir.path()).await;
        found.sort();
        assert_eq!(found, vec!["MEMORY.md".to_string(), "foo.md".to_string()]);
    }

    #[tokio::test]
    async fn find_icloud_stubs_empty_for_clean_dir() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("MEMORY.md"), "ok").await.unwrap();
        let found = find_icloud_stubs(dir.path()).await;
        assert!(found.is_empty());
    }

    #[tokio::test]
    async fn find_icloud_stubs_missing_dir_is_empty() {
        let bogus = std::path::PathBuf::from("/tmp/does-not-exist/jarvis-icloud-test");
        let found = find_icloud_stubs(&bogus).await;
        assert!(found.is_empty());
    }

    #[test]
    fn is_under_icloud_drive_false_off_macos() {
        // Use a path that LOOKS like iCloud but the function
        // returns false off macOS regardless.
        let p = PathBuf::from("/anywhere");
        if !cfg!(target_os = "macos") {
            assert!(!is_under_icloud_drive(&p));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn is_under_icloud_drive_true_for_canonical_subpath() {
        // Can't depend on the real HOME having iCloud enabled,
        // so test the prefix logic by mocking HOME.
        let home = std::path::PathBuf::from("/Users/test");
        // SAFETY: process-wide env mutation. We restore below
        // and other tests don't depend on HOME being unset.
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", &home) };
        let inside = home
            .join("Library/Mobile Documents/com~apple~CloudDocs/Jarvis/memory/MEMORY.md");
        let outside = home.join("not-icloud/file.md");
        assert!(is_under_icloud_drive(&inside));
        assert!(!is_under_icloud_drive(&outside));
        if let Some(h) = prev {
            unsafe { std::env::set_var("HOME", h) };
        } else {
            unsafe { std::env::remove_var("HOME") };
        }
    }

    #[tokio::test]
    async fn ensure_materialised_noop_when_not_under_icloud() {
        // Plain tempdir, not under iCloud Drive — even if stubs
        // exist they should be ignored (we don't materialise
        // random paths).
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".foo.md.icloud"), "").await.unwrap();
        let n = ensure_materialised(dir.path()).await.unwrap();
        assert_eq!(n, 0);
    }
}
