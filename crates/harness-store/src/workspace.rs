//! Workspace registry — recent folder list + convo↔workspace map.
//!
//! Two collections share one JSON file at
//! `<config-dir>/workspaces.json`:
//!
//! - `recent: Vec<WorkspaceEntry>` — paths the user has pinned at
//!   least once, with the most recent first. Drives the chat-header
//!   workspace dropdown ("Recent" section in the screenshot).
//! - `by_conversation: HashMap<convo_id, path>` — which workspace
//!   each persisted conversation was started in. Restored on
//!   Resume so a session always re-attaches to the folder it began
//!   in, even if the user has since pinned a different one.
//!
//! The whole file is rewritten on every mutation (atomic
//! temp-file + rename, same pattern as the plugin ledger). Keeps
//! the implementation simple; we don't expect more than a few
//! hundred entries even on heavy users.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use harness_core::error::BoxError;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// Default cap on how many recent paths we keep. Anything pruned
/// past this drops from the dropdown but stays usable via free
/// input — recent is convenience, not authority.
const MAX_RECENT: usize = 24;

/// One entry in the recent-workspaces list. `name` is the basename
/// at the time of recording so the dropdown can show "Jarvis"
/// instead of the full path; we re-derive on every touch in case
/// the user moved the folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    /// RFC-3339 timestamp; newest entries sort first.
    pub last_used_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkspacesFile {
    #[serde(default)]
    recent: Vec<WorkspaceEntry>,
    #[serde(default)]
    by_conversation: BTreeMap<String, String>,
}

/// File-backed workspaces registry.
///
/// All public methods are infallible at the API surface — disk
/// errors are logged via `tracing::warn` and the in-memory state
/// is preserved. A misbehaving disk degrades to "the dropdown
/// resets across restarts", never to a panic.
pub struct WorkspaceStore {
    path: Option<PathBuf>,
    state: RwLock<WorkspacesFile>,
}

impl WorkspaceStore {
    /// Open the store at `path`. Missing file = empty registry.
    /// `None` returns a session-only store (useful for tests and
    /// the in-memory test harness).
    pub fn open(path: Option<PathBuf>) -> Self {
        let initial = match &path {
            Some(p) if p.exists() => match std::fs::read_to_string(p) {
                Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(path = %p.display(), error = %e, "workspaces.json parse failed; starting empty");
                        WorkspacesFile::default()
                    }
                },
                _ => WorkspacesFile::default(),
            },
            _ => WorkspacesFile::default(),
        };
        Self {
            path,
            state: RwLock::new(initial),
        }
    }

    /// Snapshot of the recent list, newest-first (already sorted
    /// by `touch`).
    pub fn list_recent(&self) -> Vec<WorkspaceEntry> {
        self.state
            .read()
            .map(|g| g.recent.clone())
            .unwrap_or_default()
    }

    /// Move `path` to the front of the recent list (insert if new).
    /// Returns the canonicalised path string. Errors only on the
    /// `canonicalize` step — the on-disk write is best-effort.
    pub fn touch(&self, raw: &str) -> Result<String, BoxError> {
        let canonical = std::fs::canonicalize(raw)
            .map_err(|e| -> BoxError { format!("canonicalize {raw}: {e}").into() })?;
        if !canonical.is_dir() {
            return Err(format!("{} is not a directory", canonical.display()).into());
        }
        let path_str = canonical.display().to_string();
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_str.clone());
        let now = chrono::Utc::now().to_rfc3339();

        if let Ok(mut g) = self.state.write() {
            g.recent.retain(|e| e.path != path_str);
            g.recent.insert(
                0,
                WorkspaceEntry {
                    path: path_str.clone(),
                    name,
                    last_used_at: now,
                },
            );
            if g.recent.len() > MAX_RECENT {
                g.recent.truncate(MAX_RECENT);
            }
        }
        self.flush();
        Ok(path_str)
    }

    /// Drop `path` from the recent list. Idempotent.
    pub fn forget(&self, raw: &str) {
        let target = std::fs::canonicalize(raw)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| raw.to_string());
        if let Ok(mut g) = self.state.write() {
            g.recent.retain(|e| e.path != target);
        }
        self.flush();
    }

    /// Bind a persisted conversation to a workspace path. Used when
    /// the WS handler sees `SetWorkspace` while a `persisted_id` is
    /// active, or when `New { workspace_path }` lands.
    pub fn bind(&self, conv_id: &str, path: &str) {
        if let Ok(mut g) = self.state.write() {
            g.by_conversation.insert(conv_id.to_string(), path.to_string());
        }
        self.flush();
    }

    /// Forget a conversation's binding. No-op if absent.
    pub fn unbind(&self, conv_id: &str) {
        if let Ok(mut g) = self.state.write() {
            g.by_conversation.remove(conv_id);
        }
        self.flush();
    }

    /// Look up a conversation's bound workspace, if any. Used on
    /// `Resume` to restore the per-session pin.
    pub fn lookup(&self, conv_id: &str) -> Option<String> {
        self.state.read().ok().and_then(|g| g.by_conversation.get(conv_id).cloned())
    }

    fn flush(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let Ok(g) = self.state.read() else { return };
        let serialised = match serde_json::to_string_pretty(&*g) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "serialize workspaces.json");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    warn!(path = %parent.display(), error = %e, "create workspaces dir");
                    return;
                }
            }
        }
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, serialised) {
            warn!(path = %tmp.display(), error = %e, "write workspaces tmp");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            warn!(path = %path.display(), error = %e, "rename workspaces tmp");
            return;
        }
        debug!(path = %path.display(), "workspaces.json flushed");
    }
}

