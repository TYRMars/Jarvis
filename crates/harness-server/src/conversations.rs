//! Persisted-conversation HTTP routes.
//!
//! These routes are mounted only when `AppState` carries a
//! `ConversationStore`; if the store is `None`, every persisted route
//! returns `503 Service Unavailable` so callers can distinguish "not
//! configured" from "really broken". The ephemeral
//! `/v1/chat/completions` endpoint stays available either way.
//!
//! Endpoints:
//!
//! - `POST   /v1/conversations`              — create empty conversation
//! - `GET    /v1/conversations`              — list newest first
//! - `GET    /v1/conversations/:id`          — load full conversation
//! - `DELETE /v1/conversations/:id`          — delete
//! - `POST   /v1/conversations/:id/messages`        — append + run (blocking)
//! - `POST   /v1/conversations/:id/messages/stream` — append + run (SSE)

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures::{Stream, StreamExt};
use harness_core::{
    AgentEvent, Conversation, ConversationMetadata, ConversationStore, Message, RunOutcome,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{error, warn};
use uuid::Uuid;

use crate::project_binder::{materialise, strip_project_block, PreparedConversation};
use crate::projects::lookup_project;
use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/conversations", post(create).get(list))
        .route("/v1/conversations/search", get(search))
        .route("/v1/conversations/:id", get(get_one).delete(delete_one))
        .route("/v1/conversations/:id/messages", post(post_message))
        .route(
            "/v1/conversations/:id/messages/stream",
            post(stream_message),
        )
}

/// Pull `state.store` out, or return a 503 response if persistence isn't
/// configured. The cloned `Arc` is cheap. The `Response` Err variant is
/// large but we only build it on the unhappy path, once per request.
#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn ConversationStore>, Response> {
    state.store.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "persistence not configured; set JARVIS_DB_URL"
            })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

/// Ids beginning with `__` are reserved for internal use (today: the
/// content-addressed summary cache used by `SummarizingMemory`). They
/// must not appear in client-facing CRUD responses, and the public
/// endpoints refuse to operate on them — clients who need to clear
/// memory caches should do so through a dedicated admin path, not by
/// guessing internal keys.
pub(crate) fn is_internal_id(id: &str) -> bool {
    id.starts_with("__")
}

// ----------------------- create -----------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CreateRequest {
    /// Optional system prompt. When present, becomes the first message
    /// of the new conversation; when absent, the agent's configured
    /// system prompt is used on the first run instead.
    system: Option<String>,
    /// Optional caller-supplied id. Useful for idempotent clients.
    /// Defaults to a fresh UUID v4.
    id: Option<String>,
    /// Optional project to bind this conversation to. Accepts either
    /// the project's UUID or its slug. The project is resolved at
    /// create time (so a 404 is returned if it doesn't exist or is
    /// archived) but **not** baked into the system message — instead
    /// the binding lives on the persisted envelope and a
    /// `ProjectBinder` re-injects the project's instructions at every
    /// LLM call (late binding, so editing the project propagates to
    /// existing conversations).
    project_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
}

async fn create(State(state): State<AppState>, body: Option<Json<CreateRequest>>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let id = req.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if is_internal_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "ids starting with `__` are reserved for internal use"
            })),
        )
            .into_response();
    }

    // Resolve project binding (if requested) before doing anything
    // destructive. Stores the project's stable UUID — never the slug
    // — so renaming the slug later doesn't break the binding.
    let resolved_project_id = match req.project_id.as_ref() {
        None => None,
        Some(needle) => match state.projects.as_ref() {
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "error": "project store not configured; cannot bind to a project"
                    })),
                )
                    .into_response();
            }
            Some(ps) => match lookup_project(ps.as_ref(), needle).await {
                Ok(Some(p)) if p.archived => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": format!("project '{needle}' is archived"),
                        })),
                    )
                        .into_response();
                }
                Ok(Some(p)) => Some(p.id),
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": format!("project '{needle}' not found"),
                        })),
                    )
                        .into_response();
                }
                Err(e) => return internal_error(e),
            },
        },
    };

    let mut conv = Conversation::new();
    if let Some(sys) = req.system {
        conv.push(Message::system(sys));
    }
    let metadata = ConversationMetadata {
        project_id: resolved_project_id.clone(),
    };
    if let Err(e) = store.save_envelope(&id, &conv, &metadata).await {
        return internal_error(e);
    }
    (
        StatusCode::CREATED,
        Json(CreateResponse {
            id,
            project_id: resolved_project_id,
        }),
    )
        .into_response()
}

