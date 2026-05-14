//! DingTalk (钉钉) custom-robot adapter.
//!
//! Outbound-only webhook — same family as WeCom and Feishu, but
//! with several knobs different enough to be worth calling out:
//!
//! 1. **Sign goes in the query string, not the body.** When a
//!    secret is configured, send appends `&timestamp=…&sign=…` to
//!    the webhook URL. Feishu sticks the same fields *inside* the
//!    JSON body; the platforms made gratuitously incompatible
//!    choices.
//! 2. **Sign formula is *inverted* from Feishu.** DingTalk:
//!    `base64( HMAC-SHA256(key=<secret>, msg=<timestamp>\n<secret>) )`,
//!    then **URL-encode** the base64 (since it lands in a query
//!    string and `+` / `=` need escaping). Feishu treats
//!    `<timestamp>\n<secret>` as the *key* and signs an empty
//!    message — neither side respects the conventional "secret =
//!    HMAC key" intuition consistently.
//! 3. **Mentions are a structured object**, not inline:
//!    `"at": { "atMobiles": [...], "atUserIds": [...], "isAtAll": bool }`.
//!    Most operators use phones; a few use the per-tenant userid.
//!    `mention="@all"` from the agent translates to
//!    `isAtAll: true`.
//! 4. **Markdown requires a title.** The `markdown` msgtype rejects
//!    payloads without one. We synthesise a leading-line title
//!    from the body (everything up to the first `\n` or the first
//!    32 chars, whichever comes first).
//! 5. **Two ways to authenticate.** DingTalk accepts either a sign
//!    (preferred) OR a "keyword" enforced by the server side
//!    (every message must contain it). We only support the sign
//!    path; keyword-only bots send unsigned, which is the
//!    operator's choice and works without us — they just leave
//!    `secret` empty.
//!
//! Wire shape (text, signed):
//! ```text
//! POST <webhook_url>?timestamp=…&sign=…
//! { "msgtype": "text",
//!   "text": { "content": "..." },
//!   "at": { "isAtAll": false } }
//! ```
//!
//! Reply: `{"errcode": 0, "errmsg": "ok"}` (same shape as WeCom)
//!
//! Docs: <https://open.dingtalk.com/document/orgapp/custom-robot-access>

use async_trait::async_trait;
use harness_channel::{ChannelMessageFormat, OutboundMessage, SendOutcome};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// DingTalk caps custom-robot message bodies at ~20 KB total
/// payload; the practical limit for body text is ~4096 chars per
/// the docs. Mirror WeCom's conservative 4096-byte cap; the
/// alternative is sending a 4097-byte body and getting silently
/// truncated platform-side.
const DINGTALK_MAX_BYTES: usize = 4096;

pub struct DingTalkBotAdapter;

