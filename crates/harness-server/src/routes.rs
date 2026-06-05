use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

use axum::{
    Router,
    extract::{
        Path, Query, State,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{
        IntoResponse, Json, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use harness_core::{AgentEvent, AgentProfileEvent, ApprovalDecision, Approver, ChannelApprover, Conversation, ConversationMetadata, ConversationStore, HitlResponse, HitlStatus, Message, PendingHitl, RunOutcome, SubAgentEvent, TodoEvent, canonicalize_workspace};
use harness_observability::{ObservabilityStore, ObservedOutcome, ObservedRun, ObservedRunKind};
use harness_project::{ActivityEvent, CommentEvent, DocEvent, LabelEvent, RequirementEvent, RequirementRunEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
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
        .route("/v1/providers/:name/probe", post(probe_provider))
        .route("/v1/model-catalog", get(list_model_catalog))
        .route("/v1/tools", get(list_tools))
        .route("/v1/tools/:name", axum::routing::patch(patch_tool))
        .route("/v1/routing", get(get_route_policy).put(put_route_policy))
        .route(
            "/v1/routing/:slot",
            axum::routing::patch(patch_route_policy_slot).delete(delete_route_policy_slot),
        )
        .route("/v1/workspace", get(get_workspace))
        .route("/v1/workspace/probe", get(probe_workspace))
        .route("/v1/server/info", get(get_server_info))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/chat/completions/stream", post(chat_completions_stream))
        .route("/v1/chat/ws", get(chat_ws))
        .route("/v1/chat/runs", get(list_chat_runs))
        .route(
            "/v1/chat/runs/:conversation_id/events",
            get(list_chat_run_events),
        )
        .route(
            "/v1/chat/runs/:conversation_id/interrupt",
            post(interrupt_chat_run),
        )
        .merge(conversations::router())
        .merge(projects::router())
        .merge(permissions::router())
        .merge(workspace_diff::router())
        .merge(crate::workspace_files::router())
        .merge(crate::workspace_terminal::router())
        .merge(crate::workspace_find::router())
        .merge(crate::market_routes::router())
        .merge(crate::mcp_routes::router())
        .merge(crate::observability_routes::router())
        .merge(crate::learning_routes::router())
        .merge(crate::memory_routes::router())
        .merge(crate::skill_routes::router())
        .merge(crate::plugin_routes::router())
        .merge(crate::workspaces_routes::router())
        .merge(crate::todos_routes::router())
        .merge(crate::requirements_routes::router())
        .merge(crate::automation_routes::router())
        .merge(crate::workflow_routes::router())
        .merge(crate::roadmap_routes::router())
        .merge(crate::agent_profiles_routes::router())
        .merge(crate::subagents_routes::router())
        .merge(crate::subagent_runs_routes::router())
        .merge(crate::tasks_routes::router())
        .merge(crate::memory_sync_routes::router())
        .merge(crate::diagnostics_routes::router())
        .merge(crate::auto_mode_routes::router())
        .merge(crate::channels_routes::router())
        .merge(crate::channels_inbound_routes::router())
        .merge(crate::channels_oauth_routes::router())
        .merge(crate::comments_routes::router())
        .merge(crate::labels_routes::router())
        .merge(crate::docs_routes::router())
        .merge(crate::work_overview_routes::router())
        .merge(ui::router())
        .fallback(ui::spa_fallback)
        .layer(axum::middleware::from_fn(loopback_cors))
        .layer(
            tower_http::trace::TraceLayer::new_for_http().make_span_with(
                |req: &axum::http::Request<_>| {
                    tracing::info_span!(
                        "http.request",
                        http.request.method = %req.method(),
                        url.path = %req.uri().path(),
                        jarvis.transport = "http",
                    )
                },
            ),
        )
        .with_state(state)
}

/// Permissive CORS for loopback and Tauri webview origins so
/// `vite dev` (5173/4173) can hit the API on `:7001` without a
/// same-origin proxy, and the desktop shell (whose webview origin
/// is `tauri://localhost` on macOS / Linux or `http://tauri.localhost`
/// on Windows) can reach the same sidecar. Echoes the `Origin`
/// header back when it's a recognised local origin; otherwise the
/// response carries no `Access-Control-*` headers and same-origin
/// browsers (production) keep working unchanged. OPTIONS preflights
/// short-circuit to 204.
async fn loopback_cors(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{HeaderValue, Method, StatusCode, header};

    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let allowed = origin.as_deref().is_some_and(is_local_origin);
    let allow_origin = allowed
        .then(|| HeaderValue::from_str(origin.as_deref().unwrap_or("*")).ok())
        .flatten();

    if req.method() == Method::OPTIONS && allowed {
        let mut resp = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(axum::body::Body::empty())
            .unwrap();
        let h = resp.headers_mut();
        if let Some(o) = allow_origin {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        }
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization"),
        );
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        return resp;
    }

    let mut response = next.run(req).await;
    if let Some(o) = allow_origin {
        let h = response.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        h.append(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

fn is_local_origin(origin: &str) -> bool {
    // `Origin: scheme://host[:port]`. We accept three families:
    //
    // - **Loopback over http(s)**: `127.0.0.1`, `localhost`, `[::1]`
    //   on any port — covers `vite dev` (5173), `vite preview`
    //   (4173), and direct same-machine access from another browser.
    // - **Tauri 2 webview**: `tauri://localhost` (macOS / Linux) and
    //   `http(s)://tauri.localhost` (Windows). The desktop shell
    //   loads `dist/index.html` under this origin, so without it
    //   every fetch from the bundled UI gets blocked by the
    //   browser's cross-origin policy and the desktop user sees
    //   "service unavailable" against a perfectly healthy server.
    // - **`null` origin**: some sandboxed contexts (data: URIs,
    //   sandboxed iframes) send `Origin: null`. We allow it because
    //   the API binds to loopback anyway, so the threat model is
    //   already "anything on this machine".
    if origin == "null" || origin == "tauri://localhost" {
        return true;
    }
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    // IPv6 literals show up in `Origin` as `[::1]:port`; pull the
    // bracketed segment as a unit so `split(':')` doesn't return
    // just `[`.
    let host = if let Some(end) = rest.strip_prefix('[').and_then(|s| s.find(']')) {
        &rest[..=end + 1]
    } else {
        rest.split(':').next().unwrap_or("")
    };
    matches!(
        host,
        "127.0.0.1" | "localhost" | "[::1]" | "tauri.localhost"
    )
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

/// `GET /v1/routing` — read-only snapshot of the active model
/// route policy. Phase 4 ships read-only; PATCH/PUT mutators land
/// in a follow-up once the per-call retry wrapper is in place.
async fn get_route_policy(State(state): State<AppState>) -> impl IntoResponse {
    let snap = match state.route_policy.read() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    };
    Json(serde_json::to_value(&snap).unwrap_or(json!({})))
}

/// `PUT /v1/routing` — replace the entire route policy. The new
/// policy must deserialise as a complete [`ModelRoutePolicy`]; any
/// unknown field rejects the request (the type is
/// `deny_unknown_fields`). Mutates the in-memory policy only;
/// already-instantiated SubAgents are pinned at startup so changes
/// here take effect on the next restart for those callsites. The
/// summarising memory's resolver and any future per-request
/// resolvers see the update on their next call.
async fn put_route_policy(
    State(state): State<AppState>,
    Json(body): Json<crate::route_policy::ModelRoutePolicy>,
) -> Response {
    if let Ok(mut guard) = state.route_policy.write() {
        *guard = body.clone();
    } else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "route policy lock poisoned" })),
        )
            .into_response();
    }
    Json(serde_json::to_value(&body).unwrap_or(json!({}))).into_response()
}

/// `PATCH /v1/routing/:slot` — set or clear a single slot. The body
/// is `{"target": "<provider>/<model>"}` to set, or `{"target": null}`
/// to clear. `slot` is one of `default`, `coding`, `review`,
/// `summarization`, `doc_reader`, `vision`, `local_private`.
async fn patch_route_policy_slot(
    State(state): State<AppState>,
    Path(slot): Path<String>,
    Json(body): Json<PatchSlotBody>,
) -> Response {
    let slot = match parse_slot(&slot) {
        Some(s) => s,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("unknown slot `{slot}`") })),
            )
                .into_response();
        }
    };
    let target = match body.target {
        Some(s) => match crate::route_policy::ModelTarget::parse(&s) {
            Some(t) => Some(t),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({ "error": "target must be \"<provider>/<model>\" with both segments non-empty" }),
                    ),
                )
                    .into_response();
            }
        },
        None => None,
    };
    let updated = match state.route_policy.write() {
        Ok(mut guard) => {
            guard.set(slot, target);
            guard.clone()
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "route policy lock poisoned" })),
            )
                .into_response();
        }
    };
    Json(serde_json::to_value(&updated).unwrap_or(json!({}))).into_response()
}

/// `DELETE /v1/routing/:slot` — clear a single slot (equivalent to
/// PATCH with `{"target": null}`). Always returns 200 with the
/// updated policy.
async fn delete_route_policy_slot(
    State(state): State<AppState>,
    Path(slot): Path<String>,
) -> Response {
    let slot = match parse_slot(&slot) {
        Some(s) => s,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("unknown slot `{slot}`") })),
            )
                .into_response();
        }
    };
    let updated = match state.route_policy.write() {
        Ok(mut guard) => {
            guard.set(slot, None);
            guard.clone()
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "route policy lock poisoned" })),
            )
                .into_response();
        }
    };
    Json(serde_json::to_value(&updated).unwrap_or(json!({}))).into_response()
}

#[derive(Debug, Deserialize)]
struct PatchSlotBody {
    /// Slash form `<provider>/<model>` to set, or `null` to clear.
    #[serde(default)]
    target: Option<String>,
}