// ----------------------- list -----------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    /// Optional filter — restrict results to conversations bound to
    /// this project. Accepts either UUID or slug; the slug is resolved
    /// to a UUID before querying.
    #[serde(default)]
    project_id: Option<String>,
}
fn default_limit() -> u32 {
    20
}

async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };

    // Resolve project filter (if any) to its UUID. Slug-as-input is a
    // convenience for CLI users.
    let project_filter: Option<String> = match q.project_id.as_ref() {
        None => None,
        Some(needle) => match state.projects.as_ref() {
            Some(ps) => match lookup_project(ps.as_ref(), needle).await {
                Ok(Some(p)) => Some(p.id),
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": format!("project '{needle}' not found"),
                        })),
                    )
                        .into_response();
                }
                Err(e) => return internal_error(e),
            },
            None => Some(needle.clone()), // best effort: filter by raw value
        },
    };

    let rows_result = match project_filter.as_deref() {
        Some(pid) => store.list_by_project(pid, q.limit).await,
        None => store.list(q.limit).await,
    };
    match rows_result {
        Ok(rows) => {
            let visible: Vec<_> = rows
                .into_iter()
                .filter(|r| !is_internal_id(&r.id))
                .collect();
            // Cache project name lookups so the title fallback for
            // empty conversations doesn't issue one project load per row.
            let project_names = match state.projects.as_ref() {
                Some(ps) => collect_project_names(ps.as_ref(), &visible).await,
                None => std::collections::HashMap::new(),
            };
            let mut out = Vec::with_capacity(visible.len());
            for r in visible {
                let conv_for_title = store.load(&r.id).await.ok().flatten();
                let title = conv_for_title
                    .as_ref()
                    .and_then(first_user_title)
                    .or_else(|| {
                        // Empty conversation — fall back to project name
                        // if we can find one.
                        r.project_id
                            .as_deref()
                            .and_then(|pid| project_names.get(pid))
                            .map(|name| format!("{name} · 空会话"))
                    });
                out.push(json!({
                    "id": r.id,
                    "created_at": r.created_at,
                    "updated_at": r.updated_at,
                    "message_count": r.message_count,
                    "title": title,
                    "project_id": r.project_id,
                }));
            }
            Json(out).into_response()
        }
        Err(e) => internal_error(e),
    }
}

async fn collect_project_names(
    ps: &dyn harness_core::ProjectStore,
    rows: &[harness_core::ConversationRecord],
) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut out = HashMap::new();
    for pid in rows.iter().filter_map(|r| r.project_id.as_deref()) {
        if out.contains_key(pid) {
            continue;
        }
        if let Ok(Some(p)) = ps.load(pid).await {
            out.insert(pid.to_string(), p.name);
        }
    }
    out
}

/// Best-effort conversation title: the first user message's first
/// line, capped at 60 chars + a trailing ellipsis when truncated.
/// Returns `None` when the conversation has no user message yet
/// (e.g. system-prompt-only persisted seed).
fn first_user_title(conv: &harness_core::Conversation) -> Option<String> {
    const TITLE_MAX_CHARS: usize = 60;
    for m in &conv.messages {
        if let harness_core::Message::User { content } = m {
            let line = content.lines().next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let chars: Vec<char> = line.chars().collect();
            if chars.len() > TITLE_MAX_CHARS {
                let cut: String = chars.iter().take(TITLE_MAX_CHARS).collect();
                return Some(format!("{cut}…"));
            }
            return Some(line.to_string());
        }
    }
    None
}

// ----------------------- search -----------------------

#[derive(Debug, Deserialize)]
struct SearchQuery {
    /// Substring to look for. Required, min length 1; for sane perf we
    /// bail early on shorter / empty queries.
    q: String,
    /// Cap on returned conversations. Per-conversation snippets are
    /// also capped (see `MAX_SNIPPETS_PER_CONV`).
    #[serde(default = "default_search_limit")]
    limit: u32,
    /// Optional project filter — same semantics as the listing endpoint.
    /// Accepts UUID or slug.
    #[serde(default)]
    project_id: Option<String>,
}
fn default_search_limit() -> u32 {
    30
}