#[async_trait]
impl crate::channel_adapter::ChannelAdapter for DingTalkBotAdapter {
    fn kind(&self) -> &'static str {
        "dingtalk_bot"
    }

    fn schema(&self) -> Value {
        json!({
            "kind": "dingtalk_bot",
            "label": "钉钉自定义机器人",
            "label_en": "DingTalk custom robot",
            "direction": "outbound",
            "description": "Outbound-only webhook to a DingTalk custom robot. Optional signing secret — when set, every send appends a SHA-256 sign to the query string. Without a secret, the bot must be configured with a keyword on the DingTalk side.",
            "schema": {
                "type": "object",
                "required": ["webhook_url"],
                "properties": {
                    "webhook_url": {
                        "type": "string",
                        "title": "Webhook URL",
                        "description": "Full webhook URL from the DingTalk robot settings (includes the access_token query param). Supports `${env:NAME}` templating.",
                        "example": "https://oapi.dingtalk.com/robot/send?access_token=${env:DINGTALK_BOT_TOKEN}"
                    },
                    "secret": {
                        "type": "string",
                        "title": "签名密钥 (optional)",
                        "description": "When the bot has 加签 enabled in DingTalk, paste the secret here. Supports `${env:NAME}` templating. Leave empty for keyword-only bots."
                    }
                }
            },
            "supports_formats": ["text", "markdown"],
            "test_supported": true,
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), String> {
        let url = config
            .get("webhook_url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "webhook_url required".to_string())?;
        if !url.starts_with("https://") && !url.contains("${env:") {
            return Err(
                "webhook_url must be https:// (or contain an ${env:…} template)".into(),
            );
        }
        Ok(())
    }

    async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome {
        let raw_url = match resolved_config
            .get("webhook_url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(u) => u,
            None => return SendOutcome::fail("webhook_url missing from config"),
        };
        if raw_url.contains("${env:") {
            return SendOutcome::Failed {
                message:
                    "config contains an unresolved ${env:...} template — set the env var before retrying"
                        .into(),
                code: Some("dingtalk_bot:unresolved_template".into()),
                retryable: false,
            };
        }
        if !raw_url.starts_with("https://") {
            return SendOutcome::fail("webhook_url must be https://");
        }

        // Resolve sign (optional) — appended to URL as query params.
        let url = match resolved_config
            .get("secret")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => raw_url.to_string(),
            Some(secret) => {
                if secret.contains("${env:") {
                    return SendOutcome::Failed {
                        message:
                            "secret contains an unresolved ${env:...} template — set the env var before retrying"
                                .into(),
                        code: Some("dingtalk_bot:unresolved_template".into()),
                        retryable: false,
                    };
                }
                let timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
                    // DingTalk timestamps are milliseconds — same
                    // convention as the rest of their open API.
                    Ok(d) => d.as_millis().to_string(),
                    Err(_) => "0".to_string(),
                };
                let sign = match dingtalk_sign(&timestamp, secret) {
                    Ok(s) => s,
                    Err(e) => return SendOutcome::fail(format!("signing failed: {e}")),
                };
                let separator = if raw_url.contains('?') { "&" } else { "?" };
                format!(
                    "{raw_url}{separator}timestamp={timestamp}&sign={}",
                    url_encode(&sign)
                )
            }
        };

        // Build the JSON body per format.
        let (body, truncated) = build_body(msg);

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return SendOutcome::fail_retryable(format!("HTTP client init: {e}"))
            }
        };
        let resp = match client.post(&url).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                return SendOutcome::fail_retryable(format!("HTTP transport: {e}"));
            }
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
                    code: Some(format!(
                        "dingtalk_bot:reply_unreadable_{}",
                        status.as_u16()
                    )),
                    retryable: false,
                };
            }
        };
        if !status.is_success() {
            let retryable = status.is_server_error();
            return SendOutcome::Failed {
                message: format!("HTTP {}: {raw}", status.as_u16()),
                code: Some(format!("dingtalk_bot:http_{}", status.as_u16())),
                retryable,
            };
        }
        let parsed: DingTalkReply = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(e) => {
                return SendOutcome::Failed {
                    message: format!("response parse: {e}: {raw}"),
                    code: Some("dingtalk_bot:reply_parse".into()),
                    retryable: false,
                };
            }
        };
        if parsed.errcode != 0 {
            return SendOutcome::Failed {
                message: format!("DingTalk errcode {}: {}", parsed.errcode, parsed.errmsg),
                code: Some(format!("dingtalk_bot:errcode_{}", parsed.errcode)),
                retryable: false,
            };
        }
        SendOutcome::Sent {
            message_id: None,
            truncated,
            downgraded_format: false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct DingTalkReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

/// Build the JSON body + the truncation flag. Pulled out so the
/// per-format branches stay readable + tests can call directly
/// without an HTTP roundtrip.
fn build_body(msg: &OutboundMessage) -> (Value, bool) {
    let (truncated_text, truncated) = truncate_utf8(&msg.text, DINGTALK_MAX_BYTES);
    let at = build_at_block(&msg.mentions);
    match msg.format {
        ChannelMessageFormat::Text => (
            json!({
                "msgtype": "text",
                "text": { "content": truncated_text },
                "at": at,
            }),
            truncated,
        ),
        ChannelMessageFormat::Markdown => {
            // DingTalk's markdown msgtype mandates a title field.
            // Synthesise one from the leading line so the operator
            // doesn't have to think about it; cap at 32 chars so a
            // long single-line markdown body doesn't produce a
            // titlebar that wraps awkwardly in the DingTalk client.
            let title = derive_title(&truncated_text, 32);
            (
                json!({
                    "msgtype": "markdown",
                    "markdown": { "title": title, "text": truncated_text },
                    "at": at,
                }),
                truncated,
            )
        }
    }
}

/// Construct the `at` block. `@all` (or the bare `all` sentinel)
/// flips `isAtAll`; phone-shaped strings (digits + optional `+`)
/// land in `atMobiles`; everything else is treated as a per-tenant
/// userid and lands in `atUserIds`. The split is best-effort —
/// operators who hand-craft userid strings that look like phones
/// can override by routing through the platform's userid field
/// directly, but that's outside the agent tool's scope.
fn build_at_block(mentions: &[String]) -> Value {
    let mut at_all = false;
    let mut mobiles: Vec<&str> = Vec::new();
    let mut userids: Vec<&str> = Vec::new();
    for m in mentions {
        let trimmed = m.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "@all" || trimmed == "all" {
            at_all = true;
        } else if looks_like_phone(trimmed) {
            mobiles.push(trimmed);
        } else {
            userids.push(trimmed);
        }
    }
    json!({
        "atMobiles": mobiles,
        "atUserIds": userids,
        "isAtAll": at_all,
    })
}

/// Cheap heuristic — strip a leading `+`, then digit-only check.
/// 8+ digits = treat as a phone (international-format minimum).
fn looks_like_phone(s: &str) -> bool {
    let s = s.strip_prefix('+').unwrap_or(s);
    s.len() >= 8 && s.chars().all(|c| c.is_ascii_digit())
}

/// First non-empty line of the body, capped at `max_chars`. Used as
/// the markdown title.
fn derive_title(body: &str, max_chars: usize) -> String {
    let first_line = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    if first_line.chars().count() <= max_chars {
        return first_line.trim().to_string();
    }
    first_line.chars().take(max_chars).collect::<String>().trim().to_string()
}

/// DingTalk signing: `base64( HMAC-SHA256( key=<secret>,
/// message=<timestamp>\n<secret> ) )`. Secret is the HMAC key,
/// timestamp+secret is the signed payload — opposite of Feishu's
/// arrangement, captured here so the test asserts the right thing.
fn dingtalk_sign(timestamp_ms: &str, secret: &str) -> Result<String, String> {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let payload = format!("{timestamp_ms}\n{secret}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("hmac init: {e}"))?;
    mac.update(payload.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Minimal URL component encoder — DingTalk's sign value contains
/// `+` / `/` / `=` characters from base64, all of which need to be
/// percent-encoded when placed in a query string. We only encode
/// the "RFC 3986 unreserved + delimiters" gap; nothing else in the
/// sign payload should appear.
fn url_encode(s: &str) -> String {
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

/// UTF-8 safe truncation. Same shape as the WeCom / Feishu helpers;
/// kept inline rather than extracted because each adapter's max
/// byte cap is platform-specific and shouldn't lock-step.
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

    #[test]
    fn validate_rejects_missing_url() {
        let r = DingTalkBotAdapter.validate_config(&json!({}));
        assert!(r.unwrap_err().contains("webhook_url required"));
    }

    #[test]
    fn validate_rejects_http_scheme() {
        let r = DingTalkBotAdapter
            .validate_config(&json!({"webhook_url": "http://insecure"}));
        assert!(r.unwrap_err().contains("https://"));
    }

    #[test]
    fn validate_accepts_https() {
        DingTalkBotAdapter
            .validate_config(&json!({"webhook_url": "https://oapi.dingtalk.com/robot/send"}))
            .unwrap();
    }

    #[test]
    fn validate_accepts_template_url() {
        DingTalkBotAdapter
            .validate_config(&json!({"webhook_url": "${env:DINGTALK_WEBHOOK}"}))
            .unwrap();
    }

    #[tokio::test]
    async fn send_rejects_unresolved_url_template() {
        std::env::remove_var("NOT_SET_DINGTALK");
        let cfg = json!({"webhook_url": "https://x?token=${env:NOT_SET_DINGTALK}"});
        let r = DingTalkBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, .. } => {
                assert_eq!(code.as_deref(), Some("dingtalk_bot:unresolved_template"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_unresolved_secret_template() {
        std::env::remove_var("NOT_SET_DT_SECRET");
        let cfg = json!({
            "webhook_url": "https://oapi.dingtalk.com/robot/send",
            "secret": "${env:NOT_SET_DT_SECRET}"
        });
        let r = DingTalkBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, .. } => {
                assert_eq!(code.as_deref(), Some("dingtalk_bot:unresolved_template"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_insecure_url() {
        let cfg = json!({"webhook_url": "http://insecure.example.com/hook"});
        let r = DingTalkBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        assert!(matches!(r, SendOutcome::Failed { .. }));
    }

    #[test]
    fn schema_advertises_text_and_markdown() {
        let schema = DingTalkBotAdapter.schema();
        let formats = schema["supports_formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(formats.contains(&"text"));
        assert!(formats.contains(&"markdown"));
    }

    #[test]
    fn signing_uses_secret_as_key_and_ts_newline_secret_as_message() {
        // Different inputs → different outputs (sanity, also catches
        // a copy-paste bug where someone swaps the key/message
        // arrangement to Feishu's).
        let s1 = dingtalk_sign("1620000000000", "ECt").unwrap();
        let s2 = dingtalk_sign("1620000000000", "ECt").unwrap();
        assert_eq!(s1, s2, "deterministic");
        let s3 = dingtalk_sign("1620000000001", "ECt").unwrap();
        assert_ne!(s1, s3);
        let s4 = dingtalk_sign("1620000000000", "OTHER").unwrap();
        assert_ne!(s1, s4);

        // Critically: the sign should be DIFFERENT from Feishu's
        // for the same (timestamp, secret). Both are HMAC-SHA256
        // base64'd, but the key/message swap produces a different
        // digest. If this assertion ever fires, someone factored
        // out a shared signer that quietly took the wrong shape.
        let feishu_style_for_compare = {
            use base64::Engine;
            use hmac::{Hmac, Mac};
            use sha2::Sha256;
            let key = "1620000000000\nECt";
            let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
            mac.update(b"");
            base64::engine::general_purpose::STANDARD
                .encode(mac.finalize().into_bytes())
        };
        assert_ne!(
            s1, feishu_style_for_compare,
            "DingTalk sign collided with Feishu sign — formula likely swapped"
        );
    }

    #[test]
    fn url_encodes_base64_special_chars() {
        // The three base64 chars that must escape in a URL.
        assert_eq!(url_encode("a+b"), "a%2Bb");
        assert_eq!(url_encode("a/b"), "a%2Fb");
        assert_eq!(url_encode("a=b"), "a%3Db");
        // Unreserved chars survive intact.
        assert_eq!(url_encode("ABC123-_.~"), "ABC123-_.~");
    }

    #[test]
    fn at_block_routes_phones_userids_and_at_all() {
        let at = build_at_block(&[
            "13800138000".into(),
            "+8613900139000".into(),
            "manager_user_id_xyz".into(),
            "@all".into(),
        ]);
        assert_eq!(at["isAtAll"], true);
        let mobiles: Vec<&str> = at["atMobiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(mobiles.contains(&"13800138000"));
        assert!(mobiles.contains(&"+8613900139000"));
        let userids: Vec<&str> = at["atUserIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(userids, vec!["manager_user_id_xyz"]);
    }

    #[test]
    fn at_block_empty_when_no_mentions() {
        let at = build_at_block(&[]);
        assert_eq!(at["isAtAll"], false);
        assert!(at["atMobiles"].as_array().unwrap().is_empty());
        assert!(at["atUserIds"].as_array().unwrap().is_empty());
    }

    #[test]
    fn looks_like_phone_basic() {
        assert!(looks_like_phone("13800138000"));
        assert!(looks_like_phone("+8613800138000"));
        assert!(!looks_like_phone("12345")); // too short
        assert!(!looks_like_phone("user_id_42"));
        assert!(!looks_like_phone("13a00138000"));
    }

    #[test]
    fn derive_title_uses_first_line_then_caps() {
        assert_eq!(derive_title("hello\nworld", 32), "hello");
        assert_eq!(derive_title("only one line", 32), "only one line");
        // Long single line → truncated at char count.
        assert_eq!(derive_title(&"x".repeat(100), 10), "x".repeat(10));
    }

    #[test]
    fn build_body_text_format() {
        let msg = OutboundMessage::text("hi");
        let (body, truncated) = build_body(&msg);
        assert!(!truncated);
        assert_eq!(body["msgtype"], "text");
        assert_eq!(body["text"]["content"], "hi");
        assert_eq!(body["at"]["isAtAll"], false);
    }

    #[test]
    fn build_body_markdown_synthesises_title_from_body() {
        let msg = OutboundMessage::text("# Heading\nlonger body line")
            .with_format(ChannelMessageFormat::Markdown);
        let (body, _) = build_body(&msg);
        assert_eq!(body["msgtype"], "markdown");
        // Title is the first non-empty line.
        assert_eq!(body["markdown"]["title"], "# Heading");
        assert_eq!(body["markdown"]["text"], "# Heading\nlonger body line");
    }

    #[test]
    fn build_body_truncates_text_over_cap() {
        let big = "x".repeat(DINGTALK_MAX_BYTES + 10);
        let msg = OutboundMessage::text(big);
        let (body, truncated) = build_body(&msg);
        assert!(truncated);
        assert_eq!(
            body["text"]["content"]
                .as_str()
                .unwrap()
                .len(),
            DINGTALK_MAX_BYTES
        );
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        let s = "你好世界";
        let (out, t) = truncate_utf8(s, 4);
        assert!(t);
        assert_eq!(out, "你");
    }
}
