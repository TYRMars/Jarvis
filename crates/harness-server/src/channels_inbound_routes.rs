//! Inbound channel callback routes.
//!
//! Endpoints:
//! - `GET  /v1/channels/:id/callback` — platform verification
//!   handshake (WeCom posts an `echostr` here when the operator hits
//!   "保存" in the admin panel after configuring the callback URL).
//! - `POST /v1/channels/:id/callback` — real inbound message. Body
//!   is the platform's encrypted XML envelope.
//!
//! Both endpoints:
//! 1. Look up the channel instance by id (404 if absent).
//! 2. Find the kind's `inbound_handler()`. Outbound-only kinds
//!    (today's WeCom group bot / Feishu / DingTalk webhook) return
//!    `None`, in which case we 405.
//! 3. Resolve `${env:…}` templates on the config blob.
//! 4. Call `handler.verify()` first — 401 on failure. Always.
//! 5. Branch on method: GET → `handle_get`, POST → `handle_post`.
//!
//! For POST, the route also drives the binding-write + agent-spawn
//! flow:
//! - Look up `(channel, external_chat_id)` in `ChannelBindingStore`.
//! - Hit ⇒ load the existing `Conversation`. Miss ⇒ create a fresh
//!   one + write a new binding row.
//! - Append the inbound message as a `User` message.
//! - `tokio::spawn` an agent loop that, when done, sends the
//!   assistant's last text back through the same channel.
//! - Return the platform's ack body **synchronously**, so the
//!   5-second budget is met regardless of how long the agent takes.
//!
//! The reply-push side is best-effort — failures get logged but
//! don't surface back to the platform (it's already gotten its
//! 200 ack). Operators see them via `tracing` logs.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use harness_channel::{
    resolve_env_templates, AckPayload, ChannelBinding, ChannelInboundEvent, ChannelInstance,
    ChannelInstanceStatus, InboundRequest, OutboundMessage, SendOutcome,
};
use harness_core::{redact::hash_chat_id, Message};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{info, warn};

use crate::state::AppState;

// Note on state slicing: this module deliberately stays on
// `State<AppState>` rather than the per-domain `*Layer` extractors
// in `crate::state_layers`. The inbound flow legitimately spans:
// - `ChannelLayer` (instance lookup, binding store, adapter
//   registry for the reply push),
// - `ConversationLayer` (load/save the bound conversation),
// - the agent build (`AppState::build_agent` which itself reads
//   providers + template + tools + memory…).
// Forcing 3+ `State<…>` extractors plus an explicit `build_agent`
// route would be `State<AppState>` with extra ceremony. The
// channels CRUD + OAuth routes (`channels_routes.rs` /
// `channels_oauth_routes.rs`) use `ChannelLayer` cleanly because
// they're narrow.

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/channels/:id/callback", get(get_callback).post(post_callback))
}

async fn get_callback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let prepared = match prepare_inbound(&state, &id, query, headers, Vec::new()).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if let Err(e) = prepared.handler.verify(&prepared.req, &prepared.resolved_config) {
        warn!(channel_id = %id, kind = %prepared.instance.kind, error = %e, "inbound GET verify failed");
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": e}))).into_response();
    }
    match prepared
        .handler
        .handle_get(&prepared.req, &prepared.resolved_config)
        .await
    {
        Ok(ack) => ack_to_response(ack),
        Err(e) => {
            warn!(channel_id = %id, error = %e, "inbound GET handle failed");
            (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response()
        }
    }
}

async fn post_callback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let body_vec = body.to_vec();
    let prepared = match prepare_inbound(&state, &id, query, headers, body_vec).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if let Err(e) = prepared.handler.verify(&prepared.req, &prepared.resolved_config) {
        warn!(channel_id = %id, kind = %prepared.instance.kind, error = %e, "inbound POST verify failed");
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": e}))).into_response();
    }
    let mut decoded = match prepared
        .handler
        .handle_post(&prepared.req, &prepared.resolved_config)
        .await
    {
        Ok(d) => d,
        Err(e) => {
            warn!(channel_id = %id, error = %e, "inbound POST decode failed");
            return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response();
        }
    };
    // Stamp the instance id on the event — the handler doesn't see
    // the URL path, but downstream callers (binding lookup, log
    // lines) need it.
    decoded.event.instance_id = prepared.instance.id.clone();
    decoded.event.channel = prepared.instance.kind.clone();

    // Side effect: write / update the binding + (optionally) spawn
    // an agent loop. Both are async best-effort — we always return
    // the platform's ack synchronously.
    let state_clone = state.clone();
    let event = decoded.event.clone();
    tokio::spawn(async move {
        if let Err(e) = handle_inbound_event(state_clone, event).await {
            warn!(error = %e, "inbound event handler failed");
        }
    });
    ack_to_response(decoded.ack)
}