/// Maximum row scan budget. We don't have an inverted index — every
/// search loads conversations from the store and scans their messages
/// in-process. The cap keeps the worst case bounded; bumping it past
/// a few hundred would make a search request noticeably slow.
const SEARCH_SCAN_BUDGET: u32 = 200;
/// Per-conversation snippet cap to keep response sizes sane on
/// long conversations that mention the term in every turn.
const MAX_SNIPPETS_PER_CONV: usize = 5;

/// `GET /v1/conversations/search?q=...` — substring search across
/// conversation message bodies. Title-prefix matches still happen
/// client-side over the cached list (cheap, no network round-trip);
/// this endpoint is for the "I know the word is in there but I forget
/// which chat" case.
///
/// Response shape (newest-updated first):
///
/// ```json
/// [
///   {
///     "id": "...",
///     "title": "...",
///     "project_id": "..." | null,
///     "updated_at": "...",
///     "match_count": 3,
///     "snippets": [
///       { "role": "assistant", "ord": 4, "before": "...", "hit": "...", "after": "..." }
///     ]
///   }
/// ]
/// ```
async fn search(State(state): State<AppState>, Query(q): Query<SearchQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let needle = q.q.trim();
    if needle.is_empty() {
        return Json(json!([])).into_response();
    }

    // Resolve the optional project filter the same way `list` does so
    // slugs and uuids both work.
    let project_filter: Option<String> = match q.project_id.as_ref() {
        None => None,
        Some(needle_id) => match state.projects.as_ref() {
            Some(ps) => match lookup_project(ps.as_ref(), needle_id).await {
                Ok(Some(p)) => Some(p.id),
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": format!("project '{needle_id}' not found"),
                        })),
                    )
                        .into_response();
                }
                Err(e) => return internal_error(e),
            },
            None => Some(needle_id.clone()),
        },
    };

    let scan_rows = match project_filter.as_deref() {
        Some(pid) => store.list_by_project(pid, SEARCH_SCAN_BUDGET).await,
        None => store.list(SEARCH_SCAN_BUDGET).await,
    };
    let scan_rows = match scan_rows {
        Ok(r) => r,
        Err(e) => return internal_error(e),
    };

    let needle_lower = needle.to_lowercase();
    let mut hits: Vec<serde_json::Value> = Vec::new();
    for row in scan_rows {
        if is_internal_id(&row.id) {
            continue;
        }
        // Title pre-check is cheap; record but don't short-circuit
        // since we still want body-snippet evidence in the result.
        let conv = match store.load(&row.id).await {
            Ok(Some(c)) => c,
            _ => continue,
        };
        let mut match_count: usize = 0;
        let mut snippets: Vec<serde_json::Value> = Vec::new();
        for (ord, msg) in conv.messages.iter().enumerate() {
            let (role, body): (&str, &str) = match msg {
                harness_core::Message::User { content } => ("user", content.as_str()),
                harness_core::Message::Assistant {
                    content: Some(text),
                    ..
                } => ("assistant", text.as_str()),
                harness_core::Message::System { content, .. } => ("system", content.as_str()),
                harness_core::Message::Tool { content, .. } => ("tool", content.as_str()),
                _ => continue,
            };
            if body.is_empty() {
                continue;
            }
            // Skip injected project blocks — they're a server-side
            // synthetic artefact (see `project_binder`) and matching
            // them would surface the same Project text under every
            // bound conversation.
            if matches!(msg, harness_core::Message::System { .. })
                && body.starts_with("=== project: ")
            {
                continue;
            }
            // Case-insensitive scan over the lowercased body so
            // the needle's casing doesn't matter.
            let body_lower = body.to_lowercase();
            let mut search_from = 0usize;
            while let Some(rel) = body_lower[search_from..].find(&needle_lower) {
                let pos = search_from + rel;
                match_count += 1;
                if snippets.len() < MAX_SNIPPETS_PER_CONV {
                    snippets.push(make_snippet(role, ord, body, pos, needle.len()));
                }
                search_from = pos + needle_lower.len().max(1);
                if search_from >= body_lower.len() {
                    break;
                }
            }
        }

        if match_count == 0 {
            continue;
        }
        let title = first_user_title(&conv);
        hits.push(json!({
            "id": row.id,
            "title": title,
            "project_id": row.project_id,
            "updated_at": row.updated_at,
            "match_count": match_count,
            "snippets": snippets,
        }));
        if hits.len() >= q.limit as usize {
            break;
        }
    }

    Json(hits).into_response()
}

