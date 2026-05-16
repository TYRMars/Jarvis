//! WeCom 自建应用 (self-built application) adapter.
//!
//! Different from the existing `wecom_webhook` (group robot) kind:
//! self-built apps have a separate `agent_id` per app, push messages
//! through `cgi-bin/message/send` (not a per-group webhook URL),
//! and authenticate via a short-lived `access_token` derived from
//! `corp_id + corp_secret`. They're also bidirectional — events
//! arrive at a callback URL the operator configures in the WeCom
//! admin panel. C.1 here is the **outbound** half; C.2 (in the same
//! file) adds the inbound `ChannelInboundHandler`.
//!
//! Outbound wire shape:
//! ```text
//! GET  /cgi-bin/gettoken?corpid=...&corpsecret=...
//!      → { "errcode":0, "access_token":"...", "expires_in": 7200 }
//!
//! POST /cgi-bin/message/send?access_token=...
//!      { "touser": "@all", "msgtype": "text", "agentid": <id>,
//!        "text": { "content": "..." } }
//!      → { "errcode": 0, "errmsg": "ok", ... }
//! ```
//!
//! Reply codes worth handling specifically:
//! - `42001`: access_token expired. Force a refresh + retry once.
//! - `60020`: caller IP not whitelisted. Permanent — surface as
//!   non-retryable so the operator opens the WeCom admin and adds
//!   the IP.
//!
//! Docs: <https://developer.work.weixin.qq.com/document/path/90236>

