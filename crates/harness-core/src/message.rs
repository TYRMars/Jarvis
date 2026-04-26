use serde::{Deserialize, Serialize};

/// One turn in a conversation. Mirrors the OpenAI chat-completions shape so
/// providers can map back and forth without losing information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System {
        content: String,
        /// Hint to providers that support explicit prompt-cache
        /// breakpoints (Anthropic). `None` is the default; absent on
        /// the wire when not set so existing JSON shapes round-trip
        /// unchanged. Other providers ignore this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache: Option<CacheHint>,
    },
    User {
        content: String,
    },
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
        /// Hidden / "thinking" reasoning the model emitted alongside
        /// the visible reply. Some endpoints (notably Kimi K2
        /// thinking on `api.kimi.com/coding`) require this field on
        /// historical assistant messages that carry tool_calls —
        /// providers capture it on the way in so we can hand it
        /// back unchanged on subsequent turns.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

/// Cache-breakpoint hint consumed by providers with explicit cache
/// control. Today only the Anthropic provider acts on this; OpenAI's
/// prefix cache is automatic and Google Gemini's `cachedContents`
/// resource is a separate API plane (see
/// `docs/proposals/prompt-caching.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheHint {
    /// Anthropic's default 5-minute breakpoint.
    Ephemeral,
    /// Anthropic's extended 1-hour breakpoint (still gated as
    /// `ephemeral` + `ttl: "1h"` on the wire; rolled out per-account).
    Persistent,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self::System {
            content: content.into(),
            cache: None,
        }
    }

    /// Same as [`Message::system`] but marks this entry as a
    /// prompt-cache breakpoint. Convenience for the common case of
    /// caching a long, stable system prompt.
    pub fn system_cached(content: impl Into<String>, hint: CacheHint) -> Self {
        Self::System {
            content: content.into(),
            cache: Some(hint),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::User { content: content.into() }
    }

    pub fn assistant_text(content: impl Into<String>) -> Self {
        Self::Assistant {
            content: Some(content.into()),
            tool_calls: Vec::new(),
            reasoning_content: None,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self::Tool {
            tool_call_id: tool_call_id.into(),
            content: content.into(),
        }
    }

    /// Attach a cache hint to a message (only takes effect on
    /// variants that carry a `cache` field — currently `System`).
    /// No-op on other variants so callers can chain without matching.
    pub fn with_cache(mut self, hint: CacheHint) -> Self {
        if let Self::System { cache, .. } = &mut self {
            *cache = Some(hint);
        }
        self
    }
}

/// A function-style tool call emitted by the assistant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Arguments, already parsed from the provider's raw JSON string.
    pub arguments: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_without_hint_omits_cache_field_on_wire() {
        let m = Message::system("plain");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v, json!({ "role": "system", "content": "plain" }));
    }

    #[test]
    fn system_cached_serialises_cache_field() {
        let m = Message::system_cached("rules", CacheHint::Ephemeral);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({ "role": "system", "content": "rules", "cache": "ephemeral" })
        );
    }

    #[test]
    fn cache_hint_round_trips_through_serde() {
        let original = Message::system_cached("rules", CacheHint::Persistent);
        let s = serde_json::to_string(&original).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        match back {
            Message::System { content, cache } => {
                assert_eq!(content, "rules");
                assert_eq!(cache, Some(CacheHint::Persistent));
            }
            _ => panic!("expected system"),
        }
    }

    #[test]
    fn legacy_system_without_cache_field_decodes() {
        // Wire payloads written before this field existed must still
        // load — the `default` makes `cache` optional in the JSON.
        let raw = json!({ "role": "system", "content": "old" });
        let m: Message = serde_json::from_value(raw).unwrap();
        match m {
            Message::System { content, cache } => {
                assert_eq!(content, "old");
                assert!(cache.is_none());
            }
            _ => panic!("expected system"),
        }
    }

    #[test]
    fn with_cache_only_affects_system() {
        let m = Message::user("hi").with_cache(CacheHint::Ephemeral);
        // No-op on user, must still serialise as a plain user.
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v, json!({ "role": "user", "content": "hi" }));
    }
}
