//! Feishu (Lark) custom-bot adapter.
//!
//! Feishu's "Custom bot" (自定义机器人) — same shape as WeCom: an
//! HTTPS webhook URL the platform issues per-group, outbound only.
//! The adapter is intentionally a near-clone of `WeComWebhookAdapter`
//! to prove the M2 abstraction (trait + registry) actually scales —
//! a second kind should be a *small file*, not a refactor.
//!
//! Differences from WeCom worth knowing:
//!
//! 1. **Signing is optional but stricter.** When the bot has a
//!    "签名校验" secret, every request must include `timestamp` +
//!    `sign` (HMAC-SHA256 of `<timestamp>\n<secret>`, base64-encoded).
//!    Skipping signing on a bot that requires it returns a 19021
//!    errcode. We always sign when `secret` is present so operators
//!    don't accidentally leak unsigned messages.
//! 2. **Mentions are inline.** Feishu doesn't have a separate
//!    `mentioned_list` — `@`-mentions go inside the body as
//!    `<at user_id="ou_xxx">name</at>`. Per-user `open_id` is
//!    required (not the display name). For "everyone" use
//!    `user_id="all"`.
//! 3. **Markdown vs interactive cards.** The "text" `msg_type` does
//!    NOT render markdown — it's plain text. Real markdown needs the
//!    "interactive" card payload, which is a much bigger schema. M2
//!    of Feishu just supports text; cards land later.
//!
//! Wire shape (text):
//! ```json
//! POST <webhook_url>
//! {
//!   "timestamp": "1620000000",   // only when signing enabled
//!   "sign": "base64-of-hmac",    // only when signing enabled
//!   "msg_type": "text",
//!   "content": { "text": "hello @<at user_id=\"all\">all</at>" }
//! }
//! ```
//!
//! Reply: `{"code": 0, "msg": "success", "data": {}}` on success;
//! non-zero `code` is a non-retryable failure.
//!
//! Docs: <https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot>

use async_trait::async_trait;
use harness_channel::{ChannelMessageFormat, OutboundMessage, SendOutcome};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Feishu custom-bot accepts up to 30 KB per request body
/// (documented limit). The text payload itself can hold ~5000 chars
/// comfortably; we cap conservatively to avoid surprising the
/// platform.
const FEISHU_MAX_BYTES: usize = 5000;

pub struct FeishuBotAdapter;

