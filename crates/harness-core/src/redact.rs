//! Identifier redaction helpers.
//!
//! When a channel adapter logs an inbound message or a send failure,
//! the `chat_id` / `user_id` it has on hand may be a phone number,
//! an email, or another piece of PII. Writing those into structured
//! logs is a privacy bug — operators (and anyone who later parses
//! the log file) shouldn't see "8613800138000" in the activity row
//! for a Jarvis test deployment.
//!
//! These helpers produce a deterministic short hash suitable for
//! correlation across log lines without ever touching the raw value.
//! Modelled after Hermes's `_hash_chat_id` / `_hash_sender_id`
//! (`gateway/session.py:34-58`).
//!
//! The hash is **not** cryptographically secret — it's a 12-char
//! prefix of SHA-256, intended to defeat casual log scraping, not
//! a state-level adversary. The point is "operator can grep
//! related log lines without the raw phone number leaking
//! sideways"; for actual secret handling use the `${env:…}`
//! template + keyring stories.

use sha2::{Digest, Sha256};

/// Stable 12-char hex hash of `value`. Used as the building block
/// for the typed wrappers below; exposed so callers with their own
/// namespace prefixes can reuse the same hash function.
fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    // 6 bytes ⇒ 12 hex chars. Sha256's first 6 bytes give 2^48
    // distinct values — collision risk for a single deployment's
    // worth of chat ids is negligible.
    hex_encode(&digest[..6])
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Hash a `chat_id`, prefixed by the adapter `kind`. The prefix
/// makes greppable log lines like `wecom_app:a1b2c3d4e5f6` so
/// operators can disambiguate "channel A's chat foo" from "channel
/// B's chat foo" without any of the raw identifiers landing in
/// logs.
pub fn hash_chat_id(channel: &str, chat_id: &str) -> String {
    format!("{channel}:{}", short_hash(chat_id))
}

/// Hash a sender / user id. No platform prefix because user ids
/// are typically unique within their platform; the prefix `user_`
/// is added so a sender id and a chat id with the same hash don't
/// look interchangeable in a log.
pub fn hash_sender_id(value: &str) -> String {
    format!("user_{}", short_hash(value))
}

/// Strip an optional leading `+`, then check the remainder is all
/// ASCII digits and at least 8 chars long. Used to decide whether
/// a `chat_id` is phone-shaped before logging — phone ids should
/// always go through [`hash_chat_id`] before they hit a structured
/// log field.
///
/// E.164 (`+8613800138000`), ten-digit US (`5551234567`), and
/// other plain-numeric formats all match. Hyphens / spaces fail —
/// callers normalise (strip whitespace and dashes) before checking
/// when they expect formatted phone strings.
pub fn looks_like_phone(s: &str) -> bool {
    let s = s.strip_prefix('+').unwrap_or(s);
    s.len() >= 8 && s.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_hash_is_12_hex_chars() {
        let h = short_hash("anything");
        assert_eq!(h.len(), 12);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn short_hash_is_deterministic() {
        assert_eq!(short_hash("abc"), short_hash("abc"));
        assert_ne!(short_hash("abc"), short_hash("abd"));
    }

    #[test]
    fn hash_chat_id_carries_channel_prefix() {
        let a = hash_chat_id("wecom_app", "chat-123");
        let b = hash_chat_id("feishu_bot", "chat-123");
        // Same id under different channels gives different prefix
        // but the suffix matches — that's intentional; `:`-split
        // tooling can dedupe a chat across channels if needed.
        assert!(a.starts_with("wecom_app:"));
        assert!(b.starts_with("feishu_bot:"));
        let suffix_a = a.split(':').nth(1).unwrap();
        let suffix_b = b.split(':').nth(1).unwrap();
        assert_eq!(suffix_a, suffix_b);
        assert_eq!(suffix_a.len(), 12);
    }

    #[test]
    fn hash_sender_id_uses_user_prefix() {
        let h = hash_sender_id("user-abc-123");
        assert!(h.starts_with("user_"));
        assert_eq!(h.len(), "user_".len() + 12);
    }

    #[test]
    fn hash_sender_id_and_hash_chat_id_for_same_input_dont_collide() {
        // Same input should produce different surface forms so a
        // log line stays unambiguous.
        let same_input = "12345abc";
        let chat = hash_chat_id("k", same_input);
        let sender = hash_sender_id(same_input);
        assert!(!chat.contains("user_"));
        assert!(sender.starts_with("user_"));
        // The hash bytes are the same, but the prefix disambiguates.
        let chat_suffix = chat.split(':').nth(1).unwrap();
        let sender_suffix = sender.strip_prefix("user_").unwrap();
        assert_eq!(chat_suffix, sender_suffix);
    }

    #[test]
    fn looks_like_phone_basic() {
        // E.164
        assert!(looks_like_phone("+8613800138000"));
        // Ten-digit US
        assert!(looks_like_phone("5551234567"));
        // Mainland mobile, no country code
        assert!(looks_like_phone("13800138000"));

        // Too short → false
        assert!(!looks_like_phone("12345"));
        assert!(!looks_like_phone("+12345"));
        // Letters → false
        assert!(!looks_like_phone("user_id_42"));
        assert!(!looks_like_phone("13a00138000"));
        // Spaces / dashes (callers should normalise first) → false
        assert!(!looks_like_phone("138-0013-8000"));
        assert!(!looks_like_phone("+86 138 0013 8000"));
    }
}
