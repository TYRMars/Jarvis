//! Web terminal: a PTY-backed shell exposed over WebSocket so the
//! right-rail Terminal panel can drive a real interactive shell from
//! the browser. Each WS upgrade spins up its own child process; the
//! child is killed on socket close.
//!
//! Wire protocol (small, text-or-binary per frame):
//!
//! - Client → server text frames are JSON control messages:
//!   `{"t":"input","data":"…"}` (forwarded to PTY stdin verbatim) and
//!   `{"t":"resize","cols":80,"rows":24}`.
//! - Client → server binary frames are forwarded to PTY stdin verbatim.
//! - Server → client frames are always binary: raw PTY stdout/stderr
//!   bytes. ANSI/UTF-8/control sequences are passed through untouched
//!   so xterm.js renders them faithfully.
//!
//! Sandbox: the working directory is `?root=<abs>` (validated the
//! same way the diff/files endpoints do) or `AppState::workspace_root`
//! when absent. `503` when no root resolves.
//!
//! Access control: the WS upgrade enforces a same-origin `Origin`
//! check (`origin_allowed`) so a cross-site page cannot hijack the
//! handshake into a drive-by shell, and a global concurrency cap
//! (`MAX_CONCURRENT_TERMINALS`) bounds live PTY sessions.
//!
//! The shell is picked from `$SHELL`; we fall back to `/bin/zsh` then
//! `/bin/bash` then `/bin/sh` on Unix, and `cmd.exe` on Windows. The
//! child inherits the server's environment except `TERM` is forced to
//! `xterm-256color` and `JARVIS_WEB_TERM=1` is set so user shell rcs
//! can branch if they care.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::state::AppState;
use crate::state_layers::WorkspaceLayer;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/workspace/terminal", get(status))
        .route("/v1/workspace/terminal/ws", get(terminal_ws))
}

/// `GET /v1/workspace/terminal` — capability probe. The Terminal
/// panel hits this on mount so it can render a clean "unavailable"
/// state instead of failing the WS upgrade and surfacing a vague
/// network error. `available: false` only if no workspace root
/// resolves; the actual PTY spawn errors are surfaced through the
/// open WS as a closing frame with a reason byte.
async fn status(State(workspace): State<WorkspaceLayer>) -> Response {
    let available = workspace.root.is_some();
    Json(json!({
        "available": available,
        "shell": pick_shell(),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    /// Absolute workspace root override. Same shape as the diff /
    /// files endpoints. Falls back to `AppState::workspace_root`.
    root: Option<String>,
    /// Optional initial terminal size hint. The client also re-sends
    /// `{"t":"resize",...}` immediately on connect, so a missing
    /// query param just means "use 80x24 until the first resize".
    cols: Option<u16>,
    rows: Option<u16>,
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

#[allow(clippy::result_large_err)]
fn resolve_workspace(
    workspace: &WorkspaceLayer,
    override_root: Option<&str>,
) -> Result<PathBuf, Response> {
    if let Some(raw) = override_root {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(bad_request("`root` must not be empty"));
        }
        if trimmed.contains(['\0', '\n', '\r']) {
            return Err(bad_request("`root` contains forbidden characters"));
        }
        if !Path::new(trimmed).is_absolute() {
            return Err(bad_request("`root` must be an absolute path"));
        }
        let canonical = std::fs::canonicalize(trimmed)
            .map_err(|e| bad_request(&format!("`root` does not resolve: {e}")))?;
        if !canonical.is_dir() {
            return Err(bad_request("`root` is not a directory"));
        }
        return Ok(canonical);
    }
    workspace.root.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspace root not configured" })),
        )
            .into_response()
    })
}