/// Slice ~80 chars of context either side of the match (rounded to
/// char boundaries so we don't slice mid-codepoint). Returns
/// `{role, ord, before, hit, after}` so the client can render the
/// hit in its surrounding context with a highlight.
fn make_snippet(
    role: &str,
    ord: usize,
    body: &str,
    pos: usize,
    needle_len: usize,
) -> serde_json::Value {
    const CTX: usize = 80;
    // pos is a byte index produced by `find()` against `body_lower`,
    // which has the same length and char boundaries as `body` (it's
    // produced by `to_lowercase` on ASCII-mostly text — for non-
    // mixed-script content this holds; for pathological mixed cases
    // we fall back to the raw substring). Round both bounds to char
    // boundaries to avoid slicing inside a multi-byte sequence.
    let start_byte = pos.saturating_sub(CTX);
    let end_byte = (pos + needle_len + CTX).min(body.len());
    let before = round_to_char_boundary(body, start_byte);
    let hit_start = round_to_char_boundary(body, pos);
    let hit_end = round_to_char_boundary(body, pos + needle_len);
    let after = round_to_char_boundary(body, end_byte);
    let leading_ellipsis = before > 0;
    let trailing_ellipsis = after < body.len();
    json!({
        "role": role,
        "ord": ord,
        "before": format!(
            "{}{}",
            if leading_ellipsis { "…" } else { "" },
            &body[before..hit_start],
        ),
        "hit": &body[hit_start..hit_end],
        "after": format!(
            "{}{}",
            &body[hit_end..after],
            if trailing_ellipsis { "…" } else { "" },
        ),
    })
}

/// Find the largest char boundary `<= byte`. Cheap because Rust's
/// `is_char_boundary` is O(1).
fn round_to_char_boundary(s: &str, mut byte: usize) -> usize {
    if byte > s.len() {
        byte = s.len();
    }
    while byte > 0 && !s.is_char_boundary(byte) {
        byte -= 1;
    }
    byte
}

// ----------------------- get -----------------------

async fn get_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.load_envelope(&id).await {
        Ok(Some((conv, meta))) => Json(json!({
            "id": id,
            "messages": conv.messages,
            "project_id": meta.project_id,
        }))
        .into_response(),
        Ok(None) => not_found(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- delete -----------------------

async fn delete_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "deleted": false }))).into_response(),
        Err(e) => internal_error(e),
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "conversation not found" })),
    )
        .into_response()
}

// ----------------------- post message (blocking) -----------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PostMessageRequest {
    content: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

