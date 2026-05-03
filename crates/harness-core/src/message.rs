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
        /// Mid-conversation prompt-cache breakpoint. Anthropic
        /// translates `Some(_)` into a `cache_control` block on the
        /// emitted user content; other providers ignore it. Default
        /// `None` keeps the historical wire shape.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache: Option<CacheHint>,
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
        /// Mid-conversation prompt-cache breakpoint, attached to the
        /// last content block of this message on the Anthropic wire.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache: Option<CacheHint>,
    },
    Tool {
        tool_call_id: String,
        content: String,
        /// Mid-conversation prompt-cache breakpoint, attached to this
        /// `tool_result` block on the Anthropic wire. Other providers
        /// ignore it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache: Option<CacheHint>,
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
        Self::User {
            content: content.into(),
            cache: None,
        }
    }

    pub fn assistant_text(content: impl Into<String>) -> Self {
        Self::Assistant {
            content: Some(content.into()),
            tool_calls: Vec::new(),
            reasoning_content: None,
            cache: None,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self::Tool {
            tool_call_id: tool_call_id.into(),
            content: content.into(),
            cache: None,
        }
    }

    /// Attach a cache hint to a message. Takes effect on every variant
    /// (`System`, `User`, `Assistant`, `Tool`); the Anthropic provider
    /// translates the hint into a `cache_control` block on the right
    /// boundary, other providers ignore it.
    pub fn with_cache(mut self, hint: CacheHint) -> Self {
        match &mut self {
            Self::System { cache, .. }
            | Self::User { cache, .. }
            | Self::Assistant { cache, .. }
            | Self::Tool { cache, .. } => {
                *cache = Some(hint);
            }
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
    fn with_cache_now_marks_user() {
        let m = Message::user("hi").with_cache(CacheHint::Ephemeral);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({ "role": "user", "content": "hi", "cache": "ephemeral" })
        );
    }

    #[test]
    fn user_without_hint_omits_cache_field_on_wire() {
        let m = Message::user("plain");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v, json!({ "role": "user", "content": "plain" }));
    }

    #[test]
    fn user_with_hint_serialises_cache_field() {
        let m = Message::user("rules").with_cache(CacheHint::Ephemeral);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({ "role": "user", "content": "rules", "cache": "ephemeral" })
        );
    }

    #[test]
    fn user_cache_round_trips_through_serde() {
        let original = Message::user("rules").with_cache(CacheHint::Persistent);
        let s = serde_json::to_string(&original).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        match back {
            Message::User { content, cache } => {
                assert_eq!(content, "rules");
                assert_eq!(cache, Some(CacheHint::Persistent));
            }
            _ => panic!("expected user"),
        }
    }

    #[test]
    fn legacy_user_without_cache_field_decodes() {
        let raw = json!({ "role": "user", "content": "old" });
        let m: Message = serde_json::from_value(raw).unwrap();
        match m {
            Message::User { content, cache } => {
                assert_eq!(content, "old");
                assert!(cache.is_none());
            }
            _ => panic!("expected user"),
        }
    }

    #[test]
    fn assistant_without_hint_omits_cache_field_on_wire() {
        let m = Message::assistant_text("plain");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v, json!({ "role": "assistant", "content": "plain" }));
    }

    #[test]
    fn assistant_with_hint_serialises_cache_field() {
        let m = Message::assistant_text("done").with_cache(CacheHint::Ephemeral);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({ "role": "assistant", "content": "done", "cache": "ephemeral" })
        );
    }

    #[test]
    fn assistant_cache_round_trips_through_serde() {
        let original = Message::assistant_text("done").with_cache(CacheHint::Persistent);
        let s = serde_json::to_string(&original).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        match back {
            Message::Assistant { content, cache, .. } => {
                assert_eq!(content.as_deref(), Some("done"));
                assert_eq!(cache, Some(CacheHint::Persistent));
            }
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn legacy_assistant_without_cache_field_decodes() {
        let raw = json!({ "role": "assistant", "content": "old" });
        let m: Message = serde_json::from_value(raw).unwrap();
        match m {
            Message::Assistant { content, cache, .. } => {
                assert_eq!(content.as_deref(), Some("old"));
                assert!(cache.is_none());
            }
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn tool_without_hint_omits_cache_field_on_wire() {
        let m = Message::tool_result("call_42", "ok");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({ "role": "tool", "tool_call_id": "call_42", "content": "ok" })
        );
    }

    #[test]
    fn tool_with_hint_serialises_cache_field() {
        let m = Message::tool_result("call_42", "ok").with_cache(CacheHint::Ephemeral);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v,
            json!({
                "role": "tool",
                "tool_call_id": "call_42",
                "content": "ok",
                "cache": "ephemeral"
            })
        );
    }

    #[test]
    fn tool_cache_round_trips_through_serde() {
        let original = Message::tool_result("call_42", "ok").with_cache(CacheHint::Persistent);
        let s = serde_json::to_string(&original).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        match back {
            Message::Tool {
                tool_call_id,
                content,
                cache,
            } => {
                assert_eq!(tool_call_id, "call_42");
                assert_eq!(content, "ok");
                assert_eq!(cache, Some(CacheHint::Persistent));
            }
            _ => panic!("expected tool"),
        }
    }

    #[test]
    fn legacy_tool_without_cache_field_decodes() {
        let raw = json!({ "role": "tool", "tool_call_id": "call_42", "content": "old" });
        let m: Message = serde_json::from_value(raw).unwrap();
        match m {
            Message::Tool {
                tool_call_id,
                content,
                cache,
            } => {
                assert_eq!(tool_call_id, "call_42");
                assert_eq!(content, "old");
                assert!(cache.is_none());
            }
            _ => panic!("expected tool"),
        }
    }
}
