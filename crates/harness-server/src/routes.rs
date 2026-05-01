use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
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
    canonicalize_workspace, AgentEvent, AgentProfileEvent, ApprovalDecision, Approver,
    ChannelApprover, Conversation, ConversationMetadata, DocEvent, HitlResponse, HitlStatus,
    Message, PendingHitl, RequirementEvent, RunOutcome, TodoEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

use uuid::Uuid;

use crate::conversations::{self, is_internal_id};
use crate::permissions;
use crate::project_binder::{materialise, strip_project_block};
use crate::projects::{self, lookup_project};
use crate::state::AppState;
use crate::ui;
use crate::workspace_diff;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/providers", get(list_providers))
        .route("/v1/workspace", get(get_workspace))
        .route("/v1/workspace/probe", get(probe_workspace))
        .route("/v1/server/info", get(get_server_info))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/chat/completions/stream", post(chat_completions_stream))
        .route("/v1/chat/ws", get(chat_ws))
        .merge(conversations::router())
        .merge(projects::router())
        .merge(permissions::router())
        .merge(workspace_diff::router())
        .merge(crate::mcp_routes::router())
        .merge(crate::skill_routes::router())
        .merge(crate::plugin_routes::router())
        .merge(crate::workspaces_routes::router())
        .merge(crate::todos_routes::router())
        .merge(crate::requirements_routes::router())
        .merge(crate::agent_profiles_routes::router())
        .merge(crate::provider_admin_routes::router())
        .merge(crate::docs_routes::router())
        .merge(ui::router())
        .fallback(ui::spa_fallback)
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn list_providers(State(state): State<AppState>) -> impl IntoResponse {
    let (default_name, providers) = {
        let guard = state
            .providers
            .read()
            .expect("provider registry poisoned");
        (guard.default_name().to_string(), guard.list())
    };
    Json(json!({
        "default": default_name,
        "providers": providers,
    }))
}

/// `GET /v1/workspace` — what root and VCS state am I operating in?
///
/// Returns `{root, vcs, branch?, head?, dirty?}`. Same shape as a
/// trimmed `workspace.context` (no manifest scan, no top-level
/// listing) — meant for at-a-glance UI badges and ops scripts. The
/// git probe runs each call so a long-lived UI sees branch /
/// dirty changes when it refreshes.
///
/// Returns 503 if the binary didn't pin a workspace root (test
/// harnesses, raw `AppState::new` callers) — the field is optional
/// on `AppState` but every realistic deployment sets it.
async fn get_workspace(State(state): State<AppState>) -> Response {
    let Some(root) = state.workspace_root.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspace root not configured" })),
        )
            .into_response();
    };
    let snapshot = workspace_snapshot(root).await;
    Json(snapshot).into_response()
}

#[derive(Debug, Deserialize)]
struct WorkspaceProbeQuery {
    path: String,
}

/// `GET /v1/workspace/probe?path=/repo` — inspect a candidate
/// workspace without changing the server-wide startup root. This is
/// intentionally read-only; the WS `set_workspace` / `new` frames
/// are still the only places that pin a session workspace.
async fn probe_workspace(Query(q): Query<WorkspaceProbeQuery>) -> Response {
    let candidate = std::path::PathBuf::from(&q.path);
    let resolved = match tokio::fs::canonicalize(&candidate).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("workspace `{}` is not reachable: {e}", q.path) })),
            )
                .into_response();
        }
    };
    if !resolved.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("workspace `{}` is not a directory", resolved.display()) })),
        )
            .into_response();
    }
    Json(workspace_snapshot(&resolved).await).into_response()
}

/// `GET /v1/server/info` — runtime snapshot of the jarvis serve
/// process. Read-only; the Settings page uses it to render the
/// "Server" section without the user having to grep env vars / read
/// the config file.
///
/// Response shape:
///
/// ```json
/// {
///   "version": "0.1.0",
///   "listen_addr": "0.0.0.0:7001" | null,
///   "config_path": "/.../config.json" | null,
///   "persistence": "sqlite" | null,         // URL scheme only — never the URL
///   "project_store": true,
///   "memory": { "mode": "summary", "budget_tokens": 8000 } | null,
///   "approval_mode": "auto" | "deny" | null,
///   "coding_mode": true,
///   "project_context": { "loaded": true, "max_bytes": 32768 } | null,
///   "system_prompt": { "length": 1234, "preview": "..." },
///   "max_iterations": 30,
///   "tools": ["fs.read", "fs.list", ...],
///   "tool_count": 17,
///   "mcp_servers": ["github"],
///   "providers": [...same shape as /v1/providers...],
///   "workspace_root": "/path" | null
/// }
/// ```
///
/// **No secrets**: persistence URL credentials, API keys, OAuth
/// tokens are never included.
async fn get_server_info(State(state): State<AppState>) -> Response {
    let info = &state.server_info;
    let template = &state.agent_template;

    // Tool list — sort for stable order in the UI.
    let mut tools: Vec<String> = template.tools.specs().into_iter().map(|s| s.name).collect();
    tools.sort();
    let tool_count = tools.len();

    let memory = info
        .memory_mode
        .as_ref()
        .map(|mode| {
            json!({
                "mode": mode,
                "budget_tokens": info.memory_budget_tokens,
            })
        })
        .unwrap_or(serde_json::Value::Null);

    let project_context = if info.project_context_loaded {
        json!({
            "loaded": true,
            "max_bytes": info.project_context_bytes_cap,
        })
    } else {
        json!({
            "loaded": false,
            "max_bytes": info.project_context_bytes_cap,
        })
    };

    let prompt_text = template.system_prompt.as_deref().unwrap_or("");
    let prompt_len = prompt_text.chars().count();
    let preview_len = prompt_len.min(280);
    let preview: String = prompt_text.chars().take(preview_len).collect();

    let providers_snapshot = {
        let guard = state.providers.read().expect("provider registry poisoned");
        guard.list()
    };

    Json(json!({
        "version": info.version,
        "listen_addr": info.listen_addr,
        "config_path": info.config_path.as_ref().map(|p| p.display().to_string()),
        "persistence": info.persistence_scheme,
        "project_store": state.projects.is_some(),
        "memory": memory,
        "approval_mode": info.approval_mode,
        "coding_mode": info.coding_mode,
        "project_context": project_context,
        "system_prompt": {
            "length": prompt_len,
            "preview": preview,
        },
        "max_iterations": template.max_iterations,
        "tools": tools,
        "tool_count": tool_count,
        "mcp_servers": info.mcp_prefixes,
        "providers": providers_snapshot,
        "workspace_root": state.workspace_root.as_ref().map(|p| p.display().to_string()),
    }))
    .into_response()
}