async fn post_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PostMessageRequest>,
) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (mut conv, metadata) = match store.load_envelope(&id).await {
        Ok(Some(pair)) => pair,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    conv.push(Message::user(req.content));

    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            error!(error = %e, id = %id, "agent build failed");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    // Late-bind the project (no-op when there's no binding). The
    // synthetic project block goes into `prepared.conversation` only —
    // we strip it back out before saving so editing the project later
    // propagates without persisting a stale snapshot.
    let prepared = match materialise(
        state.projects.as_ref(),
        conv.clone(),
        metadata.project_id.as_deref(),
    )
    .await
    {
        Ok(p) => p,
        Err(e) => return internal_error(e),
    };
    let mut run_conv = prepared.conversation.clone();
    let outcome = match agent.run(&mut run_conv).await {
        Ok(o) => o,
        Err(e) => {
            error!(error = %e, id = %id, "agent run failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    // Re-derive the canonical conversation by stripping the injected
    // project block. `conv` then becomes what we save *and* what we
    // ship back to the client as `history`.
    conv = strip_project_block(run_conv, &prepared);
    if let Err(e) = store.save_envelope(&id, &conv, &metadata).await {
        warn!(error = %e, id = %id, "post-run save failed");
    }

    let iterations = match outcome {
        RunOutcome::Stopped { iterations } | RunOutcome::LengthLimited { iterations } => iterations,
    };
    let final_msg = conv
        .messages
        .iter()
        .rev()
        .find(|m| matches!(m, Message::Assistant { .. }))
        .cloned()
        .unwrap_or_else(|| Message::assistant_text(""));

    Json(json!({
        "id": id,
        "message": final_msg,
        "iterations": iterations,
        "history": conv.messages,
    }))
    .into_response()
}

// ----------------------- stream message (SSE) -----------------------

async fn stream_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PostMessageRequest>,
) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (mut conv, metadata) = match store.load_envelope(&id).await {
        Ok(Some(pair)) => pair,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    conv.push(Message::user(req.content));

    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            error!(error = %e, id = %id, "agent build failed");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    let prepared = match materialise(
        state.projects.as_ref(),
        conv,
        metadata.project_id.as_deref(),
    )
    .await
    {
        Ok(p) => p,
        Err(e) => return internal_error(e),
    };
    let stream = stream_run(
        agent.run_stream(prepared.conversation.clone()),
        store,
        id,
        metadata,
        prepared,
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn stream_run(
    mut agent_stream: harness_core::AgentStream,
    store: Arc<dyn ConversationStore>,
    id: String,
    metadata: ConversationMetadata,
    prepared: PreparedConversation,
) -> impl Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        while let Some(event) = agent_stream.next().await {
            // Snapshot the canonical conversation off the terminal Done
            // event so we save exactly what the agent committed to —
            // minus the synthetic project block, so editing the
            // project propagates to future turns.
            if let AgentEvent::Done { conversation, .. } = &event {
                let cleaned = strip_project_block(conversation.clone(), &prepared);
                if let Err(e) = store.save_envelope(&id, &cleaned, &metadata).await {
                    warn!(error = %e, id = %id, "post-run save failed (sse)");
                }
            }
            let payload = serde_json::to_string(&event).unwrap_or_else(|e| {
                format!(r#"{{"type":"error","message":"serialize: {e}"}}"#)
            });
            yield Ok::<_, Infallible>(Event::default().data(payload));
        }
    }
}

// ============================== tests ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router as full_router;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider,
        Result as CoreResult,
    };
    use harness_store::MemoryConversationStore;
    use serde_json::Value;
    use tower::ServiceExt;

    struct NoopLlm;
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
            })
        }
    }

    fn make_state(with_store: bool) -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        let mut state = AppState::new(Arc::new(agent));
        if with_store {
            state = state.with_store(Arc::new(MemoryConversationStore::new()));
        }
        state
    }

    async fn body_json(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
    }

    fn json_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn create_get_list_delete_roundtrip() {
        let app = full_router(make_state(true));

        // create
        let resp = app
            .clone()
            .oneshot(json_post("/v1/conversations", json!({})))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        // get
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);
        assert!(body["messages"].is_array());

        // list
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 1);

        // delete
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        // delete again → 404
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_with_system_prompt_persists_message() {
        let app = full_router(make_state(true));
        let resp = app
            .clone()
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "system": "you are jarvis" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "you are jarvis");
    }

    #[tokio::test]
    async fn create_accepts_caller_supplied_id() {
        let app = full_router(make_state(true));
        let resp = app
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "id": "stable-id-123" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["id"], "stable-id-123");
    }

    #[tokio::test]
    async fn missing_returns_404() {
        let app = full_router(make_state(true));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn internal_ids_hidden_from_crud() {
        let state = make_state(true);
        // Seed an internal-namespace row directly through the store.
        let store = state.store.clone().unwrap();
        let mut conv = Conversation::new();
        conv.push(Message::system("internal cache"));
        store
            .save("__memory__.summary:fakehash", &conv)
            .await
            .unwrap();
        // …and a regular one for contrast.
        store.save("user-conv", &Conversation::new()).await.unwrap();

        let app = full_router(state);

        // list must filter the internal id out.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        let ids: Vec<String> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["user-conv"]);

        // get must hide it (404).
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/__memory__.summary:fakehash")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // delete must refuse to touch it.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/conversations/__memory__.summary:fakehash")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // create with caller-supplied internal id must be rejected.
        let resp = app
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "id": "__hand_crafted" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn no_store_returns_503() {
        let app = full_router(make_state(false));
        let resp = app
            .clone()
            .oneshot(json_post("/v1/conversations", json!({})))
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Captures the system messages handed to the LLM so we can
    /// assert that late binding actually re-runs the project lookup
    /// each turn (and that the persisted history stays clean).
    struct CapturingLlm {
        seen_systems: tokio::sync::Mutex<Vec<Vec<String>>>,
    }

    #[async_trait]
    impl LlmProvider for CapturingLlm {
        async fn complete(&self, req: ChatRequest) -> CoreResult<ChatResponse> {
            let systems: Vec<String> = req
                .messages
                .iter()
                .filter_map(|m| match m {
                    Message::System { content, .. } => Some(content.clone()),
                    _ => None,
                })
                .collect();
            self.seen_systems.lock().await.push(systems);
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
            })
        }
    }

    fn make_state_capturing(llm: Arc<CapturingLlm>) -> AppState {
        let agent = Agent::new(llm, AgentConfig::new("test-model"));
        AppState::new(Arc::new(agent))
            .with_store(Arc::new(MemoryConversationStore::new()))
            .with_project_store(Arc::new(harness_store::MemoryProjectStore::new()))
    }

    #[tokio::test]
    async fn project_late_binding_propagates_edits_to_existing_conversations() {
        // 1. Create a project, bind a conversation to it, run one turn.
        // 2. Edit the project's instructions.
        // 3. Run another turn. The LLM should see the *new* instructions.
        // 4. The persisted conversation never contains the project block.

        let llm = Arc::new(CapturingLlm {
            seen_systems: tokio::sync::Mutex::new(Vec::new()),
        });
        let state = make_state_capturing(llm.clone());
        let proj_store = state.projects.clone().unwrap();
        let app = full_router(state);

        // Seed project.
        let mut p = harness_core::Project::new("Customer Support", "tone: terse")
            .with_slug("cs");
        proj_store.save(&p).await.unwrap();

        // Create a bound conversation.
        let (status, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/conversations",
                    json!({ "project_id": p.id }),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let conv_id = body["id"].as_str().unwrap().to_string();
        assert_eq!(body["project_id"], p.id);

        // First turn — LLM should see "tone: terse".
        let _ = app
            .clone()
            .oneshot(json_post(
                &format!("/v1/conversations/{conv_id}/messages"),
                json!({ "content": "hi" }),
            ))
            .await
            .unwrap();
        let seen = llm.seen_systems.lock().await.clone();
        assert_eq!(seen.len(), 1);
        let first_systems = &seen[0];
        assert!(
            first_systems.iter().any(|s| s.contains("tone: terse")),
            "expected first turn to see original project instructions, got {:?}",
            first_systems
        );

        // Edit the project.
        p.set_instructions("tone: poetic");
        proj_store.save(&p).await.unwrap();

        // Second turn — LLM should see "tone: poetic".
        let _ = app
            .clone()
            .oneshot(json_post(
                &format!("/v1/conversations/{conv_id}/messages"),
                json!({ "content": "again" }),
            ))
            .await
            .unwrap();
        let seen = llm.seen_systems.lock().await.clone();
        assert_eq!(seen.len(), 2);
        let second_systems = &seen[1];
        assert!(
            second_systems.iter().any(|s| s.contains("tone: poetic")),
            "expected second turn to see updated project instructions, got {:?}",
            second_systems
        );
        assert!(
            !second_systems.iter().any(|s| s.contains("tone: terse")),
            "old instructions must not survive — found in {:?}",
            second_systems
        );

        // Persisted history must NOT contain the project block.
        let (_, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{conv_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        let msgs = body["messages"].as_array().unwrap();
        for m in msgs {
            if let Some(content) = m.get("content").and_then(|c| c.as_str()) {
                assert!(
                    !content.contains("=== project:"),
                    "persisted history leaked the project block: {content}"
                );
            }
        }
        // Project binding survives in the envelope.
        assert_eq!(body["project_id"], p.id);
    }

    #[tokio::test]
    async fn create_with_unknown_project_id_returns_404() {
        let app = full_router(make_state(true).with_project_store(Arc::new(
            harness_store::MemoryProjectStore::new(),
        )));
        let resp = app
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "project_id": "no-such-project" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_filter_by_project_id_works() {
        let state = make_state(true).with_project_store(Arc::new(
            harness_store::MemoryProjectStore::new(),
        ));
        let proj_store = state.projects.clone().unwrap();
        let p = harness_core::Project::new("P", "x").with_slug("p");
        proj_store.save(&p).await.unwrap();

        let app = full_router(state);

        // Create one bound, one free-chat.
        let _ = app
            .clone()
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "project_id": p.id }),
            ))
            .await
            .unwrap();
        let _ = app
            .clone()
            .oneshot(json_post("/v1/conversations", json!({})))
            .await
            .unwrap();

        // Default list shows both.
        let (_, body) = body_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/conversations")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body.as_array().unwrap().len(), 2);

        // Filter by project shows just the bound one.
        let (_, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations?project_id={}", p.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        let rows = body.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["project_id"], p.id);
    }

    #[tokio::test]
    async fn search_finds_substring_in_user_messages() {
        let state = make_state(true);
        let store = state.store.clone().unwrap();
        // Three conversations: two contain the needle, one doesn't.
        let mut a = Conversation::new();
        a.push(Message::user("hello world about cats"));
        store.save("conv-a", &a).await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let mut b = Conversation::new();
        b.push(Message::user("dogs are great"));
        store.save("conv-b", &b).await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let mut c = Conversation::new();
        c.push(Message::user("Did you mention CATS earlier?"));
        c.push(Message::assistant_text("yes, cats again"));
        store.save("conv-c", &c).await.unwrap();

        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/search?q=cats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        let rows = body.as_array().unwrap();
        let ids: std::collections::HashSet<String> = rows
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect();
        assert!(ids.contains("conv-a"), "missing conv-a in {ids:?}");
        assert!(ids.contains("conv-c"), "missing conv-c in {ids:?}");
        assert!(!ids.contains("conv-b"), "conv-b should not match");

        // conv-c has TWO matches (one user, one assistant) — verify
        // match_count + at least one snippet shape.
        let conv_c = rows.iter().find(|r| r["id"] == "conv-c").unwrap();
        assert!(conv_c["match_count"].as_u64().unwrap() >= 2);
        let snip = conv_c["snippets"].as_array().unwrap().first().unwrap();
        assert!(snip.get("role").is_some());
        assert!(snip.get("hit").is_some());
    }

    #[tokio::test]
    async fn search_empty_query_returns_empty_array() {
        let app = full_router(make_state(true));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/search?q=")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn search_skips_internal_ids() {
        let state = make_state(true);
        let store = state.store.clone().unwrap();
        let mut conv = Conversation::new();
        conv.push(Message::system("internal cache mentions FOOBAR"));
        store
            .save("__memory__.summary:abc", &conv)
            .await
            .unwrap();

        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/search?q=FOOBAR")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn search_skips_synthetic_project_blocks() {
        let state = make_state(true);
        let store = state.store.clone().unwrap();
        let mut conv = Conversation::new();
        conv.push(Message::system(
            "=== project: Customer Support ===\nbe terse and friendly",
        ));
        conv.push(Message::user("hello"));
        store.save("c1", &conv).await.unwrap();

        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/search?q=terse")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        // The synthetic project block must NOT match — otherwise every
        // bound conversation would surface as a hit for any text in
        // the project's instructions.
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn post_message_runs_agent_and_persists() {
        let app = full_router(make_state(true));

        // create
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post("/v1/conversations", json!({})))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        // post a message — NoopLlm replies "ok"
        let resp = app
            .clone()
            .oneshot(json_post(
                &format!("/v1/conversations/{id}/messages"),
                json!({ "content": "hi" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);
        assert_eq!(body["message"]["role"], "assistant");
        assert_eq!(body["message"]["content"], "ok");
        assert!(body["history"].as_array().unwrap().len() >= 2);

        // re-fetch — store should have the user + assistant message
        let (_, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        let msgs = body["messages"].as_array().unwrap();
        assert!(
            msgs.iter()
                .any(|m| m["role"] == "user" && m["content"] == "hi"),
            "history did not include the user message: {body}"
        );
        assert!(
            msgs.iter()
                .any(|m| m["role"] == "assistant" && m["content"] == "ok"),
            "history did not include the assistant reply: {body}"
        );
    }
}