/// Cross-site WebSocket hijacking (CSWSH) guard.
///
/// WebSocket upgrades are **not** subject to the browser same-origin
/// policy, so without this check any web page the user happens to
/// visit could open `ws://<host>/v1/workspace/terminal/ws`, stream
/// shell commands into the victim's PTY, and read the output back —
/// i.e. drive-by remote code execution on the machine running the
/// server.
///
/// Policy:
/// - `Origin` present → its authority (host[:port]) must equal the
///   request's `Host` header. The web UI is baked into this server and
///   served from the same origin, so legitimate browser connections
///   always match; a cross-origin page does not.
/// - `Origin` absent → allowed. Browsers always send `Origin` on a WS
///   handshake, so its absence means a non-browser client (CLI / test
///   / curl) for which the same-origin policy is irrelevant anyway —
///   those are gated by the network bind, not by `Origin`.
fn origin_allowed(headers: &HeaderMap) -> bool {
    let origin = match headers.get(header::ORIGIN) {
        Some(o) => o,
        None => return true,
    };
    let origin = match origin.to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    // `Origin` is `scheme://host[:port]` with no path; strip the
    // scheme down to the authority and be defensive about any trailing
    // path bytes.
    let authority = match origin.split_once("://") {
        Some((_scheme, rest)) => rest.split('/').next().unwrap_or(""),
        None => return false,
    };
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    !authority.is_empty() && authority.eq_ignore_ascii_case(host)
}

/// Max concurrent web-terminal sessions. Each live session owns a real
/// OS process plus a PTY master fd; without a ceiling a flood of
/// connections could exhaust processes / file descriptors (DoS).
const MAX_CONCURRENT_TERMINALS: usize = 8;
static ACTIVE_TERMINALS: AtomicUsize = AtomicUsize::new(0);

/// RAII guard for a terminal slot — decrements the active counter on
/// drop so the slot is reclaimed however the session ends (clean
/// close, error, or panic).
struct TerminalSlot;

impl Drop for TerminalSlot {
    fn drop(&mut self) {
        ACTIVE_TERMINALS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Reserve one of the [`MAX_CONCURRENT_TERMINALS`] slots, or `None`
/// when the cap is already reached.
fn try_acquire_slot() -> Option<TerminalSlot> {
    let prev = ACTIVE_TERMINALS.fetch_add(1, Ordering::SeqCst);
    if prev >= MAX_CONCURRENT_TERMINALS {
        ACTIVE_TERMINALS.fetch_sub(1, Ordering::SeqCst);
        None
    } else {
        Some(TerminalSlot)
    }
}

async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(workspace): State<WorkspaceLayer>,
    Query(q): Query<TerminalQuery>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "cross-origin terminal connection refused" })),
        )
            .into_response();
    }
    let root = match resolve_workspace(&workspace, q.root.as_deref()) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let slot = match try_acquire_slot() {
        Some(s) => s,
        None => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "too many active terminal sessions" })),
            )
                .into_response();
        }
    };
    // `cols`/`rows` are `u16`, so they're already bounded to
    // `0..=0xffff`; just reject the degenerate `0` by clamping to 1.
    let cols = q.cols.unwrap_or(80).max(1);
    let rows = q.rows.unwrap_or(24).max(1);
    ws.on_upgrade(move |sock| async move {
        // Hold the slot for the lifetime of the session.
        let _slot = slot;
        if let Err(e) = run_terminal(sock, root, cols, rows).await {
            tracing::warn!(error = %e, "terminal session ended with error");
        }
    })
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum ClientFrame {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Ping {},
}

/// Pick the user's preferred shell with a sensible fallback chain.
fn pick_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    #[cfg(unix)]
    {
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "sh".to_string()
    }
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

