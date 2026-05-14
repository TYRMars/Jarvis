//! REST routes for [`Comment`](harness_project::Comment) — Phase 3.8
//! per-requirement discussion threads.
//!
//! Mounted only when [`AppState::comments`] is configured. All
//! endpoints return `503 Service Unavailable` otherwise so callers
//! can distinguish "feature off" from "really broken".
//!
//! Endpoints:
//!
//! - `GET    /v1/requirements/:id/comments`           — list, oldest-first
//! - `POST   /v1/requirements/:id/comments`           — post a top-level comment or reply
//! - `PATCH  /v1/comments/:comment_id`                — edit body
//! - `DELETE /v1/comments/:comment_id`                — delete (cascades to replies)
//!
//! Authoring policy is intentionally minimal in v0:
//!
//! * Author defaults to [`ActivityActor::Human`]. Future work that
//!   wires up real user identity will flip this; agent-authored
//!   comments come from agent-tool callsites that bypass these
//!   routes (no `requirement.comment` tool today).
//! * Trim + non-empty + length-cap on body. Format-agnostic — the
//!   web UI renders markdown via its existing component which owns
//!   sanitisation.
//! * Edits go through the model's [`Comment::edit`] helper so
//!   `updated_at` is bumped consistently with the in-process call
//!   path used by future agent tools.
//!
//! Every successful mutation also emits an
//! [`ActivityKind::Comment`] row into [`ActivityStore`] so the
//! per-Requirement timeline (the `GET /v1/requirements/:id/activities`
//! endpoint) shows the discussion alongside status flips and run
//! lifecycle events. Activity emission is best-effort — a missing
//! `ActivityStore` is silently skipped, mirroring existing patterns
//! in `requirements_routes::record_activity`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch},
    Router,
};
use harness_project::{Activity, ActivityActor, ActivityKind, Comment, CommentStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{error, warn};

use crate::state::AppState;
use crate::state_layers::ProjectLayer;

/// Soft cap on a single comment body. Mirrors typical chat-app
/// limits (Linear: 32 KiB, GitHub: 64 KiB). Past this the model
/// stops being useful as discussion and the agent token budget
/// suffers — push long content into the description / a doc.
const MAX_COMMENT_BODY_BYTES: usize = 32 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/requirements/:id/comments",
            get(list_comments).post(post_comment),
        )
        .route(
            "/v1/comments/:comment_id",
            patch(edit_comment).delete(delete_comment),
        )
}

#[allow(clippy::result_large_err)]
fn require_comment_store(project: &ProjectLayer) -> Result<Arc<dyn CommentStore>, Response> {
    project.comments.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "comment store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "comments error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn not_found(msg: impl Into<String>) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg.into() }))).into_response()
}

