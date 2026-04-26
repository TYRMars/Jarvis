//! Path-sandbox helpers shared by the `fs.*` and `shell.exec` tools. Every
//! tool that takes a path argument from the model resolves it through
//! [`resolve_under`] so absolute paths and `..` components are rejected
//! before the path ever reaches the OS.

use std::path::{Component, Path, PathBuf};

use harness_core::BoxError;

/// Join `rel` onto `root`, rejecting absolute paths and any `..` components.
/// Returns `BoxError` so callers can surface it via the tool error path.
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
    Ok(root.join(p))
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
}