/// Resolve the conventional location: `<config-dir>/workspaces.json`.
/// Returns `None` when the caller can't figure out a config dir
/// (the binary's main fallback path is to skip persistence in that
/// case rather than guess).
pub fn default_path(config_dir: Option<&Path>) -> Option<PathBuf> {
    config_dir.map(|d| d.join("workspaces.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn touch_inserts_and_promotes() {
        let tmp = TempDir::new().unwrap();
        let s = WorkspaceStore::open(Some(tmp.path().join("workspaces.json")));

        // Two distinct dirs to touch.
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();

        let a_path = s.touch(a.path().to_str().unwrap()).unwrap();
        let b_path = s.touch(b.path().to_str().unwrap()).unwrap();

        let recent = s.list_recent();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].path, b_path, "newest first");
        assert_eq!(recent[1].path, a_path);

        // Re-touching `a` moves it back to the front.
        let _ = s.touch(a.path().to_str().unwrap()).unwrap();
        let recent = s.list_recent();
        assert_eq!(recent[0].path, a_path);
        assert_eq!(recent[1].path, b_path);
    }

    #[test]
    fn forget_drops_entry() {
        let tmp = TempDir::new().unwrap();
        let s = WorkspaceStore::open(Some(tmp.path().join("workspaces.json")));
        let a = TempDir::new().unwrap();
        let _ = s.touch(a.path().to_str().unwrap()).unwrap();
        s.forget(a.path().to_str().unwrap());
        assert!(s.list_recent().is_empty());
    }

    #[test]
    fn bind_lookup_unbind_round_trip() {
        let tmp = TempDir::new().unwrap();
        let s = WorkspaceStore::open(Some(tmp.path().join("workspaces.json")));
        s.bind("conv-1", "/tmp/foo");
        assert_eq!(s.lookup("conv-1").as_deref(), Some("/tmp/foo"));
        s.unbind("conv-1");
        assert!(s.lookup("conv-1").is_none());
    }

    #[test]
    fn rejects_non_directory() {
        let tmp = TempDir::new().unwrap();
        let s = WorkspaceStore::open(Some(tmp.path().join("workspaces.json")));
        let f = tmp.path().join("file");
        std::fs::write(&f, "x").unwrap();
        let err = s.touch(f.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }

    #[test]
    fn persists_across_reopen() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("workspaces.json");
        let proj = TempDir::new().unwrap();
        {
            let s = WorkspaceStore::open(Some(path.clone()));
            let _ = s.touch(proj.path().to_str().unwrap()).unwrap();
            s.bind("c-1", proj.path().to_str().unwrap());
        }
        let s2 = WorkspaceStore::open(Some(path));
        assert_eq!(s2.list_recent().len(), 1);
        assert!(s2.lookup("c-1").is_some());
    }

    #[test]
    fn caps_recent_at_max() {
        let tmp = TempDir::new().unwrap();
        let s = WorkspaceStore::open(Some(tmp.path().join("workspaces.json")));
        let mut dirs = Vec::new();
        for _ in 0..(MAX_RECENT + 5) {
            let d = TempDir::new().unwrap();
            let _ = s.touch(d.path().to_str().unwrap()).unwrap();
            dirs.push(d);
        }
        assert_eq!(s.list_recent().len(), MAX_RECENT);
    }
}
