//! Stable cache-key derivation for OpenAI / Responses prompt caching.
//!
//! OpenAI's automatic prefix cache keys requests by a server-derived
//! hash of the prefix bytes. Distinct system prompts and tool catalogues
//! collide in the default key bucket, so two unrelated agent
//! configurations sharing the same account can evict each other.
//! Sending an explicit `prompt_cache_key` segments the cache by
//! `(model, system, tools)` so we don't fight over the same slot.
//!
//! The hash input is the canonical wire form of the inputs: the joined
//! system instructions exactly as they're sent, plus the **already
//! sorted and sanitised** tools JSON. `ToolRegistry::specs` sorts
//! alphabetically before handing tools off to the provider, so the
//! input is stable across processes.
//!
//! Hash input MUST be assembled *after* the sort/sanitise step, not
//! before — otherwise two processes can compute different keys for the
//! same outgoing wire bytes.

/// Derive a stable, namespaced cache key from the request's caching
/// inputs. The output is `jarvis-<16 hex>` — short enough to surface
/// in logs, long enough to make collisions on a single account
/// vanishingly rare.
pub fn auto_cache_key(model: &str, systems: &str, tools_json: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(model.as_bytes());
    h.update(b"\0");
    h.update(systems.as_bytes());
    h.update(b"\0");
    h.update(tools_json.as_bytes());
    let hex = h.finalize().to_hex();
    let s = hex.as_str();
    format!("jarvis-{}", &s[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_inputs_same_key() {
        let k1 = auto_cache_key("gpt-4o-mini", "you are helpful", "[]");
        let k2 = auto_cache_key("gpt-4o-mini", "you are helpful", "[]");
        assert_eq!(k1, k2);
    }

    #[test]
    fn different_model_different_key() {
        let k1 = auto_cache_key("gpt-4o-mini", "sys", "[]");
        let k2 = auto_cache_key("gpt-4o", "sys", "[]");
        assert_ne!(k1, k2);
    }

    #[test]
    fn different_system_different_key() {
        let k1 = auto_cache_key("m", "be terse", "[]");
        let k2 = auto_cache_key("m", "be verbose", "[]");
        assert_ne!(k1, k2);
    }

    #[test]
    fn different_tools_different_key() {
        let k1 = auto_cache_key("m", "sys", r#"[{"name":"a"}]"#);
        let k2 = auto_cache_key("m", "sys", r#"[{"name":"a"},{"name":"b"}]"#);
        assert_ne!(k1, k2);
    }

    #[test]
    fn key_format_is_namespaced_hex() {
        let k = auto_cache_key("m", "s", "t");
        assert!(k.starts_with("jarvis-"));
        // jarvis- (7) + 16 hex chars = 23
        assert_eq!(k.len(), 23);
        assert!(k[7..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn empty_inputs_are_separated_by_null_byte() {
        // "ab", "c" → "ab\0c\0" must differ from "a", "bc" → "a\0bc\0".
        // Without the null delimiter both would hash the byte sequence
        // "abc", losing the boundary.
        let k1 = auto_cache_key("ab", "c", "");
        let k2 = auto_cache_key("a", "bc", "");
        assert_ne!(k1, k2);
    }
}