struct PreparedInbound {
    instance: ChannelInstance,
    handler: Arc<dyn crate::channel_adapter::ChannelInboundHandler>,
    resolved_config: Value,
    req: InboundRequest,
}

/// Common preamble for both GET + POST: load instance, refuse if
/// disabled, find the kind's handler, env-resolve config. Failures
/// turn into the appropriate `Response` directly so the route
/// handlers can bubble them up.
async fn prepare_inbound(
    state: &AppState,
    id: &str,
    query: HashMap<String, String>,
    headers: HeaderMap,
    body: Vec<u8>,
) -> Result<PreparedInbound, Response> {
    let store = state.channel_instances.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "channel-instance store not configured"})),
        )
            .into_response()
    })?;
    let instance = match store.get(id).await {
        Ok(Some(i)) => i,
        Ok(None) => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({"error": "channel instance not found"})),
            )
                .into_response());
        }
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
                .into_response());
        }
    };
    if matches!(instance.status, ChannelInstanceStatus::Disabled) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": format!("channel instance '{}' is disabled", instance.display_name)})),
        )
            .into_response());
    }
    let adapter = state.channel_adapters.get(&instance.kind).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("kind '{}' not registered", instance.kind)})),
        )
            .into_response()
    })?;
    let handler = adapter.inbound_handler().ok_or_else(|| {
        (
            StatusCode::METHOD_NOT_ALLOWED,
            Json(json!({"error": format!("kind '{}' is outbound-only", instance.kind)})),
        )
            .into_response()
    })?;
    let resolved_config = resolve_env_templates(&instance.config);
    let mut header_map = HashMap::new();
    for (k, v) in headers.iter() {
        if let Ok(s) = v.to_str() {
            header_map.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let req = InboundRequest {
        query,
        headers: header_map,
        body,
    };
    Ok(PreparedInbound {
        instance,
        handler,
        resolved_config,
        req,
    })
}

fn ack_to_response(ack: AckPayload) -> Response {
    match ack {
        AckPayload::Empty => StatusCode::OK.into_response(),
        AckPayload::Plain(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            bytes,
        )
            .into_response(),
        AckPayload::Xml(body) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            body,
        )
            .into_response(),
    }
}

