use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use harness_core::{
    AgentEvent, ApprovalDecision, Approver, ChannelApprover, Conversation, Message,
    RunOutcome,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

use uuid::Uuid;

use crate::conversations::{self, is_internal_id};
use crate::state::AppState;
use crate::ui;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/providers", get(list_providers))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/chat/completions/stream", post(chat_completions_stream))
        .route("/v1/chat/ws", get(chat_ws))
        .merge(conversations::router())
        .merge(ui::router())
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn list_providers(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "default": state.providers.default_name(),
        "providers": state.providers.list(),
    }))
}

// ----------------------- /v1/chat/completions (JSON) -----------------------

#[derive(Debug, Deserialize)]
struct ChatCompletionsRequest {
    #[serde(default)]
    model: Option<String>,
    /// Optional explicit provider name. Wins over any
    /// `provider/model` form on `model`.
    #[serde(default)]
    provider: Option<String>,
    messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionsResponse {
    message: Message,
    iterations: usize,
    history: Vec<Message>,
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let mut conv = Conversation { messages: req.messages };
    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => return route_error(e),
    };

    match agent.run(&mut conv).await {
        Ok(outcome) => {
            let iterations = match outcome {
                RunOutcome::Stopped { iterations } => iterations,
                RunOutcome::LengthLimited { iterations } => iterations,
            };
            let final_msg = conv
                .messages
                .iter()
                .rev()
                .find(|m| matches!(m, Message::Assistant { .. }))
                .cloned()
                .unwrap_or_else(|| Message::assistant_text(""));
            (
                StatusCode::OK,
                Json(ChatCompletionsResponse {
                    message: final_msg,
                    iterations,
                    history: conv.messages,
                }),
            )
                .into_response()
        }
        Err(e) => {
            error!(error = %e, "agent run failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    }
}

// -------------------- /v1/chat/completions/stream (SSE) --------------------

async fn chat_completions_stream(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let conv = Conversation { messages: req.messages };
    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => return route_error(e),
    };
    let stream = agent.run_stream(conv).map(|event| {
        let payload = serde_json::to_string(&event)
            .unwrap_or_else(|e| format!(r#"{{"type":"error","message":"serialize: {e}"}}"#));
        Ok::<_, Infallible>(Event::default().data(payload))
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

fn route_error(e: crate::provider_registry::RouteError) -> Response {
    use crate::provider_registry::RouteError::*;
    let status = match &e {
        UnknownProvider(_) => StatusCode::BAD_REQUEST,
        Empty => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(json!({ "error": e.to_string() }))).into_response()
}

// --------------------------- /v1/chat/ws (WS) ------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsClientMessage {
    /// Append a user turn and run the agent loop to completion, streaming
    /// events back. In persisted mode (after `resume` or `new`) the
    /// conversation is auto-saved when the agent finishes.
    ///
    /// Optional `model` / `provider` route this single turn to a
    /// different LLM than the socket's default; subsequent turns
    /// fall back to the socket's last selection.
    User {
        content: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
    },
    /// Drop all prior turns from the in-memory conversation. Also exits
    /// persisted mode, so subsequent turns won't be saved unless the
    /// client re-issues `resume` or `new`.
    Reset,
    /// Load a conversation from the store and switch to persisted mode
    /// for this socket. Errors if no store is configured or the id
    /// doesn't exist.
    Resume {
        id: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
    },
    /// Start a fresh persisted conversation. If `id` is omitted, the
    /// server allocates a UUID and reports it back.
    New {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
    },
    /// Update the socket's default provider/model selection without
    /// running a turn. Subsequent `User` frames without their own
    /// model/provider fields use these.
    Configure {
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
    },
    /// Approve a tool call for which an `ApprovalRequest` event was
    /// previously emitted. The agent unblocks and runs the tool.
    Approve { tool_call_id: String },
    /// Deny a pending tool call. The agent emits a synthetic
    /// `tool denied: <reason>` result back to the model so it can adapt.
    Deny {
        tool_call_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Cancel the in-flight turn. The orchestrator task is aborted at
    /// its next await point (so the LLM request is dropped mid-stream)
    /// and the trailing unanswered user turn is rolled back so the
    /// conversation state stays consistent for the next request.
    /// No-op when no turn is running.
    Interrupt,
    /// Edit-and-rerun: locate the `user_ordinal`-th user message
    /// (zero-indexed, counting only `Message::User` entries), drop
    /// it and everything after it, append `content` as a fresh user
    /// turn, and run the agent. Counting by user-ordinal rather than
    /// raw index spares the client from tracking the mixed
    /// system/user/assistant/tool index space the server uses.
    /// Optional `model` / `provider` route this single rerun.
    Fork {
        user_ordinal: usize,
        content: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
    },
}

/// Static label for a `WsClientMessage` variant — used by the
/// per-frame `info!` log so we can replay ordering without dumping
/// payloads (which can be huge).
fn client_msg_kind(msg: &WsClientMessage) -> &'static str {
    match msg {
        WsClientMessage::User { .. } => "user",
        WsClientMessage::Reset => "reset",
        WsClientMessage::Resume { .. } => "resume",
        WsClientMessage::New { .. } => "new",
        WsClientMessage::Configure { .. } => "configure",
        WsClientMessage::Approve { .. } => "approve",
        WsClientMessage::Deny { .. } => "deny",
        WsClientMessage::Interrupt => "interrupt",
        WsClientMessage::Fork { .. } => "fork",
    }
}

async fn chat_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: AppState) {
    // Per-socket `ChannelApprover`: gated tool calls land in
    // `pending_rx` and we route the client's `approve` / `deny`
    // response back through the matching `oneshot::Sender`. The
    // app-level template may already carry a global approver (e.g.
    // `JARVIS_APPROVAL_MODE=auto`) — we override it for this
    // socket with our channel-driven one so the client gets a real
    // say.
    let (channel_approver, mut pending_rx) = ChannelApprover::new(8);
    let socket_approver: Arc<dyn Approver> = Arc::new(channel_approver);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut conv = Conversation::new();
    let mut persisted_id: Option<String> = None;
    let mut pending: HashMap<String, oneshot::Sender<ApprovalDecision>> = HashMap::new();
    // `Some` while a turn is in flight; `None` between turns.
    let mut event_rx: Option<mpsc::Receiver<AgentEvent>> = None;
    // Handle to the spawned agent task so `Interrupt` can abort it
    // mid-stream. Stays in lockstep with `event_rx`.
    let mut current_task: Option<tokio::task::JoinHandle<()>> = None;
    // Sticky provider/model for this socket. `None` means "use the
    // registry default". Updated by `Configure` / overridden per
    // turn by `User { model, provider }`.
    let mut sticky_provider: Option<String> = None;
    let mut sticky_model: Option<String> = None;

    loop {
        // The `event_rx` arm needs to be permanently selectable but
        // dormant when no turn is running. A `pending` future stays
        // unresolved forever, so the arm is silent until a new turn
        // installs a real receiver.
        let event_fut = async {
            match event_rx.as_mut() {
                Some(rx) => rx.recv().await,
                None => std::future::pending::<Option<AgentEvent>>().await,
            }
        };

        tokio::select! {
            biased;
            // ---- client → server ----
            msg = ws_rx.next() => {
                let Some(msg) = msg else { return };
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "ws recv error");
                        return;
                    }
                };
                if !handle_client_frame(
                    msg,
                    &mut ws_tx,
                    &state,
                    &socket_approver,
                    &mut conv,
                    &mut persisted_id,
                    &mut pending,
                    &mut event_rx,
                    &mut current_task,
                    &mut sticky_provider,
                    &mut sticky_model,
                )
                .await
                {
                    return;
                }
            }
            // ---- approver → server ----
            // The agent has yielded `ApprovalRequest` already; the
            // matching `PendingApproval` arrives here a moment later.
            // We just stash the responder so the client's reply can
            // route back.
            Some(p) = pending_rx.recv() => {
                pending.insert(p.request.tool_call_id.clone(), p.responder);
            }
            // ---- agent → server ----
            ev = event_fut => {
                let Some(ev) = ev else {
                    // Sender dropped → turn is fully drained.
                    event_rx = None;
                    pending.clear();
                    continue;
                };

                let is_terminal = matches!(
                    ev,
                    AgentEvent::Done { .. } | AgentEvent::Error { .. }
                );
                let is_error = matches!(ev, AgentEvent::Error { .. });
                if let AgentEvent::Done { conversation, .. } = &ev {
                    conv = conversation.clone();
                }
                // Failed turn: the user message we pushed in
                // `WsClientMessage::User` is still trailing on `conv`
                // but no assistant ever responded. Pop it so the
                // saved history doesn't grow a dangling user bubble
                // for every retry. The client already sees the error
                // banner and can re-send if they want.
                if is_error {
                    if let Some(harness_core::Message::User { .. }) = conv.messages.last() {
                        conv.messages.pop();
                    }
                }

                let payload = serde_json::to_string(&ev).unwrap_or_else(|e| {
                    json!({ "type": "error", "message": format!("serialize: {e}") })
                        .to_string()
                });
                if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                    return;
                }

                if is_terminal {
                    event_rx = None;
                    current_task = None;
                    // Drop any leftover responders — the agent has
                    // stopped so nothing is waiting on them anyway.
                    pending.clear();
                    if let (Some(id), Some(store)) =
                        (persisted_id.as_ref(), state.store.as_ref())
                    {
                        if let Err(e) = store.save(id, &conv).await {
                            warn!(error = %e, %id, "ws post-run save failed");
                        }
                    }
                }
            }
        }
    }
}

/// Returns `false` when the connection should be torn down
/// (binary close, fatal error). All transient errors send an
/// `error` frame and return `true` so the loop keeps going.
#[allow(clippy::too_many_arguments)]
async fn handle_client_frame(
    msg: WsMessage,
    ws_tx: &mut SplitSink<WebSocket, WsMessage>,
    state: &AppState,
    socket_approver: &Arc<dyn Approver>,
    conv: &mut Conversation,
    persisted_id: &mut Option<String>,
    pending: &mut HashMap<String, oneshot::Sender<ApprovalDecision>>,
    event_rx: &mut Option<mpsc::Receiver<AgentEvent>>,
    current_task: &mut Option<tokio::task::JoinHandle<()>>,
    sticky_provider: &mut Option<String>,
    sticky_model: &mut Option<String>,
) -> bool {
    let text = match msg {
        WsMessage::Text(t) => t,
        WsMessage::Close(_) => return false,
        WsMessage::Ping(_) | WsMessage::Pong(_) => return true,
        WsMessage::Binary(_) => {
            send_error(ws_tx, "binary frames not supported").await;
            return true;
        }
    };

    let client_msg: WsClientMessage = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            send_error(ws_tx, &format!("bad client message: {e}")).await;
            return true;
        }
    };

    // One log line per inbound frame so we can reconstruct ordering
    // when debugging "this got pushed twice" / "out of order" reports.
    // The variant tag is enough — payloads can be huge.
    info!(
        kind = client_msg_kind(&client_msg),
        in_flight = event_rx.is_some(),
        "ws client frame",
    );

    match client_msg {
        WsClientMessage::Approve { tool_call_id } => {
            if let Some(responder) = pending.remove(&tool_call_id) {
                let _ = responder.send(ApprovalDecision::Approve);
            } else {
                // Benign race: client clicked twice, or the turn ended
                // before the click reached us. Silently log instead of
                // surfacing as a banner — the user already saw the
                // outcome of the original decision.
                warn!(%tool_call_id, "approve frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::Deny { tool_call_id, reason } => {
            if let Some(responder) = pending.remove(&tool_call_id) {
                let _ = responder.send(ApprovalDecision::Deny { reason });
            } else {
                warn!(%tool_call_id, "deny frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::User {
            content,
            model,
            provider,
        } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            // Per-turn override falls back to socket-level sticky.
            let provider_pick = provider.as_deref().or(sticky_provider.as_deref());
            let model_pick = model.as_deref().or(sticky_model.as_deref());
            let approver = socket_approver.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
            }) {
                Ok(a) => a,
                Err(e) => {
                    send_error(ws_tx, &e.to_string()).await;
                    return true;
                }
            };
            // Persist the explicit selection as the new sticky.
            if provider.is_some() {
                *sticky_provider = provider;
            }
            if model.is_some() {
                *sticky_model = model;
            }
            conv.push(Message::user(content));
            let (event_tx, new_rx) = mpsc::channel::<AgentEvent>(64);
            *event_rx = Some(new_rx);
            let snapshot = conv.clone();
            let handle = tokio::spawn(async move {
                let mut stream = agent.run_stream(snapshot);
                while let Some(ev) = stream.next().await {
                    if event_tx.send(ev).await.is_err() {
                        return;
                    }
                }
            });
            *current_task = Some(handle);
        }
        WsClientMessage::Configure { model, provider } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn in progress; cannot configure").await;
                return true;
            }
            // Validate the picked combination by routing once; if
            // it's invalid we surface a clear error instead of
            // failing on the next `User` frame.
            if let Err(e) = state
                .providers
                .pick(provider.as_deref(), model.as_deref())
            {
                send_error(ws_tx, &e.to_string()).await;
                return true;
            }
            if provider.is_some() {
                *sticky_provider = provider;
            }
            if model.is_some() {
                *sticky_model = model;
            }
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "configured",
                        "provider": sticky_provider,
                        "model": sticky_model,
                    })
                    .to_string(),
                ))
                .await;
        }
        WsClientMessage::Reset => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn in progress; cannot reset").await;
                return true;
            }
            *conv = Conversation::new();
            *persisted_id = None;
            let _ = ws_tx
                .send(WsMessage::Text(json!({ "type": "reset" }).to_string()))
                .await;
        }
        WsClientMessage::Resume { id, model, provider } => {
            if provider.is_some() {
                *sticky_provider = provider;
            }
            if model.is_some() {
                *sticky_model = model;
            }
            if event_rx.is_some() {
                send_error(ws_tx, "turn in progress; cannot resume").await;
                return true;
            }
            if is_internal_id(&id) {
                send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                return true;
            }
            let Some(store) = state.store.as_ref() else {
                send_error(ws_tx, "persistence not configured").await;
                return true;
            };
            match store.load(&id).await {
                Ok(Some(loaded)) => {
                    let count = loaded.messages.len();
                    *conv = loaded;
                    *persisted_id = Some(id.clone());
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "resumed",
                                "id": id,
                                "message_count": count,
                            })
                            .to_string(),
                        ))
                        .await;
                }
                Ok(None) => {
                    send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                }
                Err(e) => {
                    error!(error = %e, "ws resume load failed");
                    send_error(ws_tx, &format!("load failed: {e}")).await;
                }
            }
        }
        WsClientMessage::New { id, model, provider } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn in progress; cannot start new").await;
                return true;
            }
            if provider.is_some() {
                *sticky_provider = provider;
            }
            if model.is_some() {
                *sticky_model = model;
            }
            if let Some(ref requested) = id {
                if is_internal_id(requested) {
                    send_error(
                        ws_tx,
                        "ids starting with `__` are reserved for internal use",
                    )
                    .await;
                    return true;
                }
            }
            let Some(store) = state.store.as_ref() else {
                send_error(ws_tx, "persistence not configured").await;
                return true;
            };
            let new_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
            *conv = Conversation::new();
            if let Err(e) = store.save(&new_id, conv).await {
                error!(error = %e, "ws new save failed");
                send_error(ws_tx, &format!("save failed: {e}")).await;
                return true;
            }
            *persisted_id = Some(new_id.clone());
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({ "type": "started", "id": new_id }).to_string(),
                ))
                .await;
        }
        WsClientMessage::Interrupt => {
            if let Some(handle) = current_task.take() {
                handle.abort();
            }
            *event_rx = None;
            // Roll back the trailing user message: the assistant
            // never replied, so leaving it in `conv` would make the
            // next turn look like back-to-back user turns to the
            // model. Some providers (Anthropic, Gemini) reject that.
            if matches!(conv.messages.last(), Some(Message::User { .. })) {
                conv.messages.pop();
            }
            pending.clear();
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({ "type": "interrupted" }).to_string(),
                ))
                .await;
        }
        WsClientMessage::Fork {
            user_ordinal,
            content,
            model,
            provider,
        } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            // Resolve user_ordinal → raw conversation index by
            // counting `Message::User` entries from the start.
            // Anything else (system / assistant / tool) is skipped
            // so the client can stay agnostic of the mixed shape.
            let from_index = match conv
                .messages
                .iter()
                .enumerate()
                .filter(|(_, m)| matches!(m, Message::User { .. }))
                .nth(user_ordinal)
                .map(|(i, _)| i)
            {
                Some(i) => i,
                None => {
                    send_error(
                        ws_tx,
                        &format!("fork user_ordinal {user_ordinal} not found"),
                    )
                    .await;
                    return true;
                }
            };
            // Drop the original user message and everything after it,
            // append the edited content as a fresh user turn, then
            // dispatch the same way `User` does.
            let provider_pick = provider.as_deref().or(sticky_provider.as_deref());
            let model_pick = model.as_deref().or(sticky_model.as_deref());
            let approver = socket_approver.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
            }) {
                Ok(a) => a,
                Err(e) => {
                    send_error(ws_tx, &e.to_string()).await;
                    return true;
                }
            };
            if provider.is_some() {
                *sticky_provider = provider;
            }
            if model.is_some() {
                *sticky_model = model;
            }
            conv.messages.truncate(from_index);
            conv.push(Message::user(content));
            // Notify the client that everything from this user
            // ordinal forward has been dropped server-side, so the
            // local mirror can prune the same prefix before the new
            // turn's events arrive.
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "forked",
                        "user_ordinal": user_ordinal,
                    })
                    .to_string(),
                ))
                .await;
            let (event_tx, new_rx) = mpsc::channel::<AgentEvent>(64);
            *event_rx = Some(new_rx);
            let snapshot = conv.clone();
            let handle = tokio::spawn(async move {
                let mut stream = agent.run_stream(snapshot);
                while let Some(ev) = stream.next().await {
                    if event_tx.send(ev).await.is_err() {
                        return;
                    }
                }
            });
            *current_task = Some(handle);
        }
    }
    true
}

async fn send_error(ws_tx: &mut SplitSink<WebSocket, WsMessage>, message: &str) {
    let _ = ws_tx
        .send(WsMessage::Text(
            json!({ "type": "error", "message": message }).to_string(),
        ))
        .await;
}