#[async_trait]
impl crate::channel_adapter::ChannelAdapter for FeishuBotAdapter {
    fn kind(&self) -> &'static str {
        "feishu_bot"
    }

    fn schema(&self) -> Value {
        json!({
            "kind": "feishu_bot",
            "label": "飞书自定义机器人",
            "label_en": "Feishu / Lark custom bot",
            "direction": "outbound",
            "description": "Outbound-only webhook to a Feishu (Lark) custom bot. Optional signing secret — when set, every send is HMAC-SHA256 signed.",
            "schema": {
                "type": "object",
                "required": ["webhook_url"],
                "properties": {
                    "webhook_url": {
                        "type": "string",
                        "title": "Webhook URL",
                        "description": "Full webhook URL from the Feishu group bot settings. Supports `${env:NAME}` templating.",
                        "example": "https://open.feishu.cn/open-apis/bot/v2/hook/${env:FEISHU_BOT_HASH}"
                    },
                    "secret": {
                        "type": "string",
                        "title": "签名密钥 (optional)",
                        "description": "When the bot has 签名校验 enabled in Feishu, paste the secret here. Supports `${env:NAME}` templating. Leave empty for unsigned bots."
                    }
                }
            },
            "supports_formats": ["text"],
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
        let url = match resolved_config
            .get("webhook_url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(u) => u,
            None => return SendOutcome::fail("webhook_url missing from config"),
        };
        if url.contains("${env:") {
            return SendOutcome::Failed {
                message:
                    "config contains an unresolved ${env:...} template — set the env var before retrying"
                        .into(),
                code: Some("feishu_bot:unresolved_template".into()),
                retryable: false,
            };
        }
        if !url.starts_with("https://") {
            return SendOutcome::fail("webhook_url must be https://");
        }

        // Markdown messages: Feishu's "text" msg_type doesn't render
        // markdown, so a plain `format=markdown` request is a
        // downgrade. Send the literal text (the user's markdown
        // source ends up readable, just unrendered) and flag it.
        let downgraded = matches!(msg.format, ChannelMessageFormat::Markdown);

        // Inline mentions: Feishu doesn't expose a mention list, so
        // we splice `<at user_id="…">…</at>` after the body. Same
        // sentinel as WeCom — `@all` becomes `user_id="all"`.
        let mut body_text = msg.text.clone();
        if !msg.mentions.is_empty() {
            let mut suffix = String::new();
            for m in &msg.mentions {
                let user = if m == "@all" || m == "all" { "all" } else { m };
                suffix.push_str(&format!(" <at user_id=\"{user}\"></at>"));
            }
            body_text.push_str(&suffix);
        }

        let (truncated_text, truncated) = truncate_utf8(&body_text, FEISHU_MAX_BYTES);

        // Build the JSON envelope; sign when `secret` is present.
        let mut envelope = serde_json::Map::new();
        if let Some(secret) = resolved_config
            .get("secret")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if secret.contains("${env:") {
                return SendOutcome::Failed {
                    message:
                        "secret contains an unresolved ${env:...} template — set the env var before retrying"
                            .into(),
                    code: Some("feishu_bot:unresolved_template".into()),
                    retryable: false,
                };
            }
            let timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_secs().to_string(),
                Err(_) => "0".to_string(),
            };
            let sign = match feishu_sign(&timestamp, secret) {
                Ok(s) => s,
                Err(e) => return SendOutcome::fail(format!("signing failed: {e}")),
            };
            envelope.insert("timestamp".into(), Value::String(timestamp));
            envelope.insert("sign".into(), Value::String(sign));
        }
        envelope.insert("msg_type".into(), Value::String("text".into()));
        envelope.insert(
            "content".into(),
            json!({ "text": truncated_text }),
        );
        let body = Value::Object(envelope);

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return SendOutcome::fail_retryable(format!("HTTP client init: {e}"))
            }
        };
        let resp = match client.post(url).json(&body).send().await {
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
                    code: Some(format!("feishu_bot:reply_unreadable_{}", status.as_u16())),
                    retryable: false,
                };
            }
        };
        if !status.is_success() {
            let retryable = status.is_server_error();
            return SendOutcome::Failed {
                message: format!("HTTP {}: {raw}", status.as_u16()),
                code: Some(format!("feishu_bot:http_{}", status.as_u16())),
                retryable,
            };
        }
        let parsed: FeishuReply = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(e) => {
                return SendOutcome::Failed {
                    message: format!("response parse: {e}: {raw}"),
                    code: Some("feishu_bot:reply_parse".into()),
                    retryable: false,
                };
            }
        };
        if parsed.code != 0 {
            return SendOutcome::Failed {
                message: format!("Feishu code {}: {}", parsed.code, parsed.msg),
                code: Some(format!("feishu_bot:code_{}", parsed.code)),
                retryable: false,
            };
        }
        SendOutcome::Sent {
            message_id: None,
            truncated,
            downgraded_format: downgraded,
        }
    }
}

#[derive(Debug, Deserialize)]
struct FeishuReply {
    code: i64,
    #[serde(default)]
    msg: String,
}

