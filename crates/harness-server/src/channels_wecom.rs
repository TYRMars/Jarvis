//! WeCom group-robot outbound sender (M2 of the Channels work).
//!
//! This is the simplest realistic channel kind: a one-shot HTTPS POST
//! to a webhook URL. The robot is **outbound-only** — WeCom does not
//! deliver inbound messages to this URL (that would require a
//! self-built application + event subscription, which is M-future).
//!
//! The wire shape is documented at:
//! <https://developer.work.weixin.qq.com/document/path/91770>
//!
//! ```json
//! POST <webhook_url>
//! {
//!   "msgtype": "text",
//!   "text": { "content": "...", "mentioned_list": ["@all"] }
//! }
//! ```
//!
//! Response: `{"errcode": 0, "errmsg": "ok"}` on success; non-zero
//! `errcode` is a hard error we propagate up.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Send a plain-text message to the webhook URL embedded in
/// `resolved_config`. The caller must have run
/// [`harness_core::resolve_env_templates`] first so the URL is a
/// concrete `https://…` string.
///
/// Returns `Ok(())` on `errcode == 0`. All other paths return an
/// error explaining what went wrong (broken template, HTTP failure,
/// non-zero errcode).
pub async fn send_text(resolved_config: &Value, text: &str) -> Result<(), SendError> {
    let url = resolved_config
        .get("webhook_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(SendError::ConfigMissing("webhook_url"))?;
    if url.contains("${env:") {
        return Err(SendError::UnresolvedTemplate);
    }
    if !url.starts_with("https://") {
        return Err(SendError::InsecureUrl);
    }

    let mut text_payload = json!({ "content": text });
    if let Some(mentions) = resolved_config
        .get("default_mention")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
    {
        text_payload["mentioned_list"] = Value::Array(mentions.clone());
    }
    let body = json!({
        "msgtype": "text",
        "text": text_payload,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| SendError::Http(e.to_string()))?;

    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| SendError::Http(e.to_string()))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| SendError::Http(e.to_string()))?;
    if !status.is_success() {
        return Err(SendError::HttpStatus(status.as_u16(), raw));
    }
    let parsed: WeComReply = serde_json::from_str(&raw)
        .map_err(|e| SendError::ReplyParse(format!("{e}: {raw}")))?;
    if parsed.errcode != 0 {
        return Err(SendError::WeCom(parsed.errcode, parsed.errmsg));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct WeComReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("config missing required field: {0}")]
    ConfigMissing(&'static str),
    #[error("config contains an unresolved ${{env:...}} template — set the env var before sending")]
    UnresolvedTemplate,
    #[error("webhook_url must be https://")]
    InsecureUrl,
    #[error("HTTP transport: {0}")]
    Http(String),
    #[error("HTTP {0}: {1}")]
    HttpStatus(u16, String),
    #[error("WeCom errcode {0}: {1}")]
    WeCom(i64, String),
    #[error("response parse: {0}")]
    ReplyParse(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn send_rejects_missing_webhook_url() {
        let cfg = json!({});
        let err = send_text(&cfg, "hi").await.unwrap_err();
        assert!(matches!(err, SendError::ConfigMissing("webhook_url")));
    }

    #[tokio::test]
    async fn send_rejects_unresolved_template() {
        let cfg = json!({"webhook_url": "https://x?key=${env:NOT_SET_XYZ}"});
        std::env::remove_var("NOT_SET_XYZ");
        let err = send_text(&cfg, "hi").await.unwrap_err();
        assert!(matches!(err, SendError::UnresolvedTemplate));
    }

    #[tokio::test]
    async fn send_rejects_insecure_url() {
        let cfg = json!({"webhook_url": "http://insecure.example.com/hook"});
        let err = send_text(&cfg, "hi").await.unwrap_err();
        assert!(matches!(err, SendError::InsecureUrl));
    }
}
