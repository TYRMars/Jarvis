//! REST routes for the Settings → Channels page (M1) and the M2
//! outbound senders.
//!
//! - `GET    /v1/channels`            — list user-configured channel instances
//! - `POST   /v1/channels`            — create a new instance (kind + display_name + config)
//! - `GET    /v1/channels/:id`        — fetch one
//! - `PATCH  /v1/channels/:id`        — partial update (display_name / status / config)
//! - `DELETE /v1/channels/:id`        — hard delete
//! - `POST   /v1/channels/:id/test`   — send a one-shot test message via the kind's sender
//! - `GET    /v1/channels/kinds`      — list supported kinds + their config schemas (drives the UI form)
//!
//! Every endpoint returns `503 Service Unavailable` when the binary
//! didn't wire a [`ChannelInstanceStore`] (matches the convention
//! used by the other optional facets).
//!
//! Credentials inside `config` may be literal strings or use the
//! `${env:VAR}` template syntax (resolved by
//! [`harness_core::resolve_env_templates`] at send time, never at
//! store time). The server returns the literal strings verbatim in
//! GET responses; callers that want the resolved value have to call
//! the test endpoint or the kind-specific sender.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_core::{
    resolve_env_templates, ChannelInstance, ChannelInstanceStatus, ChannelInstanceStore,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{error, warn};

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/channels", get(list).post(create))
        .route("/v1/channels/kinds", get(list_kinds))
        .route(
            "/v1/channels/:id",
            get(get_one).patch(patch_one).delete(delete_one),
        )
        .route("/v1/channels/:id/test", post(send_test))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn ChannelInstanceStore>, Response> {
    state.channel_instances.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "channel-instance store not configured"
            })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "channels store error");
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

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "channel instance not found" })),
    )
        .into_response()
}

fn instance_to_json(inst: &ChannelInstance) -> Value {
    json!({
        "id": inst.id,
        "kind": inst.kind,
        "display_name": inst.display_name,
        "status": inst.status.as_wire(),
        "config": inst.config,
        "created_at": inst.created_at,
        "updated_at": inst.updated_at,
    })
}

// --------------------------- list / kinds --------------------------------