fn json_value(v: impl serde::Serialize) -> Json<Value> {
    Json(serde_json::to_value(v).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

/// Best-effort audit emit. Mirrors `requirements_routes::record_activity`
/// — failures are logged at WARN, never bubbled, because losing a
/// timeline row should not cost the comment write.
async fn record_comment_activity(project: &ProjectLayer, comment: &Comment, action: &str) {
    let Some(store) = project.activities.as_ref() else {
        return;
    };
    let body = json!({
        "comment_id": comment.id,
        "action": action,
        "parent_id": comment.parent_id,
        // Truncated preview for the UI; the full body lives on the
        // comment row and is fetched alongside the timeline.
        "preview": preview(&comment.body, 120),
    });
    let activity = Activity::new(
        comment.requirement_id.clone(),
        ActivityKind::Comment,
        comment.author.clone(),
        body,
    );
    if let Err(e) = store.append(&activity).await {
        warn!(
            requirement_id = %comment.requirement_id,
            comment_id = %comment.id,
            error = %e,
            "failed to record comment activity"
        );
    }
}

fn preview(body: &str, cap: usize) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= cap {
        return trimmed.to_string();
    }
    let mut s: String = trimmed.chars().take(cap).collect();
    s.push('…');
    s
}

// ----------------------- GET /v1/requirements/:id/comments --------------

async fn list_comments(State(project): State<ProjectLayer>, Path(id): Path<String>) -> Response {
    let store = match require_comment_store(&project) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list_for_requirement(&id).await {
        Ok(items) => json_value(json!({ "requirement_id": id, "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/requirements/:id/comments -------------

#[derive(Debug, Deserialize)]
struct PostCommentBody {
    body: String,
    /// `Some` to post a one-level reply. The store enforces the
    /// depth-1 invariant — we only forward.
    #[serde(default)]
    parent_id: Option<String>,
}

async fn post_comment(
    State(project): State<ProjectLayer>,
    Path(id): Path<String>,
    Json(payload): Json<PostCommentBody>,
) -> Response {
    let store = match require_comment_store(&project) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let body = payload.body.trim();
    if body.is_empty() {
        return bad_request("comment body must not be empty");
    }
    if body.len() > MAX_COMMENT_BODY_BYTES {
        return bad_request(format!(
            "comment body exceeds {MAX_COMMENT_BODY_BYTES}-byte cap"
        ));
    }

    // v0 — every REST POST is a Human author. Real user identity
    // arrives in a future phase.
    let author = ActivityActor::Human;
    let comment = match payload.parent_id {
        Some(parent) if !parent.trim().is_empty() => {
            Comment::reply(id.clone(), author, body, parent.trim())
        }
        _ => Comment::new(id.clone(), author, body),
    };

    match store.create(&comment).await {
        Ok(()) => {
            record_comment_activity(&project, &comment, "posted").await;
            (StatusCode::CREATED, json_value(&comment)).into_response()
        }
        Err(e) => {
            // `parent_id` validation errors come from the store's
            // depth check — surface them as 400 rather than 500 so
            // the client knows the input was wrong.
            let msg = e.to_string();
            if msg.contains("depth 1") || msg.contains("not found") {
                bad_request(msg)
            } else {
                internal_error(e)
            }
        }
    }
}

// ----------------------- PATCH /v1/comments/:comment_id -----------------

/// `PATCH /v1/comments/:id?requirement_id=...` body.
#[derive(Debug, Deserialize)]
struct EditCommentBody {
    body: String,
}

#[derive(Debug, Deserialize)]
struct CommentIdQuery {
    /// Required — see `DeleteQuery` for the full rationale (the
    /// store partitions by requirement, so we need the parent id
    /// to dispatch).
    requirement_id: String,
}

async fn edit_comment(
    State(project): State<ProjectLayer>,
    Path(comment_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<CommentIdQuery>,
    Json(payload): Json<EditCommentBody>,
) -> Response {
    let store = match require_comment_store(&project) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if q.requirement_id.trim().is_empty() {
        return bad_request("requirement_id query param is required");
    }
    let new_body = payload.body.trim();
    if new_body.is_empty() {
        return bad_request("comment body must not be empty");
    }
    if new_body.len() > MAX_COMMENT_BODY_BYTES {
        return bad_request(format!(
            "comment body exceeds {MAX_COMMENT_BODY_BYTES}-byte cap"
        ));
    }
    // Build a partial Comment carrying only the fields the trait
    // permits a caller to mutate; the store's `update` impl is
    // responsible for preserving `id`, `requirement_id`, `author`,
    // `parent_id`, `created_at` from the existing row. The other
    // fields here are placeholders the store ignores.
    let now = chrono::Utc::now().to_rfc3339();
    let patch = Comment {
        id: comment_id.clone(),
        requirement_id: q.requirement_id.clone(),
        author: ActivityActor::Human, // placeholder; preserved by store impl
        body: new_body.to_string(),
        parent_id: None, // placeholder; preserved by store impl
        created_at: now.clone(),
        updated_at: now,
    };

    match store.update(&patch).await {
        Ok(true) => {
            // Emit an Activity row so the timeline shows the edit.
            // Re-load the row first so the activity payload reflects
            // the actual author / parent_id of the comment, not the
            // placeholders we passed to `update`.
            let edited = match store.list_for_requirement(&q.requirement_id).await {
                Ok(rows) => rows.into_iter().find(|c| c.id == comment_id),
                Err(_) => None,
            };
            if let Some(c) = edited.as_ref() {
                record_comment_activity(&project, c, "edited").await;
                json_value(c).into_response()
            } else {
                // Edge case: row vanished between update and re-list
                // (concurrent delete). Surface success without the
                // activity emit; the timeline subscriber will still
                // see the prior `posted` row.
                json_value(json!({
                    "id": comment_id,
                    "requirement_id": q.requirement_id,
                    "body": new_body,
                }))
                .into_response()
            }
        }
        Ok(false) => not_found(format!("comment `{comment_id}` not found")),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/comments/:comment_id ----------------

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    /// Required — the store partitions by requirement, so we need
    /// the parent id to dispatch the delete. Kept as a query param
    /// to keep the URL cacheable for GETs (parallel routes share
    /// `/v1/comments/:id`).
    requirement_id: String,
}

async fn delete_comment(
    State(project): State<ProjectLayer>,
    Path(comment_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<DeleteQuery>,
) -> Response {
    let store = match require_comment_store(&project) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if q.requirement_id.trim().is_empty() {
        return bad_request("requirement_id query param is required");
    }
    match store.delete(&q.requirement_id, &comment_id).await {
        Ok(true) => {
            // We don't have the original Comment in hand here, so
            // emit a minimal activity row so the timeline shows the
            // delete. Author defaults to Human (v0 — see post handler).
            if let Some(act_store) = project.activities.as_ref() {
                let activity = Activity::new(
                    q.requirement_id.clone(),
                    ActivityKind::Comment,
                    ActivityActor::Human,
                    json!({
                        "comment_id": comment_id,
                        "action": "deleted",
                    }),
                );
                if let Err(e) = act_store.append(&activity).await {
                    warn!(
                        requirement_id = %q.requirement_id,
                        comment_id,
                        error = %e,
                        "failed to record comment-delete activity"
                    );
                }
            }
            json_value(json!({ "deleted": true })).into_response()
        }
        Ok(false) => not_found(format!("comment `{comment_id}` not found")),
        Err(e) => internal_error(e),
    }
}