/// Side-effect handler for an inbound event:
/// 1. Look up / create a `ChannelBinding` for `(channel,
///    external_chat_id)`.
/// 2. Append the inbound text as a `User` message to the bound
///    `Conversation` and persist.
/// 3. Build a per-request `Agent` from the `AppState` template and
///    drive it through `Agent::run` to completion.
/// 4. Persist the now-extended conversation (containing the
///    assistant's reply + any tool turns).
/// 5. Push the assistant's last text back through the originating
///    channel via the adapter's `send`, with `to_user` overridden by
///    the inbound `external_user_id` so the reply DMs the sender.
///
/// Steps 3-5 are best-effort: every failure is logged at WARN and
/// swallowed. The platform ack already went out (synchronously, in
/// `post_callback`), so propagating the error here would only show
/// up in the server's own logs — and the user-message persistence
/// in step 2 means a follow-up WS Resume can still drive the
/// conversation if the auto-reply path failed.
///
/// Empty-text events (subscribe / unsubscribe pings, image notices
/// we don't yet decode) get binding-tracked but skip steps 3-5.
async fn handle_inbound_event(state: AppState, event: ChannelInboundEvent) -> Result<(), String> {
    let bindings = state
        .channel_bindings
        .clone()
        .ok_or_else(|| "channel binding store not configured".to_string())?;
    let store = state
        .store
        .clone()
        .ok_or_else(|| "conversation store not configured".to_string())?;

    // Look up an existing binding, or mint one + a fresh
    // `Conversation` if missing.
    let binding = bindings
        .lookup(&event.channel, &event.external_chat_id)
        .await
        .map_err(|e| format!("binding lookup: {e}"))?;
    let (mut conv, conversation_id) = if let Some(mut existing) = binding {
        let envelope = store
            .load_envelope(&existing.conversation_id)
            .await
            .map_err(|e| format!("load conversation: {e}"))?;
        let conv = match envelope {
            Some((c, _meta)) => c,
            None => {
                // Binding pointed at a conversation that's been
                // deleted out from under us. Treat as "miss" — mint
                // a fresh one and overwrite the binding.
                warn!(
                    binding_chat = %hash_chat_id(&event.channel, &event.external_chat_id),
                    "binding pointed at missing conversation; recreating"
                );
                harness_core::Conversation::new()
            }
        };
        existing.touch();
        bindings
            .upsert(&existing)
            .await
            .map_err(|e| format!("touch binding: {e}"))?;
        (conv, existing.conversation_id)
    } else {
        let conversation_id = uuid::Uuid::new_v4().to_string();
        let conv = harness_core::Conversation::new();
        // Save first so the binding always points at a live row.
        store
            .save_envelope(
                &conversation_id,
                &conv,
                &harness_core::ConversationMetadata::default(),
            )
            .await
            .map_err(|e| format!("save fresh conversation: {e}"))?;
        let new_binding = ChannelBinding::new(
            event.channel.clone(),
            event.external_chat_id.clone(),
            conversation_id.clone(),
            event.external_user_id.clone(),
            event.display_name.clone(),
        );
        bindings
            .upsert(&new_binding)
            .await
            .map_err(|e| format!("upsert new binding: {e}"))?;
        info!(
            chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
            conversation_id = %conversation_id,
            kind = %event.channel,
            "minted new channel binding"
        );
        (conv, conversation_id)
    };

    // Append the inbound text as a User message + persist. Empty
    // body events (subscribe/unsubscribe with no text payload, image
    // notices we don't yet decode, etc.) get binding-tracked but no
    // agent run.
    if event.text.is_empty() {
        info!(
            chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
            conversation_id = %conversation_id,
            kind_tag = %event.kind.tag(),
            "inbound channel event processed (no text — skipping agent loop)"
        );
        return Ok(());
    }
    conv.push(Message::user(event.text.clone()));
    store
        .save_envelope(
            &conversation_id,
            &conv,
            &harness_core::ConversationMetadata::default(),
        )
        .await
        .map_err(|e| format!("save updated conversation: {e}"))?;
    info!(
        chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
        conversation_id = %conversation_id,
        kind_tag = %event.kind.tag(),
        "inbound channel event processed; running agent loop"
    );

    // ---- M3.5 agent run + reply push -------------------------------
    //
    // We've already returned the platform ack synchronously. From here
    // on every failure is best-effort: we log it but don't propagate,
    // since the inbound POST has already been answered. The user's
    // message is safely persisted, so re-invoking the agent later
    // (e.g. WS Resume) can still drive the conversation.
    let agent = match state.build_agent(None, None) {
        Ok(a) => a,
        Err(e) => {
            warn!(error = %e, "build_agent failed for inbound event");
            return Ok(());
        }
    };
    if let Err(e) = agent.run(&mut conv).await {
        warn!(error = %e, "agent loop failed for inbound event");
        // Persist whatever progress we have (assistant may have
        // partial text + tool calls) so a follow-up resume can pick
        // up the trail.
        if let Err(save_err) = store
            .save_envelope(
                &conversation_id,
                &conv,
                &harness_core::ConversationMetadata::default(),
            )
            .await
        {
            warn!(error = %save_err, "save after failed agent run");
        }
        return Ok(());
    }
    if let Err(e) = store
        .save_envelope(
            &conversation_id,
            &conv,
            &harness_core::ConversationMetadata::default(),
        )
        .await
    {
        warn!(error = %e, "save conversation after agent run");
        // Continue — the in-memory `conv` still has the reply we
        // want to push, even if disk write failed.
    }

    let reply = match conv.last_assistant_text() {
        Some(text) if !text.trim().is_empty() => text.to_string(),
        _ => {
            warn!(
                chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
                conversation_id = %conversation_id,
                "agent produced no assistant text — skipping reply push"
            );
            return Ok(());
        }
    };

    // Re-look up instance + adapter at push time. The instance row
    // could have been disabled while the agent was running (operators
    // expect Disabled to actually pause traffic — same gate as the
    // outbound dispatcher honors); the adapter registry is process-
    // level so it can't disappear, but we still need it to call
    // `send()`.
    let instances = match state.channel_instances.clone() {
        Some(s) => s,
        None => {
            warn!("channel-instance store gone before reply push");
            return Ok(());
        }
    };
    let inst = match instances.get(&event.instance_id).await {
        Ok(Some(i)) => i,
        Ok(None) => {
            warn!(
                instance_id = %event.instance_id,
                "channel instance vanished before reply push"
            );
            return Ok(());
        }
        Err(e) => {
            warn!(error = %e, "channel instance lookup failed before reply push");
            return Ok(());
        }
    };
    if matches!(inst.status, ChannelInstanceStatus::Disabled) {
        warn!(
            instance_id = %inst.id,
            "channel instance disabled mid-flight — dropping reply"
        );
        return Ok(());
    }
    let adapter = match state.channel_adapters.get(&inst.kind) {
        Some(a) => a,
        None => {
            warn!(kind = %inst.kind, "channel adapter not registered for reply push");
            return Ok(());
        }
    };

    let resolved_config =
        reply_target_config(resolve_env_templates(&inst.config), event.external_user_id.as_deref());
    let outbound = OutboundMessage::text(reply);
    match adapter.send(&resolved_config, &outbound).await {
        SendOutcome::Sent {
            message_id,
            truncated,
            downgraded_format,
        } => {
            info!(
                chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
                conversation_id = %conversation_id,
                message_id = ?message_id,
                truncated,
                downgraded_format,
                "channel reply pushed"
            );
        }
        SendOutcome::Failed {
            message,
            code,
            retryable,
        } => {
            warn!(
                chat_hash = %hash_chat_id(&event.channel, &event.external_chat_id),
                conversation_id = %conversation_id,
                code = ?code,
                retryable,
                error = %message,
                "channel reply push failed"
            );
        }
    }
    Ok(())
}

