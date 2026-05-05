use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DesktopPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl DesktopPrefs {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("prefs.json");
        let Ok(bytes) = fs::read(&path) else {
            return Self::default();
        };
        serde_json::from_slice::<Self>(&bytes).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
        let Ok(bytes) = serde_json::to_vec_pretty(self) else {
            return;
        };
        let path = dir.join("prefs.json");
        let tmp = dir.join("prefs.json.tmp");
        if fs::write(&tmp, bytes).is_err() {
            return;
        }
        let _ = fs::rename(tmp, path);
    }
}

pub fn config_dir(app_name: &str) -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        #[cfg(target_os = "macos")]
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(app_name);
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
                return PathBuf::from(xdg).join(app_name);
            }
            return PathBuf::from(home).join(".config").join(app_name);
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(app_name);
        }
    }
    std::env::temp_dir().join(app_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_workspace() {
        let dir = tempdir().expect("tempdir");
        let p = DesktopPrefs {
            workspace: Some("/tmp/work".into()),
        };
        p.save(dir.path());
        let loaded = DesktopPrefs::load(dir.path());
        assert_eq!(loaded.workspace.as_deref(), Some("/tmp/work"));
    }

    #[test]
    fn missing_file_returns_default() {
        let dir = tempdir().expect("tempdir");
        let loaded = DesktopPrefs::load(dir.path());
        assert!(loaded.workspace.is_none());
    }
}
