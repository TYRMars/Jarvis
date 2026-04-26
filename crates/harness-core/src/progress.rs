//! Tool-progress channel.
//!
//! Long-running tools (`shell.exec`, future `code.search` etc.) often
//! produce useful intermediate output before returning a final result.
//! The agent loop installs an `mpsc::UnboundedSender<ToolProgress>` in
//! a [`tokio::task_local`] before invoking each tool, so the tool can
//! publish chunks from anywhere on the same task without needing the
//! sender threaded through its arguments.
//!
//! Tools call [`emit`] (or check [`is_active`] if they want to skip
//! formatting work when no listener is set up). Outside of an agent
//! invocation the channel is absent — emits become no-ops, which
//! keeps `cargo test` of individual tools simple.
//!
//! The agent loop drains the receiver alongside the tool's `invoke`
//! future and forwards each chunk as `AgentEvent::ToolProgress`.

use serde::Serialize;
use tokio::sync::mpsc;

/// One progress chunk published by a tool. The shape matches the
/// `tool_progress` event emitted by the agent so transports can
/// serialise without re-mapping.
#[derive(Debug, Clone, Serialize)]
pub struct ToolProgress {
    /// Tool-defined stream label. `shell.exec` uses `"stdout"` /
    /// `"stderr"`; other tools may use `"log"` or a custom tag.
    pub stream: String,
    /// Raw chunk content (UTF-8). Tools that produce binary output
    /// must base64-encode upstream — the wire format is text.
    pub chunk: String,
}

tokio::task_local! {
    /// Per-invocation progress sender. Set by the agent loop before
    /// every `tool.invoke(...)`; cleared automatically when the
    /// scoped future returns.
    static PROGRESS_TX: mpsc::UnboundedSender<ToolProgress>;
}

/// Publish a chunk on the current task's progress channel. No-op
/// when the task isn't running inside `with_progress(...)` — useful
/// for tool unit tests that invoke directly without an agent loop.
pub fn emit(stream: impl Into<String>, chunk: impl Into<String>) {
    let p = ToolProgress {
        stream: stream.into(),
        chunk: chunk.into(),
    };
    let _ = PROGRESS_TX.try_with(|tx| {
        let _ = tx.send(p);
    });
}

/// Whether a progress sender is installed for the current task.
/// Tools can use this to skip per-chunk formatting work when no
/// transport is listening (cheap-out for the test path).
pub fn is_active() -> bool {
    PROGRESS_TX.try_with(|_| ()).is_ok()
}

/// Clone of the active progress sender, if any. Tools that fan out
/// across `tokio::spawn`-ed sub-tasks need this — the spawned task
/// runs on its own task slot and won't see the parent's
/// `task_local`. Pass the cloned sender explicitly into the
/// sub-task and use [`emit_with`] on it.
pub fn sender() -> Option<mpsc::UnboundedSender<ToolProgress>> {
    PROGRESS_TX.try_with(|tx| tx.clone()).ok()
}

/// Publish a chunk on a sender obtained from [`sender`]. Useful in
/// `tokio::spawn`-ed sub-tasks where the `task_local` lookup
/// wouldn't find the parent's sender.
pub fn emit_with(
    tx: &mpsc::UnboundedSender<ToolProgress>,
    stream: impl Into<String>,
    chunk: impl Into<String>,
) {
    let _ = tx.send(ToolProgress {
        stream: stream.into(),
        chunk: chunk.into(),
    });
}

/// Run `fut` with `tx` as the active progress sender. Used by the
/// agent loop to scope a sender to a single tool invocation. The
/// sender goes out of scope when `fut` completes, so subsequent
/// invocations need their own channel.
pub async fn with_progress<F, R>(tx: mpsc::UnboundedSender<ToolProgress>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    PROGRESS_TX.scope(tx, fut).await
}
