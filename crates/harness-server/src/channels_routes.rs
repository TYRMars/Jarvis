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
use harness_channel::{
    resolve_env_templates, ChannelInstance, ChannelInstanceStatus, ChannelInstanceStore,
    ChannelMessageFormat, OutboundMessage, SendOutcome,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{error, warn};

use crate::state::AppState;
use crate::state_layers::ChannelLayer;

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
fn require_store(
    layer: &ChannelLayer,
) -> Result<Arc<dyn ChannelInstanceStore>, Response> {
    layer.instances.clone().ok_or_else(|| {
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

async fn list(State(layer): State<ChannelLayer>) -> Response {
    let store = match require_store(&layer) {
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

/// Returns the catalogue of supported channel kinds. Pulled from
/// the [`ChannelAdapterRegistry`] in `AppState`, so the schema is
/// always in lockstep with what the backend can actually send —
/// adding a kind = registering one adapter, no separate hardcoded
/// catalogue to keep in sync.
async fn list_kinds(State(layer): State<ChannelLayer>) -> Response {
    let kinds: Vec<Value> = layer.adapters.iter().map(|a| a.schema()).collect();
    Json(json!({ "kinds": kinds })).into_response()
}

// --------------------------- create --------------------------------------

#[derive(Debug, Deserialize)]
struct CreateRequest {
    kind: String,
    display_name: String,
    #[serde(default)]
    config: Value,
}

async fn create(State(layer): State<ChannelLayer>, Json(body): Json<CreateRequest>) -> Response {
    let store = match require_store(&layer) {
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
    let Some(adapter) = layer.adapters.get(&body.kind) else {
        return bad_request(format!(
            "unknown channel kind '{}' — see GET /v1/channels/kinds",
            body.kind
        ));
    };
    let mut inst = ChannelInstance::new(body.kind, display_name, body.config);
    // Validate via the kind's adapter — when the config parses,
    // promote to Enabled so the new row goes live immediately.
    // Invalid configs stay Unconfigured so the UI prompts "继续配置".
    if adapter.validate_config(&inst.config).is_ok() {
        inst.status = ChannelInstanceStatus::Enabled;
    }
    if let Err(e) = store.upsert(&inst).await {
        return internal_error(e);
    }
    (StatusCode::CREATED, Json(instance_to_json(&inst))).into_response()
}

// --------------------------- get / patch / delete ------------------------

async fn get_one(State(layer): State<ChannelLayer>, Path(id): Path<String>) -> Response {
    let store = match require_store(&layer) {
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
    State(layer): State<ChannelLayer>,
    Path(id): Path<String>,
    Json(body): Json<PatchRequest>,
) -> Response {
    let store = match require_store(&layer) {
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
    // Re-validate via the adapter so a config edit can promote
    // Unconfigured → Enabled (or kick a healthy row back to
    // Unconfigured if the operator nukes a required field). Unknown
    // kinds (could happen if a row was created on an older binary
    // that registered a kind this one doesn't) treat as valid so we
    // don't accidentally demote them — operator can manually flip
    // status if they really want.
    let cfg_ok = match layer.adapters.get(&inst.kind) {
        Some(adapter) => adapter.validate_config(&inst.config).is_ok(),
        None => true,
    };
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

async fn delete_one(State(layer): State<ChannelLayer>, Path(id): Path<String>) -> Response {
    let store = match require_store(&layer) {
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
    /// Optional format override — defaults to `text`. Adapters that
    /// don't support the requested format degrade gracefully and
    /// flag `downgraded_format: true` on the response.
    #[serde(default)]
    format: Option<String>,
}

async fn send_test(
    State(layer): State<ChannelLayer>,
    Path(id): Path<String>,
    body: Option<Json<TestRequest>>,
) -> Response {
    let store = match require_store(&layer) {
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
    let body = body.map(|Json(b)| b);
    let text = body
        .as_ref()
        .and_then(|b| b.text.clone())
        .unwrap_or_else(|| "Jarvis 测试消息 (test ping)".to_string());
    let format = match body.as_ref().and_then(|b| b.format.as_deref()) {
        None => ChannelMessageFormat::Text,
        Some(s) => match ChannelMessageFormat::from_wire(s) {
            Some(f) => f,
            None => {
                return bad_request(format!(
                    "unknown format '{s}' — expected text|markdown"
                ))
            }
        },
    };
    let Some(adapter) = layer.adapters.get(&inst.kind) else {
        return bad_request(format!(
            "kind '{}' has no registered adapter in this binary",
            inst.kind
        ));
    };
    let resolved = resolve_env_templates(&inst.config);
    let outcome = adapter
        .send(&resolved, &OutboundMessage::text(text.clone()).with_format(format))
        .await;
    match outcome {
        SendOutcome::Sent {
            message_id,
            truncated,
            downgraded_format,
        } => Json(json!({
            "ok": true,
            "kind": inst.kind,
            "message_preview": text.chars().take(80).collect::<String>(),
            "message_id": message_id,
            "truncated": truncated,
            "downgraded_format": downgraded_format,
        }))
        .into_response(),
        SendOutcome::Failed {
            message,
            code,
            retryable,
        } => {
            warn!(channel_id = %id, kind = %inst.kind, %message, "test send failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "ok": false,
                    "error": message,
                    "code": code,
                    "retryable": retryable,
                })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_adapter::ChannelAdapterRegistry;

    #[test]
    fn default_registry_lists_all_shipped_kinds() {
        // Phase-0 invariant: the default registry surfaces every
        // shipped kind through its `schema()`. The Settings page +
        // create-time kind gate both consult this exact iterator,
        // so this test guards against a kind being added to one
        // place but not the other.
        let registry = ChannelAdapterRegistry::with_defaults();
        let kinds: Vec<&str> = registry.iter().map(|a| a.kind()).collect();
        assert!(
            kinds.contains(&"wecom_webhook"),
            "wecom_webhook missing from default registry: {kinds:?}"
        );
        assert!(
            kinds.contains(&"feishu_bot"),
            "feishu_bot missing from default registry: {kinds:?}"
        );
        assert!(
            kinds.contains(&"dingtalk_bot"),
            "dingtalk_bot missing from default registry: {kinds:?}"
        );
        assert!(
            kinds.contains(&"wecom_app"),
            "wecom_app missing from default registry: {kinds:?}"
        );
    }

    #[test]
    fn default_registry_validates_wecom_via_adapter() {
        // Validation now lives on the adapter, not in routes — make
        // sure the bridge (registry → adapter::validate_config) is
        // wired so create / patch reject broken configs.
        let registry = ChannelAdapterRegistry::with_defaults();
        let adapter = registry.get("wecom_webhook").expect("wecom_webhook");
        assert!(adapter.validate_config(&json!({})).is_err());
        assert!(adapter
            .validate_config(&json!({"webhook_url": "https://qyapi.weixin.qq.com/x"}))
            .is_ok());
        assert!(adapter
            .validate_config(&json!({"webhook_url": "${env:WECOM_FULL_URL}"}))
            .is_ok());
    }
}
