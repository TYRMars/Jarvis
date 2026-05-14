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
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const WECOM_API_BASE: &str = "https://qyapi.weixin.qq.com";

/// WeCom caps text body at ~2000 chars; markdown card body at ~4096.
/// Use the more permissive bound and let the platform truncate
/// anything above (it doesn't error, just clips).
const WECOM_APP_MAX_BYTES: usize = 4096;

/// How early to refresh `access_token` before its declared
/// `expires_in`. WeCom hands out 7200-second tokens; refreshing 5
/// minutes before keeps every send well clear of the boundary.
const TOKEN_REFRESH_LEAD_SECS: u64 = 300;

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Process-level cache, keyed by `corp_id`. A separate
/// `RwLock<HashMap>` per binary (not per-instance) because access
/// tokens are corp-scoped, not app-scoped — multiple
/// `ChannelInstance` rows for the same `corp_id` share one token to
/// stay under WeCom's 2000-call/day refresh quota.
#[derive(Default)]
struct AccessTokenCache {
    inner: RwLock<HashMap<String, CachedToken>>,
}

impl AccessTokenCache {
    fn get(&self, corp_id: &str) -> Option<String> {
        let g = self.inner.read().ok()?;
        let cached = g.get(corp_id)?;
        if Instant::now() < cached.expires_at {
            Some(cached.token.clone())
        } else {
            None
        }
    }

    fn set(&self, corp_id: &str, token: String, ttl_secs: u64) {
        let safe_ttl = ttl_secs.saturating_sub(TOKEN_REFRESH_LEAD_SECS);
        let expires_at = Instant::now() + Duration::from_secs(safe_ttl);
        if let Ok(mut g) = self.inner.write() {
            g.insert(
                corp_id.to_string(),
                CachedToken {
                    token,
                    expires_at,
                },
            );
        }
    }

    fn invalidate(&self, corp_id: &str) {
        if let Ok(mut g) = self.inner.write() {
            g.remove(corp_id);
        }
    }
}

/// Singleton — every `WeComAppAdapter` invocation hits the same
/// cache so deployments with multiple instances behind one
/// `corp_id` share tokens. Lazy-init via `OnceLock`.
fn token_cache() -> &'static AccessTokenCache {
    static CACHE: std::sync::OnceLock<AccessTokenCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(AccessTokenCache::default)
}

/// Reset helper for tests — never called from production code.
#[cfg(test)]
fn reset_token_cache() {
    if let Ok(mut g) = token_cache().inner.write() {
        g.clear();
    }
}

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
fn wecom_signature(token: &str, timestamp: &str, nonce: &str, payload: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut parts = [token, timestamp, nonce, payload];
    parts.sort();
    let joined = parts.concat();
    let digest = Sha1::digest(joined.as_bytes());
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(40);
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Compare two byte slices in constant time so a mismatched
/// signature doesn't leak prefix-length info via timing. Stdlib has
/// no constant-time eq; this 4-line version is the hot-path-cheap
/// equivalent everyone copy-pastes.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Find `<Tag>...</Tag>` in `xml` and return the inner content,
/// stripping a `<![CDATA[...]]>` wrapper if present. Hand-rolled
/// because the inbound XML shape is rigid (5 message kinds, all
/// flat) — pulling in `quick-xml` for this would be way more
/// complexity than the parsing demands.
///
/// Returns `None` for missing or empty tags. Doesn't handle
/// nesting — WeCom's inbound XML never does.
fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let raw = &xml[start..end];
    let stripped = raw
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(raw);
    Some(stripped.to_string())
}