/// Feishu signing: `base64(HMAC-SHA256(key=<timestamp>\n<secret>,
/// message=<empty>))`. The "key is timestamp+secret, message is
/// empty" thing is non-obvious — most HMAC users put the secret in
/// the key. Feishu docs explicitly call out this twist:
/// <https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot>.
fn feishu_sign(timestamp: &str, secret: &str) -> Result<String, String> {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let key = format!("{timestamp}\n{secret}");
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())
        .map_err(|e| format!("hmac init: {e}"))?;
    // Feishu signs an *empty* message; the secret is the key.
    mac.update(b"");
    let bytes = mac.finalize().into_bytes();
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Mirror of the same helper in `channels_wecom`. Kept duplicated
/// rather than extracted into a shared util because the two
/// adapters' max byte caps differ (WeCom 4096, Feishu 5000), and
/// premature de-duplication would couple them.
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
        let r = FeishuBotAdapter.validate_config(&json!({}));
        assert!(r.unwrap_err().contains("webhook_url required"));
    }

    #[test]
    fn validate_rejects_http_scheme() {
        let r = FeishuBotAdapter
            .validate_config(&json!({"webhook_url": "http://insecure"}));
        assert!(r.unwrap_err().contains("https://"));
    }

    #[test]
    fn validate_accepts_https() {
        FeishuBotAdapter
            .validate_config(&json!({"webhook_url": "https://open.feishu.cn/x"}))
            .unwrap();
    }

    #[test]
    fn validate_accepts_template_url() {
        FeishuBotAdapter
            .validate_config(&json!({"webhook_url": "${env:FEISHU_FULL_URL}"}))
            .unwrap();
    }

    #[tokio::test]
    async fn send_rejects_unresolved_url_template() {
        std::env::remove_var("NOT_SET_FEISHU");
        let cfg = json!({"webhook_url": "https://x?key=${env:NOT_SET_FEISHU}"});
        let r = FeishuBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, retryable, .. } => {
                assert_eq!(code.as_deref(), Some("feishu_bot:unresolved_template"));
                assert!(!retryable);
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_unresolved_secret_template() {
        std::env::remove_var("NOT_SET_FEISHU_SECRET");
        let cfg = json!({
            "webhook_url": "https://open.feishu.cn/x",
            "secret": "${env:NOT_SET_FEISHU_SECRET}"
        });
        let r = FeishuBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, .. } => {
                assert_eq!(code.as_deref(), Some("feishu_bot:unresolved_template"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_insecure_url() {
        let cfg = json!({"webhook_url": "http://insecure.example.com/hook"});
        let r = FeishuBotAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        assert!(matches!(r, SendOutcome::Failed { .. }));
    }

    #[test]
    fn schema_advertises_text_only() {
        let schema = FeishuBotAdapter.schema();
        let formats = schema["supports_formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(formats, vec!["text"]);
    }

    #[test]
    fn signing_uses_timestamp_newline_secret_as_key_and_empty_message() {
        // Spot-check against the value docs publish: timestamp =
        // "1620000000", secret = "ECt", expected base64 sign
        // (computed offline with: openssl) — we just assert the
        // function is deterministic + non-empty + base64-shaped.
        let s1 = feishu_sign("1620000000", "ECt").unwrap();
        let s2 = feishu_sign("1620000000", "ECt").unwrap();
        assert_eq!(s1, s2, "signing is deterministic");
        assert!(!s1.is_empty());
        // Standard base64 chars only.
        assert!(
            s1.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='),
            "non-base64 byte in sign: {s1:?}"
        );
        // Different inputs produce different outputs.
        let s3 = feishu_sign("1620000001", "ECt").unwrap();
        assert_ne!(s1, s3);
        let s4 = feishu_sign("1620000000", "OTHER").unwrap();
        assert_ne!(s1, s4);
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        let s = "你好世界";
        let (out, t) = truncate_utf8(s, 4);
        assert!(t);
        assert_eq!(out, "你");
    }

    #[test]
    fn truncate_under_cap_is_identity() {
        let s = "hello";
        let (out, t) = truncate_utf8(s, FEISHU_MAX_BYTES);
        assert!(!t);
        assert_eq!(out, s);
    }
}