use async_trait::async_trait;
use harness_channel::{
    AckPayload, ChannelInboundEvent, ChannelInboundKind, ChannelMessageFormat, DecodedInbound,
    InboundRequest, OutboundMessage, SendOutcome,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

// Submodules — each owns a concern that was previously inlined in
// this 1900-line file. mod.rs keeps the trait impls (the public
// surface) plus codec / outbound HTTP helpers that are tightly
// coupled to them; primitives that have a clean boundary moved out.
mod crypto;
mod oauth;
mod token;

use crypto::{constant_time_eq, decrypt_aes_payload, extract_tag, wecom_signature};
use oauth::{
    exchange_code_for_userid, make_oauth_state, oauth_authorize_url, verify_oauth_state, OAuthScope,
};
use token::{ensure_token, token_cache};

pub(super) const WECOM_API_BASE: &str = "https://qyapi.weixin.qq.com";

/// WeCom caps text body at ~2000 chars; markdown card body at ~4096.
/// Use the more permissive bound and let the platform truncate
/// anything above (it doesn't error, just clips).
const WECOM_APP_MAX_BYTES: usize = 4096;

pub struct WeComAppAdapter;

#[async_trait]
impl crate::channel_adapter::ChannelAdapter for WeComAppAdapter {
    fn kind(&self) -> &'static str {
        "wecom_app"
    }

    fn schema(&self) -> Value {
        json!({
            "kind": "wecom_app",
            "label": "WeCom 自建应用",
            "label_en": "WeCom self-built application",
            "direction": "bidirectional",
            "description": "WeCom self-built app — bidirectional messaging via cgi-bin/message/send (outbound) and a configured callback URL (inbound). Requires corp_id, agent_id, and corp_secret from the WeCom admin panel.",
            "schema": {
                "type": "object",
                "required": ["corp_id", "agent_id", "corp_secret"],
                "properties": {
                    "corp_id": {
                        "type": "string",
                        "title": "Corp ID",
                        "description": "Enterprise WeChat tenant id (`ww...`). Found at WeCom admin → 我的企业 → 企业信息.",
                        "example": "ww1234567890abcdef"
                    },
                    "agent_id": {
                        "type": "string",
                        "title": "Agent ID",
                        "description": "App's AgentId from the WeCom admin. Numeric string."
                    },
                    "corp_secret": {
                        "type": "string",
                        "title": "Corp Secret",
                        "description": "App's secret. Use `${env:NAME}` templating to keep it out of the row.",
                        "example": "${env:WECOM_CORP_SECRET}"
                    },
                    "to_user": {
                        "type": "string",
                        "title": "Default 接收人 (optional)",
                        "description": "Default `touser` for outbound. `@all` to broadcast within the agent's user pool. Use `|`-separated user ids for multiple recipients."
                    },
                    "to_party": {
                        "type": "string",
                        "title": "Default 部门 (optional)",
                        "description": "Default `toparty` (department id list, `|`-separated). Specify at most one of touser / toparty / totag — WeCom requires exactly one."
                    },
                    "to_tag": {
                        "type": "string",
                        "title": "Default 标签组 (optional)",
                        "description": "Default `totag` (tag id list, `|`-separated)."
                    },
                    "callback_token": {
                        "type": "string",
                        "title": "Callback Token (inbound, optional)",
                        "description": "WeCom-side token used to sign callback POSTs. Required to enable inbound. Supports `${env:NAME}` templating."
                    },
                    "callback_aes_key": {
                        "type": "string",
                        "title": "Callback EncodingAESKey (inbound, optional)",
                        "description": "43-char EncodingAESKey from the WeCom callback config. Required to enable inbound."
                    }
                }
            },
            "supports_formats": ["text", "markdown"],
            "test_supported": true,
            "callback_path": "/v1/channels/<id>/callback"
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), String> {
        for required in ["corp_id", "agent_id", "corp_secret"] {
            let val = config
                .get(required)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if val.is_none() {
                return Err(format!("{required} required"));
            }
        }
        // Exactly-one rule for the recipient targets — WeCom rejects
        // sends with all three empty AND with more than one set.
        let targets = ["to_user", "to_party", "to_tag"]
            .iter()
            .filter(|k| {
                config
                    .get(*k)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
            })
            .count();
        if targets == 0 {
            return Err(
                "specify at least one of to_user / to_party / to_tag (use `@all` under to_user to broadcast)"
                    .into(),
            );
        }
        Ok(())
    }

    async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome {
        // Validate fields are concrete (no leftover ${env:…}).
        let corp_id = match concrete_str(resolved_config, "corp_id") {
            Ok(v) => v,
            Err(e) => return e,
        };
        let agent_id_raw = match concrete_str(resolved_config, "agent_id") {
            Ok(v) => v,
            Err(e) => return e,
        };
        let agent_id: i64 = match agent_id_raw.parse() {
            Ok(v) => v,
            Err(_) => {
                return SendOutcome::fail(format!(
                    "agent_id '{agent_id_raw}' must be a numeric string"
                ));
            }
        };
        let corp_secret = match concrete_str(resolved_config, "corp_secret") {
            Ok(v) => v,
            Err(e) => return e,
        };

        let body = match build_send_body(resolved_config, msg, agent_id) {
            Ok(b) => b,
            Err(e) => return SendOutcome::fail(e),
        };

        // First attempt — use whatever token's cached.
        let mut outcome = send_once(&corp_id, &corp_secret, &body, false).await;
        // 42001 = expired token. Force-refresh and retry once.
        if let SendOutcome::Failed { code, .. } = &outcome {
            if code.as_deref() == Some("wecom_app:errcode_42001") {
                token_cache().invalidate(&corp_id);
                outcome = send_once(&corp_id, &corp_secret, &body, true).await;
            }
        }
        // Bake truncation flag into the success outcome.
        if let SendOutcome::Sent { .. } = &outcome {
            let truncated = msg.text.len() > WECOM_APP_MAX_BYTES;
            return SendOutcome::Sent {
                message_id: None,
                truncated,
                downgraded_format: false,
            };
        }
        outcome
    }

    fn inbound_handler(&self) -> Option<Arc<dyn crate::channel_adapter::ChannelInboundHandler>> {
        Some(Arc::new(WeComAppInboundHandler))
    }

    fn oauth_capability(
        &self,
    ) -> Option<Arc<dyn crate::channel_adapter::ChannelOAuthCapability>> {
        Some(Arc::new(WeComAppOAuth))
    }
}

// ---------------------------------------------------------------------------
// OAuth capability adapter — wraps the kind-local helpers
// (oauth_authorize_url / make_oauth_state / verify_oauth_state /
// exchange_code_for_userid) behind the kind-agnostic
// `ChannelOAuthCapability` trait so the route layer can dispatch
// without knowing it's talking to WeCom specifically.
// ---------------------------------------------------------------------------

/// Zero-sized adapter — every call re-reads secrets from
/// `resolved_config`, so no per-instance state lives here. The
/// process-level `token_cache()` covers the access_token coordination.
pub(crate) struct WeComAppOAuth;

#[async_trait]
impl crate::channel_adapter::ChannelOAuthCapability for WeComAppOAuth {
    fn authorize_url(
        &self,
        resolved_config: &Value,
        redirect_uri: &str,
        state: &str,
    ) -> Result<String, String> {
        let corp_id = resolved_config
            .get("corp_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "corp_id missing or unresolved".to_string())?;
        let agent_id = resolved_config
            .get("agent_id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "agent_id missing or not a number".to_string())?;
        Ok(oauth_authorize_url(
            corp_id,
            agent_id,
            redirect_uri,
            state,
            OAuthScope::Base,
        ))
    }

    fn sign_state(
        &self,
        resolved_config: &Value,
        instance_id: &str,
        ttl_secs: u64,
        ctx: Option<&str>,
        now_unix: u64,
    ) -> Result<String, String> {
        let token = resolved_config
            .get("token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "instance token missing — required for OAuth state signing".to_string())?;
        // Generate the nonce locally so the trait surface stays tiny.
        // 16 random bytes → 32 hex chars; we don't need crypto-secure
        // RNG here (the HMAC sig is what proves authenticity), but
        // using `rand::thread_rng()` keeps it simple.
        let nonce = {
            use rand::RngCore;
            let mut buf = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut buf);
            let mut out = String::with_capacity(32);
            const HEX: &[u8; 16] = b"0123456789abcdef";
            for b in buf {
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0f) as usize] as char);
            }
            out
        };
        make_oauth_state(instance_id, token, ttl_secs, ctx, &nonce, now_unix)
    }

    fn verify_state(
        &self,
        resolved_config: &Value,
        state: &str,
        expected_instance: &str,
        now_unix: u64,
    ) -> Result<Option<String>, String> {
        let token = resolved_config
            .get("token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "instance token missing — cannot verify OAuth state".to_string())?;
        let claims = verify_oauth_state(state, expected_instance, token, now_unix)?;
        Ok(claims.ctx)
    }

    async fn exchange_code(
        &self,
        resolved_config: &Value,
        code: &str,
    ) -> Result<crate::channel_adapter::OAuthIdentity, String> {
        let corp_id = resolved_config
            .get("corp_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "corp_id unresolved".to_string())?;
        let corp_secret = resolved_config
            .get("corp_secret")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "corp_secret unresolved".to_string())?;
        let access_token = ensure_token(corp_id, corp_secret, false)
            .await
            .map_err(|outcome| format!("access_token fetch failed: {outcome:?}"))?;
        let info = exchange_code_for_userid(&access_token, code).await?;
        Ok(crate::channel_adapter::OAuthIdentity {
            external_user_id: info.userid,
            // snsapi_base doesn't surface display name; future
            // snsapi_privateinfo support would set this from the
            // user_ticket → getuserdetail round-trip.
            display_name: None,
            extras: serde_json::json!({
                "external_userid": info.external_userid,
                "user_ticket": info.user_ticket,
            }),
        })
    }
}

// ---------------------------------------------------------------------------
// Inbound (C.2)
// ---------------------------------------------------------------------------

pub struct WeComAppInboundHandler;

#[async_trait]
impl crate::channel_adapter::ChannelInboundHandler for WeComAppInboundHandler {
    fn verify(
        &self,
        req: &InboundRequest,
        resolved_config: &Value,
    ) -> Result<(), String> {
        // Pull required inbound config — `callback_token` is the
        // shared secret operators set in the WeCom admin panel.
        let token = require_inbound_field(resolved_config, "callback_token")?;
        let timestamp = req
            .query
            .get("timestamp")
            .ok_or_else(|| "missing timestamp query param".to_string())?;
        let nonce = req
            .query
            .get("nonce")
            .ok_or_else(|| "missing nonce query param".to_string())?;
        let signature = req
            .query
            .get("msg_signature")
            .or_else(|| req.query.get("signature"))
            .ok_or_else(|| "missing msg_signature query param".to_string())?;

        // The signed payload depends on the request shape:
        //   - GET handshake: `(token, timestamp, nonce, echostr)`
        //   - POST callback: `(token, timestamp, nonce, msg_encrypt)`
        // Use whichever the request provides.
        let echo = req.query.get("echostr").map(|s| s.as_str());
        let body_encrypt = if echo.is_some() {
            None
        } else {
            extract_tag(std::str::from_utf8(&req.body).unwrap_or(""), "Encrypt")
        };
        let fourth: &str = echo.or(body_encrypt.as_deref()).unwrap_or("");
        if fourth.is_empty() {
            return Err("missing echostr / Encrypt".to_string());
        }

        let expected = wecom_signature(&token, timestamp, nonce, fourth);
        if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
            return Err("signature mismatch".to_string());
        }
        Ok(())
    }

    async fn handle_get(
        &self,
        req: &InboundRequest,
        resolved_config: &Value,
    ) -> Result<AckPayload, String> {
        // Already passed `verify()`. Decrypt the echostr and return
        // the raw plaintext — that's the WeCom callback verification
        // protocol.
        let aes_key = require_inbound_field(resolved_config, "callback_aes_key")?;
        let corp_id = require_inbound_field(resolved_config, "corp_id")?;
        let echo = req
            .query
            .get("echostr")
            .ok_or_else(|| "missing echostr".to_string())?;
        let plain = decrypt_aes_payload(&aes_key, echo, &corp_id)?;
        Ok(AckPayload::Plain(plain.into_bytes()))
    }

    async fn handle_post(
        &self,
        req: &InboundRequest,
        resolved_config: &Value,
    ) -> Result<DecodedInbound, String> {
        let aes_key = require_inbound_field(resolved_config, "callback_aes_key")?;
        let corp_id = require_inbound_field(resolved_config, "corp_id")?;
        let body_str = std::str::from_utf8(&req.body)
            .map_err(|e| format!("body is not utf-8: {e}"))?;
        let encrypt = extract_tag(body_str, "Encrypt")
            .ok_or_else(|| "body missing <Encrypt> field".to_string())?;
        let plaintext_xml = decrypt_aes_payload(&aes_key, &encrypt, &corp_id)?;
        let event = parse_inbound_xml(&plaintext_xml)?;
        Ok(DecodedInbound {
            event,
            // Ack-and-async: 200 OK empty body. The agent's reply
            // gets pushed back via cgi-bin/message/send (handled by
            // the inbound route, not the handler).
            ack: AckPayload::Empty,
        })
    }
}

fn require_inbound_field(config: &Value, field: &str) -> Result<String, String> {
    let raw = config
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("inbound requires `{field}` to be set on the channel instance"))?;
    if raw.contains("${env:") {
        return Err(format!(
            "{field} contains an unresolved ${{env:...}} template — set the env var before retrying"
        ));
    }
    Ok(raw.to_string())
}