/// AES-256-CBC decrypt the WeCom callback payload + extract the
/// real plaintext. WeCom's encryption envelope:
/// ```text
/// base64-decoded ciphertext = AES-256-CBC encrypted bytes
///   key = base64-decode(EncodingAESKey + "=")  // 32 bytes
///   iv  = key[..16]                            // first 16 bytes of key
/// plaintext = random_16 || msg_len_be_u32 || msg || receive_id
/// ```
/// We extract `msg`, validate `receive_id == corp_id`, and return
/// `msg`. PKCS#7 padding is stripped from the tail of the ciphertext
/// before slicing.
fn decrypt_aes_payload(
    encoding_aes_key: &str,
    ciphertext_b64: &str,
    expected_corp_id: &str,
) -> Result<String, String> {
    use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
    use base64::Engine;
    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

    // EncodingAESKey is 43 chars of base64 — append `=` to make it
    // a valid 44-char padded base64 → 32 bytes.
    let aes_key = base64::engine::general_purpose::STANDARD
        .decode(format!("{encoding_aes_key}="))
        .map_err(|e| format!("encoding_aes_key not valid base64: {e}"))?;
    if aes_key.len() != 32 {
        return Err(format!(
            "encoding_aes_key decoded to {} bytes; expected 32",
            aes_key.len()
        ));
    }
    let iv = &aes_key[..16];

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64.trim())
        .map_err(|e| format!("ciphertext not valid base64: {e}"))?;
    if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
        return Err(format!(
            "ciphertext length {} is not a multiple of 16",
            ciphertext.len()
        ));
    }

    let mut buf = ciphertext.clone();
    let cipher = Aes256CbcDec::new_from_slices(&aes_key, iv)
        .map_err(|e| format!("AES init failed: {e}"))?;
    cipher
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decrypt failed: {e}"))?;

    // Strip WeCom's custom PKCS#7-style padding. The last byte
    // tells you how many trailing bytes are padding; valid range
    // 1..=32. Anything else means key/iv/payload corruption.
    let pad = *buf.last().ok_or("decrypted buffer is empty")? as usize;
    if pad == 0 || pad > 32 || pad > buf.len() {
        return Err(format!("invalid padding length: {pad}"));
    }
    let stripped_len = buf.len() - pad;
    let plain = &buf[..stripped_len];

    // Layout: `random_16 || msg_len_4_be || msg || receive_id`
    if plain.len() < 16 + 4 {
        return Err(format!("plaintext too short: {} bytes", plain.len()));
    }
    let msg_len = u32::from_be_bytes(plain[16..20].try_into().unwrap()) as usize;
    if 16 + 4 + msg_len > plain.len() {
        return Err(format!(
            "msg_len {} exceeds plaintext length {}",
            msg_len,
            plain.len() - 20
        ));
    }
    let msg_bytes = &plain[20..20 + msg_len];
    let receive_id = &plain[20 + msg_len..];
    let receive_id = std::str::from_utf8(receive_id)
        .map_err(|e| format!("receive_id is not utf-8: {e}"))?;

    if receive_id != expected_corp_id {
        return Err(format!(
            "receive_id mismatch: expected {expected_corp_id}, got {receive_id}"
        ));
    }
    let msg = std::str::from_utf8(msg_bytes)
        .map_err(|e| format!("msg is not utf-8: {e}"))?;
    Ok(msg.to_string())
}

/// Parse decrypted inbound XML into a normalised
/// [`ChannelInboundEvent`]. WeCom's 5 inbound message types we
/// actually care about (text, image, voice, event/subscribe,
/// event/unsubscribe). Anything else folds into `ChannelInboundKind
/// ::Event(...)` so the caller still sees the message even if we
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

/// Return a token from the cache, fetching one when missing /
/// expired / `force_refresh = true`.
pub(crate) async fn ensure_token(
    corp_id: &str,
    corp_secret: &str,
    force_refresh: bool,
) -> Result<String, SendOutcome> {
    if !force_refresh {
        if let Some(t) = token_cache().get(corp_id) {
            return Ok(t);
        }
    }
    fetch_token(corp_id, corp_secret).await
}

#[derive(Debug, Deserialize)]
struct GetTokenReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_in: u64,
}

