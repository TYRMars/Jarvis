//! Per-provider auth credential store.
//!
//! Files live under `<config-root>/auth/<provider>.json` separately
//! from `config.json` so the config file can be committed / shared
//! without leaking tokens. Layout:
//!
//! ```text
//! ~/.config/jarvis/
//!   config.json         # 0644
//!   auth/
//!     openai.json       # 0600 — { "api_key": "sk-..." }
//!     anthropic.json    # 0600
//!     google.json       # 0600
//!     kimi.json         # 0600
//!     codex.json        # full TokenData (PKCE OAuth)
//! ```
//!
//! Writes go through a write-temp + rename pair so a crash mid-write
//! never produces a half-flushed file. Permissions are set to `0600`
//! on unix; on Windows we rely on the user profile being
//! per-user-protected.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Resolve `<config-root>` (parent of `auth/`). Mirrors
/// `Config::discover` / `default_search_paths` in `config.rs`. Picks
/// the first writable location:
///
/// 1. `$JARVIS_CONFIG_HOME` (explicit override)
/// 2. `$XDG_CONFIG_HOME/jarvis`
/// 3. `~/.config/jarvis`
/// 4. `%APPDATA%\jarvis` (Windows)
///
/// Returns `Err` if none of those are derivable (e.g. no `HOME`).
pub fn config_dir() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("JARVIS_CONFIG_HOME") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(xdg).join("jarvis"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".config").join("jarvis"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Ok(PathBuf::from(appdata).join("jarvis"));
    }
    anyhow::bail!("can't locate a config home (set HOME or JARVIS_CONFIG_HOME)")
}

pub fn config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.json"))
}

pub fn auth_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("auth"))
}

pub fn auth_path(provider: &str) -> Result<PathBuf> {
    Ok(auth_dir()?.join(format!("{provider}.json")))
}

/// On unix, ensures the directory exists with mode 0700 so listing
/// it doesn't leak which providers a user has authed against. On
/// other platforms we rely on standard user-profile permissions.
fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o700);
        let _ = std::fs::set_permissions(path, perm);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyAuth {
    pub api_key: String,
}

/// Save an API key to `<config-root>/auth/<provider>.json`. The
/// directory is created if missing; the file is written atomically
/// (write-temp + rename) and chmod'd to 0600 on unix.
pub fn save_api_key(provider: &str, key: &str) -> Result<PathBuf> {
    let dir = auth_dir()?;
    ensure_dir(&dir)?;
    let path = dir.join(format!("{provider}.json"));
    write_json_secret(
        &path,
        &ApiKeyAuth {
            api_key: key.to_string(),
        },
    )?;
    Ok(path)
}

/// Load an API key for the given provider, or `None` if no auth
/// file exists yet. Errors only when a file is present but malformed.
pub fn load_api_key(provider: &str) -> Result<Option<String>> {
    let path = match auth_path(provider) {
        Ok(p) => p,
        // No HOME/APPDATA — treat as "no auth", not an error.
        Err(_) => return Ok(None),
    };
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: ApiKeyAuth =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(parsed.api_key))
}

/// Drop the auth file for `provider`. Returns `true` if a file was
/// removed, `false` if there was nothing to remove. Errors only on
/// IO failure other than NotFound.
///
/// Currently unused outside tests — the `jarvis logout` subcommand
/// will be the first caller (PR 2 / PR 3 follow-up).
#[allow(dead_code)]
pub fn delete(provider: &str) -> Result<bool> {
    let path = match auth_path(provider) {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(anyhow::anyhow!("delete {}: {e}", path.display())),
    }
}

fn write_json_secret<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let pretty = serde_json::to_vec_pretty(value)
        .with_context(|| format!("serialize {}", path.display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &pretty).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&tmp, perm);
    }
    std::fs::rename(&tmp, path).with_context(|| format!("rename onto {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Override the resolution roots so a test only ever touches its
    /// own scratch dir. Holds [`crate::test_env::lock`] for the
    /// guard's lifetime so concurrent env-mutating tests don't race.
    struct EnvGuard {
        keys: Vec<(&'static str, Option<String>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl EnvGuard {
        fn isolate(home: &Path) -> Self {
            let lock = crate::test_env::lock();
            let keys = ["JARVIS_CONFIG_HOME", "XDG_CONFIG_HOME", "HOME", "APPDATA"];
            let mut saved = Vec::new();
            for k in keys {
                saved.push((k, std::env::var(k).ok()));
            }
            // SAFETY: env mutations are serialised across tests by the
            // global lock above; the guard outlives the mutations.
            unsafe {
                std::env::set_var("JARVIS_CONFIG_HOME", home);
                std::env::remove_var("XDG_CONFIG_HOME");
                std::env::remove_var("HOME");
                std::env::remove_var("APPDATA");
            }
            EnvGuard {
                keys: saved,
                _lock: lock,
            }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in self.keys.drain(..) {
                unsafe {
                    match v {
                        Some(val) => std::env::set_var(k, val),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());

        let path = save_api_key("openai", "sk-secret-1").unwrap();
        assert!(path.is_file());
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "auth");

        let loaded = load_api_key("openai").unwrap();
        assert_eq!(loaded.as_deref(), Some("sk-secret-1"));
    }

    #[test]
    fn load_returns_none_when_missing() {
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());
        assert_eq!(load_api_key("anthropic").unwrap(), None);
    }

    #[test]
    fn save_overwrites_existing() {
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());

        save_api_key("google", "old").unwrap();
        save_api_key("google", "new").unwrap();
        assert_eq!(load_api_key("google").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn delete_removes_file_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());

        save_api_key("openai", "sk").unwrap();
        assert!(delete("openai").unwrap());
        assert!(!delete("openai").unwrap()); // already gone
        assert_eq!(load_api_key("openai").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn auth_file_has_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());

        let path = save_api_key("openai", "sk-x").unwrap();
        let mode = path.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn auth_dir_has_0700_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let _g = EnvGuard::isolate(dir.path());

        save_api_key("openai", "sk-x").unwrap();
        let mode = auth_dir().unwrap().metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0700, got {mode:o}");
    }
}