fn parse_slot(s: &str) -> Option<crate::route_policy::RouteSlot> {
    use crate::route_policy::RouteSlot;
    match s {
        "default" => Some(RouteSlot::Default),
        "coding" => Some(RouteSlot::Coding),
        "review" => Some(RouteSlot::Review),
        "summarization" => Some(RouteSlot::Summarization),
        "doc_reader" => Some(RouteSlot::DocReader),
        "vision" => Some(RouteSlot::Vision),
        "local_private" => Some(RouteSlot::LocalPrivate),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct CatalogQuery {
    /// When set, restrict the catalog to a single provider name
    /// (matches the `name` field, not the canonical kind).
    #[serde(default)]
    provider: Option<String>,
}

/// `GET /v1/model-catalog` — flat list of model capabilities
/// across configured providers.
///
/// The catalog merges two sources:
/// 1. Per-entry capabilities populated by the binary at startup
///    via [`ProviderRegistry::insert_with_capabilities`] (live
///    snapshot of the configured providers).
/// 2. Static built-in profile catalog from [`harness_llm`] —
///    surfaced under `wellKnown` so the picker can advertise
///    profiles even when no provider of that kind is currently
///    configured (e.g. the wizard's "Add OpenRouter provider"
///    flow).
async fn list_model_catalog(
    State(state): State<AppState>,
    Query(q): Query<CatalogQuery>,
) -> impl IntoResponse {
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for info in state.providers.list() {
        if let Some(filter) = &q.provider {
            if &info.name != filter {
                continue;
            }
        }
        for cap in &info.capabilities {
            let mut row = serde_json::to_value(cap).unwrap_or(json!({}));
            if let Some(obj) = row.as_object_mut() {
                obj.insert("providerName".into(), json!(info.name));
                obj.insert("providerKind".into(), json!(info.kind));
                obj.insert(
                    "isProviderDefault".into(),
                    json!(cap.model == info.default_model),
                );
            }
            entries.push(row);
        }
    }

    // Static known-models surface (the "wellKnown" half) — only
    // populated when no provider filter is in effect (the typical
    // wizard "what providers can I add?" call).
    let well_known = if q.provider.is_none() {
        Some(harness_llm::flat_builtin_catalog())
    } else {
        None
    };

    Json(json!({
        "entries": entries,
        "wellKnown": well_known,
    }))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ProbeBody {
    /// Override the model used for the probe call. Defaults to the
    /// provider's `default_model`.
    model: Option<String>,
    /// Whether to also send a tools-array round-trip. Defaults to
    /// `true` when the catalog says the model supports tool calls.
    test_tools: Option<bool>,
}

/// `POST /v1/providers/:name/probe` — minimal connectivity check.
/// Sends a `ping` user message with `max_tokens=1` and returns:
/// - `auth_ok` — request reached the provider without an auth
///   error;
/// - `default_model_ok` — the configured / overridden model id
///   accepted the request;
/// - `supports_tool_calls` — when `test_tools` is set or implied,
///   whether the provider returned without rejecting the
///   tool-spec.
/// - `latency_ms` — wall-clock time of the round trip;
/// - `error` — the provider error message when any step failed.
///
/// Probe never modifies registry state in Phase 0; it's read-only
/// from the operator's standpoint, and cheap (single 1-token
/// completion, no streaming).
async fn probe_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
    body: Option<Json<ProbeBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();

    // Snapshot the entry's data into owned values before any
    // await — the registry borrow can't cross the await point
    // because entries live behind `Arc<ProviderRegistry>` shared
    // across handlers.
    let (provider, default_model, known_supports_tools) = match state.providers.entry(&name) {
        Some(e) => {
            let model = body
                .model
                .clone()
                .unwrap_or_else(|| e.default_model.clone());
            let known = e
                .capabilities
                .iter()
                .find(|c| c.model == model)
                .and_then(|c| c.supports_tool_calls);
            (e.provider.clone(), model, known)
        }
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("provider `{name}` not registered") })),
            )
                .into_response();
        }
    };
    let model = default_model;
    let test_tools = body
        .test_tools
        .unwrap_or(known_supports_tools == Some(true));

    let start = Instant::now();

    // Step 1: minimal "ping" round-trip with no tools.
    let ping_req = harness_core::ChatRequest {
        model: model.clone(),
        messages: vec![Message::User {
            content: "ping".into(),
            cache: None,
        }],
        max_tokens: Some(1),
        temperature: Some(0.0),
        ..Default::default()
    };

    let ping_result = provider.complete(ping_req).await;
    let mut default_model_ok = false;
    let mut probe_error: Option<String> = None;

    let auth_ok = match ping_result {
        Ok(_) => {
            default_model_ok = true;
            true
        }
        Err(e) => {
            let msg = e.to_string();
            let lower = msg.to_lowercase();
            // Heuristic: an error that mentions auth / 401 / 403
            // is treated as auth failure; everything else is a
            // model / network failure but auth is presumed OK.
            let likely_auth_failure = lower.contains("401")
                || lower.contains("403")
                || lower.contains("unauthorized")
                || lower.contains("invalid api key")
                || lower.contains("authentication");
            probe_error = Some(msg);
            !likely_auth_failure
        }
    };

    // Step 2: tools round-trip, only if step 1 succeeded.
    let mut supports_tool_calls: Option<bool> = known_supports_tools;
    if default_model_ok && test_tools {
        let tools_req = harness_core::ChatRequest {
            model: model.clone(),
            messages: vec![Message::User {
                content: "ping".into(),
                cache: None,
            }],
            tools: vec![harness_core::ToolSpec {
                name: "noop".into(),
                description: "no-op probe tool; do not call".into(),
                parameters: json!({"type": "object", "properties": {}}),
                cacheable: false,
            }],
            max_tokens: Some(1),
            temperature: Some(0.0),
            ..Default::default()
        };
        match provider.complete(tools_req).await {
            Ok(_) => supports_tool_calls = Some(true),
            Err(e) => {
                let m = e.to_string().to_lowercase();
                if m.contains("tool") || m.contains("function") {
                    supports_tool_calls = Some(false);
                } else {
                    // Network / 5xx — leave the catalog hint as-is
                    // (could be transient).
                }
            }
        }
    }

    let latency_ms = start.elapsed().as_millis() as u64;

    Json(json!({
        "name": name,
        "model": model,
        "auth_ok": auth_ok,
        "default_model_ok": default_model_ok,
        "supports_tool_calls": supports_tool_calls,
        "supports_streaming": Some(true), // every provider in tree streams
        "latency_ms": latency_ms,
        "error": probe_error,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct ToolsQuery {
    /// Filter by tool source kind. Accepts `builtin`, `mcp`, `plugin`,
    /// `subagent`. Unknown values are ignored.
    #[serde(default)]
    source: Option<String>,
    /// Filter by product pack. Matches the kebab-case enum repr
    /// (e.g. `file-read`, `file-write`, `shell`, `git`).
    #[serde(default)]
    pack: Option<String>,
    /// Filter by risk level (kebab-case, e.g. `read-only`, `shell`,
    /// `workspace-write`).
    #[serde(default)]
    risk: Option<String>,
}

/// `GET /v1/tools` — full tool catalog with metadata.
///
/// Each entry derives its source / pack / risk classification from
/// either the registration-time annotation (MCP-bridged tools carry
/// `ToolSource::Mcp { server }`; subagent wrappers carry
/// `ToolSource::SubAgent { ... }`) or, for built-in registrations
/// without an explicit annotation, the name-convention heuristics in
/// [`harness_core::tool_metadata`]. Source for MCP tools is derived
/// from the running [`McpManager`]'s prefix list — a tool whose name
/// starts with `<prefix>.` and whose prefix matches an active MCP
/// server gets reclassified to `Mcp`.
async fn list_tools(State(state): State<AppState>, Query(q): Query<ToolsQuery>) -> Response {
    use harness_core::{ToolMetadata, ToolPackCategory, ToolRisk, ToolSource};

    // Snapshot the registry under the read lock and immediately
    // drop the guard so the async MCP-prefix lookup below doesn't
    // hold it across an await. We need the *unfiltered* tool list
    // (including muted tools) because the catalog UI must let the
    // operator un-mute them.
    let registry_snapshot: Vec<(String, ToolMetadata)> = match state.tools.read() {
        Ok(g) => g
            .all_names()
            .into_iter()
            .filter_map(|name| {
                let arc = g.resolve_unchecked(&name)?;
                let mut meta = ToolMetadata::from_tool(arc.as_ref());
                meta.enabled = !g.is_muted(&name);
                Some((name, meta))
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    // Load the active MCP server prefixes so we can reclassify
    // remote tools' source. `manager.list().await` is async; we
    // already dropped the registry lock above so this is safe.
    let mcp_prefixes: Vec<String> = if let Some(manager) = state.mcp.as_ref() {
        manager
            .list()
            .await
            .into_iter()
            .map(|info| info.prefix)
            .collect()
    } else {
        Vec::new()
    };

    let mut entries: Vec<ToolMetadata> = registry_snapshot
        .into_iter()
        .map(|(name, mut meta)| {
            // SubAgent wrappers are registered as `subagent.<kind>`.
            if let Some(kind) = name.strip_prefix("subagent.") {
                meta.source = ToolSource::SubAgent {
                    subagent: kind.to_string(),
                };
            }
            // MCP tools land as `<server>.<remote_name>`. Match
            // against the running prefix list so we don't false-
            // positive on built-in `fs.read` etc.
            for prefix in &mcp_prefixes {
                let needle = format!("{prefix}.");
                if name.starts_with(&needle) {
                    meta.source = ToolSource::Mcp {
                        server: prefix.clone(),
                    };
                    meta.pack = ToolPackCategory::Mcp;
                    // MCP remote tools default to Network risk
                    // unless their trait-level category proves
                    // them read-only.
                    if !matches!(meta.risk, ToolRisk::ReadOnly) {
                        meta.risk = ToolRisk::Network;
                    }
                    break;
                }
            }
            meta
        })
        .collect();

    // Server-side filtering for the catalog UI's facets.
    if let Some(filter) = &q.source {
        entries.retain(|m| {
            matches!(
                (&m.source, filter.as_str()),
                (ToolSource::Builtin, "builtin")
                    | (ToolSource::Mcp { .. }, "mcp")
                    | (ToolSource::Plugin { .. }, "plugin")
                    | (ToolSource::SubAgent { .. }, "subagent")
            )
        });
    }
    if let Some(filter) = &q.pack {
        entries.retain(|m| pack_matches(m.pack, filter));
    }
    if let Some(filter) = &q.risk {
        entries.retain(|m| risk_matches(m.risk, filter));
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let total = entries.len();
    Json(json!({
        "total": total,
        "tools": entries,
    }))
    .into_response()
}

fn pack_matches(p: harness_core::ToolPackCategory, s: &str) -> bool {
    serde_json::to_value(p)
        .ok()
        .and_then(|v| v.as_str().map(|x| x == s))
        .unwrap_or(false)
}
fn risk_matches(r: harness_core::ToolRisk, s: &str) -> bool {
    serde_json::to_value(r)
        .ok()
        .and_then(|v| v.as_str().map(|x| x == s))
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
struct ToolPatch {
    /// Toggle the tool's runtime visibility. `false` mutes the
    /// tool — it disappears from the LLM's tool catalogue and
    /// `resolve()` returns `None` for any in-flight call.
    /// `true` un-mutes it.
    enabled: bool,
}

/// `PATCH /v1/tools/:name` — toggle runtime mute state.
///
/// Returns `{name, enabled, muted_count}` so the UI can refresh
/// without a separate list call. `404` when the tool isn't
/// registered (covers typos as well as MCP servers / plugins
/// that have since gone away). The mute state lives in-process
/// only — restart returns the registry to "everything enabled".
async fn patch_tool(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<ToolPatch>,
) -> Response {
    let mut guard = match state.tools.write() {
        Ok(g) => g,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("tool registry poisoned: {e}") })),
            )
                .into_response();
        }
    };
    if !guard.contains(&name) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("tool `{name}` is not registered") })),
        )
            .into_response();
    }
    let _ = if body.enabled {
        guard.unmute(&name)
    } else {
        guard.mute(&name)
    };
    let muted_count = guard.muted_names().len();
    Json(json!({
        "name": name,
        "enabled": body.enabled,
        "muted_count": muted_count,
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct ChatRunsQuery {
    #[serde(default)]
    active: bool,
}

async fn list_chat_runs(
    State(state): State<AppState>,
    Query(q): Query<ChatRunsQuery>,
) -> impl IntoResponse {
    Json(state.chat_runs.list(q.active))
}

#[derive(Debug, Deserialize)]
struct ChatRunEventsQuery {
    #[serde(default)]
    after: u64,
}

async fn list_chat_run_events(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(q): Query<ChatRunEventsQuery>,
) -> impl IntoResponse {
    Json(state.chat_runs.events(&conversation_id, q.after))
}

async fn interrupt_chat_run(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Response {
    if state.chat_runs.interrupt(&conversation_id) {
        Json(json!({ "ok": true })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no active run for conversation" })),
        )
            .into_response()
    }
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
///   "project_memory": { "loaded": true, "dir": ".jarvis/memory", "max_bytes": 25000 },
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
    let project_memory = json!({
        "loaded": info.project_memory_loaded,
        "dir": info.project_memory_dir,
        "max_bytes": info.project_memory_bytes_cap,
    });

    let prompt_text = template.system_prompt.as_deref().unwrap_or("");
    let prompt_len = prompt_text.chars().count();
    let preview_len = prompt_len.min(280);
    let preview: String = prompt_text.chars().take(preview_len).collect();

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
        "project_memory": project_memory,
        "system_prompt": {
            "length": prompt_len,
            "preview": preview,
        },
        "max_iterations": template.max_iterations,
        "tools": tools,
        "tool_count": tool_count,
        "mcp_servers": info.mcp_prefixes,
        "providers": state.providers.list(),
        "workspace_root": state.workspace_root.as_ref().map(|p| p.display().to_string()),
    }))
    .into_response()
}

pub(crate) async fn workspace_snapshot(root: &std::path::Path) -> serde_json::Value {
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

/// Capability gate for chat-style routes. Rejects requests when
/// the routed model has explicit `supports_tool_calls = Some(false)`
/// in the registered catalog AND the agent has any tools registered
/// (the realistic scenario where the loop would otherwise send a
/// `tools` array the model can't honour).
///
/// Unknown capability (`None` — no static catalog entry) falls
/// through to "allow"; we never block requests just because we
/// lack metadata.
#[allow(clippy::result_large_err)]
fn enforce_tool_capability(
    state: &AppState,
    explicit_provider: Option<&str>,
    model: Option<&str>,
) -> Result<(), Response> {
    let routed = match state.providers.pick(explicit_provider, model) {
        Ok(r) => r,
        Err(_) => return Ok(()), // routing-error path is handled later by build_agent
    };
    let supports = routed
        .entry
        .capabilities
        .iter()
        .find(|c| c.model == routed.model)
        .and_then(|c| c.supports_tool_calls);
    if supports != Some(false) {
        return Ok(());
    }
    let tool_count = state.tools.read().map(|g| g.len()).unwrap_or(0);
    if tool_count == 0 {
        return Ok(());
    }
    Err((
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": format!(
                "model `{model}` does not support tool calls but the agent has \
                 {tool_count} tool(s) registered. Pick a tool-capable model, or \
                 disable tools in your agent config.",
                model = routed.model,
                tool_count = tool_count,
            ),
        })),
    )
        .into_response())
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

#[derive(Debug, Clone)]
struct AgentRunRecord {
    id: String,
    transport: &'static str,
    started_at: String,
    elapsed_ms: u64,
    outcome: ObservedOutcome,
    iterations: Option<usize>,
    message_count: usize,
    conversation_id: Option<String>,
    project_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Debug)]
struct ActiveToolRun {
    id: String,
    name: String,
    started_at: String,
    started: Instant,
    args_bytes: usize,
}

#[derive(Debug)]
struct ActiveSubAgentRun {
    id: String,
    name: String,
    started_at: String,
    started: Instant,
    model: Option<String>,
    frames: usize,
    tool_calls: usize,
}

#[derive(Debug, Default)]
struct RunEventAccumulator {
    tools: HashMap<String, ActiveToolRun>,
    subagents: HashMap<String, ActiveSubAgentRun>,
}

