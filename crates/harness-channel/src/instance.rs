//! Channel-instance value type + env-template resolver.
//!
//! A `ChannelInstance` is one user-configured outbound (or inbound)
//! connection to a messaging platform — e.g. "the prod-alerts WeCom
//! group robot", "my company's WeChat MP". One Jarvis deployment
//! typically carries several instances, each pinning a `kind`
//! (transport flavour) and an opaque `config` blob shaped by that
//! kind.
//!
//! Credentials in `config` may be literal strings or use the
//! `${env:VAR_NAME}` template syntax (mirrors the plugin manifest
//! convention from `harness-plugin`). The resolver runs at send-time
//! so rotating a webhook key is `export WECOM_KEY=… && (no restart
//! needed for the next message)`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// User-driven enabled/disabled/unconfigured state. Distinct from
/// "did the last send succeed" — that's surfaced via per-instance
/// telemetry instead. `Unconfigured` is set by handlers when the
/// validator detects required fields are missing (so the UI can show
/// a "继续配置" CTA without the user having to remember which fields
/// they skipped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub enum ChannelInstanceStatus {
    #[default]
    Enabled,
    Disabled,
    Unconfigured,
}

impl ChannelInstanceStatus {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Unconfigured => "unconfigured",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "enabled" => Some(Self::Enabled),
            "disabled" => Some(Self::Disabled),
            "unconfigured" => Some(Self::Unconfigured),
            _ => None,
        }
    }
}

/// One configured channel — e.g. a WeCom group robot, a WeChat MP
/// callback target, a Feishu bot. Instances are user-named (`display_name`)
/// because a deployment may host several of the same `kind` (multiple
/// WeCom groups = multiple `wecom_webhook` rows).
///
/// `config` is left as a `serde_json::Value` so each kind owns its own
/// schema without baking variant-specific fields into the trait
/// surface. The current kinds and their schemas live next to the
/// `kind`-specific senders in `harness-server`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub struct ChannelInstance {
    /// Stable UUID. Frontend keys list rows by this.
    pub id: String,
    /// Discriminator: "wecom_webhook" / "wechat_mp" / "feishu_bot" / …
    /// Validators in the server know which `config` shape to expect
    /// per kind; unknown kinds are rejected at the REST boundary.
    pub kind: String,
    /// User-set human-readable name (e.g. "prod-alerts"). The REST
    /// layer enforces non-empty + max 64 chars; the trait stays
    /// liberal so storage doesn't need to know.
    pub display_name: String,
    pub status: ChannelInstanceStatus,
    /// Kind-specific config payload. May embed `${env:NAME}` template
    /// strings — resolved at send-time, never at store-time, so a
    /// rotated env var takes effect immediately.
    #[ts(type = "Record<string, unknown>")]
    pub config: serde_json::Value,
    /// RFC-3339 timestamp set on insert.
    pub created_at: String,
    /// RFC-3339 timestamp bumped on every upsert.
    pub updated_at: String,
}

impl ChannelInstance {
    /// Build a fresh instance with a UUID id and now-stamped timestamps.
    /// Status defaults to `Unconfigured` so the caller has to opt into
    /// "go live" by toggling it after validation.
    pub fn new(
        kind: impl Into<String>,
        display_name: impl Into<String>,
        config: serde_json::Value,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            display_name: display_name.into(),
            status: ChannelInstanceStatus::Unconfigured,
            config,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to "now". Stores never mutate timestamps on
    /// the caller's behalf — same convention as
    /// [`crate::ChannelBinding::touch`].
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Resolve `${env:VAR_NAME}` template strings against the process env.
/// Used by `kind`-specific senders right before the outbound HTTP
/// call. Other shapes (literals, JSON nulls) pass through unchanged.
///
/// Unknown env vars resolve to `None` — the caller is expected to
/// treat that as "configuration broken" and surface the field name
/// to the operator. Keep the resolver pure (no I/O beyond env reads)
/// so it stays cheap to call inside hot paths.
///
/// Example:
/// ```ignore
/// let raw = serde_json::json!({"webhook_key": "${env:WECOM_KEY}"});
/// let resolved = resolve_env_templates(&raw);
/// // resolved["webhook_key"] is now the contents of $WECOM_KEY,
/// // or unchanged if the var isn't set.
/// ```
pub fn resolve_env_templates(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            serde_json::Value::String(resolve_env_template_string(s))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items.iter().map(resolve_env_templates).collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve_env_templates(v)))
                .collect(),
        ),
        // numbers / bools / null pass through.
        other => other.clone(),
    }
}

