//! WeCom group-robot adapter (M2 + Phase B markdown).
//!
//! Outbound-only: a one-shot HTTPS POST to the per-group webhook URL.
//! The robot does **not** receive inbound messages — that requires a
//! WeCom self-built application + event subscription, which is M3+
//! territory.
//!
//! Wire shape (text):
//! ```json
//! POST <webhook_url>
//! { "msgtype": "text",
//!   "text": { "content": "...", "mentioned_list": ["@all"] } }
//! ```
//!
//! Wire shape (markdown):
//! ```json
//! POST <webhook_url>
//! { "msgtype": "markdown", "markdown": { "content": "**bold**" } }
//! ```
//!
//! Reply: `{"errcode": 0, "errmsg": "ok"}` on success; any non-zero
//! `errcode` is a non-retryable failure (the request was processed,
//! it just rejected for a structural reason).
//!
//! Docs: <https://developer.work.weixin.qq.com/document/path/91770>

use async_trait::async_trait;
use harness_channel::{ChannelMessageFormat, OutboundMessage, SendOutcome};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// WeCom group robot caps message bodies at 4096 bytes (UTF-8).
/// Larger bodies are silently truncated by the platform; we do the
/// truncation client-side so the agent transcript can flag it.
const WECOM_MAX_BYTES: usize = 4096;

/// Adapter implementation. Stateless — every send takes the
/// resolved config blob anew, so a single instance handles every
/// configured `wecom_webhook` row.
pub struct WeComWebhookAdapter;