/// `sha1(sort([token, timestamp, nonce, payload]).join(""))`,
/// hex-encoded lowercase. Same scheme used for the GET handshake
/// (where `payload = echostr`) and POST verify (where `payload =
/// <Encrypt>` field from the body).
/// don't have a dedicated branch.
fn parse_inbound_xml(xml: &str) -> Result<ChannelInboundEvent, String> {
    let msg_type = extract_tag(xml, "MsgType")
        .ok_or_else(|| "inbound XML missing <MsgType>".to_string())?;
    // FromUserName is the sender's userid; for group messages
    // (`MsgType=text` from a group bot) it's the WeCom userid of the
    // human who @-mentioned the bot.
    let from_user = extract_tag(xml, "FromUserName")
        .ok_or_else(|| "inbound XML missing <FromUserName>".to_string())?;
    // Some WeCom event types carry `<ChatId>` for the group; the
    // text-from-group flow puts the group id into `ChatId` and the
    // user id into `FromUserName`. We prefer ChatId when present so
    // the binding key is the group, not the individual sender.
    let external_chat_id = extract_tag(xml, "ChatId").unwrap_or_else(|| from_user.clone());

    let (kind, text) = match msg_type.as_str() {
        "text" => (
            ChannelInboundKind::Text,
            extract_tag(xml, "Content").unwrap_or_default(),
        ),
        "image" => (ChannelInboundKind::Image, String::new()),
        "voice" => (ChannelInboundKind::Voice, String::new()),
        "event" => {
            let event = extract_tag(xml, "Event").unwrap_or_default().to_lowercase();
            (ChannelInboundKind::Event(event), String::new())
        }
        other => (
            ChannelInboundKind::Event(other.to_string()),
            String::new(),
        ),
    };
    Ok(ChannelInboundEvent {
        channel: "wecom_app".into(),
        // instance_id is filled in by the route handler — the
        // adapter doesn't see the URL path.
        instance_id: String::new(),
        external_chat_id,
        external_user_id: Some(from_user),
        display_name: None,
        thread_id: None,
        text,
        kind,
        raw: serde_json::json!({ "xml": xml }),
        received_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Pull a non-empty string field, returning a SendOutcome::Failed
/// directly if the field is missing or still has an unresolved
/// `${env:…}` template. The caller folds the error into its own
/// path without an extra `match`.
fn concrete_str(config: &Value, field: &str) -> Result<String, SendOutcome> {
    let raw = config
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| SendOutcome::fail(format!("{field} missing from config")))?;
    if raw.contains("${env:") {
        return Err(SendOutcome::Failed {
            message: format!(
                "{field} contains an unresolved ${{env:...}} template — set the env var before retrying"
            ),
            code: Some("wecom_app:unresolved_template".into()),
            retryable: false,
        });
    }
    Ok(raw.to_string())
}

/// Build the cgi-bin/message/send body. Truncation happens here so
/// the cap is enforced even when the caller forgot to truncate
/// earlier.
fn build_send_body(
    resolved_config: &Value,
    msg: &OutboundMessage,
    agent_id: i64,
) -> Result<Value, String> {
    let to_user = resolved_config
        .get("to_user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let to_party = resolved_config
        .get("to_party")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let to_tag = resolved_config
        .get("to_tag")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if to_user.is_none() && to_party.is_none() && to_tag.is_none() {
        return Err(
            "no recipient configured (to_user / to_party / to_tag all empty)".into(),
        );
    }

    let (truncated_text, _) = truncate_utf8(&msg.text, WECOM_APP_MAX_BYTES);
    let mut body = json!({
        "agentid": agent_id,
        "safe": 0,
    });
    if let Some(v) = to_user {
        body["touser"] = Value::String(v.to_string());
    }
    if let Some(v) = to_party {
        body["toparty"] = Value::String(v.to_string());
    }
    if let Some(v) = to_tag {
        body["totag"] = Value::String(v.to_string());
    }
    match msg.format {
        ChannelMessageFormat::Text => {
            body["msgtype"] = Value::String("text".into());
            body["text"] = json!({ "content": truncated_text });
        }
        ChannelMessageFormat::Markdown => {
            body["msgtype"] = Value::String("markdown".into());
            body["markdown"] = json!({ "content": truncated_text });
        }
    }
    Ok(body)
}

/// One round-trip: ensure_token → POST /cgi-bin/message/send. Used
/// twice by `send` (initial + token-expiry retry). The
/// `force_refresh` flag bypasses the cache entirely.
async fn send_once(
    corp_id: &str,
    corp_secret: &str,
    body: &Value,
    force_refresh: bool,
) -> SendOutcome {
    let token = match ensure_token(corp_id, corp_secret, force_refresh).await {
        Ok(t) => t,
        Err(e) => return e,
    };
    let url = format!(
        "{WECOM_API_BASE}/cgi-bin/message/send?access_token={}",
        urlencoding_minimal(&token)
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return SendOutcome::fail_retryable(format!("HTTP client init: {e}")),
    };
    let resp = match client.post(&url).json(body).send().await {
        Ok(r) => r,
        Err(e) => return SendOutcome::fail_retryable(format!("HTTP transport: {e}")),
    };
    let status = resp.status();
    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return SendOutcome::Failed {
                message: format!(
                    "HTTP {} but reply body unreadable: {e}",
                    status.as_u16()
                ),
                code: Some(format!("wecom_app:reply_unreadable_{}", status.as_u16())),
                retryable: false,
            };
        }
    };
    if !status.is_success() {
        let retryable = status.is_server_error();
        return SendOutcome::Failed {
            message: format!("HTTP {}: {raw}", status.as_u16()),
            code: Some(format!("wecom_app:http_{}", status.as_u16())),
            retryable,
        };
    }
    let parsed: WeComReply = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            return SendOutcome::Failed {
                message: format!("response parse: {e}: {raw}"),
                code: Some("wecom_app:reply_parse".into()),
                retryable: false,
            };
        }
    };
    if parsed.errcode != 0 {
        // Only 42001 is retryable (and we burn that retry inside
        // `send`). 60020 (IP not whitelisted) and friends are config
        // errors — same payload retried = same rejection.
        let retryable = matches!(parsed.errcode, 42001);
        return SendOutcome::Failed {
            message: format!("WeCom errcode {}: {}", parsed.errcode, parsed.errmsg),
            code: Some(format!("wecom_app:errcode_{}", parsed.errcode)),
            retryable,
        };
    }
    SendOutcome::sent()
}