async fn run_terminal(
    socket: WebSocket,
    cwd: PathBuf,
    initial_cols: u16,
    initial_rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_rows,
            cols: initial_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(pick_shell());
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("JARVIS_WEB_TERM", "1");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell: {e}"))?;
    drop(pair.slave);

    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));
    // The master can hand out one writer per call. Cache a single
    // writer up-front and share it via the same lock — calling
    // take_writer() again after that is implementation-defined
    // across platforms.
    let writer = {
        let m = master.lock().await;
        m.take_writer().map_err(|e| format!("take_writer: {e}"))?
    };
    let writer = Arc::new(Mutex::new(writer));

    // ---------- reader: PTY → WS (binary frames) ----------
    let mut reader = {
        let m = master.lock().await;
        m.try_clone_reader()
            .map_err(|e| format!("clone PTY reader: {e}"))?
    };

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    let reader_handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::debug!(error = %e, "PTY read error");
                    break;
                }
            }
        }
    });

    let send_loop = async {
        while let Some(chunk) = out_rx.recv().await {
            if ws_tx.send(WsMessage::Binary(chunk)).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.send(WsMessage::Close(None)).await;
    };

    let writer_for_recv = writer.clone();
    let master_for_recv = master.clone();
    let recv_loop = async {
        while let Some(Ok(frame)) = ws_rx.next().await {
            match frame {
                WsMessage::Text(text) => match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(ClientFrame::Input { data }) => {
                        let w = writer_for_recv.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            if let Ok(mut w) = w.try_lock() {
                                let _ = w.write_all(data.as_bytes());
                                let _ = w.flush();
                            }
                        })
                        .await;
                    }
                    Ok(ClientFrame::Resize { cols, rows }) => {
                        let m = master_for_recv.lock().await;
                        // `u16` already bounds these to `0..=0xffff`;
                        // clamp the degenerate `0` up to 1 so a resize
                        // never collapses a dimension.
                        let _ = m.resize(PtySize {
                            rows: rows.max(1),
                            cols: cols.max(1),
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    Ok(ClientFrame::Ping {}) => {}
                    Err(e) => {
                        tracing::debug!(error = %e, "bad terminal frame");
                    }
                },
                WsMessage::Binary(data) => {
                    let w = writer_for_recv.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(mut w) = w.try_lock() {
                            let _ = w.write_all(&data);
                            let _ = w.flush();
                        }
                    })
                    .await;
                }
                WsMessage::Close(_) => break,
                WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            }
        }
    };

    tokio::select! {
        _ = send_loop => {}
        _ = recv_loop => {}
    }

    let _ = child.kill();
    let _ = reader_handle.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderMap, HeaderValue};

    fn headers_with(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        if let Some(host) = host {
            h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        h
    }

    #[test]
    fn same_origin_allowed() {
        let h = headers_with(Some("http://localhost:7001"), Some("localhost:7001"));
        assert!(origin_allowed(&h));
    }

    #[test]
    fn cross_origin_rejected() {
        // The CSWSH / drive-by-RCE case: a different site opening the WS.
        let h = headers_with(Some("http://evil.example"), Some("localhost:7001"));
        assert!(!origin_allowed(&h));
    }

    #[test]
    fn cross_origin_same_host_different_port_rejected() {
        let h = headers_with(Some("http://localhost:9999"), Some("localhost:7001"));
        assert!(!origin_allowed(&h));
    }

    #[test]
    fn missing_origin_allowed_for_non_browser_clients() {
        // CLI / test / curl never send Origin; SOP is irrelevant to them.
        let h = headers_with(None, Some("localhost:7001"));
        assert!(origin_allowed(&h));
    }

    #[test]
    fn host_comparison_is_case_insensitive() {
        let h = headers_with(Some("http://LocalHost:7001"), Some("localhost:7001"));
        assert!(origin_allowed(&h));
    }

    #[test]
    fn https_origin_authority_matches_host() {
        let h = headers_with(Some("https://example.com"), Some("example.com"));
        assert!(origin_allowed(&h));
    }

    #[test]
    fn malformed_origin_rejected() {
        let h = headers_with(Some("not-a-url"), Some("localhost:7001"));
        assert!(!origin_allowed(&h));
    }

    #[test]
    fn null_origin_rejected() {
        // Sandboxed iframes / some redirects send `Origin: null`.
        let h = headers_with(Some("null"), Some("localhost:7001"));
        assert!(!origin_allowed(&h));
    }

    #[test]
    fn concurrency_slots_cap_and_release() {
        // Exhaust the cap, confirm the next acquire fails, then confirm
        // dropping a guard frees a slot. Serialized via the global
        // counter — reset to a known baseline first.
        ACTIVE_TERMINALS.store(0, Ordering::SeqCst);
        let mut slots = Vec::new();
        for _ in 0..MAX_CONCURRENT_TERMINALS {
            slots.push(try_acquire_slot().expect("under cap"));
        }
        assert!(try_acquire_slot().is_none(), "cap should reject overflow");
        drop(slots.pop());
        assert!(try_acquire_slot().is_some(), "freed slot is reusable");
        // Clean up so we don't leak counter state into other tests.
        slots.clear();
        ACTIVE_TERMINALS.store(0, Ordering::SeqCst);
    }
}