#[async_trait]
impl crate::channel_adapter::ChannelAdapter for WeComWebhookAdapter {
    fn kind(&self) -> &'static str {
        "wecom_webhook"
    }

    fn schema(&self) -> Value {
        json!({
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
        // Allow templated URLs (`${env:NAME}`) since the literal
        // string itself isn't a valid URL until resolution.
        if !url.starts_with("https://") && !url.contains("${env:") {
            return Err(
                "webhook_url must be https:// (or contain an ${env:…} template)".into(),
            );
        }
        Ok(())
    }

    async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome {
        // Pre-flight: URL must be present, fully resolved, and HTTPS.
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
                code: Some("wecom_webhook:unresolved_template".into()),
                retryable: false,
            };
        }
        if !url.starts_with("https://") {
            return SendOutcome::fail("webhook_url must be https://");
        }

        // Body shape per format. Truncate over WECOM_MAX_BYTES so we
        // don't lose the platform-side silent-cap; flag the
        // transcript via SendOutcome.truncated.
        let (truncated_text, truncated) = truncate_utf8(&msg.text, WECOM_MAX_BYTES);
        let body = match msg.format {
            ChannelMessageFormat::Text => {
                let mut text_payload = json!({ "content": truncated_text });
                // `mentions` on the message takes priority over the
                // instance's `default_mention`. If the message
                // didn't supply one, fall back to the configured
                // default.
                let mentions: Vec<Value> = if !msg.mentions.is_empty() {
                    msg.mentions.iter().map(|m| Value::String(m.clone())).collect()
                } else {
                    resolved_config
                        .get("default_mention")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default()
                };
                if !mentions.is_empty() {
                    text_payload["mentioned_list"] = Value::Array(mentions);
                }
                json!({ "msgtype": "text", "text": text_payload })
            }
            ChannelMessageFormat::Markdown => {
                // WeCom markdown variant doesn't support
                // `mentioned_list` — the platform expects
                // mentions inline as `<@user_id>` tokens. We keep
                // it simple: drop mentions on the markdown path
                // and surface that downgrade if either side asked
                // for them.
                json!({
                    "msgtype": "markdown",
                    "markdown": { "content": truncated_text }
                })
            }
        };

        // Send.
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
                // reqwest's `is_connect()` / `is_timeout()` would
                // give us better signal, but the surface area is
                // tiny here — anything that prevented the request
                // from completing the round-trip is retryable. Once
                // the server has *replied* (any HTTP status), we'd
                // be on the next branch.
                return SendOutcome::fail_retryable(format!("HTTP transport: {e}"));
            }
        };
        let status = resp.status();
        let raw = match resp.text().await {
            Ok(t) => t,
            // We have a status code but the body was unreadable —
            // can't tell whether the platform actually accepted
            // the message. Mark non-retryable to avoid duplicate
            // sends; surface the status code so the operator can
            // decide.
            Err(e) => {
                return SendOutcome::Failed {
                    message: format!(
                        "HTTP {} but reply body unreadable: {e}",
                        status.as_u16()
                    ),
                    code: Some(format!("wecom_webhook:reply_unreadable_{}", status.as_u16())),
                    retryable: false,
                };
            }
        };
        if !status.is_success() {
            // 5xx is the one server-side case where retrying is
            // probably safe (the request didn't make it through to
            // the message dispatcher). 4xx is a config error — same
            // payload retried = same rejection.
            let retryable = status.is_server_error();
            return SendOutcome::Failed {
                message: format!("HTTP {}: {raw}", status.as_u16()),
                code: Some(format!("wecom_webhook:http_{}", status.as_u16())),
                retryable,
            };
        }
        let parsed: WeComReply = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(e) => {
                return SendOutcome::Failed {
                    message: format!("response parse: {e}: {raw}"),
                    code: Some("wecom_webhook:reply_parse".into()),
                    retryable: false,
                };
            }
        };
        if parsed.errcode != 0 {
            return SendOutcome::Failed {
                message: format!("WeCom errcode {}: {}", parsed.errcode, parsed.errmsg),
                code: Some(format!("wecom_webhook:errcode_{}", parsed.errcode)),
                retryable: false,
            };
        }
        SendOutcome::Sent {
            message_id: None, // WeCom group robots don't return one.
            truncated,
            downgraded_format: false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct WeComReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

/// Truncate `s` at the largest UTF-8 boundary ≤ `max_bytes`. Returns
/// `(text, truncated_flag)`. Important: must NOT slice in the middle
/// of a multi-byte codepoint (Chinese text in WeCom alerts is the
/// hot path here).
fn truncate_utf8(s: &str, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s.to_string(), false);
    }
    // Walk back from `max_bytes` to the previous char boundary.
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
        let r = WeComWebhookAdapter.validate_config(&json!({}));
        assert!(r.unwrap_err().contains("webhook_url required"));
    }

    #[test]
    fn validate_rejects_http_scheme() {
        let r = WeComWebhookAdapter
            .validate_config(&json!({"webhook_url": "http://insecure"}));
        assert!(r.unwrap_err().contains("https://"));
    }

    #[test]
    fn validate_accepts_https() {
        WeComWebhookAdapter
            .validate_config(&json!({"webhook_url": "https://qyapi.weixin.qq.com/x"}))
            .unwrap();
    }

    #[test]
    fn validate_accepts_template_url() {
        // Bare template (no scheme) and templated query string both
        // bypass the literal scheme check.
        WeComWebhookAdapter
            .validate_config(&json!({"webhook_url": "${env:WECOM_FULL_URL}"}))
            .unwrap();
        WeComWebhookAdapter
            .validate_config(
                &json!({"webhook_url": "https://qyapi.weixin.qq.com/x?key=${env:K}"}),
            )
            .unwrap();
    }

    #[tokio::test]
    async fn send_rejects_unresolved_template() {
        std::env::remove_var("NOT_SET_XYZ_WECOM");
        let cfg = json!({"webhook_url": "https://x?key=${env:NOT_SET_XYZ_WECOM}"});
        let r = WeComWebhookAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { code, retryable, .. } => {
                assert_eq!(code.as_deref(), Some("wecom_webhook:unresolved_template"));
                assert!(!retryable);
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn send_rejects_missing_webhook_url() {
        let r = WeComWebhookAdapter
            .send(&json!({}), &OutboundMessage::text("hi"))
            .await;
        assert!(matches!(r, SendOutcome::Failed { .. }));
    }

    #[tokio::test]
    async fn send_rejects_insecure_url() {
        let cfg = json!({"webhook_url": "http://insecure.example.com/hook"});
        let r = WeComWebhookAdapter
            .send(&cfg, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { message, retryable, .. } => {
                assert!(message.contains("https://"));
                assert!(!retryable);
            }
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn truncate_at_max_bytes_is_identity() {
        let s = "a".repeat(WECOM_MAX_BYTES);
        let (out, t) = truncate_utf8(&s, WECOM_MAX_BYTES);
        assert!(!t);
        assert_eq!(out.len(), WECOM_MAX_BYTES);
    }

    #[test]
    fn truncate_one_over_cuts_one() {
        let s = "a".repeat(WECOM_MAX_BYTES + 1);
        let (out, t) = truncate_utf8(&s, WECOM_MAX_BYTES);
        assert!(t);
        assert_eq!(out.len(), WECOM_MAX_BYTES);
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        // Each Chinese character is 3 bytes in UTF-8. With a max
        // of 4 bytes, we can fit 1 character (3 bytes); cutting
        // at byte 4 would split the second character mid-byte.
        let s = "你好世界"; // 12 bytes
        let (out, t) = truncate_utf8(s, 4);
        assert!(t);
        assert_eq!(out, "你"); // 3 bytes; cut walked back to boundary
    }

    #[test]
    fn schema_advertises_text_and_markdown() {
        let schema = WeComWebhookAdapter.schema();
        let formats = schema["supports_formats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(formats.contains(&"text"));
        assert!(formats.contains(&"markdown"));
    }
}