async fn list(State(state): State<AppState>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list().await {
        Ok(rows) => Json(json!({
            "items": rows.iter().map(instance_to_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => internal_error(e),
    }
}

/// Returns the catalogue of supported channel kinds and the JSON
/// Schema each kind expects in its `config` blob. The frontend uses
/// this to render the "Add channel" picker + dynamically build the
/// config form per kind, so adding a new kind on the backend
/// auto-surfaces in the UI without a frontend change.
///
/// M2 ships only `wecom_webhook`; M3 will add `wechat_mp`; future
/// adapters slot in without touching this handler's structure.
async fn list_kinds(State(_state): State<AppState>) -> Response {
    Json(json!({
        "kinds": kind_catalogue(),
    }))
    .into_response()
}

fn kind_catalogue() -> Vec<Value> {
    vec![json!({
        "kind": "wecom_webhook",
        "label": "WeCom 群机器人",
        "label_en": "WeCom group robot",
        "direction": "outbound",
        "description": "Outbound-only webhook to a WeCom group robot. Useful for alerts / notifications. The robot receives nothing in return.",
        "schema": {
            "type": "object",
            "required": ["webhook_url"],
            "properties": {
                "webhook_url": {
                    "type": "string",
                    "title": "Webhook URL",
                    "description": "Full webhook URL from WeCom group settings. Supports `${env:NAME}` templating to keep secrets out of the row.",
                    "example": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${env:WECOM_PROD_KEY}"
                },
                "default_mention": {
                    "type": "array",
                    "items": {"type": "string"},
                    "title": "@mentioned member ids (optional)",
                    "description": "Member ids to @-mention on every message. Use `@all` to mention everyone."
                }
            }
        },
        "test_supported": true
    })]
}

// --------------------------- create --------------------------------------

#[derive(Debug, Deserialize)]
struct CreateRequest {
    kind: String,
    display_name: String,
    #[serde(default)]
    config: Value,
}

async fn create(State(state): State<AppState>, Json(body): Json<CreateRequest>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let display_name = body.display_name.trim().to_string();
    if display_name.is_empty() {
        return bad_request("display_name must be non-empty");
    }
    if display_name.len() > 64 {
        return bad_request("display_name must be ≤ 64 chars");
    }
    if !is_known_kind(&body.kind) {
        return bad_request(format!(
            "unknown channel kind '{}' — see GET /v1/channels/kinds",
            body.kind
        ));
    }
    let mut inst = ChannelInstance::new(body.kind, display_name, body.config);
    // Validate config — when valid, mark Enabled so the new row goes
    // live immediately (the user can flip back to Disabled later).
    // Invalid configs stay in `Unconfigured` so the UI prompts
    // "继续配置".
    if validate_config(&inst.kind, &inst.config).is_ok() {
        inst.status = ChannelInstanceStatus::Enabled;
    }
    if let Err(e) = store.upsert(&inst).await {
        return internal_error(e);
    }
    (StatusCode::CREATED, Json(instance_to_json(&inst))).into_response()
}

fn is_known_kind(kind: &str) -> bool {
    kind_catalogue()
        .iter()
        .any(|k| k.get("kind").and_then(|v| v.as_str()) == Some(kind))
}

/// Validate a `config` blob against its kind's expected shape.
/// Returns the offending field name on failure. M2 only validates
/// `wecom_webhook`; future kinds extend this match arm.
fn validate_config(kind: &str, config: &Value) -> Result<(), String> {
    match kind {
        "wecom_webhook" => {
            let url = config
                .get("webhook_url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "webhook_url required".to_string())?;
            // Allow templated URLs (`${env:NAME}`) since the literal
            // string itself isn't a valid URL until resolution.
            if !url.starts_with("https://") && !url.contains("${env:") {
                return Err("webhook_url must be https:// (or contain an ${env:…} template)".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// --------------------------- get / patch / delete ------------------------

async fn get_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.get(&id).await {
        Ok(Some(inst)) => Json(instance_to_json(&inst)).into_response(),
        Ok(None) => not_found(),
        Err(e) => internal_error(e),
    }
}

#[derive(Debug, Deserialize)]
struct PatchRequest {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    config: Option<Value>,
}

async fn patch_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut inst = match store.get(&id).await {
        Ok(Some(i)) => i,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    if let Some(name) = body.display_name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return bad_request("display_name must be non-empty");
        }
        if trimmed.len() > 64 {
            return bad_request("display_name must be ≤ 64 chars");
        }
        inst.display_name = trimmed.to_string();
    }
    if let Some(cfg) = body.config {
        inst.config = cfg;
    }
    // Re-validate after every patch so a config edit can promote
    // Unconfigured → Enabled (or kick a healthy row back to
    // Unconfigured if the operator nukes a required field).
    let cfg_ok = validate_config(&inst.kind, &inst.config).is_ok();
    if let Some(s) = body.status.as_deref() {
        match ChannelInstanceStatus::from_wire(s) {
            Some(want) => {
                // Block transitioning to Enabled when config is broken
                // — keep the row at Unconfigured so the UI shows the
                // CTA. Disabled is always allowed (operator override).
                inst.status = match want {
                    ChannelInstanceStatus::Enabled if !cfg_ok => {
                        ChannelInstanceStatus::Unconfigured
                    }
                    other => other,
                };
            }
            None => {
                return bad_request(format!(
                    "unknown status '{s}' — expected enabled|disabled|unconfigured"
                ))
            }
        }
    } else if matches!(inst.status, ChannelInstanceStatus::Unconfigured) && cfg_ok {
        // Auto-promote when the config edit fixed the missing field.
        inst.status = ChannelInstanceStatus::Enabled;
    } else if !cfg_ok && matches!(inst.status, ChannelInstanceStatus::Enabled) {
        // Auto-demote when a config edit broke a required field.
        inst.status = ChannelInstanceStatus::Unconfigured;
    }
    inst.touch();
    if let Err(e) = store.upsert(&inst).await {
        return internal_error(e);
    }
    Json(instance_to_json(&inst)).into_response()
}

async fn delete_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({"deleted": true})).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({"deleted": false}))).into_response(),
        Err(e) => internal_error(e),
    }
}

// --------------------------- test send -----------------------------------

#[derive(Debug, Deserialize)]
struct TestRequest {
    /// Optional override message body. Defaults to a fixed
    /// "Jarvis test ping" so a "test" button click is one tap.
    #[serde(default)]
    text: Option<String>,
}

async fn send_test(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<TestRequest>>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let inst = match store.get(&id).await {
        Ok(Some(i)) => i,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    if matches!(inst.status, ChannelInstanceStatus::Disabled) {
        return bad_request("instance is disabled — flip status to enabled before testing");
    }
    let text = body
        .and_then(|Json(b)| b.text)
        .unwrap_or_else(|| "Jarvis 测试消息 (test ping)".to_string());

    let resolved_config = resolve_env_templates(&inst.config);
    match inst.kind.as_str() {
        "wecom_webhook" => match crate::channels_wecom::send_text(&resolved_config, &text).await {
            Ok(_) => Json(json!({
                "ok": true,
                "kind": inst.kind,
                "message_preview": text.chars().take(80).collect::<String>(),
            }))
            .into_response(),
            Err(e) => {
                warn!(channel_id = %id, error = %e, "wecom_webhook test send failed");
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"ok": false, "error": e.to_string()})),
                )
                    .into_response()
            }
        },
        other => bad_request(format!("kind '{other}' has no test sender (M2 only ships wecom_webhook)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_wecom_requires_webhook_url() {
        assert!(validate_config("wecom_webhook", &json!({})).is_err());
        assert!(validate_config("wecom_webhook", &json!({"webhook_url": ""})).is_err());
        assert!(validate_config("wecom_webhook", &json!({"webhook_url": "http://insecure"})).is_err());
        assert!(validate_config(
            "wecom_webhook",
            &json!({"webhook_url": "https://qyapi.weixin.qq.com/x"})
        )
        .is_ok());
        // Templated URLs allowed even though the literal isn't a valid URL.
        assert!(validate_config(
            "wecom_webhook",
            &json!({"webhook_url": "https://qyapi.weixin.qq.com/x?key=${env:WECOM_KEY}"})
        )
        .is_ok());
        // Pure template (no scheme prefix) still allowed.
        assert!(validate_config(
            "wecom_webhook",
            &json!({"webhook_url": "${env:WECOM_FULL_URL}"})
        )
        .is_ok());
    }

    #[test]
    fn validate_unknown_kind_passes() {
        // Unknown kinds aren't validated by name here — `is_known_kind`
        // is the gate that rejects them at create time.
        assert!(validate_config("not_a_real_kind", &json!({})).is_ok());
    }

    #[test]
    fn kind_catalogue_lists_wecom_webhook() {
        let kinds = kind_catalogue();
        assert!(kinds
            .iter()
            .any(|k| k["kind"] == "wecom_webhook" && k["test_supported"] == true));
    }
}