async fn workspace_snapshot(root: &std::path::Path) -> serde_json::Value {
    let canonical = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let display = canonical.display().to_string();
    let git = probe_git(&canonical).await;
    match git {
        Some(g) => json!({
            "root": display,
            "vcs": "git",
            "branch": g.branch,
            "head": g.head,
            "dirty": g.dirty,
        }),
        None => json!({
            "root": display,
            "vcs": "none",
        }),
    }
}

struct GitSnapshot {
    branch: Option<String>,
    head: Option<String>,
    dirty: bool,
}

async fn probe_git(root: &std::path::Path) -> Option<GitSnapshot> {
    use std::process::Stdio;
    use tokio::process::Command;
    let run = |args: Vec<&'static str>| {
        let root = root.to_path_buf();
        async move {
            let out = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output()
                .await
                .ok()?;
            if !out.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    };
    let inside = run(vec!["rev-parse", "--is-inside-work-tree"]).await?;
    if inside != "true" {
        return None;
    }
    let branch = run(vec!["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .filter(|s| !s.is_empty() && s != "HEAD");
    let head = run(vec!["rev-parse", "--short", "HEAD"])
        .await
        .filter(|s| !s.is_empty());
    let dirty = !run(vec!["status", "--porcelain"])
        .await
        .unwrap_or_default()
        .is_empty();
    Some(GitSnapshot {
        branch,
        head,
        dirty,
    })
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
    let mut conv = Conversation {
        messages: req.messages,
    };
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
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

// -------------------- /v1/chat/completions/stream (SSE) --------------------

async fn chat_completions_stream(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let conv = Conversation {
        messages: req.messages,
    };
    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => return route_error(e),
    };
    let stream = agent.run_stream(conv).map(|event| {
        let payload = serde_json::to_string(&event)
            .unwrap_or_else(|e| format!(r#"{{"type":"error","message":"serialize: {e}"}}"#));
        Ok::<_, Infallible>(Event::default().data(payload))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
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
        #[serde(default)]
        soul_prompt: Option<String>,
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
    /// server allocates a UUID and reports it back. Optional
    /// `project_id` (UUID or slug) binds the new conversation to a
    /// project — its instructions are then re-injected as a system
    /// message at every turn (see `crate::project_binder`). Optional
    /// `workspace_path` pins this socket's filesystem root and
    /// records the binding in the workspaces registry so a future
    /// `Resume` restores it.
    New {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
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
    /// Respond to a native HITL request emitted by an `ask.*` tool.
    HitlResponse {
        request_id: String,
        status: HitlStatus,
        #[serde(default)]
        payload: Option<Value>,
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
        #[serde(default)]
        soul_prompt: Option<String>,
    },
    /// Switch the per-socket permission mode at runtime. Bypass is
    /// rejected — that mode requires `--dangerously-skip-permissions`
    /// at process start and isn't reachable via WS.
    SetMode { mode: harness_core::PermissionMode },
    /// Accept a previously-emitted plan (`AgentEvent::PlanProposed`)
    /// and switch to `post_mode` so subsequent turns can execute.
    /// The agent does not auto-resume — the user's next message
    /// kicks off the next turn in the new mode.
    AcceptPlan {
        post_mode: harness_core::PermissionMode,
    },
    /// Send refinement feedback for a proposed plan. Equivalent to
    /// sending a `User` frame with the same content; kept as a
    /// distinct frame so the client can label the bubble.
    RefinePlan { feedback: String },
    /// Activate a skill on this socket. Subsequent agent turns
    /// prepend the skill's body to the system prompt. Idempotent —
    /// activating an already-active skill is a no-op. Server replies
    /// with `skill_activated { name, active: [..] }` (or an `error`
    /// frame if the catalogue / name is missing).
    ActivateSkill { name: String },
    /// Deactivate a skill on this socket. No-op if the skill wasn't
    /// active. Server replies with `skill_deactivated`.
    DeactivateSkill { name: String },
    /// Pin a per-socket workspace root. Subsequent turns run their
    /// fs / git / shell / grep tools against this path instead of
    /// the binary's startup workspace. `path: null` clears the
    /// override and falls back to the startup root.
    ///
    /// Server replies with `workspace_changed { path }` on
    /// success, or an `error` frame if the path doesn't exist or
    /// isn't a directory.
    SetWorkspace { path: Option<String> },
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
        WsClientMessage::HitlResponse { .. } => "hitl_response",
        WsClientMessage::Interrupt => "interrupt",
        WsClientMessage::Fork { .. } => "fork",
        WsClientMessage::SetMode { .. } => "set_mode",
        WsClientMessage::AcceptPlan { .. } => "accept_plan",
        WsClientMessage::RefinePlan { .. } => "refine_plan",
        WsClientMessage::ActivateSkill { .. } => "activate_skill",
        WsClientMessage::DeactivateSkill { .. } => "deactivate_skill",
        WsClientMessage::SetWorkspace { .. } => "set_workspace",
    }
}

struct TurnInjection {
    project: crate::project_binder::PreparedConversation,
    /// Prepared TODO injection state. The injection happens *after*
    /// the project block (so the order is `[base systems, project,
    /// todos, rest]`). Stripping reverses both.
    todos: crate::todo_binder::PreparedTodos,
    soul_injected_at: Option<usize>,
}

fn inject_soul_prompt(
    conv: Conversation,
    soul_prompt: Option<&str>,
) -> (Conversation, Option<usize>) {
    let Some(prompt) = soul_prompt.map(str::trim).filter(|s| !s.is_empty()) else {
        return (conv, None);
    };
    let mut messages = conv.messages;
    let pos = leading_system_count(&messages);
    messages.insert(
        pos,
        Message::system(format!("=== Jarvis soul ===\n{prompt}")),
    );
    (Conversation { messages }, Some(pos))
}

fn strip_turn_injections(conv: Conversation, prepared: &TurnInjection) -> Conversation {
    // Strip in reverse insertion order: TODOs went in *after* the
    // project block (so on later indices), so removing them first
    // keeps the project-block index stable.
    let conv = crate::todo_binder::strip_todo_block(conv, &prepared.todos);
    let mut conv = strip_project_block(conv, &prepared.project);
    let Some(idx) = prepared.soul_injected_at else {
        return conv;
    };
    if idx >= conv.messages.len() {
        return conv;
    }
    let should_remove = matches!(
        &conv.messages[idx],
        Message::System { content, .. } if content.starts_with("=== Jarvis soul ===\n")
    );
    if should_remove {
        conv.messages.remove(idx);
    }
    conv
}

/// Resolve the active workspace path for the current socket: prefer
/// the per-socket override, fall back to the binary's startup root.
/// Returns the canonicalised string form ready to query the TODO
/// store with.
fn active_workspace_key(
    state: &AppState,
    socket_workspace: Option<&std::path::Path>,
) -> Option<String> {
    let path = socket_workspace
        .map(|p| p.to_path_buf())
        .or_else(|| state.workspace_root.clone())?;
    Some(canonicalize_workspace(&path))
}

fn leading_system_count(messages: &[Message]) -> usize {
    messages
        .iter()
        .take_while(|m| matches!(m, Message::System { .. }))
        .count()
}

async fn chat_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// Compose a per-turn system prompt by prepending the bodies of
/// the currently-active skills to the template. Each skill is wrapped
/// in a fenced header so the model can tell injected guidance from
/// its own template:
///
/// ```text
/// === skill: code-review ===
/// <skill body>
/// === /skill ===
/// ```
///
/// Returns `None` when the catalogue is absent or no active skill
/// resolved to a known entry — leaves `cfg.system_prompt` alone.
/// Default cap on how many auto-activated skills to inject per turn.
/// Two keeps the system-prompt overhead small while still letting two
/// orthogonal skills (e.g. "code-review" + "pdf-helper") fire on a
/// mixed query. Reachable via [`merged_skills_for_turn`].
const AUTO_SKILL_TOP_K: usize = 2;

/// Build the per-turn skill list: manual activations first, then up
/// to `AUTO_SKILL_TOP_K` auto-picks scored against the user's
/// most recent message. Manual entries always survive; auto entries
/// are deduped against the manual set so the same body never gets
/// injected twice.
fn merged_skills_for_turn(
    catalog: Option<&Arc<std::sync::RwLock<harness_skill::SkillCatalog>>>,
    manual_active: &[String],
    user_content: &str,
) -> Vec<String> {
    let mut merged: Vec<String> = manual_active.to_vec();
    let Some(cat_arc) = catalog else {
        return merged;
    };
    let Ok(guard) = cat_arc.read() else {
        return merged;
    };
    let picks =
        harness_skill::pick_auto_skills(&guard, user_content, AUTO_SKILL_TOP_K, manual_active);
    for n in picks {
        if !merged.iter().any(|m| m == &n) {
            merged.push(n);
        }
    }
    merged
}

fn compose_with_skills(
    template: Option<&str>,
    catalog: Option<&Arc<std::sync::RwLock<harness_skill::SkillCatalog>>>,
    active_names: &[String],
) -> Option<String> {
    let cat = catalog?;
    let guard = cat.read().ok()?;
    let mut bodies: Vec<String> = Vec::new();
    for name in active_names {
        if let Some(entry) = guard.get(name) {
            if entry.body.trim().is_empty() {
                continue;
            }
            bodies.push(format!(
                "=== skill: {name} ===\n{}\n=== /skill ===",
                entry.body.trim_end()
            ));
        }
    }
    if bodies.is_empty() {
        return None;
    }
    let prefix = bodies.join("\n\n");
    let composed = match template {
        Some(t) if !t.is_empty() => format!("{prefix}\n\n{t}"),
        _ => prefix,
    };
    Some(composed)
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
    // Per-socket mode handle. Drives `RuleApprover`'s mode-default
    // computation; flipped at runtime via the `set_mode` /
    // `accept_plan` WS frames. Process-wide rules + per-socket mode
    // is the right split: rules persist across reconnects but each
    // session can be in a different mode.
    let mode_handle = std::sync::Arc::new(tokio::sync::RwLock::new(state.default_permission_mode));
    // If a permission store is wired up, wrap the channel approver
    // in a `RuleApprover` so allow / deny rules + mode defaults
    // short-circuit before reaching the WS prompt. Without a store
    // we fall back to the historical "always prompt" behaviour for
    // every gated call.
    let channel_approver_arc: Arc<dyn Approver> = Arc::new(channel_approver);
    let socket_approver: Arc<dyn Approver> = match state.permission_store.as_ref() {
        Some(store) => Arc::new(harness_core::permission::RuleApprover::new(
            store.clone(),
            channel_approver_arc.clone(),
            mode_handle.clone(),
        )),
        None => channel_approver_arc.clone(),
    };
    // Subscribe to permission-store mutations so we can fan a
    // `PermissionRulesChanged` event out to this socket whenever any
    // socket (or external file edit) changes the rule table.
    let mut rules_changed_rx = state.permission_store.as_ref().map(|s| s.subscribe());
    // Subscribe to TODO-store mutations. Both REST and `todo.*` tool
    // mutations broadcast through the same store sender, so a single
    // emit reaches every connected client (including the one that
    // triggered it). Per-event we filter by the socket's pinned
    // workspace so multi-window UIs don't cross-contaminate.
    let mut todos_changed_rx = state.todos.as_ref().map(|s| s.subscribe());
    // Subscribe to Requirement-store mutations. Same fanout pattern
    // as TODOs but scoped by `project_id` (no socket-level filter
    // today: the `/projects` kanban Web UI listens globally and
    // routes events to the right project list itself).
    let mut requirements_changed_rx = state.requirements.as_ref().map(|s| s.subscribe());
    // Subscribe to Doc-store mutations. Same fanout pattern as
    // requirements; the `/docs` page listens globally and routes
    // events by project_id itself.
    let mut docs_changed_rx = state.docs.as_ref().map(|s| s.subscribe());
    // Subscribe to AgentProfile-store mutations. Server-global; every
    // connected client sees every change (the Settings page and any
    // future assignee picker rerender accordingly).
    let mut agent_profiles_changed_rx = state.agent_profiles.as_ref().map(|s| s.subscribe());
    // Subscribe to provider-registry mutations (the
    // `POST/PATCH/DELETE /v1/providers` admin routes). One bare tick
    // per change; clients refetch `/v1/providers` on receipt to
    // repopulate the model picker, default badge, etc.
    let mut providers_changed_rx = state.providers_changed.subscribe();
    let (hitl_tx, mut pending_hitl_rx) = mpsc::channel::<PendingHitl>(8);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut conv = Conversation::new();
    let mut persisted_id: Option<String> = None;
    // Project binding for the persisted conversation (only meaningful
    // when `persisted_id` is `Some`). Drives the `ProjectBinder`'s
    // per-turn instruction injection. Set on `New { project_id }` /
    // re-loaded on `Resume`. `None` = "free chat" persisted session.
    let mut persisted_project_id: Option<String> = None;
    // State carried from binder.materialise → terminal Done so the
    // strip step removes the right injected message.
    let mut last_injection: Option<TurnInjection> = None;
    let mut pending: HashMap<String, oneshot::Sender<ApprovalDecision>> = HashMap::new();
    let mut pending_hitl: HashMap<String, oneshot::Sender<HitlResponse>> = HashMap::new();
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
    // Per-socket skill activation. Each entry is a skill `name` from
    // the catalogue; the agent's per-turn `build_agent_with`
    // closure looks each one up and prepends its body to the
    // system prompt. Order is insertion order so the model sees
    // them in the same order the user activated them.
    let mut active_skills: Vec<String> = Vec::new();
    // Per-socket workspace override. `None` means "use the binary's
    // startup workspace" (the historical behaviour). When `Some`,
    // the path is installed as a `crate::workspace::with_session_workspace`
    // scope around every tool invocation in this socket's turns,
    // so fs / git / shell / grep tools target it.
    let mut socket_workspace: Option<std::path::PathBuf> = None;

    // Tell the client the initial mode so it can render the badge
    // before any user interaction. Always sent; even when no
    // permission store is configured the value is meaningful (it's
    // the binary's default mode).
    {
        let initial = mode_handle.read().await;
        let _ = ws_tx
            .send(WsMessage::Text(
                json!({ "type": "permission_mode", "mode": *initial }).to_string(),
            ))
            .await;
    }

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
                    &mode_handle,
                    &mut conv,
                    &mut persisted_id,
                    &mut persisted_project_id,
                    &mut last_injection,
                    &mut pending,
                    &mut pending_hitl,
                    &mut event_rx,
                    &mut current_task,
                    &mut sticky_provider,
                    &mut sticky_model,
                    &mut active_skills,
                    &mut socket_workspace,
                    &hitl_tx,
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
            // ---- permission rules changed ----
            // Fan a single short event out so connected clients can
            // refetch `/v1/permissions`. We keep the wire-side
            // payload empty to avoid sending the (potentially large)
            // table on every keystroke of `Add rule`.
            Ok(()) = async {
                match rules_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map(|_| ()).map_err(|_| ()),
                    None => std::future::pending::<Result<(), ()>>().await,
                }
            } => {
                let _ = ws_tx
                    .send(WsMessage::Text(
                        json!({ "type": "permission_rules_changed" }).to_string(),
                    ))
                    .await;
            }
            // ---- todo store mutated (REST or tool) ----
            // Both REST handlers and the agent's `todo.*` tools call
            // the store's mutators, which fan out a single
            // `TodoEvent` per change. We filter by the socket's
            // active workspace so multi-window UIs pinned to
            // different roots don't see each other's updates. Lagged
            // receivers fall through to a refetch via REST.
            Ok(ev) = async {
                match todos_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<TodoEvent, ()>>().await,
                }
            } => {
                let active_ws_path = socket_workspace
                    .as_deref()
                    .map(|p| p.to_path_buf())
                    .or_else(|| state.workspace_root.clone());
                let active_ws = active_ws_path.as_deref().map(canonicalize_workspace);
                if active_ws.as_deref() == Some(ev.workspace()) {
                    let frame = match &ev {
                        TodoEvent::Upserted(item) => {
                            json!({ "type": "todo_upserted", "todo": item })
                        }
                        TodoEvent::Deleted { workspace, id } => {
                            json!({ "type": "todo_deleted", "id": id, "workspace": workspace })
                        }
                    };
                    let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
                }
            }
            // ---- requirement store mutated (REST or tool) ----
            // The store fans out a single `RequirementEvent` per
            // change; we forward as `requirement_upserted` /
            // `requirement_deleted` to every connected client
            // unconditionally (no per-socket filter — the
            // `/projects` kanban routes events to the right
            // project list itself).
            Ok(ev) = async {
                match requirements_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<RequirementEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    RequirementEvent::Upserted(item) => {
                        json!({ "type": "requirement_upserted", "requirement": item })
                    }
                    RequirementEvent::Deleted { project_id, id } => {
                        json!({
                            "type": "requirement_deleted",
                            "id": id,
                            "project_id": project_id
                        })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- doc store mutated (REST or future tool) ----
            Ok(ev) = async {
                match docs_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<DocEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    DocEvent::ProjectUpserted(item) => {
                        json!({ "type": "doc_project_upserted", "project": item })
                    }
                    DocEvent::ProjectDeleted { workspace, id } => {
                        json!({
                            "type": "doc_project_deleted",
                            "id": id,
                            "workspace": workspace
                        })
                    }
                    DocEvent::DraftUpserted(item) => {
                        json!({ "type": "doc_draft_upserted", "draft": item })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- agent profile store mutated (REST) ----
            // Server-global fanout: every connected client sees every
            // mutation. The Settings page and any future assignee
            // picker re-render off this stream.
            Ok(ev) = async {
                match agent_profiles_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<AgentProfileEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    AgentProfileEvent::Upserted(item) => {
                        json!({ "type": "agent_profile_upserted", "profile": item })
                    }
                    AgentProfileEvent::Deleted { id } => {
                        json!({ "type": "agent_profile_deleted", "id": id })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- provider registry mutated (REST admin) ----
            // Bare tick: clients refetch /v1/providers on receipt.
            // No payload — keeps the wire small and avoids leaking
            // api-key state in the broadcast.
            Ok(()) = async {
                providers_changed_rx.recv().await.map(|_| ()).map_err(|_| ())
            } => {
                let frame = json!({ "type": "providers_changed" });
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- native HITL tool → server ----
            Some(p) = pending_hitl_rx.recv() => {
                let id = p.request.id.clone();
                let payload = json!({ "type": "hitl_request", "request": p.request }).to_string();
                pending_hitl.insert(id, p.responder);
                if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                    return;
                }
            }
            // ---- agent → server ----
            ev = event_fut => {
                let Some(ev) = ev else {
                    // Sender dropped → turn is fully drained.
                    event_rx = None;
                    pending.clear();
                    pending_hitl.clear();
                    continue;
                };

                let is_terminal = matches!(
                    ev,
                    AgentEvent::Done { .. } | AgentEvent::Error { .. }
                );
                let is_error = matches!(ev, AgentEvent::Error { .. });
                // Strip the synthetic project block (if any) before
                // mutating either the local mirror or what we send to
                // the client. The client never sees it; the persisted
                // history never stores it.
                let mut ev_to_send = ev;
                if let AgentEvent::Done { conversation, .. } = &mut ev_to_send {
                    if let Some(prepared) = last_injection.as_ref() {
                        *conversation = strip_turn_injections(conversation.clone(), prepared);
                    }
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

                let payload = serde_json::to_string(&ev_to_send).unwrap_or_else(|e| {
                    json!({ "type": "error", "message": format!("serialize: {e}") })
                        .to_string()
                });
                if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                    return;
                }

                if is_terminal {
                    event_rx = None;
                    current_task = None;
                    last_injection = None;
                    // Drop any leftover responders — the agent has
                    // stopped so nothing is waiting on them anyway.
                    pending.clear();
                    pending_hitl.clear();
                    if let (Some(id), Some(store)) =
                        (persisted_id.as_ref(), state.store.as_ref())
                    {
                        let metadata = ConversationMetadata {
                            project_id: persisted_project_id.clone(),
                        };
                        if let Err(e) = store.save_envelope(id, &conv, &metadata).await {
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
    mode_handle: &Arc<tokio::sync::RwLock<harness_core::PermissionMode>>,
    conv: &mut Conversation,
    persisted_id: &mut Option<String>,
    persisted_project_id: &mut Option<String>,
    last_injection: &mut Option<TurnInjection>,
    pending: &mut HashMap<String, oneshot::Sender<ApprovalDecision>>,
    pending_hitl: &mut HashMap<String, oneshot::Sender<HitlResponse>>,
    event_rx: &mut Option<mpsc::Receiver<AgentEvent>>,
    current_task: &mut Option<tokio::task::JoinHandle<()>>,
    sticky_provider: &mut Option<String>,
    sticky_model: &mut Option<String>,
    active_skills: &mut Vec<String>,
    socket_workspace: &mut Option<std::path::PathBuf>,
    hitl_tx: &mpsc::Sender<PendingHitl>,
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
        WsClientMessage::Deny {
            tool_call_id,
            reason,
        } => {
            if let Some(responder) = pending.remove(&tool_call_id) {
                let _ = responder.send(ApprovalDecision::Deny { reason });
            } else {
                warn!(%tool_call_id, "deny frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::HitlResponse {
            request_id,
            status,
            payload,
            reason,
        } => {
            let response = HitlResponse {
                request_id: request_id.clone(),
                status,
                payload,
                reason,
            };
            if let Some(responder) = pending_hitl.remove(&request_id) {
                let _ = responder.send(response.clone());
                let _ = ws_tx
                    .send(WsMessage::Text(
                        json!({ "type": "hitl_response", "response": response }).to_string(),
                    ))
                    .await;
            } else {
                warn!(%request_id, "hitl_response frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::User {
            content,
            model,
            provider,
            soul_prompt,
        } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            // Per-turn override falls back to socket-level sticky.
            let provider_pick = provider.as_deref().or(sticky_provider.as_deref());
            let model_pick = model.as_deref().or(sticky_model.as_deref());
            let approver = socket_approver.clone();
            let hitl = hitl_tx.clone();
            // Apply Plan-Mode tool filter if the per-socket mode says
            // so. Done per-turn (not once at socket open) so a mid-
            // session `set_mode` flip takes effect on the next message.
            let active_mode = *mode_handle.read().await;
            let skills_catalog = state.skills.as_ref().cloned();
            let skills_snapshot =
                merged_skills_for_turn(skills_catalog.as_ref(), active_skills, &content);
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) = compose_with_skills(
                    cfg.system_prompt.as_deref(),
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                ) {
                    cfg.system_prompt = Some(prompt);
                }
                if workspace_for_turn.is_some() {
                    cfg.session_workspace = workspace_for_turn;
                }
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
            let (soul_conv, soul_injected_at) =
                inject_soul_prompt(conv.clone(), soul_prompt.as_deref());
            // Late-bind the project (no-op for free-chat sessions).
            let prepared = match materialise(
                state.projects.as_ref(),
                soul_conv,
                persisted_project_id.as_deref(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    send_error(ws_tx, &format!("project binder: {e}")).await;
                    // Roll back the user message we just pushed.
                    conv.messages.pop();
                    return true;
                }
            };
            // Late-bind the persistent TODO list (no-op when no
            // store / no workspace / opt-out).
            let workspace_key =
                active_workspace_key(state, socket_workspace.as_deref());
            let (snapshot, todos_prepared) = match crate::todo_binder::materialise_todos(
                state.todos.as_ref(),
                prepared.conversation.clone(),
                workspace_key.as_deref(),
                state.todos_in_prompt,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    send_error(ws_tx, &format!("todo binder: {e}")).await;
                    conv.messages.pop();
                    return true;
                }
            };
            *last_injection = Some(TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at,
            });
            let (event_tx, new_rx) = mpsc::channel::<AgentEvent>(64);
            *event_rx = Some(new_rx);
            let handle = tokio::spawn(async move {
                harness_core::todo::with_turn_budget(async move {
                    let mut stream = agent.run_stream(snapshot);
                    while let Some(ev) = stream.next().await {
                        if event_tx.send(ev).await.is_err() {
                            return;
                        }
                    }
                })
                .await;
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
            let routing_check = {
                let guard = state.providers.read().expect("provider registry poisoned");
                guard.pick(provider.as_deref(), model.as_deref()).map(|_| ())
            };
            if let Err(e) = routing_check {
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
            *persisted_project_id = None;
            let _ = ws_tx
                .send(WsMessage::Text(json!({ "type": "reset" }).to_string()))
                .await;
        }
        WsClientMessage::Resume {
            id,
            model,
            provider,
        } => {
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
            match store.load_envelope(&id).await {
                Ok(Some((loaded, meta))) => {
                    let count = loaded.messages.len();
                    let bound_project = meta.project_id.clone();
                    *conv = loaded;
                    *persisted_id = Some(id.clone());
                    *persisted_project_id = bound_project.clone();
                    // Restore per-conversation workspace pin if the
                    // store has one. We canonicalize on the way in
                    // so a moved-since-last-time folder surfaces an
                    // error rather than silently falling back.
                    let bound_workspace = state.workspaces.as_ref().and_then(|s| s.lookup(&id));
                    if let Some(path_str) = bound_workspace.as_deref() {
                        match std::fs::canonicalize(path_str) {
                            Ok(p) if p.is_dir() => {
                                *socket_workspace = Some(p.clone());
                                let workspace_info = workspace_snapshot(&p).await;
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({
                                            "type": "workspace_changed",
                                            "path": p.display().to_string(),
                                            "workspace": workspace_info,
                                        })
                                        .to_string(),
                                    ))
                                    .await;
                            }
                            _ => {
                                warn!(
                                    convo = %id,
                                    path = %path_str,
                                    "bound workspace no longer exists; clearing pin",
                                );
                                if let Some(s) = state.workspaces.as_ref() {
                                    s.unbind(&id);
                                }
                                *socket_workspace = None;
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({ "type": "workspace_changed", "path": null })
                                            .to_string(),
                                    ))
                                    .await;
                            }
                        }
                    } else {
                        *socket_workspace = None;
                        let _ = ws_tx
                            .send(WsMessage::Text(
                                json!({ "type": "workspace_changed", "path": null }).to_string(),
                            ))
                            .await;
                    }
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "resumed",
                                "id": id,
                                "message_count": count,
                                "project_id": bound_project,
                                "workspace_path": bound_workspace,
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
        WsClientMessage::New {
            id,
            model,
            provider,
            project_id,
            workspace_path,
        } => {
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

            // Resolve project binding (UUID or slug → UUID) before
            // creating the row. Refuse archived / missing.
            let resolved_project_id: Option<String> = match project_id.as_ref() {
                None => None,
                Some(needle) => {
                    let Some(ps) = state.projects.as_ref() else {
                        send_error(
                            ws_tx,
                            "project store not configured; cannot bind to a project",
                        )
                        .await;
                        return true;
                    };
                    match lookup_project(ps.as_ref(), needle).await {
                        Ok(Some(p)) if !p.archived => Some(p.id),
                        Ok(Some(_)) => {
                            send_error(ws_tx, &format!("project `{needle}` is archived")).await;
                            return true;
                        }
                        Ok(None) => {
                            send_error(ws_tx, &format!("project `{needle}` not found")).await;
                            return true;
                        }
                        Err(e) => {
                            send_error(ws_tx, &format!("project lookup failed: {e}")).await;
                            return true;
                        }
                    }
                }
            };

            let new_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
            *conv = Conversation::new();
            // Deferred persistence: we DON'T write the empty
            // conversation row to the store now. The first User
            // turn's post-run save flushes everything atomically
            // with whatever metadata is on this socket at the time
            // (including any in-the-meantime `set_mode` /
            // `set_workspace` flips). The earlier `state.store`
            // require above stays so we still refuse `New` when
            // persistence isn't configured — the difference is
            // only whether we call `save_envelope` here.
            let _ = store; // intentionally unused — see comment above
            *persisted_id = Some(new_id.clone());
            *persisted_project_id = resolved_project_id.clone();

            // Optional workspace pin. Validate the same way
            // SetWorkspace does, then bind it in the registry so
            // Resume restores it. Failure here surfaces as an
            // error and aborts — we already saved the conversation
            // row, but the user's next attempt can use a different
            // path (the `started` echo isn't sent on this path).
            let mut bound_workspace_info: Option<Value> = None;
            let bound_workspace = if let Some(raw) = workspace_path.as_deref() {
                match std::fs::canonicalize(raw) {
                    Ok(p) if p.is_dir() => {
                        *socket_workspace = Some(p.clone());
                        if let Some(ws) = state.workspaces.as_ref() {
                            let path_str = p.display().to_string();
                            let _ = ws.touch(&path_str);
                            ws.bind(&new_id, &path_str);
                        }
                        bound_workspace_info = Some(workspace_snapshot(&p).await);
                        Some(p.display().to_string())
                    }
                    Ok(p) => {
                        send_error(
                            ws_tx,
                            &format!("workspace `{}` is not a directory", p.display()),
                        )
                        .await;
                        return true;
                    }
                    Err(e) => {
                        send_error(ws_tx, &format!("workspace `{raw}` is not reachable: {e}"))
                            .await;
                        return true;
                    }
                }
            } else {
                None
            };

            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "started",
                        "id": new_id,
                        "project_id": resolved_project_id,
                        "workspace_path": bound_workspace,
                        "workspace": bound_workspace_info,
                    })
                    .to_string(),
                ))
                .await;
        }
        WsClientMessage::Interrupt => {
            if let Some(handle) = current_task.take() {
                handle.abort();
            }
            *event_rx = None;
            *last_injection = None;
            // Roll back the trailing user message: the assistant
            // never replied, so leaving it in `conv` would make the
            // next turn look like back-to-back user turns to the
            // model. Some providers (Anthropic, Gemini) reject that.
            if matches!(conv.messages.last(), Some(Message::User { .. })) {
                conv.messages.pop();
            }
            pending.clear();
            pending_hitl.clear();
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
            soul_prompt,
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
            let hitl = hitl_tx.clone();
            let active_mode = *mode_handle.read().await;
            let skills_catalog = state.skills.as_ref().cloned();
            let skills_snapshot =
                merged_skills_for_turn(skills_catalog.as_ref(), active_skills, &content);
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) = compose_with_skills(
                    cfg.system_prompt.as_deref(),
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                ) {
                    cfg.system_prompt = Some(prompt);
                }
                if workspace_for_turn.is_some() {
                    cfg.session_workspace = workspace_for_turn;
                }
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
            let (soul_conv, soul_injected_at) =
                inject_soul_prompt(conv.clone(), soul_prompt.as_deref());
            // Same late-binding dance as `User`.
            let prepared = match materialise(
                state.projects.as_ref(),
                soul_conv,
                persisted_project_id.as_deref(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    send_error(ws_tx, &format!("project binder: {e}")).await;
                    conv.messages.pop(); // roll back the new user message
                    return true;
                }
            };
            let workspace_key =
                active_workspace_key(state, socket_workspace.as_deref());
            let (snapshot, todos_prepared) = match crate::todo_binder::materialise_todos(
                state.todos.as_ref(),
                prepared.conversation.clone(),
                workspace_key.as_deref(),
                state.todos_in_prompt,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    send_error(ws_tx, &format!("todo binder: {e}")).await;
                    conv.messages.pop();
                    return true;
                }
            };
            *last_injection = Some(TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at,
            });
            let (event_tx, new_rx) = mpsc::channel::<AgentEvent>(64);
            *event_rx = Some(new_rx);
            let handle = tokio::spawn(async move {
                harness_core::todo::with_turn_budget(async move {
                    let mut stream = agent.run_stream(snapshot);
                    while let Some(ev) = stream.next().await {
                        if event_tx.send(ev).await.is_err() {
                            return;
                        }
                    }
                })
                .await;
            });
            *current_task = Some(handle);
        }
        WsClientMessage::SetMode { mode } => {
            // Bypass used to require boot-time `--dangerously-skip-permissions`
            // for runtime entry too. We've since relaxed that: the
            // operator who opened the browser already has the same
            // privileges as the operator who started the server, so
            // forcing a process restart just to flip a UI switch is
            // bureaucratic. The CLI flag still exists for unattended
            // / CI use where there's no human to click confirm.
            // We log loudly so the audit trail captures it.
            if matches!(mode, harness_core::PermissionMode::Bypass) {
                tracing::warn!(
                    "permission mode set to BYPASS at runtime via WS — \
                     all gated tools will run without prompting until reset",
                );
            }
            *mode_handle.write().await = mode;
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({ "type": "permission_mode", "mode": mode }).to_string(),
                ))
                .await;
        }
        WsClientMessage::AcceptPlan { post_mode } => {
            if matches!(post_mode, harness_core::PermissionMode::Bypass) {
                tracing::warn!(
                    "plan accepted with post-mode=BYPASS — all gated tools \
                     will run without prompting for the rest of this session",
                );
            }
            *mode_handle.write().await = post_mode;
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "permission_mode",
                        "mode": post_mode,
                        "via": "plan_accepted",
                    })
                    .to_string(),
                ))
                .await;
        }
        WsClientMessage::RefinePlan { feedback } => {
            // Equivalent to a User frame — feed the feedback back to
            // the agent in the current (Plan) mode so it iterates on
            // the plan rather than executing.
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            let provider_pick = sticky_provider.as_deref();
            let model_pick = sticky_model.as_deref();
            let approver = socket_approver.clone();
            let hitl = hitl_tx.clone();
            // Plan Mode tool filter applied here too — same as the User
            // arm. We rebuild on each turn so per-socket mode is
            // honoured even if the user just toggled it.
            let active_mode = *mode_handle.read().await;
            let skills_catalog = state.skills.as_ref().cloned();
            let skills_snapshot =
                merged_skills_for_turn(skills_catalog.as_ref(), active_skills, &feedback);
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) = compose_with_skills(
                    cfg.system_prompt.as_deref(),
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                ) {
                    cfg.system_prompt = Some(prompt);
                }
                if workspace_for_turn.is_some() {
                    cfg.session_workspace = workspace_for_turn;
                }
            }) {
                Ok(a) => a,
                Err(e) => {
                    send_error(ws_tx, &e.to_string()).await;
                    return true;
                }
            };
            conv.push(Message::user(feedback));
            let prepared = match materialise(
                state.projects.as_ref(),
                conv.clone(),
                persisted_project_id.as_deref(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => {
                    send_error(ws_tx, &format!("project binder: {e}")).await;
                    conv.messages.pop();
                    return true;
                }
            };
            let workspace_key =
                active_workspace_key(state, socket_workspace.as_deref());
            let (snapshot, todos_prepared) = match crate::todo_binder::materialise_todos(
                state.todos.as_ref(),
                prepared.conversation.clone(),
                workspace_key.as_deref(),
                state.todos_in_prompt,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    send_error(ws_tx, &format!("todo binder: {e}")).await;
                    conv.messages.pop();
                    return true;
                }
            };
            *last_injection = Some(TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at: None,
            });
            let (event_tx, new_rx) = mpsc::channel::<AgentEvent>(64);
            *event_rx = Some(new_rx);
            let handle = tokio::spawn(async move {
                harness_core::todo::with_turn_budget(async move {
                    let mut stream = agent.run_stream(snapshot);
                    while let Some(ev) = stream.next().await {
                        if event_tx.send(ev).await.is_err() {
                            return;
                        }
                    }
                })
                .await;
            });
            *current_task = Some(handle);
        }
        WsClientMessage::ActivateSkill { name } => {
            let Some(catalog) = state.skills.as_ref() else {
                send_error(ws_tx, "skill catalogue not configured").await;
                return true;
            };
            let known = catalog
                .read()
                .map(|g| g.get(&name).is_some())
                .unwrap_or(false);
            if !known {
                send_error(ws_tx, &format!("no such skill `{name}`")).await;
                return true;
            }
            if !active_skills.iter().any(|n| n == &name) {
                active_skills.push(name.clone());
            }
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "skill_activated",
                        "name": name,
                        "active": &*active_skills,
                    })
                    .to_string(),
                ))
                .await;
        }
        WsClientMessage::DeactivateSkill { name } => {
            let before = active_skills.len();
            active_skills.retain(|n| n != &name);
            let removed = active_skills.len() != before;
            let _ = ws_tx
                .send(WsMessage::Text(
                    json!({
                        "type": "skill_deactivated",
                        "name": name,
                        "removed": removed,
                        "active": &*active_skills,
                    })
                    .to_string(),
                ))
                .await;
        }
        WsClientMessage::SetWorkspace { path } => {
            match path {
                None => {
                    *socket_workspace = None;
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({ "type": "workspace_changed", "path": null }).to_string(),
                        ))
                        .await;
                }
                Some(raw) => {
                    let candidate = std::path::PathBuf::from(&raw);
                    let resolved = match std::fs::canonicalize(&candidate) {
                        Ok(p) => p,
                        Err(e) => {
                            send_error(ws_tx, &format!("workspace `{raw}` is not reachable: {e}"))
                                .await;
                            return true;
                        }
                    };
                    if !resolved.is_dir() {
                        send_error(
                            ws_tx,
                            &format!("workspace `{}` is not a directory", resolved.display()),
                        )
                        .await;
                        return true;
                    }
                    *socket_workspace = Some(resolved.clone());
                    info!(workspace = %resolved.display(), "ws socket workspace pinned");
                    // Touch the registry so the dropdown sees this
                    // path next time, and bind the active persisted
                    // conversation (if any) so Resume restores it.
                    if let Some(store) = state.workspaces.as_ref() {
                        let path_str = resolved.display().to_string();
                        let _ = store.touch(&path_str);
                        if let Some(id) = persisted_id.as_deref() {
                            store.bind(id, &path_str);
                        }
                    }
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "workspace_changed",
                                "path": resolved.display().to_string(),
                                "workspace": workspace_snapshot(&resolved).await,
                            })
                            .to_string(),
                        ))
                        .await;
                }
            }
        }
    }
    true
}

/// Tool filter applied to every agent turn while the per-socket mode
/// is `Plan`: keep only `Read` tools (plus `exit_plan`, which is also
/// `Read`-categorised). Hides write/exec/network tools from the
/// LLM's catalogue entirely so the model can't even attempt them
/// — the deny-loop alternative wastes turns and confuses models.
fn plan_mode_tool_filter() -> Arc<harness_core::agent::ToolFilter> {
    use harness_core::ToolCategory;
    Arc::new(|t| matches!(t.category(), ToolCategory::Read))
}

async fn send_error(ws_tx: &mut SplitSink<WebSocket, WsMessage>, message: &str) {
    let _ = ws_tx
        .send(WsMessage::Text(
            json!({ "type": "error", "message": message }).to_string(),
        ))
        .await;
}
