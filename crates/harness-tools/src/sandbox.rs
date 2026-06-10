//! Path-sandbox helpers shared by the `fs.*` and `shell.exec` tools. Every
//! tool that takes a path argument from the model resolves it through
//! [`resolve_under`] so absolute paths and `..` components are rejected
//! before the path ever reaches the OS.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use harness_core::BoxError;

/// Join `rel` onto `root`, rejecting absolute paths and any `..` components,
/// then canonicalize the result and verify it still lives under `root`. The
/// second step matters because the lexical checks only inspect the textual
/// path — a symlink that lives *inside* `root` but points outside it would
/// otherwise be followed transparently, escaping the sandbox (the read-side
/// tools `fs.read` / `fs.list` / `code.grep` are not approval-gated, so this
/// would be a no-prompt host-file read). Returns `BoxError` so callers can
/// surface it via the tool error path.
pub(crate) fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, BoxError> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("path must be relative to the tool root".into());
    }
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                return Err("`..` components are not allowed".into());
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("absolute path components are not allowed".into());
            }
            _ => {}
        }
    }
    let candidate = root.join(p);

    // Resolve symlinks on both sides before comparing. The target may not
    // exist yet (e.g. `fs.write` creating a new file), so canonicalize the
    // longest existing prefix and re-append the not-yet-created tail — those
    // trailing components don't exist on disk and therefore can't be symlinks.
    let canonical_root = canonicalize_existing_prefix(root);
    let resolved = canonicalize_existing_prefix(&candidate);
    if !resolved.starts_with(&canonical_root) {
        return Err("path escapes the tool root via a symlink".into());
    }

    Ok(candidate)
}

/// Canonicalize the longest existing ancestor of `path` (resolving any
/// symlinks along the way) and re-append the trailing components that don't
/// exist yet. Falls back to the lexical path when nothing canonicalizes.
fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let mut tail: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(canonical) = cur.canonicalize() {
            let mut result = canonical;
            for name in tail.iter().rev() {
                result.push(name);
            }
            return result;
        }
        let Some(name) = cur.file_name().map(|n| n.to_os_string()) else {
            return path.to_path_buf();
        };
        tail.push(name);
        if !cur.pop() {
            return path.to_path_buf();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_dir() {
        let root = Path::new("/tmp/doesnt-matter");
        assert!(resolve_under(root, "../etc/passwd").is_err());
        assert!(resolve_under(root, "a/../../b").is_err());
    }

    #[test]
    fn rejects_absolute() {
        let root = Path::new("/tmp/doesnt-matter");
        assert!(resolve_under(root, "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative() {
        let root = Path::new("/tmp/root");
        let p = resolve_under(root, "a/b.txt").unwrap();
        assert_eq!(p, Path::new("/tmp/root/a/b.txt"));
    }

    #[test]
    fn accepts_real_nested_path_under_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/file.txt"), b"hi").unwrap();
        let resolved = resolve_under(dir.path(), "sub/file.txt").unwrap();
        assert_eq!(resolved, dir.path().join("sub/file.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_inside_root_pointing_outside() {
        // A symlink that lives inside the sandbox root but targets a directory
        // outside it must not be followed — otherwise `fs.read`/`code.grep`
        // (ungated) could read arbitrary host files.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"top secret").unwrap();

        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();

        // Reading through the symlink to an existing file must be rejected.
        assert!(resolve_under(root.path(), "link/secret.txt").is_err());
        // So must a not-yet-existing path beyond the symlink.
        assert!(resolve_under(root.path(), "link/new.txt").is_err());
        // And the symlink directory itself.
        assert!(resolve_under(root.path(), "link").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_symlink_inside_root_pointing_inside() {
        // A symlink that stays within the root is fine.
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("real")).unwrap();
        std::fs::write(root.path().join("real/file.txt"), b"ok").unwrap();
        std::os::unix::fs::symlink(root.path().join("real"), root.path().join("link")).unwrap();

        assert!(resolve_under(root.path(), "link/file.txt").is_ok());
    }
}