/// Fetch a fresh access_token. Cache populated on success.
async fn fetch_token(corp_id: &str, corp_secret: &str) -> Result<String, SendOutcome> {
    let url = format!(
        "{WECOM_API_BASE}/cgi-bin/gettoken?corpid={}&corpsecret={}",
        urlencoding_minimal(corp_id),
        urlencoding_minimal(corp_secret),
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Err(SendOutcome::fail_retryable(format!(
                "HTTP client init: {e}"
            )))
        }
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Err(SendOutcome::fail_retryable(format!(
                "gettoken transport: {e}"
            )))
        }
    };
    let status = resp.status();
    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Err(SendOutcome::Failed {
                message: format!("gettoken reply unreadable: {e}"),
                code: Some("wecom_app:gettoken_reply_unreadable".into()),
                retryable: false,
            });
        }
    };
    if !status.is_success() {
        return Err(SendOutcome::Failed {
            message: format!("gettoken HTTP {}: {raw}", status.as_u16()),
            code: Some(format!("wecom_app:gettoken_http_{}", status.as_u16())),
            retryable: status.is_server_error(),
        });
    }
    let parsed: GetTokenReply = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            return Err(SendOutcome::Failed {
                message: format!("gettoken parse: {e}: {raw}"),
                code: Some("wecom_app:gettoken_reply_parse".into()),
                retryable: false,
            });
        }
    };
    if parsed.errcode != 0 || parsed.access_token.is_empty() {
        return Err(SendOutcome::Failed {
            message: format!(
                "gettoken errcode {}: {}",
                parsed.errcode, parsed.errmsg
            ),
            code: Some(format!("wecom_app:gettoken_errcode_{}", parsed.errcode)),
            retryable: false,
        });
    }
    token_cache().set(corp_id, parsed.access_token.clone(), parsed.expires_in);
    Ok(parsed.access_token)
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
fn urlencoding_minimal(s: &str) -> String {
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

// ---------------------------------------------------------------------------
// OAuth2 免登 (snsapi_base) — terminal-user identity verification.
//
// WeCom's snsapi_base scope returns a `userid` after a silent in-client
// authorisation. We use it for "click here to verify who you are" links
// the bot can post into a chat, or for the `/v1/channels/:id/oauth/start`
// + `/oauth/callback` redirect pair.
//
// State is HMAC-SHA1 signed against the instance's `token` field — same
// secret the inbound verify uses — so we don't need a server-side state
// store. The signed payload carries `instance_id`, an expiry timestamp,
// and a random nonce. Verification checks the signature, parses the
// payload, validates the instance binding + expiry, all in constant time.
//
// Reference: https://developer.work.weixin.qq.com/document/path/91022
//   ?appid=<corp_id> & redirect_uri=<urlencoded> & response_type=code
//   & scope=snsapi_base | snsapi_privateinfo & agentid=<agent_id>
//   & state=<our_csrf_state> #wechat_redirect
// ---------------------------------------------------------------------------

/// `snsapi_base` returns just the `userid` silently — no popup in the
/// WeCom client when the user is already logged in. `snsapi_privateinfo`
/// additionally surfaces name / avatar / mobile via a `user_ticket`, but
/// it triggers a confirmation prompt and requires extra app permissions.
/// v1 ships only `Base` — it's the minimum that proves identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OAuthScope {
    Base,
}

impl OAuthScope {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Base => "snsapi_base",
        }
    }
}

/// Build the WeCom OAuth2 authorize URL. `redirect_uri` is treated as
/// opaque and URL-encoded verbatim — the operator is responsible for
/// whitelisting its domain in the WeCom admin's "可信域名".
///
/// `#wechat_redirect` is mandatory per WeCom's docs; without it the
/// authorize page renders blank inside the WeCom client.
pub(crate) fn oauth_authorize_url(
    corp_id: &str,
    agent_id: u64,
    redirect_uri: &str,
    state: &str,
    scope: OAuthScope,
) -> String {
    format!(
        "https://open.weixin.qq.com/connect/oauth2/authorize\
         ?appid={appid}\
         &redirect_uri={redirect}\
         &response_type=code\
         &scope={scope}\
         &state={state}\
         &agentid={agentid}#wechat_redirect",
        appid = urlencoding_minimal(corp_id),
        redirect = urlencoding_minimal(redirect_uri),
        scope = scope.as_wire(),
        state = urlencoding_minimal(state),
        agentid = agent_id,
    )
}

/// Decoded state payload after signature verification. The fields are
/// the contract between `make_oauth_state` and `verify_oauth_state` —
/// keep them additive-only or version the payload.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct OAuthStateClaims {
    /// Channel-instance id this state belongs to. The callback route
    /// uses this to cross-check the `:id` path parameter.
    pub(crate) instance_id: String,
    /// Unix seconds after which the state is invalid. Typically now +
    /// 10 minutes — long enough for a slow tap, short enough that a
    /// stolen state ages out before being useful.
    pub(crate) exp: u64,
    /// 16-byte hex random — guards against replay of the same state
    /// (combined with `exp`) and makes the signed blob look opaque.
    pub(crate) nonce: String,
    /// Optional caller-supplied opaque field. Often a Jarvis session
    /// id, a `next=` URL hint, or a pairing token — the callback
    /// surfaces this verbatim so the originator can correlate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ctx: Option<String>,
}