/// Substitute every `${env:VAR}` occurrence in `s`. Vars that aren't
/// set are left as the literal `${env:…}` placeholder so debug logs
/// don't silently elide misconfigurations — the channel sender treats
/// any remaining placeholder as a fatal "config incomplete" error.
fn resolve_env_template_string(s: &str) -> String {
    // Cheap path: short-circuit when no template markers present.
    if !s.contains("${env:") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"${env:") {
            // Find the matching '}'.
            if let Some(rel_end) = s[i + 6..].find('}') {
                let var_start = i + 6;
                let var_end = i + 6 + rel_end;
                let var_name = &s[var_start..var_end];
                match std::env::var(var_name) {
                    Ok(val) => out.push_str(&val),
                    // Leave the placeholder verbatim — the sender will
                    // refuse to dispatch and surface the missing var.
                    Err(_) => out.push_str(&s[i..=var_end]),
                }
                i = var_end + 1;
                continue;
            }
        }
        out.push(s[i..].chars().next().unwrap());
        i += s[i..].chars().next().unwrap().len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_env_templates_substitutes_string_values() {
        std::env::set_var("JARVIS_TEST_WECOM", "secret-key-abc");
        let input = json!({
            "webhook_url": "https://qyapi.weixin.qq.com/x?key=${env:JARVIS_TEST_WECOM}",
            "literal": "no template here",
        });
        let out = resolve_env_templates(&input);
        assert_eq!(
            out["webhook_url"].as_str().unwrap(),
            "https://qyapi.weixin.qq.com/x?key=secret-key-abc"
        );
        assert_eq!(out["literal"].as_str().unwrap(), "no template here");
        std::env::remove_var("JARVIS_TEST_WECOM");
    }

    #[test]
    fn resolve_env_templates_leaves_unknown_var_as_placeholder() {
        std::env::remove_var("JARVIS_TEST_MISSING");
        let input = json!("${env:JARVIS_TEST_MISSING}");
        let out = resolve_env_templates(&input);
        // Unchanged — caller is expected to treat as misconfigured.
        assert_eq!(out.as_str().unwrap(), "${env:JARVIS_TEST_MISSING}");
    }

    #[test]
    fn resolve_env_templates_recurses_into_nested_objects_and_arrays() {
        std::env::set_var("JARVIS_TEST_NEST", "Z");
        let input = json!({
            "outer": [
                {"inner": "x-${env:JARVIS_TEST_NEST}-y"},
                "${env:JARVIS_TEST_NEST}",
            ]
        });
        let out = resolve_env_templates(&input);
        assert_eq!(out["outer"][0]["inner"].as_str().unwrap(), "x-Z-y");
        assert_eq!(out["outer"][1].as_str().unwrap(), "Z");
        std::env::remove_var("JARVIS_TEST_NEST");
    }

    #[test]
    fn channel_instance_new_defaults_to_unconfigured() {
        let inst = ChannelInstance::new("wecom_webhook", "test", json!({}));
        assert_eq!(inst.status, ChannelInstanceStatus::Unconfigured);
        assert!(!inst.id.is_empty());
        assert_eq!(inst.created_at, inst.updated_at);
    }

    #[test]
    fn status_wire_round_trip() {
        for s in [
            ChannelInstanceStatus::Enabled,
            ChannelInstanceStatus::Disabled,
            ChannelInstanceStatus::Unconfigured,
        ] {
            assert_eq!(ChannelInstanceStatus::from_wire(s.as_wire()), Some(s));
        }
        assert_eq!(ChannelInstanceStatus::from_wire("nope"), None);
    }
}
