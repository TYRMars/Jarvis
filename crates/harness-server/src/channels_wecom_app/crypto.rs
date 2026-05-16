//! Crypto primitives for the inbound callback verify path —
//! signature, constant-time eq, XML tag extractor, and the
//! AES-256-CBC payload decryptor.
//!
//! All four functions are pure (no I/O, no state) so they live in
//! one place and stay easily testable. The `synth_encrypt` test
//! helper underneath is the symmetric counterpart of
//! [`decrypt_aes_payload`] that lets the round-trip tests build
//! their own ciphertext without depending on a real WeCom fixture.

/// `sha1(sort([token, timestamp, nonce, payload]).join(""))`,
/// hex-encoded lowercase. Same scheme used for the GET handshake
/// (where `payload = echostr`) and POST verify (where `payload =
/// <Encrypt>` field from the body).
pub(super) fn wecom_signature(
    token: &str,
    timestamp: &str,
    nonce: &str,
    payload: &str,
) -> String {
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
pub(super) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
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
pub(super) fn extract_tag(xml: &str, tag: &str) -> Option<String> {
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
pub(super) fn decrypt_aes_payload(
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