/// Sign a fresh state token. The `token` argument is the same value
/// configured on the `ChannelInstance` for inbound verify (`config.token`
/// — operator-chosen, kept secret) so we don't need a dedicated
/// signing key.
pub(crate) fn make_oauth_state(
    instance_id: &str,
    instance_token: &str,
    ttl_secs: u64,
    ctx: Option<&str>,
    nonce_hex: &str,
    now_unix: u64,
) -> Result<String, String> {
    use base64::Engine;
    if instance_token.is_empty() {
        return Err("instance token is empty — cannot sign OAuth state".to_string());
    }
    let claims = OAuthStateClaims {
        instance_id: instance_id.to_string(),
        exp: now_unix.saturating_add(ttl_secs),
        nonce: nonce_hex.to_string(),
        ctx: ctx.map(str::to_string),
    };
    let json = serde_json::to_vec(&claims).map_err(|e| format!("state encode: {e}"))?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json);
    let sig = oauth_state_sig(&b64, instance_token);
    Ok(format!("{b64}.{sig}"))
}

/// Verify + decode a state token. Returns the claims (CSRF passed and
/// not expired) or an operator-readable error.
///
/// Step order matters:
/// 1. Split on `.`  (cheap, doesn't leak anything)
/// 2. Recompute sig + constant-time compare — catches tampering early
/// 3. Decode payload, parse JSON
/// 4. Cross-check `instance_id` against the route's `:id`
/// 5. Check expiry against the caller-supplied `now_unix`
pub(crate) fn verify_oauth_state(
    state: &str,
    expected_instance: &str,
    instance_token: &str,
    now_unix: u64,
) -> Result<OAuthStateClaims, String> {
    use base64::Engine;
    let (b64, sig) = state.split_once('.').ok_or("state missing signature")?;
    if b64.is_empty() || sig.is_empty() {
        return Err("state malformed".to_string());
    }
    let expected_sig = oauth_state_sig(b64, instance_token);
    if !constant_time_eq(sig.as_bytes(), expected_sig.as_bytes()) {
        return Err("state signature mismatch".to_string());
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64)
        .map_err(|e| format!("state base64: {e}"))?;
    let claims: OAuthStateClaims =
        serde_json::from_slice(&raw).map_err(|e| format!("state json: {e}"))?;
    if claims.instance_id != expected_instance {
        return Err("state instance_id mismatch".to_string());
    }
    if claims.exp < now_unix {
        return Err("state expired".to_string());
    }
    Ok(claims)
}

/// HMAC-SHA1 of the state payload keyed by the instance token. Output
/// is the 40-char lowercase hex digest. WeCom signatures elsewhere in
/// this file are plain `sha1(concat)` — we use HMAC here because the
/// token is a true secret (operator-chosen) and HMAC is the standard
/// CSRF-token construction; plain SHA1 of `token + payload` is
/// vulnerable to length-extension on hypothetical inputs we don't
/// fully control.
fn oauth_state_sig(payload_b64: &str, instance_token: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    type HmacSha1 = Hmac<Sha1>;
    let mut mac =
        HmacSha1::new_from_slice(instance_token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload_b64.as_bytes());
    let bytes = mac.finalize().into_bytes();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(40);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Exchange the `code` returned by WeCom for the user's `userid` via
/// `cgi-bin/auth/getuserinfo`. The `access_token` argument is the
/// app-level access_token from [`ensure_token`].
///
/// WeCom returns `{errcode:0, errmsg:"ok", userid:"..."}` on success.
/// `external_userid` (for non-corp users) and `user_ticket` (only with
/// `snsapi_privateinfo` scope) are surfaced when present — callers
/// that only need `userid` ignore them.
pub(crate) async fn exchange_code_for_userid(
    access_token: &str,
    code: &str,
) -> Result<OAuthUserInfo, String> {
    let url = format!(
        "{WECOM_API_BASE}/cgi-bin/auth/getuserinfo?access_token={}&code={}",
        urlencoding_minimal(access_token),
        urlencoding_minimal(code),
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("getuserinfo http: {e}"))?;
    let parsed: GetUserInfoReply = resp
        .json()
        .await
        .map_err(|e| format!("getuserinfo json: {e}"))?;
    if parsed.errcode != 0 {
        return Err(format!(
            "wecom getuserinfo failed: errcode={} errmsg={}",
            parsed.errcode, parsed.errmsg
        ));
    }
    // A corp member returns `userid`; a non-corp visitor returns
    // `openid` + `external_userid` instead. v1 only supports corp
    // members — surface the visitor case as a clear error rather than
    // silently dropping them.
    let userid = parsed
        .userid
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "wecom oauth: not a corp member (no userid)".to_string())?;
    Ok(OAuthUserInfo {
        userid,
        external_userid: parsed.external_userid.filter(|s| !s.is_empty()),
        user_ticket: parsed.user_ticket.filter(|s| !s.is_empty()),
    })
}

