//! Mode-signal channel — typed "switch permission mode" stream.
//!
//! Companion to [`crate::plan`] / [`crate::progress`]. Lets a tool
//! ask the host transport to change the current permission mode
//! from inside an agent turn — e.g. the `enter_plan_mode` tool
//! emits [`PermissionMode::Plan`] and the WS handler reacts by
//! flipping its per-socket mode handle. Without a typed channel,
//! transports would have to parse mode hints out of free-form tool
//! output.
//!
//! Wire model mirrors `plan` / `progress`:
//!
//! - The agent loop installs an [`mpsc::UnboundedSender<PermissionMode>`]
//!   in a [`tokio::task_local`] before invoking each tool, scoped via
//!   [`with_mode_signal`].
//! - A tool calls [`emit`] with the target mode. The mode change does
//!   **not** take effect inside the current tool dispatch — the agent
//!   loop drains the receiver after the tool returns and emits
//!   [`crate::AgentEvent::ModeChanged`]. Transports intercept the
//!   event and apply the mode for subsequent turns.
//! - Outside an agent invocation the channel is absent — emits become
//!   no-ops, which keeps the tool's unit tests trivial.

use tokio::sync::mpsc;

use crate::permission::PermissionMode;

tokio::task_local! {
    /// Per-invocation mode-signal sender, scoped via [`with_mode_signal`].
    static MODE_SIGNAL_TX: mpsc::UnboundedSender<PermissionMode>;
}

/// Publish a mode-change request. No-op when no listener is installed
/// (e.g. the tool was invoked outside an agent loop in a unit test).
pub fn emit(mode: PermissionMode) {
    let _ = MODE_SIGNAL_TX.try_with(|tx| {
        let _ = tx.send(mode);
    });
}

/// Whether a mode-signal sender is installed for the current task.
pub fn is_active() -> bool {
    MODE_SIGNAL_TX.try_with(|_| ()).is_ok()
}

/// Run `fut` with `tx` installed as the active mode-signal sender.
/// Used by the agent loop to scope a sender to a single tool
/// invocation.
pub async fn with_mode_signal<F, R>(tx: mpsc::UnboundedSender<PermissionMode>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    MODE_SIGNAL_TX.scope(tx, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_inside_with_mode_signal_reaches_receiver() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_mode_signal(tx, async {
            assert!(is_active());
            emit(PermissionMode::Plan);
        })
        .await;
        let got = rx.try_recv().unwrap();
        assert_eq!(got, PermissionMode::Plan);
    }

    #[tokio::test]
    async fn emit_outside_scope_is_noop() {
        assert!(!is_active());
        emit(PermissionMode::Plan);
        // No panic; receiver doesn't exist.
    }
}
