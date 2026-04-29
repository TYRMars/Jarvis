//! Per-session workspace root.
//!
//! The harness's filesystem-bound tools (`fs.*`, `git.*`, `code.grep`,
//! `shell.exec`, …) are constructed at startup with a single root
//! path baked into each instance. Per-session overrides — "this
//! WebSocket's turns should target a different project folder than
//! the binary was launched against" — flow through this `task_local`
//! scope: the agent loop sets it for the duration of one tool
//! invocation; tools call [`active_workspace`] / [`active_workspace_or`]
//! from inside `invoke` and use the override when present.
//!
//! Outside an agent invocation the task-local is absent and the
//! helpers degrade to "use the constructor-time default", which is
//! exactly what every existing call site already did.

use std::future::Future;
use std::path::{Path, PathBuf};

tokio::task_local! {
    static SESSION_WORKSPACE: Option<PathBuf>;
}

/// Run `f` with `path` installed as the session-level workspace
/// override. `None` is allowed and means "no override" — the helpers
/// below then fall back to the tool's constructor-time root.
///
/// Used by the agent loop right around each tool invocation; tests
/// can call it directly to exercise per-session behaviour without
/// standing up the whole loop.
pub async fn with_session_workspace<F>(path: Option<PathBuf>, f: F) -> F::Output
where
    F: Future,
{
    SESSION_WORKSPACE.scope(path, f).await
}

/// Read the current session's workspace override, if any.
///
/// `None` outside an `with_session_workspace` scope or when the
/// active scope was started with `None`.
pub fn active_workspace() -> Option<PathBuf> {
    SESSION_WORKSPACE
        .try_with(|p| p.clone())
        .ok()
        .flatten()
}

/// Convenience: prefer the session-level override, fall back to
/// `default`. Returns an owned `PathBuf` because tools need to
/// construct sandboxed paths from it.
pub fn active_workspace_or(default: &Path) -> PathBuf {
    active_workspace().unwrap_or_else(|| default.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn override_visible_inside_scope() {
        let custom = PathBuf::from("/tmp/custom");
        let observed = with_session_workspace(Some(custom.clone()), async {
            active_workspace()
        })
        .await;
        assert_eq!(observed, Some(custom));
    }

    #[tokio::test]
    async fn none_scope_clears_override() {
        let observed =
            with_session_workspace(None, async { active_workspace() }).await;
        assert!(observed.is_none());
    }

    #[tokio::test]
    async fn no_scope_falls_back_to_default() {
        let default = PathBuf::from("/tmp/default");
        // Outside any with_session_workspace call, active_workspace_or
        // must return the constructor-time default.
        assert_eq!(active_workspace_or(&default), default);
    }

    #[tokio::test]
    async fn or_helper_prefers_session_override() {
        let default = PathBuf::from("/tmp/default");
        let custom = PathBuf::from("/tmp/custom");
        let observed = with_session_workspace(Some(custom.clone()), async {
            active_workspace_or(&default)
        })
        .await;
        assert_eq!(observed, custom);
    }
}