#[derive(Debug, Deserialize)]
struct WeComReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

/// Minimal RFC 3986 unreserved-chars-only URL encoder. The corp
/// secret can contain `+` / `/` / `=` from base64 in some configs
/// (rare but documented), so we treat it like the DingTalk sign:
/// percent-encode anything not in the unreserved set.
pub(super) fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}


/// Same UTF-8-safe truncation pattern as the other adapters. Kept
/// inline rather than extracted — each kind's max-bytes is platform
/// specific.
fn truncate_utf8(s: &str, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s.to_string(), false);
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (s[..cut].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_adapter::{ChannelAdapter, ChannelInboundHandler};
    use std::collections::HashMap;

    /// Mirror of `crypto::tests::synth_encrypt` — duplicated here
    /// because integration-shape tests (handler_post_round_trip)
    /// live in mod.rs but need to fabricate ciphertext, and
    /// `#[cfg(test)]` items inside a sibling submodule's `mod tests`
    /// aren't reachable from this module. Keep them in sync — the
    /// unit tests in crypto.rs cover the round-trip semantics.
    fn synth_encrypt(msg: &str, corp_id: &str, key: &[u8; 32]) -> String {
        use aes::cipher::{block_padding::NoPadding, BlockEncryptMut, KeyIvInit};
        use base64::Engine;
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

        let iv = &key[..16];
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0u8; 16]);
        payload.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        payload.extend_from_slice(msg.as_bytes());
        payload.extend_from_slice(corp_id.as_bytes());
        let pad_len = 32 - (payload.len() % 32);
        payload.extend_from_slice(&vec![pad_len as u8; pad_len]);
        let mut buf = payload.clone();
        let cipher = Aes256CbcEnc::new_from_slices(key, iv).unwrap();
        let n = cipher
            .encrypt_padded_mut::<NoPadding>(&mut buf, payload.len())
            .unwrap()
            .len();
        base64::engine::general_purpose::STANDARD.encode(&buf[..n])
    }

    fn synth_aes_key_b64(key: &[u8; 32]) -> String {
        use base64::Engine;
        let full = base64::engine::general_purpose::STANDARD.encode(key);
        full.chars().take(43).collect()
    }

    fn full_config() -> Value {
        json!({
            "corp_id": "wwabc",
            "agent_id": "1000002",
            "corp_secret": "secret-xyz",
            "to_user": "@all"
        })
    }

    #[test]
    fn validate_requires_corp_id_agent_id_secret() {
        for missing in ["corp_id", "agent_id", "corp_secret"] {
            let mut cfg = full_config();
            cfg.as_object_mut().unwrap().remove(missing);
            let err = WeComAppAdapter.validate_config(&cfg).unwrap_err();
            assert!(err.contains(missing), "{missing} missing not flagged: {err}");
        }
    }

    #[test]
    fn validate_requires_at_least_one_target() {
        let mut cfg = full_config();
        cfg.as_object_mut().unwrap().remove("to_user");
        let err = WeComAppAdapter.validate_config(&cfg).unwrap_err();
        assert!(err.contains("to_user / to_party / to_tag"));
    }

    #[test]
    fn validate_accepts_minimal_full_config() {
        WeComAppAdapter.validate_config(&full_config()).unwrap();
    }

    #[test]
    fn schema_advertises_text_markdown_and_callback_path() {
        let s = WeComAppAdapter.schema();
        assert_eq!(s["direction"], "bidirectional");
        let formats = s["supports_formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(formats.contains(&"text"));
        assert!(formats.contains(&"markdown"));
        assert_eq!(s["callback_path"], "/v1/channels/<id>/callback");
    }

    #[tokio::test]
    async fn send_rejects_unresolved_template() {
        std::env::remove_var("NOT_SET_WECOM_APP");
        let cfg = json!({
            "corp_id": "wwabc",
            "agent_id": "1",
            "corp_secret": "${env:NOT_SET_WECOM_APP}",
            "to_user": "@all"
        });
        let r = WeComAppAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, .. } => {
                assert_eq!(code.as_deref(), Some("wecom_app:unresolved_template"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_non_numeric_agent_id() {
        let cfg = json!({
            "corp_id": "wwabc",
            "agent_id": "not-a-number",
            "corp_secret": "abc",
            "to_user": "@all"
        });
        let r = WeComAppAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { message, .. } => {
                assert!(message.contains("agent_id"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn build_body_text_routes_to_user() {
        let cfg = json!({
            "to_user": "alice|bob"
        });
        let body = build_send_body(
            &cfg,
            &OutboundMessage::text("hello"),
            42,
        )
        .unwrap();
        assert_eq!(body["msgtype"], "text");
        assert_eq!(body["text"]["content"], "hello");
        assert_eq!(body["touser"], "alice|bob");
        assert!(!body.as_object().unwrap().contains_key("toparty"));
        assert_eq!(body["agentid"], 42);
    }

    #[test]
    fn build_body_markdown_uses_markdown_field() {
        let cfg = json!({"to_user": "alice"});
        let body = build_send_body(
            &cfg,
            &OutboundMessage::text("# hello").with_format(ChannelMessageFormat::Markdown),
            7,
        )
        .unwrap();
        assert_eq!(body["msgtype"], "markdown");
        assert_eq!(body["markdown"]["content"], "# hello");
        assert!(body.get("text").is_none());
    }

    #[test]
    fn build_body_to_party_works_alone() {
        let cfg = json!({"to_party": "1|2"});
        let body = build_send_body(&cfg, &OutboundMessage::text("hi"), 1).unwrap();
        assert_eq!(body["toparty"], "1|2");
        assert!(!body.as_object().unwrap().contains_key("touser"));
    }

    #[test]
    fn build_body_truncates_over_cap() {
        let big = "x".repeat(WECOM_APP_MAX_BYTES + 100);
        let cfg = json!({"to_user": "@all"});
        let body = build_send_body(&cfg, &OutboundMessage::text(big), 1).unwrap();
        assert_eq!(
            body["text"]["content"].as_str().unwrap().len(),
            WECOM_APP_MAX_BYTES
        );
    }

    #[test]
    fn build_body_rejects_no_targets() {
        let err = build_send_body(&json!({}), &OutboundMessage::text("hi"), 1).unwrap_err();
        assert!(err.contains("no recipient"));
    }

    #[test]
    fn url_encoder_handles_base64_chars() {
        assert_eq!(urlencoding_minimal("a+b"), "a%2Bb");
        assert_eq!(urlencoding_minimal("a/b"), "a%2Fb");
        assert_eq!(urlencoding_minimal("a=b"), "a%3Db");
        assert_eq!(urlencoding_minimal("ww-corp_123"), "ww-corp_123");
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        let s = "你好世界";
        let (out, t) = truncate_utf8(s, 4);
        assert!(t);
        assert_eq!(out, "你");
    }


    #[test]
    fn parse_inbound_xml_text_message() {
        let xml = r#"<xml>
            <ToUserName><![CDATA[ww-corp]]></ToUserName>
            <FromUserName><![CDATA[user42]]></FromUserName>
            <CreateTime>1700000000</CreateTime>
            <MsgType><![CDATA[text]]></MsgType>
            <Content><![CDATA[你好 jarvis]]></Content>
            <ChatId><![CDATA[group-abc]]></ChatId>
        </xml>"#;
        let evt = parse_inbound_xml(xml).unwrap();
        assert_eq!(evt.channel, "wecom_app");
        assert_eq!(evt.text, "你好 jarvis");
        assert_eq!(evt.kind, ChannelInboundKind::Text);
        // ChatId wins over FromUserName for the binding key.
        assert_eq!(evt.external_chat_id, "group-abc");
        assert_eq!(evt.external_user_id.as_deref(), Some("user42"));
    }

    #[test]
    fn parse_inbound_xml_falls_back_to_from_user_when_no_chat_id() {
        let xml = r#"<xml>
            <FromUserName><![CDATA[user-alone]]></FromUserName>
            <MsgType><![CDATA[text]]></MsgType>
            <Content><![CDATA[hi]]></Content>
        </xml>"#;
        let evt = parse_inbound_xml(xml).unwrap();
        assert_eq!(evt.external_chat_id, "user-alone");
    }

    #[test]
    fn parse_inbound_xml_image_kind() {
        let xml = r#"<xml>
            <FromUserName>u1</FromUserName>
            <MsgType>image</MsgType>
            <PicUrl>https://x.example/y.jpg</PicUrl>
        </xml>"#;
        let evt = parse_inbound_xml(xml).unwrap();
        assert_eq!(evt.kind, ChannelInboundKind::Image);
        assert_eq!(evt.text, "");
    }

    #[test]
    fn parse_inbound_xml_subscribe_event() {
        let xml = r#"<xml>
            <FromUserName>u-new</FromUserName>
            <MsgType>event</MsgType>
            <Event>subscribe</Event>
        </xml>"#;
        let evt = parse_inbound_xml(xml).unwrap();
        assert_eq!(evt.kind, ChannelInboundKind::Event("subscribe".into()));
    }

    #[test]
    fn parse_inbound_xml_unknown_msg_type_folds_to_event() {
        let xml = r#"<xml>
            <FromUserName>u1</FromUserName>
            <MsgType>location</MsgType>
        </xml>"#;
        let evt = parse_inbound_xml(xml).unwrap();
        assert_eq!(evt.kind, ChannelInboundKind::Event("location".into()));
    }

    #[test]
    fn parse_inbound_xml_missing_msg_type_errors() {
        let err = parse_inbound_xml("<xml><FromUserName>u</FromUserName></xml>").unwrap_err();
        assert!(err.contains("MsgType"));
    }

    #[test]
    fn handler_verify_rejects_missing_token() {
        let h = WeComAppInboundHandler;
        let req = InboundRequest::default();
        let cfg = json!({});
        let err = h.verify(&req, &cfg).unwrap_err();
        assert!(err.contains("callback_token"));
    }

    #[test]
    fn handler_verify_rejects_missing_query_params() {
        let h = WeComAppInboundHandler;
        let cfg = json!({"callback_token": "ABC"});
        let mut req = InboundRequest::default();
        // No timestamp/nonce/signature → 401.
        let err = h.verify(&req, &cfg).unwrap_err();
        assert!(err.contains("timestamp"));

        req.query.insert("timestamp".into(), "1".into());
        let err = h.verify(&req, &cfg).unwrap_err();
        assert!(err.contains("nonce"));

        req.query.insert("nonce".into(), "N".into());
        let err = h.verify(&req, &cfg).unwrap_err();
        assert!(err.contains("msg_signature"));
    }

    #[test]
    fn handler_verify_accepts_correct_signature_for_get() {
        let h = WeComAppInboundHandler;
        let cfg = json!({"callback_token": "ABC"});
        let mut req = InboundRequest::default();
        req.query.insert("timestamp".into(), "100".into());
        req.query.insert("nonce".into(), "rand".into());
        req.query.insert("echostr".into(), "hello".into());
        let sig = wecom_signature("ABC", "100", "rand", "hello");
        req.query.insert("msg_signature".into(), sig);
        h.verify(&req, &cfg).unwrap();
    }

    #[test]
    fn handler_verify_rejects_signature_mismatch() {
        let h = WeComAppInboundHandler;
        let cfg = json!({"callback_token": "ABC"});
        let mut req = InboundRequest::default();
        req.query.insert("timestamp".into(), "100".into());
        req.query.insert("nonce".into(), "rand".into());
        req.query.insert("echostr".into(), "hello".into());
        req.query.insert("msg_signature".into(), "0".repeat(40));
        let err = h.verify(&req, &cfg).unwrap_err();
        assert!(err.contains("signature mismatch"));
    }

    #[tokio::test]
    async fn handler_post_round_trip_decrypts_xml() {
        let key = [3u8; 32];
        let aes_key_b64 = synth_aes_key_b64(&key);
        let cfg = json!({
            "corp_id": "ww-test",
            "callback_token": "T",
            "callback_aes_key": aes_key_b64,
        });
        let xml = "<xml><FromUserName>u1</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>";
        let cipher = synth_encrypt(xml, "ww-test", &key);
        let body = format!("<xml><Encrypt><![CDATA[{cipher}]]></Encrypt></xml>");

        let h = WeComAppInboundHandler;
        let req = InboundRequest {
            query: HashMap::new(),
            headers: HashMap::new(),
            body: body.into_bytes(),
        };
        let decoded = h.handle_post(&req, &cfg).await.unwrap();
        assert_eq!(decoded.event.kind, ChannelInboundKind::Text);
        assert_eq!(decoded.event.text, "hi");
        assert!(matches!(decoded.ack, AckPayload::Empty));
    }

    #[test]
    fn adapter_returns_inbound_handler() {
        let h = WeComAppAdapter.inbound_handler();
        assert!(h.is_some(), "wecom_app must advertise inbound support");
    }

    #[test]
    fn outbound_only_adapters_return_none_for_inbound_handler() {
        // Default impl on the trait keeps the existing 3 webhook
        // adapters opt-out — the inbound router uses this to 405
        // POSTs to outbound-only kinds.
        assert!(crate::channels_wecom::WeComWebhookAdapter
            .inbound_handler()
            .is_none());
        assert!(crate::channels_feishu::FeishuBotAdapter
            .inbound_handler()
            .is_none());
        assert!(crate::channels_dingtalk::DingTalkBotAdapter
            .inbound_handler()
            .is_none());
    }

    #[test]
    fn adapter_returns_oauth_capability() {
        // OAuth gate previously hardcoded `if kind == "wecom_app"`
        // in two places. Now the route dispatches via this method —
        // so the wecom_app adapter MUST return `Some(...)`. The
        // sibling test below proves the default `None` impl keeps
        // the 3 webhook adapters opted out without code changes.
        assert!(
            WeComAppAdapter.oauth_capability().is_some(),
            "wecom_app must advertise OAuth capability — used by /v1/channels/:id/oauth/{{start,callback}}"
        );
    }

    #[test]
    fn outbound_only_adapters_return_none_for_oauth_capability() {
        assert!(crate::channels_wecom::WeComWebhookAdapter
            .oauth_capability()
            .is_none());
        assert!(crate::channels_feishu::FeishuBotAdapter
            .oauth_capability()
            .is_none());
        assert!(crate::channels_dingtalk::DingTalkBotAdapter
            .oauth_capability()
            .is_none());
    }
}