/// Build the config we'll hand the adapter for the reply push.
///
/// When the inbound event carries a sender id, we override `to_user`
/// so the reply DMs the sender (and clear `to_party` / `to_tag` so
/// WeCom doesn't fan out to the operator-configured department on
/// top of the DM). When the sender is unknown — typical for events
/// without a `FromUserName` field — we leave the operator's config
/// as-is so the reply still goes somewhere sensible.
///
/// Group-chat replies (`external_chat_id` is a `ChatId`) currently
/// land as DMs to the sender, not the group, because the cgi-bin
/// `message/send` API used by `WeComAppAdapter` doesn't support
/// `chatid` routing — that's a separate `appchat/send` endpoint
/// we haven't wired in yet. Acceptable behavior for v1.
fn reply_target_config(mut config: Value, external_user_id: Option<&str>) -> Value {
    if let Some(user) = external_user_id {
        if let Some(obj) = config.as_object_mut() {
            obj.insert("to_user".to_string(), Value::String(user.to_string()));
            obj.remove("to_party");
            obj.remove("to_tag");
        }
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_adapter::{ChannelAdapter, ChannelAdapterRegistry};
    use async_trait::async_trait;
    use harness_channel::{ChannelInboundKind, ChannelInstance, ChannelInstanceStatus};
    use harness_core::{AgentConfig, ChatRequest, ChatResponse, Error, FinishReason, LlmProvider};
    use harness_store::{
        MemoryChannelBindingStore, MemoryChannelInstanceStore, MemoryConversationStore,
    };
    use std::sync::Mutex as StdMutex;

    #[test]
    fn reply_target_config_overrides_to_user_with_sender() {
        let cfg = json!({
            "to_user": "OperatorConfigured",
            "to_party": "DeptOps",
            "to_tag": "TagBroadcast",
            "agent_id": 1000002,
        });
        let resolved = reply_target_config(cfg, Some("ZhangSan"));
        assert_eq!(resolved["to_user"], "ZhangSan");
        assert!(resolved.get("to_party").is_none(), "to_party must be cleared");
        assert!(resolved.get("to_tag").is_none(), "to_tag must be cleared");
        assert_eq!(resolved["agent_id"], 1000002);
    }

    #[test]
    fn reply_target_config_leaves_operator_routing_when_no_sender() {
        let cfg = json!({
            "to_user": "OperatorConfigured",
            "to_party": "DeptOps",
            "agent_id": 1000002,
        });
        let resolved = reply_target_config(cfg.clone(), None);
        assert_eq!(resolved, cfg);
    }

    #[test]
    fn reply_target_config_handles_non_object_config() {
        // Defensive: validate_config rejects non-object schemas at
        // create time, but this helper has to be safe regardless.
        let cfg = json!("not-an-object");
        let resolved = reply_target_config(cfg.clone(), Some("ZhangSan"));
        assert_eq!(resolved, cfg);
    }

    /// Stub LLM that returns a canned assistant message and `Stop` —
    /// the agent loop runs exactly one turn and exits.
    struct CannedLlm {
        reply: String,
    }

    #[async_trait]
    impl LlmProvider for CannedLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Ok(ChatResponse {
                message: Message::assistant_text(&self.reply),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    /// Stub adapter that records every `send` call. We only need the
    /// kind tag + a way to capture the resolved-config + outbound
    /// payload that landed; everything else returns trivial values.
    struct RecordingAdapter {
        sends: Arc<StdMutex<Vec<(Value, OutboundMessage)>>>,
    }

    #[async_trait]
    impl ChannelAdapter for RecordingAdapter {
        fn kind(&self) -> &'static str {
            "rec_test"
        }
        fn schema(&self) -> Value {
            json!({})
        }
        fn validate_config(&self, _: &Value) -> Result<(), String> {
            Ok(())
        }
        async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome {
            self.sends
                .lock()
                .unwrap()
                .push((resolved_config.clone(), msg.clone()));
            SendOutcome::Sent {
                message_id: Some("recorded-id".into()),
                truncated: false,
                downgraded_format: false,
            }
        }
    }

    /// Bundle of test fixtures produced by `state_with_recording_adapter`.
    /// Kept as a named struct so the helper return type stays
    /// readable as the wiring grows.
    struct InboundFixtures {
        state: AppState,
        sends: Arc<StdMutex<Vec<(Value, OutboundMessage)>>>,
        inst_store: Arc<dyn harness_channel::ChannelInstanceStore>,
        bind_store: Arc<dyn harness_channel::ChannelBindingStore>,
        conv_store: Arc<dyn harness_core::ConversationStore>,
    }

    /// Build an `AppState` with: canned-LLM provider, in-memory
    /// stores for conversations / channel instances / channel
    /// bindings, plus a registry containing only a recording adapter.
    fn state_with_recording_adapter(canned_reply: &str) -> InboundFixtures {
        use crate::provider_registry::ProviderRegistry;

        let llm: Arc<dyn LlmProvider> = Arc::new(CannedLlm {
            reply: canned_reply.to_string(),
        });
        let cfg = AgentConfig::new("canned-model");
        let mut registry = ProviderRegistry::new("canned");
        registry.insert("canned", llm, "canned-model".to_string());

        let sends: Arc<StdMutex<Vec<(Value, OutboundMessage)>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let mut adapter_registry = ChannelAdapterRegistry::empty();
        adapter_registry.register(Arc::new(RecordingAdapter {
            sends: sends.clone(),
        }));

        let conv_store: Arc<dyn harness_core::ConversationStore> =
            Arc::new(MemoryConversationStore::new());
        let inst_store: Arc<dyn harness_channel::ChannelInstanceStore> =
            Arc::new(MemoryChannelInstanceStore::new());
        let bind_store: Arc<dyn harness_channel::ChannelBindingStore> =
            Arc::new(MemoryChannelBindingStore::new());

        let state = AppState::from_registry(registry, cfg)
            .with_channel_adapters(Arc::new(adapter_registry))
            .with_store(conv_store.clone())
            .with_channel_instance_store(inst_store.clone())
            .with_channel_binding_store(bind_store.clone());

        InboundFixtures {
            state,
            sends,
            inst_store,
            bind_store,
            conv_store,
        }
    }

    fn fake_event(channel: &str, instance_id: &str, text: &str) -> ChannelInboundEvent {
        ChannelInboundEvent {
            channel: channel.to_string(),
            instance_id: instance_id.to_string(),
            external_chat_id: "ChatXYZ".to_string(),
            external_user_id: Some("ZhangSan".to_string()),
            display_name: Some("Zhang San".to_string()),
            thread_id: None,
            text: text.to_string(),
            kind: ChannelInboundKind::Text,
            raw: json!({}),
            received_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    #[tokio::test]
    async fn handle_inbound_event_runs_agent_and_pushes_reply_back() {
        let fx = state_with_recording_adapter("Hello back!");
        let mut inst = ChannelInstance::new(
            "rec_test",
            "test-row",
            json!({"to_user": "OperatorConfigured"}),
        );
        inst.status = ChannelInstanceStatus::Enabled;
        let inst_id = inst.id.clone();
        fx.inst_store.upsert(&inst).await.unwrap();

        let event = fake_event("rec_test", &inst_id, "Ping");
        handle_inbound_event(fx.state, event)
            .await
            .expect("handler should succeed");

        // Recording adapter should have received exactly one send,
        // carrying the canned reply.
        let recorded = fx.sends.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "expected one reply-push");
        let (config, outbound) = &recorded[0];
        assert_eq!(
            config["to_user"], "ZhangSan",
            "to_user must be overridden with the inbound sender"
        );
        // The canned reply text should round-trip into the outbound.
        match &outbound.format {
            harness_channel::ChannelMessageFormat::Text => {}
            other => panic!("expected Text format, got {other:?}"),
        }
        assert_eq!(outbound.text, "Hello back!");

        // Binding should now point at a real saved conversation
        // containing both the user's message and the canned reply.
        let binding = fx
            .bind_store
            .lookup("rec_test", "ChatXYZ")
            .await
            .unwrap()
            .expect("binding should be created");
        let envelope = fx
            .conv_store
            .load_envelope(&binding.conversation_id)
            .await
            .unwrap()
            .expect("conversation should be saved");
        let (conv, _meta) = envelope;
        // Walk the messages — first User=="Ping", last Assistant has the canned reply.
        let last_assistant = conv.last_assistant_text();
        assert_eq!(last_assistant, Some("Hello back!"));
    }

    #[tokio::test]
    async fn handle_inbound_event_skips_agent_loop_for_empty_text() {
        let fx = state_with_recording_adapter("(should-not-be-emitted)");
        let mut inst =
            ChannelInstance::new("rec_test", "test-row", json!({"to_user": "OperatorConfigured"}));
        inst.status = ChannelInstanceStatus::Enabled;
        let inst_id = inst.id.clone();
        fx.inst_store.upsert(&inst).await.unwrap();

        let event = fake_event("rec_test", &inst_id, "");
        handle_inbound_event(fx.state, event)
            .await
            .expect("empty-text path should still return Ok");

        // No reply push — agent loop never ran.
        assert!(
            fx.sends.lock().unwrap().is_empty(),
            "no reply should be sent for empty inbound text"
        );
        // Binding *is* created so the next non-empty message lands in
        // the same conversation. (Subscribe-without-text events still
        // need a binding row so the bot doesn't lose track of who's
        // who.)
        let binding = fx.bind_store.lookup("rec_test", "ChatXYZ").await.unwrap();
        assert!(binding.is_some(), "binding row created even for empty text");
    }

    #[tokio::test]
    async fn handle_inbound_event_skips_push_when_instance_disabled_mid_flight() {
        let fx = state_with_recording_adapter("Hello back!");
        let mut inst =
            ChannelInstance::new("rec_test", "test-row", json!({"to_user": "OperatorConfigured"}));
        inst.status = ChannelInstanceStatus::Enabled;
        let inst_id = inst.id.clone();
        fx.inst_store.upsert(&inst).await.unwrap();

        // Flip to Disabled so the post-agent push gate trips.
        let mut disabled = inst.clone();
        disabled.status = ChannelInstanceStatus::Disabled;
        fx.inst_store.upsert(&disabled).await.unwrap();

        let event = fake_event("rec_test", &inst_id, "Ping");
        handle_inbound_event(fx.state, event)
            .await
            .expect("handler should succeed even when push is suppressed");

        assert!(
            fx.sends.lock().unwrap().is_empty(),
            "Disabled instance must drop the reply push"
        );
    }
}