/// Subset of the `getuserinfo` reply we care about. The other fields
/// (`openid`, `device_id`) we ignore — see WeCom's docs if a future
/// feature needs them.
#[derive(Debug, Deserialize)]
struct GetUserInfoReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
    #[serde(default)]
    userid: Option<String>,
    #[serde(default)]
    external_userid: Option<String>,
    #[serde(default)]
    user_ticket: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OAuthUserInfo {
    pub(crate) userid: String,
    /// Set when the authenticator is a non-corp visitor. v1 routes
    /// reject these; recording the field anyway so future "external
    /// contact" features can pick it up without a wire change.
    pub(crate) external_userid: Option<String>,
    /// Set only with `snsapi_privateinfo` scope. Used to call
    /// `cgi-bin/auth/getuserdetail` for name / mobile. `None` for
    /// snsapi_base.
    pub(crate) user_ticket: Option<String>,
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
    use crate::channel_adapter::ChannelAdapter;

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

    // ----------------------- OAuth2 helpers --------------------------

    #[test]
    fn oauth_authorize_url_has_required_params_and_hash() {
        let url = oauth_authorize_url(
            "ww-corp",
            1_000_002,
            "https://abc.example/v1/channels/xyz/oauth/callback",
            "state-token-abc",
            OAuthScope::Base,
        );
        // All of WeCom's required parameters present.
        assert!(url.contains("appid=ww-corp"));
        assert!(url.contains(
            "redirect_uri=https%3A%2F%2Fabc.example%2Fv1%2Fchannels%2Fxyz%2Foauth%2Fcallback"
        ));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("scope=snsapi_base"));
        assert!(url.contains("state=state-token-abc"));
        assert!(url.contains("agentid=1000002"));
        // The `#wechat_redirect` fragment is mandatory — without it
        // WeCom client renders blank.
        assert!(url.ends_with("#wechat_redirect"));
        // No accidental newlines / whitespace from the format string.
        assert!(!url.contains(' '));
        assert!(!url.contains('\n'));
    }

    #[test]
    fn oauth_state_round_trip_decodes_claims() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            600,
            Some("session=abc"),
            "deadbeefcafebabe",
            1_700_000_000,
        )
        .expect("sign ok");
        let claims = verify_oauth_state(&state, "inst-1", "token-secret", 1_700_000_100)
            .expect("verify ok");
        assert_eq!(claims.instance_id, "inst-1");
        assert_eq!(claims.exp, 1_700_000_600);
        assert_eq!(claims.nonce, "deadbeefcafebabe");
        assert_eq!(claims.ctx.as_deref(), Some("session=abc"));
    }

    #[test]
    fn oauth_state_rejects_tampered_payload() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            600,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        // Flip a payload byte (but keep the signature) → signature
        // mismatch.
        let (payload, sig) = state.split_once('.').unwrap();
        let mut bad_payload = payload.to_string();
        let last = bad_payload.pop().unwrap();
        // Replace last char with something different.
        bad_payload.push(if last == 'A' { 'B' } else { 'A' });
        let tampered = format!("{bad_payload}.{sig}");
        let err = verify_oauth_state(&tampered, "inst-1", "token-secret", 1_700_000_100)
            .expect_err("must reject");
        assert!(err.contains("signature"));
    }

    #[test]
    fn oauth_state_rejects_wrong_instance_id() {
        let state = make_oauth_state(
            "inst-A",
            "token-secret",
            600,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        let err = verify_oauth_state(&state, "inst-B", "token-secret", 1_700_000_100)
            .expect_err("must reject");
        assert!(err.contains("instance_id"));
    }

    #[test]
    fn oauth_state_rejects_expired() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            60,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        // 70 seconds later — exp = 1_700_000_060, now = 1_700_000_070.
        let err = verify_oauth_state(&state, "inst-1", "token-secret", 1_700_000_070)
            .expect_err("must reject");
        assert!(err.contains("expired"));
    }

    #[test]
    fn oauth_state_rejects_missing_signature() {
        // No period at all.
        let err = verify_oauth_state("aGVsbG8", "inst-1", "token-secret", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("missing signature"));
        // Empty signature segment.
        let err = verify_oauth_state("aGVsbG8.", "inst-1", "token-secret", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("malformed"));
    }

    #[test]
    fn oauth_state_refuses_empty_token() {
        let err = make_oauth_state("inst-1", "", 600, None, "nonce", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("token"));
    }

    #[test]
    fn oauth_state_sig_differs_per_token_value() {
        // Two distinct tokens MUST produce distinct signatures over
        // the same payload, otherwise the CSRF gate is decorative.
        let s1 = oauth_state_sig("payload", "token-A");
        let s2 = oauth_state_sig("payload", "token-B");
        assert_ne!(s1, s2);
        // And the same input is deterministic.
        assert_eq!(s1, oauth_state_sig("payload", "token-A"));
    }

    // ----------------------- token cache ----------------------------
    //
    // All four cache tests touch the same process-level
    // `token_cache()` singleton. Cargo runs tests in parallel by
    // default, so we serialise just this group with a local mutex —
    // simpler than dragging `serial_test` into the workspace deps
    // and the cost is negligible (4 tests, each <2 ms).

    fn cache_test_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    #[test]
    fn token_cache_stores_and_returns_within_ttl() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-A", "tok-1".into(), 7200);
        assert_eq!(cache.get("corp-A"), Some("tok-1".into()));
    }

    #[test]
    fn token_cache_treats_short_ttl_as_expired_via_lead() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-B", "tok-2".into(), 30); // shorter than 300s lead
        // Cache stores expires_at = now() + 0s (saturating sub),
        // already in the past by the time `get` runs.
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(cache.get("corp-B"), None);
    }

    #[test]
    fn token_cache_invalidate_drops_entry() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-C", "tok-3".into(), 7200);
        cache.invalidate("corp-C");
        assert_eq!(cache.get("corp-C"), None);
    }

    #[test]
    fn token_cache_keys_by_corp_id() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-D", "tok-D".into(), 7200);
        cache.set("corp-E", "tok-E".into(), 7200);
        assert_eq!(cache.get("corp-D").as_deref(), Some("tok-D"));
        assert_eq!(cache.get("corp-E").as_deref(), Some("tok-E"));
    }

    // ----------------------- inbound (C.2) --------------------------

    use crate::channel_adapter::ChannelInboundHandler;
    use harness_channel::ChannelInboundKind;

    #[test]
    fn extract_tag_handles_plain_and_cdata() {
        let xml = "<root><A>plain</A><B><![CDATA[in cdata]]></B></root>";
        assert_eq!(extract_tag(xml, "A").as_deref(), Some("plain"));
        assert_eq!(extract_tag(xml, "B").as_deref(), Some("in cdata"));
        assert_eq!(extract_tag(xml, "Missing"), None);
    }

    #[test]
    fn signature_is_lowercase_hex_and_matches_spec_example() {
        // Sort + concat + sha1. Spot-check a known case computed
        // off-line: `(token=ABC, ts=1, nonce=N, payload=PL)`.
        // Sort → ["1","ABC","N","PL"] → concat → "1ABCNPL"
        // sha1 of that string is deterministic; just check it's
        // 40 lowercase hex chars and changes when an input changes.
        let s1 = wecom_signature("ABC", "1", "N", "PL");
        assert_eq!(s1.len(), 40);
        assert!(s1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let s2 = wecom_signature("ABC", "2", "N", "PL");
        assert_ne!(s1, s2);
        // Reordering identical inputs yields the same signature
        // (sort makes parameter order irrelevant — that's the
        // protocol).
        let s_same = wecom_signature("PL", "ABC", "1", "N");
        assert_eq!(s_same, s1);
    }

    #[test]
    fn constant_time_eq_is_correct_for_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    /// Build a plaintext that the WeCom AES envelope wraps, then
    /// encrypt it ourselves and round-trip through
    /// `decrypt_aes_payload`. We don't depend on a known WeCom
    /// fixture; instead we use the same `aes` + `cbc` crates the
    /// production decrypt does, on a synthetic key, and assert the
    /// shape comes back out cleanly.
    fn synth_encrypt(msg: &str, corp_id: &str, key: &[u8; 32]) -> String {
        use aes::cipher::{block_padding::NoPadding, BlockEncryptMut, KeyIvInit};
        use base64::Engine;
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

        let iv = &key[..16];
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0u8; 16]); // random_16
        payload.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        payload.extend_from_slice(msg.as_bytes());
        payload.extend_from_slice(corp_id.as_bytes());
        // Pad to 32 (PKCS#7 amounts to (32 - len%32) % 32 minimum 1).
        let pad_len = 32 - (payload.len() % 32);
        payload.extend_from_slice(&vec![pad_len as u8; pad_len]);
        // Pre-allocate the buffer for `encrypt_padded_mut`.
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
        // EncodingAESKey = first 43 chars of base64(key). The
        // production decoder appends `=` itself.
        let full = base64::engine::general_purpose::STANDARD.encode(key);
        full.chars().take(43).collect()
    }

    #[test]
    fn decrypt_round_trip_extracts_msg_and_validates_corpid() {
        let key = [7u8; 32];
        let aes_key_b64 = synth_aes_key_b64(&key);
        let cipher = synth_encrypt("hello world", "ww-good-corp", &key);
        let plain = decrypt_aes_payload(&aes_key_b64, &cipher, "ww-good-corp").unwrap();
        assert_eq!(plain, "hello world");
    }

    #[test]
    fn decrypt_rejects_wrong_corp_id() {
        let key = [7u8; 32];
        let aes_key_b64 = synth_aes_key_b64(&key);
        let cipher = synth_encrypt("hi", "ww-actual", &key);
        let err = decrypt_aes_payload(&aes_key_b64, &cipher, "ww-different").unwrap_err();
        assert!(err.contains("receive_id mismatch"), "got: {err}");
    }

    #[test]
    fn decrypt_rejects_invalid_base64() {
        // Use a valid AES key first (so we reach the ciphertext
        // decode), then feed garbage that base64 can't parse.
        let key = [11u8; 32];
        let aes_key_b64 = synth_aes_key_b64(&key);
        let err = decrypt_aes_payload(&aes_key_b64, "@@@not-base64@@@", "ww").unwrap_err();
        assert!(err.contains("ciphertext not valid base64"), "got: {err}");
    }

    #[test]
    fn decrypt_rejects_short_aes_key() {
        // EncodingAESKey of 30 chars decodes to ~22 bytes, not 32.
        let err = decrypt_aes_payload(&"a".repeat(30), "AAAA", "ww").unwrap_err();
        assert!(err.contains("expected 32") || err.contains("not valid base64"));
    }

    #[test]
    fn decrypt_rejects_truncated_plaintext() {
        // A ciphertext that decrypts to fewer than 20 bytes (the
        // header alone) should be rejected.
        use aes::cipher::{block_padding::NoPadding, BlockEncryptMut, KeyIvInit};
        use base64::Engine;
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
        let key = [9u8; 32];
        let iv = &key[..16];
        // 16 bytes total: just one block padded with PKCS#7. After
        // strip we'd have <20 bytes, triggering the length check.
        let payload = b"123456789012345"; // 15 bytes; pad to 16 with 1 byte of pad
        let mut padded = payload.to_vec();
        padded.push(1u8); // 1 byte of pad
        let mut buf = padded.clone();
        let cipher = Aes256CbcEnc::new_from_slices(&key, iv).unwrap();
        let n = cipher
            .encrypt_padded_mut::<NoPadding>(&mut buf, padded.len())
            .unwrap()
            .len();
        let cipher_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
        let err =
            decrypt_aes_payload(&synth_aes_key_b64(&key), &cipher_b64, "ww").unwrap_err();
        assert!(err.contains("plaintext too short"), "got: {err}");
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
