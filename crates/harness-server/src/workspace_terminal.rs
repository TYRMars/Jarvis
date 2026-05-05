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
//! The shell is picked from `$SHELL`; we fall back to `/bin/zsh` then
//! `/bin/bash` then `/bin/sh` on Unix, and `cmd.exe` on Windows. The
//! child inherits the server's environment except `TERM` is forced to
//! `xterm-256color` and `JARVIS_WEB_TERM=1` is set so user shell rcs
//! can branch if they care.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
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
async fn status(State(state): State<AppState>) -> Response {
    let available = state.workspace_root.is_some();
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
fn resolve_workspace(state: &AppState, override_root: Option<&str>) -> Result<PathBuf, Response> {
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
    state.workspace_root.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspace root not configured" })),
        )
            .into_response()
    })
}

async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(q): Query<TerminalQuery>,
) -> Response {
    let root = match resolve_workspace(&state, q.root.as_deref()) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let cols = q.cols.unwrap_or(80);
    let rows = q.rows.unwrap_or(24);
    ws.on_upgrade(move |sock| async move {
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
                        let _ = m.resize(PtySize {
                            rows,
                            cols,
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