impl RunEventAccumulator {
    fn observe(&mut self, event: &AgentEvent) -> Vec<ObservedRun> {
        let mut out = Vec::new();
        match event {
            AgentEvent::ToolStart {
                id,
                name,
                arguments,
            } => {
                self.tools.insert(
                    id.clone(),
                    ActiveToolRun {
                        id: format!("tool-{id}"),
                        name: name.clone(),
                        started_at: chrono::Utc::now().to_rfc3339(),
                        started: Instant::now(),
                        args_bytes: serde_json::to_vec(arguments).map(|v| v.len()).unwrap_or(0),
                    },
                );
            }
            AgentEvent::ToolEnd { id, name, content } => {
                let active = self.tools.remove(id).unwrap_or_else(|| ActiveToolRun {
                    id: format!("tool-{id}"),
                    name: name.clone(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                    started: Instant::now(),
                    args_bytes: 0,
                });
                out.push(tool_observed_run(active, content));
            }
            AgentEvent::SubAgentEvent { frame } => {
                let entry = self
                    .subagents
                    .entry(frame.subagent_id.clone())
                    .or_insert_with(|| ActiveSubAgentRun {
                        id: format!("subagent-{}", frame.subagent_id),
                        name: frame.subagent_name.clone(),
                        started_at: chrono::Utc::now().to_rfc3339(),
                        started: Instant::now(),
                        model: None,
                        frames: 0,
                        tool_calls: 0,
                    });
                entry.frames += 1;
                match &frame.event {
                    SubAgentEvent::Started { model, .. } => {
                        entry.model = model.clone();
                    }
                    SubAgentEvent::ToolStart { .. } => {
                        entry.tool_calls += 1;
                    }
                    SubAgentEvent::Done { .. } => {
                        if let Some(active) = self.subagents.remove(&frame.subagent_id) {
                            out.push(subagent_observed_run(active, ObservedOutcome::Success));
                        }
                    }
                    SubAgentEvent::Error { .. } => {
                        if let Some(active) = self.subagents.remove(&frame.subagent_id) {
                            out.push(subagent_observed_run(active, ObservedOutcome::Error));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        out
    }

    fn finish_unclosed(&mut self) -> Vec<ObservedRun> {
        let mut out = Vec::new();
        out.extend(
            self.tools
                .drain()
                .map(|(_, active)| unfinished_tool_observed_run(active)),
        );
        out.extend(
            self.subagents
                .drain()
                .map(|(_, active)| subagent_observed_run(active, ObservedOutcome::Unknown)),
        );
        out
    }
}

fn tool_observed_run(active: ActiveToolRun, content: &str) -> ObservedRun {
    let errored = content.starts_with("tool error:")
        || content.starts_with("tool denied:")
        || content.starts_with("subagent error:");
    ObservedRun {
        id: active.id,
        trace_id: None,
        span_id: None,
        parent_run_id: None,
        kind: ObservedRunKind::Tool,
        name: active.name,
        started_at: active.started_at,
        ended_at: Some(chrono::Utc::now().to_rfc3339()),
        duration_ms: Some(active.started.elapsed().as_millis() as u64),
        outcome: if errored {
            ObservedOutcome::Error
        } else {
            ObservedOutcome::Success
        },
        conversation_id: None,
        project_id: None,
        workspace_hash: None,
        attributes: json!({
            "args_bytes": active.args_bytes,
            "output_bytes": content.len(),
        }),
        metrics: json!({
            "duration_ms": active.started.elapsed().as_millis() as u64,
            "output_bytes": content.len(),
        }),
        artifact_ids: Vec::new(),
    }
}

fn unfinished_tool_observed_run(active: ActiveToolRun) -> ObservedRun {
    ObservedRun {
        id: active.id,
        trace_id: None,
        span_id: None,
        parent_run_id: None,
        kind: ObservedRunKind::Tool,
        name: active.name,
        started_at: active.started_at,
        ended_at: Some(chrono::Utc::now().to_rfc3339()),
        duration_ms: Some(active.started.elapsed().as_millis() as u64),
        outcome: ObservedOutcome::Unknown,
        conversation_id: None,
        project_id: None,
        workspace_hash: None,
        attributes: json!({
            "args_bytes": active.args_bytes,
            "unclosed": true,
        }),
        metrics: json!({
            "duration_ms": active.started.elapsed().as_millis() as u64,
        }),
        artifact_ids: Vec::new(),
    }
}

fn subagent_observed_run(active: ActiveSubAgentRun, outcome: ObservedOutcome) -> ObservedRun {
    ObservedRun {
        id: active.id,
        trace_id: None,
        span_id: None,
        parent_run_id: None,
        kind: ObservedRunKind::Subagent,
        name: active.name,
        started_at: active.started_at,
        ended_at: Some(chrono::Utc::now().to_rfc3339()),
        duration_ms: Some(active.started.elapsed().as_millis() as u64),
        outcome,
        conversation_id: None,
        project_id: None,
        workspace_hash: None,
        attributes: json!({
            "model": active.model,
            "frames": active.frames,
            "tool_calls": active.tool_calls,
        }),
        metrics: json!({
            "duration_ms": active.started.elapsed().as_millis() as u64,
            "frames": active.frames,
            "tool_calls": active.tool_calls,
        }),
        artifact_ids: Vec::new(),
    }
}

async fn record_observed_runs(store: Option<Arc<dyn ObservabilityStore>>, runs: Vec<ObservedRun>) {
    let Some(store) = store else {
        return;
    };
    for run in runs {
        if let Err(e) = store.append_run(&run).await {
            warn!(error = %e, run_id = %run.id, "observability append_run failed");
        }
    }
}

async fn record_agent_run(store: Option<Arc<dyn ObservabilityStore>>, record: AgentRunRecord) {
    let Some(store) = store else {
        return;
    };
    let run = ObservedRun {
        id: record.id,
        trace_id: None,
        span_id: None,
        parent_run_id: None,
        kind: ObservedRunKind::Agent,
        name: "jarvis.agent.run".into(),
        started_at: record.started_at,
        ended_at: Some(chrono::Utc::now().to_rfc3339()),
        duration_ms: Some(record.elapsed_ms),
        outcome: record.outcome,
        conversation_id: record.conversation_id,
        project_id: record.project_id,
        workspace_hash: None,
        attributes: json!({
            "transport": record.transport,
            "provider": record.provider,
            "model": record.model,
            "message_count": record.message_count,
        }),
        metrics: json!({
            "duration_ms": record.elapsed_ms,
            "iterations": record.iterations,
        }),
        artifact_ids: Vec::new(),
    };
    if let Err(e) = store.append_run(&run).await {
        warn!(error = %e, run_id = %run.id, "observability append_run failed");
    }
}

fn run_iterations(outcome: &RunOutcome) -> usize {
    match outcome {
        RunOutcome::Stopped { iterations } | RunOutcome::LengthLimited { iterations } => {
            *iterations
        }
    }
}

fn observed_outcome(outcome: &RunOutcome) -> ObservedOutcome {
    match outcome {
        RunOutcome::Stopped { .. } => ObservedOutcome::Success,
        RunOutcome::LengthLimited { .. } => ObservedOutcome::MaxIterations,
    }
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    if let Err(resp) =
        enforce_tool_capability(&state, req.provider.as_deref(), req.model.as_deref())
    {
        return resp;
    }
    let run_id = Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();
    let started = Instant::now();
    let provider = req.provider.clone();
    let model = req.model.clone();
    let mut conv = Conversation {
        messages: expand_goal_in_messages(req.messages),
        ..Default::default()
    };
    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => return route_error(e),
    };

    match agent.run(&mut conv).await {
        Ok(outcome) => {
            let iterations = run_iterations(&outcome);
            record_agent_run(
                state.observability.clone(),
                AgentRunRecord {
                    id: run_id,
                    transport: "http",
                    started_at,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    outcome: observed_outcome(&outcome),
                    iterations: Some(iterations),
                    message_count: conv.messages.len(),
                    conversation_id: None,
                    project_id: None,
                    provider,
                    model,
                },
            )
            .await;
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
            record_agent_run(
                state.observability.clone(),
                AgentRunRecord {
                    id: run_id,
                    transport: "http",
                    started_at,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    outcome: ObservedOutcome::Error,
                    iterations: None,
                    message_count: conv.messages.len(),
                    conversation_id: None,
                    project_id: None,
                    provider,
                    model,
                },
            )
            .await;
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
    if let Err(resp) =
        enforce_tool_capability(&state, req.provider.as_deref(), req.model.as_deref())
    {
        return resp;
    }
    let run_id = Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();
    let started = Instant::now();
    let provider = req.provider.clone();
    let model = req.model.clone();
    let conv = Conversation {
        messages: expand_goal_in_messages(req.messages),
        ..Default::default()
    };
    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => return route_error(e),
    };
    let observability = state.observability.clone();
    let stream = async_stream::stream! {
        let mut inner = agent.run_stream(conv);
        let mut event_acc = RunEventAccumulator::default();
        let mut final_outcome = ObservedOutcome::Unknown;
        let mut iterations = None;
        let mut message_count = 0usize;
        while let Some(event) = inner.next().await {
            let observed = event_acc.observe(&event);
            record_observed_runs(observability.clone(), observed).await;
            match &event {
                AgentEvent::Done { outcome, conversation } => {
                    final_outcome = observed_outcome(outcome);
                    iterations = Some(run_iterations(outcome));
                    message_count = conversation.messages.len();
                }
                AgentEvent::Error { .. } => {
                    final_outcome = ObservedOutcome::Error;
                }
                _ => {}
            }
            let terminal = matches!(event, AgentEvent::Done { .. } | AgentEvent::Error { .. });
            let payload = serde_json::to_string(&event)
                .unwrap_or_else(|e| format!(r#"{{"type":"error","message":"serialize: {e}"}}"#));
            yield Ok::<_, Infallible>(Event::default().data(payload));
            if terminal {
                break;
            }
        }
        record_observed_runs(observability.clone(), event_acc.finish_unclosed()).await;
        record_agent_run(
            observability,
            AgentRunRecord {
                id: run_id,
                transport: "sse",
                started_at,
                elapsed_ms: started.elapsed().as_millis() as u64,
                outcome: final_outcome,
                iterations,
                message_count,
                conversation_id: None,
                project_id: None,
                provider,
                model,
            },
        )
        .await;
    };
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
    /// Atomic persisted-session turn start. This folds the old
    /// `new/resume` + `user` handshake into one frame so the server
    /// either prepares the requested persisted conversation and starts
    /// the user turn, or rejects the whole request before any model
    /// call can run against the wrong in-memory session.
    StartTurn {
        mode: StartTurnMode,
        id: String,
        content: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        soul_prompt: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        active_skills: Option<Vec<String>>,
    },
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
        /// When the client has previously observed events for this
        /// conversation (via `seq` stamping on the wire), it can
        /// pass its high-water mark here so the server only replays
        /// events with `seq > after_seq`. Omitting or `0` means
        /// "replay everything in the ring buffer". The server may
        /// respond with a `resume_error: evicted` frame when the
        /// requested cursor is older than the oldest retained seq.
        #[serde(default)]
        after_seq: Option<u64>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StartTurnMode {
    New,
    Resume,
}

/// Static label for a `WsClientMessage` variant — used by the
/// per-frame `info!` log so we can replay ordering without dumping
/// payloads (which can be huge).
fn client_msg_kind(msg: &WsClientMessage) -> &'static str {
    match msg {
        WsClientMessage::StartTurn { .. } => "start_turn",
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

#[derive(Debug, Clone)]
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
    (
        Conversation {
            messages,
            ..Default::default()
        },
        Some(pos),
    )
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

/// Payload pushed through the owner WS event channel. The
/// `Option<u64>` is the per-conversation `seq` assigned by
/// `ChatRunRegistry::event` when the run is persisted; `None` for
/// non-persisted free chats (no ring buffer, no replay). The WS
/// receiver stamps the seq onto the serialized JSON before sending
/// so the wire format on the owner socket matches what tail
/// subscribers see.
pub(crate) type OwnerWsEvent = (Option<u64>, AgentEvent);

struct DetachedTurn {
    agent: Arc<harness_core::Agent>,
    conversation: Conversation,
    event_tx: mpsc::Sender<OwnerWsEvent>,
    chat_runs: Arc<crate::chat_runs::ChatRunRegistry>,
    subagent_runs: Option<Arc<crate::subagent_runs::SubAgentRunRegistry>>,
    observability: Option<Arc<dyn ObservabilityStore>>,
    run_id: String,
    started_at: String,
    started: Instant,
    provider: Option<String>,
    model: Option<String>,
    persisted_id: Option<String>,
    persisted_project_id: Option<String>,
    store: Option<Arc<dyn ConversationStore>>,
    injection: Option<TurnInjection>,
    /// Cloned AppState carried into the detached task so the terminal
    /// hook can reconcile any `RequirementRun` rows linked to the
    /// conversation. Survives WS disconnect / page reload because the
    /// task continues to drain the agent stream regardless of whether
    /// a client is listening.
    state: AppState,
}

fn spawn_detached_turn(turn: DetachedTurn) -> tokio::task::JoinHandle<()> {
    use tracing::Instrument;
    let turn_span = tracing::info_span!(
        "ws.turn",
        jarvis.run.id = %turn.run_id,
        jarvis.transport = "ws",
        jarvis.conversation.id = turn.persisted_id.as_deref().unwrap_or(""),
        jarvis.provider = turn.provider.as_deref().unwrap_or(""),
        jarvis.model = turn.model.as_deref().unwrap_or(""),
    );
    tokio::spawn(
        async move {
            let DetachedTurn {
                agent,
                conversation,
                event_tx,
                chat_runs,
                subagent_runs,
                observability,
                run_id,
                started_at,
                started,
                provider,
                model,
                persisted_id,
                persisted_project_id,
                store,
                injection,
                state,
            } = turn;
            harness_core::todo::with_turn_budget(async move {
                let mut stream = agent.run_stream(conversation);
                let mut event_acc = RunEventAccumulator::default();
                let mut final_outcome = ObservedOutcome::Unknown;
                let mut iterations = None;
                let mut message_count = 0usize;
                let mut terminal_error: Option<String> = None;
                while let Some(ev) = stream.next().await {
                    let mut ev_to_send = ev;
                    let observed = event_acc.observe(&ev_to_send);
                    record_observed_runs(observability.clone(), observed).await;
                    let is_terminal = matches!(
                        ev_to_send,
                        AgentEvent::Done { .. } | AgentEvent::Error { .. }
                    );
                    if let AgentEvent::Done { conversation, .. } = &mut ev_to_send {
                        message_count = conversation.messages.len();
                        if let Some(prepared) = injection.as_ref() {
                            *conversation = strip_turn_injections(conversation.clone(), prepared);
                        }
                        if let (Some(id), Some(store)) = (persisted_id.as_ref(), store.as_ref()) {
                            let metadata = ConversationMetadata {
                                project_id: persisted_project_id.clone(),
                                ..Default::default()
                            };
                            if let Err(e) = store.save_envelope(id, conversation, &metadata).await {
                                warn!(error = %e, %id, "detached turn save failed");
                            }
                        }
                    }
                    match &ev_to_send {
                        AgentEvent::Done {
                            outcome,
                            conversation,
                        } => {
                            final_outcome = observed_outcome(outcome);
                            iterations = Some(run_iterations(outcome));
                            message_count = conversation.messages.len();
                        }
                        AgentEvent::Error { message } => {
                            final_outcome = ObservedOutcome::Error;
                            if terminal_error.is_none() {
                                terminal_error = Some(message.clone());
                            }
                        }
                        _ => {}
                    }
                    let seq = chat_runs.event(persisted_id.as_deref(), &ev_to_send);
                    if let (Some(reg), AgentEvent::SubAgentEvent { frame }) =
                        (subagent_runs.as_ref(), &ev_to_send)
                    {
                        reg.record_frame(persisted_id.as_deref(), frame);
                    }
                    let _ = event_tx.send((seq, ev_to_send)).await;
                    if is_terminal {
                        break;
                    }
                }
                record_observed_runs(observability.clone(), event_acc.finish_unclosed()).await;
                // Server-side fallback for the WS reconciliation that
                // the frontend (conversationSockets.ts) does on
                // terminal frames. Runs whether the client is still
                // attached or not, so a stuck `running`
                // RequirementRun can't survive a tab close / network
                // drop / page reload mid-turn.
                if let Some(conv_id) = persisted_id.as_deref() {
                    let succeeded = !matches!(final_outcome, ObservedOutcome::Error);
                    crate::requirements_routes::reconcile_runs_for_conversation(
                        &state,
                        conv_id,
                        succeeded,
                        terminal_error.as_deref(),
                    )
                    .await;
                }
                record_agent_run(
                    observability,
                    AgentRunRecord {
                        id: run_id,
                        transport: "ws",
                        started_at,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        outcome: final_outcome,
                        iterations,
                        message_count,
                        conversation_id: persisted_id,
                        project_id: persisted_project_id,
                        provider,
                        model,
                    },
                )
                .await;
            })
            .await;
        }
        .instrument(turn_span),
    )
}

async fn resolve_requested_workspace(
    raw: Option<&str>,
) -> std::result::Result<Option<(std::path::PathBuf, String, Value)>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    match std::fs::canonicalize(raw) {
        Ok(p) if p.is_dir() => {
            let path = p.display().to_string();
            let snapshot = workspace_snapshot(&p).await;
            Ok(Some((p, path, snapshot)))
        }
        Ok(p) => Err(format!("workspace `{}` is not a directory", p.display())),
        Err(e) => Err(format!("workspace `{raw}` is not reachable: {e}")),
    }
}

fn validate_active_skills(
    catalog: Option<&Arc<std::sync::RwLock<harness_skill::SkillCatalog>>>,
    requested: &[String],
) -> std::result::Result<Vec<String>, String> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let Some(cat) = catalog else {
        return Err("skill catalogue not configured".to_string());
    };
    let guard = cat
        .read()
        .map_err(|_| "skill catalogue lock poisoned".to_string())?;
    let mut out = Vec::with_capacity(requested.len());
    for name in requested {
        if guard.get(name).is_none() {
            return Err(format!("no such skill `{name}`"));
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.clone());
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
async fn begin_user_turn(
    content: String,
    model: Option<String>,
    provider: Option<String>,
    soul_prompt: Option<String>,
    ws_tx: &mut SplitSink<WebSocket, WsMessage>,
    state: &AppState,
    socket_approver: &Arc<dyn Approver>,
    mode_handle: &Arc<tokio::sync::RwLock<harness_core::PermissionMode>>,
    conv: &mut Conversation,
    persisted_id: &mut Option<String>,
    persisted_project_id: &mut Option<String>,
    last_injection: &mut Option<TurnInjection>,
    event_rx: &mut Option<mpsc::Receiver<OwnerWsEvent>>,
    current_task: &mut Option<tokio::task::JoinHandle<()>>,
    sticky_provider: &mut Option<String>,
    sticky_model: &mut Option<String>,
    active_skills: &[String],
    recent_touched_files: &[String],
    socket_workspace: &Option<std::path::PathBuf>,
    hitl_tx: &mpsc::Sender<PendingHitl>,
) -> bool {
    if event_rx.is_some() {
        send_error(ws_tx, "turn already in progress").await;
        return true;
    }
    if persisted_id
        .as_deref()
        .is_some_and(|id| state.chat_runs.is_active(id))
    {
        send_error(ws_tx, "turn already in progress").await;
        return true;
    }

    let content = expand_goal_command(&content).unwrap_or(content);
    let provider_pick = provider.as_deref().or(sticky_provider.as_deref());
    let model_pick = model.as_deref().or(sticky_model.as_deref());
    let approver = socket_approver.clone();
    let hitl = hitl_tx.clone();
    let active_mode = *mode_handle.read().await;
    let skills_catalog = state.skills.as_ref().cloned();
    let skills_snapshot = merged_skills_for_turn(
        skills_catalog.as_ref(),
        active_skills,
        &content,
        recent_touched_files,
    );
    // Phase 0 self-improving-agent — emit `Used` events for every
    // skill whose body actually lands in this turn's system prompt.
    // Fire-and-forget: never block the agent on disk I/O.
    crate::learning_emit::spawn_record(
        state.learning_skill_usage.clone(),
        crate::learning_emit::build_used_events(
            skills_catalog.as_ref(),
            &skills_snapshot,
            crate::learning_emit::workspace_scope(socket_workspace.as_deref()),
            persisted_id.clone(),
        ),
    );
    // Phase 1 — fetch user memories before building the agent so the
    // closure below can apply them synchronously. The fetcher
    // degrades to an empty Vec when the store is None / unreachable.
    let user_memories =
        crate::learning_emit::fetch_user_memories_for_prompt(state.learning_memory.as_ref())
            .await;
    let workspace_for_turn = socket_workspace.clone();
    let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
        cfg.approver = Some(approver);
        cfg.hitl_tx = Some(hitl);
        if matches!(active_mode, harness_core::PermissionMode::Plan) {
            cfg.tool_filter = Some(plan_mode_tool_filter());
        }
        if let Some(prompt) = compose_with_user_memory(cfg.system_prompt.as_deref(), &user_memories)
        {
            cfg.system_prompt = Some(prompt);
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
    let record_provider = provider_pick.map(str::to_string);
    let record_model = model_pick.map(str::to_string);
    if provider.is_some() {
        *sticky_provider = provider;
    }
    if model.is_some() {
        *sticky_model = model;
    }

    conv.push(Message::user(content));
    let (soul_conv, soul_injected_at) = inject_soul_prompt(conv.clone(), soul_prompt.as_deref());
    let prepared = match materialise(
        state.projects.as_ref(),
        state.project_memory.as_ref(),
        soul_conv,
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
    let workspace_key = active_workspace_key(state, socket_workspace.as_deref());
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
    let injection = TurnInjection {
        project: prepared,
        todos: todos_prepared,
        soul_injected_at,
    };
    *last_injection = Some(injection.clone());
    let (event_tx, new_rx) = mpsc::channel::<OwnerWsEvent>(64);
    *event_rx = Some(new_rx);
    if let Some(id) = persisted_id.as_deref() {
        if !state.chat_runs.try_start(id) {
            *event_rx = None;
            *last_injection = None;
            conv.messages.pop();
            send_error(ws_tx, "turn already in progress").await;
            return true;
        }
    }
    let handle = spawn_detached_turn(DetachedTurn {
        agent,
        conversation: snapshot,
        event_tx,
        chat_runs: state.chat_runs.clone(),
        subagent_runs: state.subagent_runs.clone(),
        observability: state.observability.clone(),
        run_id: Uuid::new_v4().to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        started: Instant::now(),
        provider: record_provider,
        model: record_model,
        persisted_id: persisted_id.clone(),
        persisted_project_id: persisted_project_id.clone(),
        store: state.store.clone(),
        injection: Some(injection),
        state: state.clone(),
    });
    state
        .chat_runs
        .attach_abort_handle(persisted_id.as_deref(), handle.abort_handle());
    *current_task = Some(handle);
    true
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
    recent_paths: &[String],
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
    // M3.3: file-path auto-activation. Skills with a non-empty
    // `paths` glob list that hit any of the agent's recently-
    // touched files this socket get added on top of the keyword
    // matches. Capped at AUTO_SKILL_TOP_K so a single edit can't
    // pile on indefinitely.
    if !recent_paths.is_empty() {
        let path_picks =
            harness_skill::pick_path_match_skills(&guard, recent_paths, AUTO_SKILL_TOP_K, &merged);
        for n in path_picks {
            if !merged.iter().any(|m| m == &n) {
                merged.push(n);
            }
        }
    }
    merged
}

/// FIFO push that dedupes and caps. Used to maintain the per-WS
/// session's "recently-touched files" list that feeds M3.3 skill
/// path-based auto-activation. Bounded so a long session can't
/// grow the list unbounded; older entries fall off as new ones
/// land. The dedupe-and-move-to-front policy keeps the most-
/// recent file at the head.
const RECENT_TOUCHED_FILES_CAP: usize = 32;

/// Push a fresh `tasks_snapshot` frame down `ws_tx`. Fan-out
/// helper for the BackgroundTasksPanel's WS-push path (P7): the
/// frontend listens for these and replaces its local task list,
/// so it doesn't need to poll `/v1/tasks` on a tight interval.
async fn push_tasks_snapshot(ws_tx: &mut SplitSink<WebSocket, WsMessage>, state: &AppState) {
    let items = crate::tasks_routes::collect_tasks(state).await;
    let _ = ws_tx
        .send(WsMessage::Text(
            json!({
                "type": "tasks_snapshot",
                "items": items,
                "generated_at": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
            .to_string(),
        ))
        .await;
}

/// Compute which skills would auto-activate via the M3.3
/// path-match rule on the next user turn, given `manual_active`
/// (the currently-selected skills the user already sees) and
/// `recent_touched_files`. Returns just the names, deduped against
/// the manual set. Used to power the Composer's "next turn
/// auto-activated" preview chip.
fn predict_skill_auto_activation(
    catalog: Option<&Arc<std::sync::RwLock<harness_skill::SkillCatalog>>>,
    manual_active: &[String],
    recent_touched_files: &[String],
) -> Vec<String> {
    let Some(cat_arc) = catalog else {
        return Vec::new();
    };
    let Ok(guard) = cat_arc.read() else {
        return Vec::new();
    };
    harness_skill::pick_path_match_skills(
        &guard,
        recent_touched_files,
        AUTO_SKILL_TOP_K,
        manual_active,
    )
}

fn push_recent_touched_file(files: &mut Vec<String>, path: &str) {
    if path.is_empty() {
        return;
    }
    let owned = path.to_string();
    if let Some(pos) = files.iter().position(|p| p == &owned) {
        files.remove(pos);
    }
    files.insert(0, owned);
    while files.len() > RECENT_TOUCHED_FILES_CAP {
        files.pop();
    }
}

/// Self-improving-agent Phase 1 — prepend a `=== user memory ===` block
/// onto the system prompt template. Each row renders as
/// `[<kind>] <title>: <body>`; rows arrive pinned-first / recent-first
/// from the store and the caller has already applied the byte cap via
/// [`crate::learning_emit::fetch_user_memories_for_prompt`].
///
/// Returns `None` when there's nothing to inject so callers can
/// short-circuit and leave the existing prompt untouched.
fn compose_with_user_memory(
    template: Option<&str>,
    memories: &[harness_learning::MemoryItem],
) -> Option<String> {
    if memories.is_empty() {
        return None;
    }
    let mut lines = Vec::with_capacity(memories.len() + 2);
    lines.push("=== user memory ===".to_string());
    for m in memories {
        if m.title.trim().is_empty() && m.body.trim().is_empty() {
            continue;
        }
        let kind = match m.kind {
            harness_learning::MemoryKind::Preference => "preference",
            harness_learning::MemoryKind::Fact => "fact",
            harness_learning::MemoryKind::Lesson => "lesson",
            harness_learning::MemoryKind::Gotcha => "gotcha",
            harness_learning::MemoryKind::Convention => "convention",
        };
        let title = m.title.trim();
        let body = m.body.trim();
        if body.is_empty() {
            lines.push(format!("[{kind}] {title}"));
        } else {
            lines.push(format!("[{kind}] {title}: {body}"));
        }
    }
    if lines.len() <= 1 {
        return None; // header only, nothing useful
    }
    lines.push("=== /user memory ===".to_string());
    let prefix = lines.join("\n");
    Some(match template {
        Some(t) if !t.is_empty() => format!("{prefix}\n\n{t}"),
        _ => prefix,
    })
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
    // Subscribe to RequirementRun-store mutations — sibling fanout
    // to `requirements_changed_rx`, but for typed run lifecycle
    // events (`Started` / `Finished` / `Verified`). Drives the
    // kanban card "Runs" drawer in the `/projects` Web UI.
    let mut runs_changed_rx = state.requirement_runs.as_ref().map(|s| s.subscribe());
    // Subscribe to Activity timeline appends — fan-out for the
    // `activity_appended` WS frame the kanban-card detail panel
    // listens on (see `RequirementDetail.tsx::ActivitySection`).
    let mut activities_changed_rx = state.activities.as_ref().map(|s| s.subscribe());
    // Subscribe to AgentProfile mutations — fan-out for the
    // Settings page's Agents tab and the kanban card assignee
    // picker.
    let mut agent_profiles_changed_rx = state.agent_profiles.as_ref().map(|s| s.subscribe());
    // Subscribe to Doc-store mutations. Same fanout pattern as
    // requirements; the `/docs` page listens globally and routes
    // events by project_id itself.
    let mut docs_changed_rx = state.docs.as_ref().map(|s| s.subscribe());
    // Phase 3.8 — Comment + Label store fan-out. Both feed the
    // kanban-card detail panel: comments for the discussion
    // drawer, labels for chip rendering. The Web UI routes to the
    // right card / project by `requirement_id` / `project_id`
    // itself, so the WS bridge stays unfiltered.
    let mut comments_changed_rx = state.comments.as_ref().map(|s| s.subscribe());
    let mut labels_changed_rx = state.labels.as_ref().map(|s| s.subscribe());
    // Phase 1 self-improving-agent — broadcast fan-out from the
    // `GuardedMemoryStore` wrapper. Same `Sender` the wrapper
    // publishes on at the composition root; here we subscribe and
    // forward each `MemoryEvent` to the client as a JSON frame so the
    // Memories panel doesn't have to poll `/v1/memories`.
    let mut memory_changed_rx = state.memory_events.as_ref().map(|tx| tx.subscribe());
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
    // Per-socket fallback for non-persisted (free-chat) turns where
    // there is no `chat_runs` entry to anchor approvals against.
    // Persisted turns route through `state.chat_runs.register_pending_approval`
    // (and `take_pending_approval`) so a disconnect → reconnect on
    // another tab can take over the approval prompt mid-turn — see
    // the `WsClientMessage::Approve` / `Deny` arms below.
    let mut pending: HashMap<String, oneshot::Sender<ApprovalDecision>> = HashMap::new();
    let mut pending_hitl: HashMap<String, oneshot::Sender<HitlResponse>> = HashMap::new();
    // `Some` while a turn is in flight; `None` between turns.
    let mut event_rx: Option<mpsc::Receiver<OwnerWsEvent>> = None;
    // Handle to the spawned agent task so `Interrupt` can abort it
    // mid-stream. Stays in lockstep with `event_rx`.
    let mut current_task: Option<tokio::task::JoinHandle<()>> = None;
    // Live tail of an in-flight turn that this socket does NOT own.
    // Set when `Resume` lands on a `persisted_id` whose run is already
    // active (the original socket dropped, or another client is
    // observing the same conversation). Cleared on terminal events,
    // on `Reset`, or when the client switches conversations via
    // `Resume`/`New`. Mutually exclusive with `event_rx` — a socket
    // either owns its turn or tails someone else's, never both.
    let mut tail_rx: Option<broadcast::Receiver<crate::chat_runs::ChatRunEventRecord>> = None;
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
    // M3.3: workspace-relative paths the agent has touched in this
    // socket's lifetime. Sniffed from `ToolStart` events for fs.*
    // tools below; consulted by `merged_skills_for_turn` so a
    // skill with `paths: ["**/*.rs"]` auto-activates after the
    // agent reads/edits a `.rs` file. Bounded so a long session
    // can't grow this unbounded.
    let mut recent_touched_files: Vec<String> = Vec::new();
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
                None => std::future::pending::<Option<OwnerWsEvent>>().await,
            }
        };
        // Same dormant pattern for the tail receiver. `recv()` returns
        // `Result<T, RecvError>` (Closed | Lagged), so the arm sees
        // both a frame and the channel-error variants in one place.
        let tail_fut = async {
            match tail_rx.as_mut() {
                Some(rx) => Some(rx.recv().await),
                None => std::future::pending::<Option<Result<_, _>>>().await,
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
                    &mut tail_rx,
                    &mut sticky_provider,
                    &mut sticky_model,
                    &mut active_skills,
                    &recent_touched_files,
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
            // Stash the responder so the client's reply can route
            // back: persisted conversations go through the
            // `ChatRunRegistry` (survives reconnect), free chat
            // falls back to the per-socket map.
            Some(p) = pending_rx.recv() => {
                if let Some(convo) = persisted_id.as_deref() {
                    state.chat_runs.register_pending_approval(
                        convo,
                        p.request,
                        p.responder,
                    );
                } else {
                    pending.insert(p.request.tool_call_id.clone(), p.responder);
                }
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
            // ---- requirement-run store mutated (start_run / patch /
            // verification gate) ----
            // The store classifies each `upsert` into a typed
            // [`RequirementRunEvent`] (Started for first-insert
            // non-terminal, Finished for the row crossing into a
            // terminal status), and the verification handler fans
            // out an extra `Verified` frame via `broadcast`. We
            // forward all three to every connected client without
            // a per-socket filter — the kanban UI routes events to
            // the right card by `requirement_id`.
            Ok(ev) = async {
                match runs_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<RequirementRunEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    RequirementRunEvent::Started(run) => {
                        json!({ "type": "requirement_run_started", "run": run })
                    }
                    RequirementRunEvent::Finished(run) => {
                        json!({ "type": "requirement_run_finished", "run": run })
                    }
                    RequirementRunEvent::Verified { run_id, result } => {
                        json!({
                            "type": "requirement_run_verified",
                            "run_id": run_id,
                            "result": result
                        })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- activity timeline appended ----
            // Append-only audit log; one variant in the enum today
            // (`Appended`). UI routes events to the matching
            // requirement card by `requirement_id`.
            Ok(ev) = async {
                match activities_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<ActivityEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    ActivityEvent::Appended(item) => {
                        json!({ "type": "activity_appended", "activity": item })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- agent profile store mutated ----
            // Process-wide CRUD; both the Settings page's Agents
            // tab and every card detail's assignee picker listen
            // on these frames.
            Ok(ev) = async {
                match agent_profiles_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<AgentProfileEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    AgentProfileEvent::Upserted(p) => {
                        json!({ "type": "agent_profile_upserted", "profile": p })
                    }
                    AgentProfileEvent::Deleted { id } => {
                        json!({ "type": "agent_profile_deleted", "id": id })
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
            // ---- comment store mutated (Phase 3.8) ----
            // Discussion thread under one Requirement. Sibling fan-out
            // to `activities_changed_rx` — the kanban-card detail
            // panel reads both streams to keep the timeline + thread
            // in sync without a refetch round-trip.
            Ok(ev) = async {
                match comments_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<CommentEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    CommentEvent::Posted(c) => {
                        json!({ "type": "comment_posted", "comment": c })
                    }
                    CommentEvent::Edited(c) => {
                        json!({ "type": "comment_edited", "comment": c })
                    }
                    CommentEvent::Deleted { requirement_id, comment_id } => {
                        json!({
                            "type": "comment_deleted",
                            "requirement_id": requirement_id,
                            "comment_id": comment_id
                        })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- label store mutated (Phase 3.8) ----
            // Project-scoped tags. The Web UI routes by `project_id`
            // — the kanban repaints chips on rename / recolour, the
            // settings panel keeps its list synced.
            Ok(ev) = async {
                match labels_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<LabelEvent, ()>>().await,
                }
            } => {
                let frame = match &ev {
                    LabelEvent::Created(l) => {
                        json!({ "type": "label_created", "label": l })
                    }
                    LabelEvent::Updated(l) => {
                        json!({ "type": "label_updated", "label": l })
                    }
                    LabelEvent::Deleted { project_id, label_id } => {
                        json!({
                            "type": "label_deleted",
                            "project_id": project_id,
                            "label_id": label_id
                        })
                    }
                };
                let _ = ws_tx.send(WsMessage::Text(frame.to_string())).await;
            }
            // ---- long-term memory store mutated (Phase 1 self-improving-agent) ----
            // Source: `harness_store::GuardedMemoryStore`. Wire shape
            // is `{type: "memory_upserted", item}` / `{type: "memory_deleted", id}`.
            // The Web UI Memories panel listens for these to refresh
            // without a polling round-trip.
            Ok(ev) = async {
                match memory_changed_rx.as_mut() {
                    Some(rx) => rx.recv().await.map_err(|_| ()),
                    None => std::future::pending::<Result<harness_learning::MemoryEvent, ()>>().await,
                }
            } => {
                // The enum is `#[serde(tag = "type")]` with snake_case
                // variant names → serialising the event directly
                // gives us the exact wire shape we want.
                if let Ok(payload) = serde_json::to_string(&ev) {
                    let _ = ws_tx.send(WsMessage::Text(payload)).await;
                }
            }
            // ---- native HITL tool → server ----
            Some(p) = pending_hitl_rx.recv() => {
                let id = p.request.id.clone();
                let frame = json!({ "type": "hitl_request", "request": p.request });
                let payload = frame.to_string();
                pending_hitl.insert(id, p.responder);
                state.chat_runs.waiting_hitl(persisted_id.as_deref());
                state.chat_runs.frame(
                    persisted_id.as_deref(),
                    Some(crate::chat_runs::ChatRunStatus::WaitingHitl),
                    frame,
                );
                if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                    return;
                }
            }
            // ---- agent → server ----
            ev = event_fut => {
                let Some((event_seq, ev)) = ev else {
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
                // Tool-initiated mode change (M2.3 `enter_plan_mode`).
                // Flip the per-socket mode handle so the next turn's
                // approver / tool_filter see the new mode. The
                // current turn finishes under the old mode — that's
                // intentional, see [`mode_signal`] doc.
                // M3.3 skill auto-activation: track every fs.* path
                // the agent touches so the next turn's
                // `merged_skills_for_turn` can pick up skills whose
                // `paths` glob hits the recent set. Bounded FIFO so a
                // long session doesn't accumulate forever; sniffed at
                // ToolStart rather than ToolEnd because Start lands
                // first and successful starts are followed by a body
                // event anyway — we don't gate on success because the
                // glob only cares "did the agent intend to touch X".
                if let AgentEvent::ToolStart { name, arguments, .. } = &ev_to_send {
                    if matches!(
                        name.as_str(),
                        "fs.read" | "fs.list" | "fs.write" | "fs.edit"
                    ) {
                        if let Some(p) = arguments.get("path").and_then(|v| v.as_str()) {
                            push_recent_touched_file(&mut recent_touched_files, p);
                        }
                    } else if name == "fs.patch" {
                        if let Some(diff) = arguments.get("diff").and_then(|v| v.as_str()) {
                            for line in diff.lines() {
                                if let Some(rest) = line.strip_prefix("+++ b/") {
                                    push_recent_touched_file(&mut recent_touched_files, rest);
                                }
                            }
                        }
                    }
                }
                if let AgentEvent::ModeChanged { mode } = &ev_to_send {
                    let new_mode = *mode;
                    *mode_handle.write().await = new_mode;
                    // Mirror via the existing `permission_mode` UI
                    // frame so banners / mode badges update in step
                    // with the change, same shape as the `SetMode`
                    // / `AcceptPlan` paths.
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "permission_mode",
                                "mode": new_mode,
                                "via": "tool",
                            })
                            .to_string(),
                        ))
                        .await;
                }
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
                // Serialize then stamp the `seq` the ring buffer
                // assigned to this frame (same seq the tail
                // subscribers see in `ChatRunEventRecord`). Lets
                // the client track its high-water mark so a
                // disconnect → `Resume { after_seq }` only replays
                // events it actually missed.
                let payload = match serde_json::to_value(&ev_to_send) {
                    Ok(mut v) => {
                        if let (Some(seq), Some(obj)) = (event_seq, v.as_object_mut()) {
                            obj.insert("seq".to_string(), json!(seq));
                        }
                        v.to_string()
                    }
                    Err(e) => json!({
                        "type": "error",
                        "message": format!("serialize: {e}")
                    })
                    .to_string(),
                };
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
                    // M3.3 UX patch: after a turn ends, predict which
                    // skills *would* auto-activate next turn given
                    // the files the agent touched. The Composer shows
                    // a chip ("auto-activated next turn: foo") so the
                    // user can see in advance — and decide whether to
                    // proceed or pivot. Empty payload still emitted
                    // so the Composer can clear any stale chip.
                    let preview = predict_skill_auto_activation(
                        state.skills.as_ref(),
                        &active_skills,
                        &recent_touched_files,
                    );
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "skill_auto_activated_for_next_turn",
                                "skills": preview,
                            })
                            .to_string(),
                        ))
                        .await;
                    // P7: push the BackgroundTasksPanel's task list
                    // at the natural state-change moment (turn just
                    // finished) so the panel can drop its 3s poll.
                    push_tasks_snapshot(&mut ws_tx, &state).await;
                }
            }
            // ---- tailed run → server ----
            // Active when `Resume` landed on an in-flight turn that
            // belongs to a different (or now-disconnected) socket.
            // Each `ChatRunEventRecord.frame` is the same JSON shape
            // the owning socket would have produced via the agent
            // arm above, so we can ship it down the wire as-is.
            Some(tail_result) = tail_fut => {
                match tail_result {
                    Ok(record) => {
                        let seq = record.seq;
                        let mut frame = record.frame;
                        let frame_type = frame
                            .get("type")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        // Stamp the ring-buffer seq onto the frame
                        // before sending so a tail subscriber's
                        // wire payload looks identical to what the
                        // owner socket would have sent.
                        if let Some(obj) = frame.as_object_mut() {
                            obj.insert("seq".to_string(), json!(seq));
                        }
                        let payload = frame.to_string();
                        if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                            return;
                        }
                        let is_terminal = matches!(
                            frame_type.as_deref(),
                            Some("done") | Some("error")
                        );
                        if is_terminal {
                            // The detached agent task already saved
                            // the conversation on Done; reload so the
                            // local mirror is fresh for any follow-up
                            // turn the client kicks off. On Error the
                            // agent task did NOT save (the failure
                            // path leaves the pre-turn state intact),
                            // so reloading is a no-op but harmless.
                            if let (Some(id), Some(store)) =
                                (persisted_id.as_deref(), state.store.as_ref())
                            {
                                if let Ok(Some((mut loaded, _))) = store.load_envelope(id).await {
                                    loaded.last_response_id = None;
                                    loaded.last_response_chain_origin = None;
                                    conv = loaded;
                                }
                            }
                            tail_rx = None;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(
                            convo = persisted_id.as_deref().unwrap_or(""),
                            skipped,
                            "ws tail subscriber lagged; dropping tail",
                        );
                        let _ = ws_tx
                            .send(WsMessage::Text(
                                json!({
                                    "type": "tail_lost",
                                    "reason": "lagged",
                                    "skipped": skipped,
                                })
                                .to_string(),
                            ))
                            .await;
                        tail_rx = None;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // Sender side gone. Should not happen while a
                        // run is active (the registry holds the Sender
                        // for the lifetime of the conversation entry),
                        // but if it ever does, drop quietly.
                        tail_rx = None;
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
    event_rx: &mut Option<mpsc::Receiver<OwnerWsEvent>>,
    current_task: &mut Option<tokio::task::JoinHandle<()>>,
    tail_rx: &mut Option<broadcast::Receiver<crate::chat_runs::ChatRunEventRecord>>,
    sticky_provider: &mut Option<String>,
    sticky_model: &mut Option<String>,
    active_skills: &mut Vec<String>,
    recent_touched_files: &[String],
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
            // Persisted conversations store the oneshot in the
            // registry so a reconnect can take it over; fall back
            // to the per-socket map for free chat (no registry
            // entry exists for non-persisted turns).
            let responder = persisted_id
                .as_deref()
                .and_then(|convo| state.chat_runs.take_pending_approval(convo, &tool_call_id))
                .or_else(|| pending.remove(&tool_call_id));
            if let Some(responder) = responder {
                let _ = responder.send(ApprovalDecision::Approve);
            } else {
                // Benign race: client clicked twice, the turn
                // ended before the click reached us, or the slot
                // was drained on terminal. Silently log instead of
                // surfacing as a banner — the user already saw the
                // outcome of the original decision.
                warn!(%tool_call_id, "approve frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::Deny {
            tool_call_id,
            reason,
        } => {
            let responder = persisted_id
                .as_deref()
                .and_then(|convo| state.chat_runs.take_pending_approval(convo, &tool_call_id))
                .or_else(|| pending.remove(&tool_call_id));
            if let Some(responder) = responder {
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
                state.chat_runs.running(persisted_id.as_deref());
                state.chat_runs.frame(
                    persisted_id.as_deref(),
                    Some(crate::chat_runs::ChatRunStatus::Running),
                    json!({ "type": "hitl_response", "response": response.clone() }),
                );
                let _ = ws_tx
                    .send(WsMessage::Text(
                        json!({ "type": "hitl_response", "response": response }).to_string(),
                    ))
                    .await;
            } else {
                warn!(%request_id, "hitl_response frame for unknown id (already resolved or stale)");
            }
        }
        WsClientMessage::StartTurn {
            mode,
            id,
            content,
            model,
            provider,
            soul_prompt,
            project_id,
            workspace_path,
            active_skills: requested_skills,
        } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            if state.chat_runs.is_active(&id) {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            if let Some(requested) = requested_skills.as_ref() {
                match validate_active_skills(state.skills.as_ref(), requested) {
                    Ok(validated) => *active_skills = validated,
                    Err(e) => {
                        send_error(ws_tx, &e).await;
                        return true;
                    }
                }
            }
            let provider_pick = provider.as_deref().or(sticky_provider.as_deref());
            let model_pick = model.as_deref().or(sticky_model.as_deref());
            if let Err(e) = state.providers.pick(provider_pick, model_pick) {
                send_error(ws_tx, &e.to_string()).await;
                return true;
            }

            match mode {
                StartTurnMode::New => {
                    if is_internal_id(&id) {
                        send_error(
                            ws_tx,
                            "ids starting with `__` are reserved for internal use",
                        )
                        .await;
                        return true;
                    }
                    let Some(store) = state.store.as_ref() else {
                        send_error(ws_tx, "persistence not configured").await;
                        return true;
                    };
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
                                    send_error(ws_tx, &format!("project `{needle}` is archived"))
                                        .await;
                                    return true;
                                }
                                Ok(None) => {
                                    send_error(ws_tx, &format!("project `{needle}` not found"))
                                        .await;
                                    return true;
                                }
                                Err(e) => {
                                    send_error(ws_tx, &format!("project lookup failed: {e}")).await;
                                    return true;
                                }
                            }
                        }
                    };
                    let workspace_binding =
                        match resolve_requested_workspace(workspace_path.as_deref()).await {
                            Ok(binding) => binding,
                            Err(e) => {
                                send_error(ws_tx, &e).await;
                                return true;
                            }
                        };

                    *conv = Conversation::new();
                    let metadata = ConversationMetadata {
                        project_id: resolved_project_id.clone(),
                        ..Default::default()
                    };
                    if let Err(e) = store.save_envelope(&id, conv, &metadata).await {
                        error!(error = %e, %id, "ws start_turn save_envelope failed");
                        send_error(ws_tx, &format!("create failed: {e}")).await;
                        return true;
                    }
                    *persisted_id = Some(id.clone());
                    *persisted_project_id = resolved_project_id.clone();

                    let (bound_workspace, bound_workspace_info) =
                        if let Some((path, path_str, snapshot)) = workspace_binding {
                            *socket_workspace = Some(path);
                            if let Some(ws) = state.workspaces.as_ref() {
                                let _ = ws.touch(&path_str);
                                ws.bind(&id, &path_str);
                            }
                            (Some(path_str), Some(snapshot))
                        } else {
                            *socket_workspace = None;
                            (None, None)
                        };

                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "started",
                                "id": id,
                                "project_id": resolved_project_id,
                                "workspace_path": bound_workspace,
                                "workspace": bound_workspace_info,
                            })
                            .to_string(),
                        ))
                        .await;
                }
                StartTurnMode::Resume => {
                    if is_internal_id(&id) {
                        send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                        return true;
                    }
                    let Some(store) = state.store.as_ref() else {
                        send_error(ws_tx, "persistence not configured").await;
                        return true;
                    };
                    match store.load_envelope(&id).await {
                        Ok(Some((mut loaded, meta))) => {
                            let count = loaded.messages.len();
                            let bound_project = meta.project_id.clone();
                            loaded.last_response_id = None;
                            loaded.last_response_chain_origin = None;
                            *conv = loaded;
                            *persisted_id = Some(id.clone());
                            *persisted_project_id = bound_project.clone();

                            let stored_workspace =
                                state.workspaces.as_ref().and_then(|s| s.lookup(&id));
                            let mut resumed_workspace: Option<String> = None;
                            if let Some(path_str) = stored_workspace.as_deref() {
                                match std::fs::canonicalize(path_str) {
                                    Ok(p) if p.is_dir() => {
                                        *socket_workspace = Some(p.clone());
                                        resumed_workspace = Some(p.display().to_string());
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
                                                json!({
                                                    "type": "workspace_changed",
                                                    "path": null
                                                })
                                                .to_string(),
                                            ))
                                            .await;
                                    }
                                }
                            } else {
                                *socket_workspace = None;
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({ "type": "workspace_changed", "path": null })
                                            .to_string(),
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
                                        "workspace_path": resumed_workspace,
                                        "live": false,
                                    })
                                    .to_string(),
                                ))
                                .await;
                        }
                        Ok(None) => {
                            send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                            return true;
                        }
                        Err(e) => {
                            error!(error = %e, %id, "ws start_turn resume load failed (treating as not found)");
                            send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                            return true;
                        }
                    }
                }
            }

            return begin_user_turn(
                content,
                model,
                provider,
                soul_prompt,
                ws_tx,
                state,
                socket_approver,
                mode_handle,
                conv,
                persisted_id,
                persisted_project_id,
                last_injection,
                event_rx,
                current_task,
                sticky_provider,
                sticky_model,
                active_skills,
                recent_touched_files,
                socket_workspace,
                hitl_tx,
            )
            .await;
        }
        WsClientMessage::User {
            content,
            model,
            provider,
            soul_prompt,
        } => {
            return begin_user_turn(
                content,
                model,
                provider,
                soul_prompt,
                ws_tx,
                state,
                socket_approver,
                mode_handle,
                conv,
                persisted_id,
                persisted_project_id,
                last_injection,
                event_rx,
                current_task,
                sticky_provider,
                sticky_model,
                active_skills,
                recent_touched_files,
                socket_workspace,
                hitl_tx,
            )
            .await;
        }
        WsClientMessage::Configure { model, provider } => {
            if event_rx.is_some() {
                send_error(ws_tx, "turn in progress; cannot configure").await;
                return true;
            }
            // Validate the picked combination by routing once; if
            // it's invalid we surface a clear error instead of
            // failing on the next `User` frame.
            if let Err(e) = state.providers.pick(provider.as_deref(), model.as_deref()) {
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
            // Drop any live tail when the user clears state — they're
            // explicitly leaving the conversation, no further frames
            // from it should reach this socket.
            *tail_rx = None;
            let _ = ws_tx
                .send(WsMessage::Text(json!({ "type": "reset" }).to_string()))
                .await;
        }
        WsClientMessage::Resume {
            id,
            model,
            provider,
            after_seq,
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
            // Drop any prior tail before swapping conversations — if
            // the previous Resume attached to a different conv's live
            // run, those frames must not bleed into the new context.
            *tail_rx = None;
            if is_internal_id(&id) {
                send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                return true;
            }
            let Some(store) = state.store.as_ref() else {
                send_error(ws_tx, "persistence not configured").await;
                return true;
            };
            match store.load_envelope(&id).await {
                Ok(Some((mut loaded, meta))) => {
                    let count = loaded.messages.len();
                    let bound_project = meta.project_id.clone();
                    // Chain breaker: server-side state behind
                    // `last_response_id` may have aged out of the
                    // provider's retention window while we were down.
                    // Treat the persisted id as a hint at most — clear
                    // it on resume so the next request rebuilds the
                    // chain from scratch.
                    loaded.last_response_id = None;
                    loaded.last_response_chain_origin = None;
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
                    let live_tail = state.chat_runs.is_active(&id);
                    let _ = ws_tx
                        .send(WsMessage::Text(
                            json!({
                                "type": "resumed",
                                "id": id,
                                "message_count": count,
                                "project_id": bound_project,
                                "workspace_path": bound_workspace,
                                "live": live_tail,
                            })
                            .to_string(),
                        ))
                        .await;
                    // If a turn is already running for this
                    // conversation (the original socket dropped, or
                    // another client is observing), attach to the
                    // broadcast bus so the user sees streaming events
                    // pick up where the disconnect happened.
                    //
                    // Atomicity: `subscribe()` takes the registry's
                    // write-side guard, so the snapshot + the
                    // `Receiver` it returns are consistent — any
                    // event pushed after this call lands on the
                    // receiver, any event pushed before is in the
                    // snapshot. Replay first so wire order matches
                    // what the original socket would have seen.
                    if live_tail {
                        let cursor = after_seq.unwrap_or(0);
                        match state.chat_runs.subscribe(&id, cursor) {
                            Some(Ok((snapshot, rx, window))) => {
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({
                                            "type": "tail_replay_start",
                                            "count": snapshot.len(),
                                            "first_seq": window.first_seq,
                                            "latest_seq": window.latest_seq,
                                        })
                                        .to_string(),
                                    ))
                                    .await;
                                for record in snapshot {
                                    let seq = record.seq;
                                    let mut frame = record.frame;
                                    if let Some(obj) = frame.as_object_mut() {
                                        obj.insert("seq".to_string(), json!(seq));
                                    }
                                    let payload = frame.to_string();
                                    if ws_tx.send(WsMessage::Text(payload)).await.is_err() {
                                        return false;
                                    }
                                }
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({ "type": "tail_replay_done" }).to_string(),
                                    ))
                                    .await;
                                *tail_rx = Some(rx);
                            }
                            // Resume with after=0 on a buffer that
                            // has already evicted seq 1: the run is
                            // still live but the early frames are
                            // gone. Tell the client so it can do a
                            // full reload via the persisted history
                            // endpoint instead of silently missing
                            // events.
                            Some(Err(crate::chat_runs::ResumeError::Evicted {
                                first_available_seq,
                            })) => {
                                let _ = ws_tx
                                    .send(WsMessage::Text(
                                        json!({
                                            "type": "resume_error",
                                            "reason": "evicted",
                                            "first_available_seq": first_available_seq,
                                        })
                                        .to_string(),
                                    ))
                                    .await;
                            }
                            // No buffered state at all (race with
                            // terminal cleanup, or registry was
                            // wiped). Silent fallthrough — the
                            // resumed REST history is already on the
                            // wire and the next user message will
                            // start a fresh turn.
                            None => {}
                        }
                        // Re-prompt the reconnecting client for any
                        // approvals the agent is still blocked on.
                        // The original socket's `pending` map (or a
                        // prior tab) may have dropped, but the
                        // oneshot lives in the registry under M4 so
                        // this socket can route the verdict back.
                        // Send AFTER the tail snapshot so the ApprovalRequest
                        // frame appears in chronological order
                        // before the explicit `approval_pending`
                        // re-prompt the UI uses to know the slot is
                        // still alive.
                        let pending_replays = state.chat_runs.list_pending_approvals(&id);
                        for req in pending_replays {
                            let frame = json!({
                                "type": "approval_pending",
                                "id": req.tool_call_id,
                                "name": req.tool_name,
                                "arguments": req.arguments,
                                "category": req.category,
                            });
                            if ws_tx
                                .send(WsMessage::Text(frame.to_string()))
                                .await
                                .is_err()
                            {
                                return false;
                            }
                        }
                    }
                }
                Ok(None) => {
                    send_error(ws_tx, &format!("conversation `{id}` not found")).await;
                }
                Err(e) => {
                    // Treat load failures (corrupted JSON from a
                    // partial atomic-write, missing parent dir, IO
                    // hiccup) the same as `Ok(None)` on the wire so
                    // the web client's not-found handler can reap
                    // the stale sidebar row uniformly. The error
                    // detail still goes to the operator log.
                    error!(error = %e, %id, "ws resume load failed (treating as not found)");
                    send_error(ws_tx, &format!("conversation `{id}` not found")).await;
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
            // Same logic as Resume: leaving the prior conversation,
            // so any tail attached to it must be dropped.
            *tail_rx = None;
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

            let workspace_binding =
                match resolve_requested_workspace(workspace_path.as_deref()).await {
                    Ok(binding) => binding,
                    Err(e) => {
                        send_error(ws_tx, &e).await;
                        return true;
                    }
                };

            let new_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
            *conv = Conversation::new();
            // Eager persistence: write the empty conversation row up
            // front so a `New` followed by tab-close / network drop /
            // mid-tool abandonment still leaves a resumable row on
            // disk. Validate all user-supplied bindings before this
            // point so rejected starts do not leave empty rows behind.
            let metadata = ConversationMetadata {
                project_id: resolved_project_id.clone(),
                ..Default::default()
            };
            if let Err(e) = store.save_envelope(&new_id, conv, &metadata).await {
                error!(error = %e, %new_id, "ws new save_envelope failed");
                send_error(ws_tx, &format!("create failed: {e}")).await;
                return true;
            }
            *persisted_id = Some(new_id.clone());
            *persisted_project_id = resolved_project_id.clone();

            let (bound_workspace, bound_workspace_info) =
                if let Some((path, path_str, snapshot)) = workspace_binding {
                    *socket_workspace = Some(path);
                    if let Some(ws) = state.workspaces.as_ref() {
                        let _ = ws.touch(&path_str);
                        ws.bind(&new_id, &path_str);
                    }
                    (Some(path_str), Some(snapshot))
                } else {
                    *socket_workspace = None;
                    (None, None)
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
            state.chat_runs.cancelled(persisted_id.as_deref());
            // Roll back the trailing user message: the assistant
            // never replied, so leaving it in `conv` would make the
            // next turn look like back-to-back user turns to the
            // model. Some providers (Anthropic, Gemini) reject that.
            if matches!(conv.messages.last(), Some(Message::User { .. })) {
                conv.messages.pop();
            }
            pending.clear();
            pending_hitl.clear();
            state.chat_runs.frame(
                persisted_id.as_deref(),
                Some(crate::chat_runs::ChatRunStatus::Cancelled),
                json!({ "type": "interrupted" }),
            );
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
            if persisted_id
                .as_deref()
                .is_some_and(|id| state.chat_runs.is_active(id))
            {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            let content = expand_goal_command(&content).unwrap_or(content);
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
            let skills_snapshot = merged_skills_for_turn(
                skills_catalog.as_ref(),
                active_skills,
                &content,
                recent_touched_files,
            );
            crate::learning_emit::spawn_record(
                state.learning_skill_usage.clone(),
                crate::learning_emit::build_used_events(
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                    crate::learning_emit::workspace_scope(socket_workspace.as_deref()),
                    persisted_id.clone(),
                ),
            );
            let user_memories =
                crate::learning_emit::fetch_user_memories_for_prompt(state.learning_memory.as_ref())
                    .await;
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) =
                    compose_with_user_memory(cfg.system_prompt.as_deref(), &user_memories)
                {
                    cfg.system_prompt = Some(prompt);
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
            let record_provider = provider_pick.map(str::to_string);
            let record_model = model_pick.map(str::to_string);
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
                state.project_memory.as_ref(),
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
            let workspace_key = active_workspace_key(state, socket_workspace.as_deref());
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
            let injection = TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at,
            };
            *last_injection = Some(injection.clone());
            let (event_tx, new_rx) = mpsc::channel::<OwnerWsEvent>(64);
            *event_rx = Some(new_rx);
            if let Some(id) = persisted_id.as_deref() {
                if !state.chat_runs.try_start(id) {
                    *event_rx = None;
                    *last_injection = None;
                    conv.messages.pop();
                    send_error(ws_tx, "turn already in progress").await;
                    return true;
                }
            }
            let handle = spawn_detached_turn(DetachedTurn {
                agent,
                conversation: snapshot,
                event_tx,
                chat_runs: state.chat_runs.clone(),
                subagent_runs: state.subagent_runs.clone(),
                observability: state.observability.clone(),
                run_id: Uuid::new_v4().to_string(),
                started_at: chrono::Utc::now().to_rfc3339(),
                started: Instant::now(),
                provider: record_provider,
                model: record_model,
                persisted_id: persisted_id.clone(),
                persisted_project_id: persisted_project_id.clone(),
                store: state.store.clone(),
                injection: Some(injection),
                state: state.clone(),
            });
            state
                .chat_runs
                .attach_abort_handle(persisted_id.as_deref(), handle.abort_handle());
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
            // Plan accepted — push a synthetic "proceed" user
            // message and spawn the next turn under the new mode so
            // the agent picks up immediately instead of stalling
            // after exit_plan ended its previous turn. Mirrors
            // RefinePlan's spawn pattern; the only structural
            // difference is we don't apply plan_mode_tool_filter,
            // since AcceptPlan's whole point is leaving plan mode
            // and the new turn must see write/exec tools.
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            if persisted_id
                .as_deref()
                .is_some_and(|id| state.chat_runs.is_active(id))
            {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            let proceed_message = "Plan approved. Please proceed with the implementation.";
            let provider_pick = sticky_provider.as_deref();
            let model_pick = sticky_model.as_deref();
            let approver = socket_approver.clone();
            let hitl = hitl_tx.clone();
            let active_mode = *mode_handle.read().await;
            let skills_catalog = state.skills.as_ref().cloned();
            let skills_snapshot = merged_skills_for_turn(
                skills_catalog.as_ref(),
                active_skills,
                proceed_message,
                recent_touched_files,
            );
            crate::learning_emit::spawn_record(
                state.learning_skill_usage.clone(),
                crate::learning_emit::build_used_events(
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                    crate::learning_emit::workspace_scope(socket_workspace.as_deref()),
                    persisted_id.clone(),
                ),
            );
            let user_memories =
                crate::learning_emit::fetch_user_memories_for_prompt(state.learning_memory.as_ref())
                    .await;
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) =
                    compose_with_user_memory(cfg.system_prompt.as_deref(), &user_memories)
                {
                    cfg.system_prompt = Some(prompt);
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
            conv.push(Message::user(proceed_message.to_string()));
            let prepared = match materialise(
                state.projects.as_ref(),
                state.project_memory.as_ref(),
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
            let workspace_key = active_workspace_key(state, socket_workspace.as_deref());
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
            let injection = TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at: None,
            };
            *last_injection = Some(injection.clone());
            let (event_tx, new_rx) = mpsc::channel::<OwnerWsEvent>(64);
            *event_rx = Some(new_rx);
            if let Some(id) = persisted_id.as_deref() {
                if !state.chat_runs.try_start(id) {
                    *event_rx = None;
                    *last_injection = None;
                    conv.messages.pop();
                    send_error(ws_tx, "turn already in progress").await;
                    return true;
                }
            }
            let handle = spawn_detached_turn(DetachedTurn {
                agent,
                conversation: snapshot,
                event_tx,
                chat_runs: state.chat_runs.clone(),
                subagent_runs: state.subagent_runs.clone(),
                observability: state.observability.clone(),
                run_id: Uuid::new_v4().to_string(),
                started_at: chrono::Utc::now().to_rfc3339(),
                started: Instant::now(),
                provider: provider_pick.map(str::to_string),
                model: model_pick.map(str::to_string),
                persisted_id: persisted_id.clone(),
                persisted_project_id: persisted_project_id.clone(),
                store: state.store.clone(),
                injection: Some(injection),
                state: state.clone(),
            });
            state
                .chat_runs
                .attach_abort_handle(persisted_id.as_deref(), handle.abort_handle());
            *current_task = Some(handle);
        }
        WsClientMessage::RefinePlan { feedback } => {
            // Equivalent to a User frame — feed the feedback back to
            // the agent in the current (Plan) mode so it iterates on
            // the plan rather than executing.
            if event_rx.is_some() {
                send_error(ws_tx, "turn already in progress").await;
                return true;
            }
            if persisted_id
                .as_deref()
                .is_some_and(|id| state.chat_runs.is_active(id))
            {
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
            let skills_snapshot = merged_skills_for_turn(
                skills_catalog.as_ref(),
                active_skills,
                &feedback,
                recent_touched_files,
            );
            crate::learning_emit::spawn_record(
                state.learning_skill_usage.clone(),
                crate::learning_emit::build_used_events(
                    skills_catalog.as_ref(),
                    &skills_snapshot,
                    crate::learning_emit::workspace_scope(socket_workspace.as_deref()),
                    persisted_id.clone(),
                ),
            );
            let user_memories =
                crate::learning_emit::fetch_user_memories_for_prompt(state.learning_memory.as_ref())
                    .await;
            let workspace_for_turn = socket_workspace.clone();
            let agent = match state.build_agent_with(provider_pick, model_pick, |cfg| {
                cfg.approver = Some(approver);
                cfg.hitl_tx = Some(hitl);
                if matches!(active_mode, harness_core::PermissionMode::Plan) {
                    cfg.tool_filter = Some(plan_mode_tool_filter());
                }
                if let Some(prompt) =
                    compose_with_user_memory(cfg.system_prompt.as_deref(), &user_memories)
                {
                    cfg.system_prompt = Some(prompt);
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
                state.project_memory.as_ref(),
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
            let workspace_key = active_workspace_key(state, socket_workspace.as_deref());
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
            let injection = TurnInjection {
                project: prepared,
                todos: todos_prepared,
                soul_injected_at: None,
            };
            *last_injection = Some(injection.clone());
            let (event_tx, new_rx) = mpsc::channel::<OwnerWsEvent>(64);
            *event_rx = Some(new_rx);
            if let Some(id) = persisted_id.as_deref() {
                if !state.chat_runs.try_start(id) {
                    *event_rx = None;
                    *last_injection = None;
                    conv.messages.pop();
                    send_error(ws_tx, "turn already in progress").await;
                    return true;
                }
            }
            let handle = spawn_detached_turn(DetachedTurn {
                agent,
                conversation: snapshot,
                event_tx,
                chat_runs: state.chat_runs.clone(),
                subagent_runs: state.subagent_runs.clone(),
                observability: state.observability.clone(),
                run_id: Uuid::new_v4().to_string(),
                started_at: chrono::Utc::now().to_rfc3339(),
                started: Instant::now(),
                provider: provider_pick.map(str::to_string),
                model: model_pick.map(str::to_string),
                persisted_id: persisted_id.clone(),
                persisted_project_id: persisted_project_id.clone(),
                store: state.store.clone(),
                injection: Some(injection),
                state: state.clone(),
            });
            state
                .chat_runs
                .attach_abort_handle(persisted_id.as_deref(), handle.abort_handle());
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
            // Phase 0 self-improving-agent — explicit user activation
            // is the strongest "Used" signal we have. Emit before the
            // ack so the event lands even if the WS closes mid-write.
            crate::learning_emit::spawn_record(
                state.learning_skill_usage.clone(),
                crate::learning_emit::build_used_events(
                    state.skills.as_ref(),
                    std::slice::from_ref(&name),
                    crate::learning_emit::workspace_scope(socket_workspace.as_deref()),
                    persisted_id.clone(),
                ),
            );
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

/// Expand `/goal ...` into an explicit coordinator instruction before
/// the turn reaches the model. The raw slash command is intentionally
/// handled server-side so every client (web, desktop, direct WS) gets
/// the same long-running-goal semantics without inventing a new frame.
fn expand_goal_command(content: &str) -> Option<String> {
    let goal = slash_command_arg(content, "/goal")?;
    if goal.is_empty() {
        return Some(
            "The user invoked `/goal` without a goal. Ask one concise follow-up for the \
             long-running goal they want Jarvis to pursue."
                .to_string(),
        );
    }

    Some(format!(
        "The user invoked `/goal`, which means this is a long-running session/project goal.\n\n\
Goal:\n{goal}\n\n\
Act as the coordinator for this goal:\n\
1. Orient in the workspace and current project/session context before editing.\n\
2. Create or update durable TODOs / Requirements when those tools are available; otherwise keep a visible plan for this session.\n\
3. Prefer delegating implementation slices to `subagent.codex` when coding work benefits from a fresh context. Use focused task strings and keep the main conversation as scheduler/reviewer.\n\
4. Use `subagent.read_doc` or `subagent.review` for reading and verification work when useful.\n\
5. Continue until the goal is done, blocked on a human decision, or needs approval. Report progress, blockers, files changed, and checks run."
    ))
}

fn expand_goal_in_messages(mut messages: Vec<Message>) -> Vec<Message> {
    if let Some(Message::User { content, .. }) = messages.last_mut() {
        if let Some(expanded) = expand_goal_command(content) {
            *content = expanded;
        }
    }
    messages
}

fn slash_command_arg<'a>(content: &'a str, command: &str) -> Option<&'a str> {
    let trimmed = content.trim_start();
    let rest = trimmed.strip_prefix(command)?;
    match rest.chars().next() {
        Some(ch) if !ch.is_whitespace() => None,
        _ => Some(rest.trim()),
    }
}

async fn send_error(ws_tx: &mut SplitSink<WebSocket, WsMessage>, message: &str) {
    let _ = ws_tx
        .send(WsMessage::Text(
            json!({ "type": "error", "message": message }).to_string(),
        ))
        .await;
}

#[cfg(test)]
mod cors_tests {
    use super::is_local_origin;

    #[test]
    fn allows_loopback_and_vite_dev() {
        assert!(is_local_origin("http://127.0.0.1:7001"));
        assert!(is_local_origin("http://localhost:5173"));
        assert!(is_local_origin("http://localhost:4173"));
        assert!(is_local_origin("http://[::1]:7001"));
        assert!(is_local_origin("https://localhost"));
    }

    #[test]
    fn allows_tauri_webview_origins() {
        // macOS / Linux Tauri 2 default
        assert!(is_local_origin("tauri://localhost"));
        // Windows Tauri 2 default
        assert!(is_local_origin("http://tauri.localhost"));
        assert!(is_local_origin("https://tauri.localhost"));
        // Sandboxed contexts (data: URIs, sandboxed iframes) — server
        // is loopback-only, so allowing the null origin is safe.
        assert!(is_local_origin("null"));
    }

    #[test]
    fn rejects_remote_origins() {
        assert!(!is_local_origin("https://example.com"));
        assert!(!is_local_origin("http://192.168.1.4"));
        assert!(!is_local_origin("ftp://localhost"));
        assert!(!is_local_origin(""));
    }
}

#[cfg(test)]
mod goal_command_tests {
    use super::{expand_goal_command, expand_goal_in_messages, slash_command_arg};
    use harness_core::Message;

    #[test]
    fn goal_command_expands_to_scheduler_instruction() {
        let expanded = expand_goal_command("/goal add a codex subagent scheduler").unwrap();
        assert!(expanded.contains("long-running session/project goal"));
        assert!(expanded.contains("add a codex subagent scheduler"));
        assert!(expanded.contains("subagent.codex"));
    }

    #[test]
    fn goal_command_requires_command_boundary() {
        assert!(expand_goal_command("/goals should stay ordinary").is_none());
        assert_eq!(
            slash_command_arg("  /goal   ship it  ", "/goal"),
            Some("ship it")
        );
    }

    #[test]
    fn empty_goal_asks_for_follow_up() {
        let expanded = expand_goal_command("/goal").unwrap();
        assert!(expanded.contains("without a goal"));
    }

    #[test]
    fn rest_messages_expand_last_user_goal() {
        let messages = expand_goal_in_messages(vec![
            Message::system("rules"),
            Message::user("/goal finish the roadmap"),
        ]);
        match messages.last().unwrap() {
            Message::User { content, .. } => {
                assert!(content.contains("finish the roadmap"));
                assert!(content.contains("subagent.codex"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }
}

#[cfg(test)]
mod ws_protocol_tests {
    use super::*;

    #[test]
    fn start_turn_frame_deserializes() {
        let msg: WsClientMessage = serde_json::from_value(json!({
            "type": "start_turn",
            "mode": "new",
            "id": "conv-1",
            "content": "hello",
            "provider": "openai",
            "model": "gpt-test",
            "project_id": "proj-1",
            "workspace_path": "/tmp/project",
            "active_skills": ["code-review"],
        }))
        .unwrap();

        match msg {
            WsClientMessage::StartTurn {
                mode,
                id,
                content,
                provider,
                model,
                project_id,
                workspace_path,
                active_skills,
                ..
            } => {
                assert!(matches!(mode, StartTurnMode::New));
                assert_eq!(id, "conv-1");
                assert_eq!(content, "hello");
                assert_eq!(provider.as_deref(), Some("openai"));
                assert_eq!(model.as_deref(), Some("gpt-test"));
                assert_eq!(project_id.as_deref(), Some("proj-1"));
                assert_eq!(workspace_path.as_deref(), Some("/tmp/project"));
                assert_eq!(active_skills, Some(vec!["code-review".to_string()]));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }
}

#[cfg(test)]
mod model_catalog_tests {
    use super::*;
    use crate::provider_registry::ProviderRegistry;
    use crate::router as full_router;
    use crate::state::AppState;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult, Tool, ToolRegistry,
    };
    use harness_llm::{ModelCapability, PrivacyHint};
    use std::sync::{Arc, RwLock};
    use tower::ServiceExt;

    struct EchoLlm;
    #[async_trait]
    impl LlmProvider for EchoLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    struct DummyTool;
    #[async_trait]
    impl Tool for DummyTool {
        fn name(&self) -> &str {
            "dummy"
        }
        fn description(&self) -> &str {
            "test"
        }
        fn parameters(&self) -> serde_json::Value {
            json!({"type": "object"})
        }
        async fn invoke(
            &self,
            _args: serde_json::Value,
        ) -> std::result::Result<String, harness_core::BoxError> {
            Ok("ok".into())
        }
    }

    fn make_state_with_caps(supports_tools: Option<bool>, register_tool: bool) -> AppState {
        let mut registry = ProviderRegistry::new("test");
        let cap = ModelCapability {
            provider: "test".into(),
            model: "test-model".into(),
            supports_tool_calls: supports_tools,
            privacy_hint: PrivacyHint::FirstPartyCloud,
            ..Default::default()
        };
        registry.insert_with_capabilities(
            "test",
            Arc::new(EchoLlm),
            "test-model",
            vec![],
            "openai",
            vec![cap],
        );
        let agent = Agent::new(Arc::new(EchoLlm), AgentConfig::new("test-model"));
        let mut state = AppState::from_registry(registry, agent.config.clone());
        if register_tool {
            let mut tools = ToolRegistry::new();
            tools.register(DummyTool);
            state.tools = Arc::new(RwLock::new(tools));
        }
        state
    }

    #[tokio::test]
    async fn model_catalog_returns_registered_capabilities() {
        let state = make_state_with_caps(Some(true), false);
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/model-catalog")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let entries = body["entries"].as_array().expect("entries array");
        assert!(entries.iter().any(|e| e["model"] == "test-model"));
        // wellKnown should be present (no provider filter) and contain the
        // built-in profile catalog.
        let well_known = body["wellKnown"].as_array().expect("wellKnown array");
        assert!(!well_known.is_empty(), "expected built-in profiles");
    }

    #[tokio::test]
    async fn chat_completions_rejects_tools_against_no_tools_model() {
        let state = make_state_with_caps(Some(false), true);
        let app = full_router(state);
        let body = json!({
            "provider": "test",
            "model": "test-model",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let err = v["error"].as_str().unwrap_or("");
        assert!(err.contains("does not support tool calls"), "got: {err}");
    }

    #[tokio::test]
    async fn chat_completions_passes_when_capability_unknown() {
        // No supports_tool_calls hint → never block.
        let state = make_state_with_caps(None, true);
        let app = full_router(state);
        let body = json!({
            "provider": "test",
            "model": "test-model",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn probe_returns_auth_ok_for_echo_provider() {
        let state = make_state_with_caps(Some(true), false);
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/providers/test/probe")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["auth_ok"], true);
        assert_eq!(v["default_model_ok"], true);
        assert_eq!(v["model"], "test-model");
        assert!(v["latency_ms"].as_u64().is_some());
    }

    #[tokio::test]
    async fn probe_returns_404_for_unknown_provider() {
        let state = make_state_with_caps(Some(true), false);
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/providers/no-such/probe")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}

#[cfg(test)]
mod tools_catalog_tests {
    use super::*;
    use crate::provider_registry::ProviderRegistry;
    use crate::router as full_router;
    use crate::state::AppState;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult, Tool, ToolCategory, ToolRegistry,
    };
    use std::sync::{Arc, RwLock};
    use tower::ServiceExt;

    struct EchoLlm;
    #[async_trait]
    impl LlmProvider for EchoLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    struct FakeReadTool;
    #[async_trait]
    impl Tool for FakeReadTool {
        fn name(&self) -> &str {
            "fs.read"
        }
        fn description(&self) -> &str {
            "read"
        }
        fn parameters(&self) -> serde_json::Value {
            json!({"type":"object"})
        }
        fn category(&self) -> ToolCategory {
            ToolCategory::Read
        }
        async fn invoke(
            &self,
            _args: serde_json::Value,
        ) -> std::result::Result<String, harness_core::BoxError> {
            Ok("ok".into())
        }
    }
    struct FakeShellTool;
    #[async_trait]
    impl Tool for FakeShellTool {
        fn name(&self) -> &str {
            "shell.exec"
        }
        fn description(&self) -> &str {
            "exec"
        }
        fn parameters(&self) -> serde_json::Value {
            json!({"type":"object"})
        }
        fn category(&self) -> ToolCategory {
            ToolCategory::Exec
        }
        fn requires_approval(&self) -> bool {
            true
        }
        async fn invoke(
            &self,
            _args: serde_json::Value,
        ) -> std::result::Result<String, harness_core::BoxError> {
            Ok("ok".into())
        }
    }

    fn make_state() -> AppState {
        let mut registry = ProviderRegistry::new("echo");
        registry.insert_with_models("echo", Arc::new(EchoLlm), "echo-1", vec![]);
        let agent = Agent::new(Arc::new(EchoLlm), AgentConfig::new("echo-1"));
        let mut state = AppState::from_registry(registry, agent.config.clone());
        let mut tools = ToolRegistry::new();
        tools.register(FakeReadTool);
        tools.register(FakeShellTool);
        state.tools = Arc::new(RwLock::new(tools));
        state
    }

    #[tokio::test]
    async fn list_tools_returns_metadata_for_each_registered_tool() {
        let state = make_state();
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/tools")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["total"], 2);
        let tools = body["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"fs.read"));
        assert!(names.contains(&"shell.exec"));
        let shell = tools.iter().find(|t| t["name"] == "shell.exec").unwrap();
        assert_eq!(shell["risk"], "shell");
        assert_eq!(shell["pack"], "shell");
        assert_eq!(shell["requiresApproval"], true);
        let fs_read = tools.iter().find(|t| t["name"] == "fs.read").unwrap();
        assert_eq!(fs_read["risk"], "read-only");
        assert_eq!(fs_read["pack"], "file-read");
        assert_eq!(fs_read["requiresApproval"], false);
    }

    #[tokio::test]
    async fn list_tools_filters_by_risk() {
        let state = make_state();
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/tools?risk=shell")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["total"], 1);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "shell.exec");
    }

    #[tokio::test]
    async fn list_tools_filters_by_pack() {
        let state = make_state();
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/tools?pack=file-read")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["total"], 1);
        assert_eq!(body["tools"][0]["name"], "fs.read");
    }

    #[tokio::test]
    async fn list_tools_filters_by_source_builtin() {
        let state = make_state();
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/tools?source=builtin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["total"], 2);
    }

    #[tokio::test]
    async fn patch_mutes_tool_and_hides_it_from_agent_loop() {
        let state = make_state();
        let app = full_router(state.clone());

        // Mute fs.read.
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/tools/fs.read")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled": false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["name"], "fs.read");
        assert_eq!(body["enabled"], false);
        assert_eq!(body["muted_count"], 1);

        // Confirm the registry now hides fs.read from `specs` /
        // `resolve` (the agent loop view).
        {
            let g = state.tools.read().unwrap();
            assert!(g.is_muted("fs.read"));
            let visible: Vec<String> = g.specs().into_iter().map(|s| s.name).collect();
            assert!(!visible.contains(&"fs.read".to_string()));
            assert!(g.resolve("fs.read").is_none());
            assert!(g.resolve_unchecked("fs.read").is_some());
        }

        // The catalog UI still sees fs.read with `enabled: false`
        // so the operator can flip it back.
        let app2 = full_router(state.clone());
        let resp = app2
            .oneshot(
                Request::builder()
                    .uri("/v1/tools")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let tools = body["tools"].as_array().unwrap();
        let fs_read = tools.iter().find(|t| t["name"] == "fs.read").unwrap();
        assert_eq!(fs_read["enabled"], false);
    }

    #[tokio::test]
    async fn patch_re_enables_tool() {
        let state = make_state();
        // Pre-mute via the registry directly so the test exercises
        // the unmute path independently.
        {
            let mut g = state.tools.write().unwrap();
            assert!(g.mute("shell.exec"));
        }
        let app = full_router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/tools/shell.exec")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled": true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["enabled"], true);
        assert_eq!(body["muted_count"], 0);
        let g = state.tools.read().unwrap();
        assert!(!g.is_muted("shell.exec"));
    }

    #[tokio::test]
    async fn patch_unknown_tool_returns_404() {
        let state = make_state();
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/tools/does.not.exist")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled": false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    use crate::provider_registry::ProviderRegistry;
    use crate::route_policy::{ModelRoutePolicy, ModelTarget};
    use crate::router as full_router;
    use crate::state::AppState;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    struct EchoLlm;
    #[async_trait]
    impl LlmProvider for EchoLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    fn make_state(policy: ModelRoutePolicy) -> AppState {
        let mut registry = ProviderRegistry::new("echo");
        registry.insert("echo", Arc::new(EchoLlm), "echo-1");
        let agent = Agent::new(Arc::new(EchoLlm), AgentConfig::new("echo-1"));
        AppState::from_registry(registry, agent.config.clone()).with_route_policy(policy)
    }

    #[tokio::test]
    async fn routing_endpoint_returns_empty_object_when_unset() {
        let state = make_state(ModelRoutePolicy::default());
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/routing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        // Empty policy serialises to `{}` because every field has
        // skip_serializing_if = Option::is_none / Vec::is_empty.
        assert_eq!(v, json!({}));
    }

    #[tokio::test]
    async fn routing_endpoint_surfaces_populated_slots() {
        let policy = ModelRoutePolicy {
            default: Some(ModelTarget::new("openai", "gpt-4o-mini")),
            coding: Some(ModelTarget::new("codex", "gpt-5.4-codex")),
            fallbacks: vec![ModelTarget::new("ollama", "qwen3:14b")],
            ..Default::default()
        };
        let state = make_state(policy);
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/routing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["default"]["provider"], "openai");
        assert_eq!(v["default"]["model"], "gpt-4o-mini");
        assert_eq!(v["coding"]["provider"], "codex");
        assert_eq!(v["fallbacks"][0]["provider"], "ollama");
    }

    #[tokio::test]
    async fn put_routing_replaces_whole_policy() {
        let state = make_state(ModelRoutePolicy::default());
        let app = full_router(state.clone());
        let body = json!({
            "default": { "provider": "openai", "model": "gpt-4o" },
            "summarization": { "provider": "ollama", "model": "qwen3:14b" }
        });
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/routing")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        // The in-memory state was actually updated.
        let snap = state.route_policy.read().unwrap().clone();
        assert_eq!(snap.default.as_ref().unwrap().model, "gpt-4o");
        assert_eq!(snap.summarization.as_ref().unwrap().provider, "ollama");
    }

    #[tokio::test]
    async fn patch_routing_slot_sets_target() {
        let state = make_state(ModelRoutePolicy::default());
        let app = full_router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/routing/coding")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"target": "codex/gpt-5.4-codex"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let snap = state.route_policy.read().unwrap().clone();
        let coding = snap.coding.as_ref().unwrap();
        assert_eq!(coding.provider, "codex");
        assert_eq!(coding.model, "gpt-5.4-codex");
    }

    #[tokio::test]
    async fn patch_routing_slot_clears_when_target_null() {
        let policy = ModelRoutePolicy {
            coding: Some(ModelTarget::new("codex", "x")),
            ..Default::default()
        };
        let state = make_state(policy);
        let app = full_router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/routing/coding")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"target": null}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(state.route_policy.read().unwrap().coding.is_none());
    }

    #[tokio::test]
    async fn patch_routing_unknown_slot_400() {
        let state = make_state(ModelRoutePolicy::default());
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/routing/typooo")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"target": "x/y"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn patch_routing_malformed_target_400() {
        let state = make_state(ModelRoutePolicy::default());
        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/routing/coding")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"target": "no-slash"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_routing_slot_clears_target() {
        let policy = ModelRoutePolicy {
            review: Some(ModelTarget::new("anthropic", "claude-3-5")),
            ..Default::default()
        };
        let state = make_state(policy);
        let app = full_router(state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/routing/review")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(state.route_policy.read().unwrap().review.is_none());
    }
}

#[cfg(test)]
mod compose_user_memory_tests {
    use super::compose_with_user_memory;
    use harness_learning::{MemoryItem, MemoryKind, MemoryScope};

    fn item(kind: MemoryKind, title: &str, body: &str) -> MemoryItem {
        MemoryItem::new(MemoryScope::User, kind, title, body)
    }

    #[test]
    fn empty_memories_returns_none() {
        assert!(compose_with_user_memory(Some("base"), &[]).is_none());
    }

    #[test]
    fn renders_block_then_template() {
        let mems = vec![
            item(MemoryKind::Preference, "Be terse", "max 3 sentences"),
            item(MemoryKind::Fact, "Reply lang", "zh-CN"),
        ];
        let out = compose_with_user_memory(Some("you are jarvis"), &mems).unwrap();
        assert!(out.starts_with("=== user memory ==="));
        assert!(out.contains("[preference] Be terse: max 3 sentences"));
        assert!(out.contains("[fact] Reply lang: zh-CN"));
        assert!(out.contains("=== /user memory ==="));
        assert!(out.ends_with("you are jarvis"));
    }

    #[test]
    fn empty_body_renders_title_only() {
        let mems = vec![item(MemoryKind::Convention, "Use pnpm", "")];
        let out = compose_with_user_memory(None, &mems).unwrap();
        assert!(out.contains("[convention] Use pnpm"));
        assert!(!out.contains(": "), "no colon when body is empty");
    }

    #[test]
    fn all_blank_returns_none() {
        let mems = vec![item(MemoryKind::Fact, "   ", "   ")];
        assert!(compose_with_user_memory(None, &mems).is_none());
    }
}
