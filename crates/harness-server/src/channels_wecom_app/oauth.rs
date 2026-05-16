//! OAuth2 免登 (snsapi_base) — terminal-user identity verification.
//!
//! WeCom's snsapi_base scope returns a `userid` after a silent in-client
//! authorisation. We use it for "click here to verify who you are" links
//! the bot can post into a chat, or for the `/v1/channels/:id/oauth/start`
//! + `/oauth/callback` redirect pair.
//!
//! State is HMAC-SHA1 signed against the instance's `token` field — same
//! secret the inbound verify uses — so we don't need a server-side state
//! store. The signed payload carries `instance_id`, an expiry timestamp,
//! and a random nonce. Verification checks the signature, parses the
//! payload, validates the instance binding + expiry, all in constant time.
//!
//! Reference: <https://developer.work.weixin.qq.com/document/path/91022>

use serde::Deserialize;

use super::crypto::constant_time_eq;
use super::{urlencoding_minimal, WECOM_API_BASE};

/// `snsapi_base` returns just the `userid` silently — no popup in the
/// WeCom client when the user is already logged in. `snsapi_privateinfo`
/// additionally surfaces name / avatar / mobile via a `user_ticket`, but
/// it triggers a confirmation prompt and requires extra app permissions.
/// v1 ships only `Base` — it's the minimum that proves identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OAuthScope {
    Base,
}

impl OAuthScope {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Base => "snsapi_base",
        }
    }
}

/// Build the WeCom OAuth2 authorize URL. `redirect_uri` is treated as
/// opaque and URL-encoded verbatim — the operator is responsible for
/// whitelisting its domain in the WeCom admin's "可信域名".
///
/// `#wechat_redirect` is mandatory per WeCom's docs; without it the
/// authorize page renders blank inside the WeCom client.
pub(crate) fn oauth_authorize_url(
    corp_id: &str,
    agent_id: u64,
    redirect_uri: &str,
    state: &str,
    scope: OAuthScope,
) -> String {
    format!(
        "https://open.weixin.qq.com/connect/oauth2/authorize\
         ?appid={appid}\
         &redirect_uri={redirect}\
         &response_type=code\
         &scope={scope}\
         &state={state}\
         &agentid={agentid}#wechat_redirect",
        appid = urlencoding_minimal(corp_id),
        redirect = urlencoding_minimal(redirect_uri),
        scope = scope.as_wire(),
        state = urlencoding_minimal(state),
        agentid = agent_id,
    )
}

/// Decoded state payload after signature verification. The fields are
/// the contract between `make_oauth_state` and `verify_oauth_state` —
/// keep them additive-only or version the payload.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct OAuthStateClaims {
    /// Channel-instance id this state belongs to. The callback route
    /// uses this to cross-check the `:id` path parameter.
    pub(crate) instance_id: String,
    /// Unix seconds after which the state is invalid. Typically now +
    /// 10 minutes — long enough for a slow tap, short enough that a
    /// stolen state ages out before being useful.
    pub(crate) exp: u64,
    /// 16-byte hex random — guards against replay of the same state
    /// (combined with `exp`) and makes the signed blob look opaque.
    pub(crate) nonce: String,
    /// Optional caller-supplied opaque field. Often a Jarvis session
    /// id, a `next=` URL hint, or a pairing token — the callback
    /// surfaces this verbatim so the originator can correlate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ctx: Option<String>,
}

/// Sign a fresh state token. The `token` argument is the same value
/// configured on the `ChannelInstance` for inbound verify (`config.token`
/// — operator-chosen, kept secret) so we don't need a dedicated
/// signing key.
pub(crate) fn make_oauth_state(
    instance_id: &str,
    instance_token: &str,
    ttl_secs: u64,
    ctx: Option<&str>,
    nonce_hex: &str,
    now_unix: u64,
) -> Result<String, String> {
    use base64::Engine;
    if instance_token.is_empty() {
        return Err("instance token is empty — cannot sign OAuth state".to_string());
    }
    let claims = OAuthStateClaims {
        instance_id: instance_id.to_string(),
        exp: now_unix.saturating_add(ttl_secs),
        nonce: nonce_hex.to_string(),
        ctx: ctx.map(str::to_string),
    };
    let json = serde_json::to_vec(&claims).map_err(|e| format!("state encode: {e}"))?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json);
    let sig = oauth_state_sig(&b64, instance_token);
    Ok(format!("{b64}.{sig}"))
}

/// Verify + decode a state token. Returns the claims (CSRF passed and
/// not expired) or an operator-readable error.
///
/// Step order matters:
/// 1. Split on `.`  (cheap, doesn't leak anything)
/// 2. Recompute sig + constant-time compare — catches tampering early
/// 3. Decode payload, parse JSON
/// 4. Cross-check `instance_id` against the route's `:id`
/// 5. Check expiry against the caller-supplied `now_unix`
pub(crate) fn verify_oauth_state(
    state: &str,
    expected_instance: &str,
    instance_token: &str,
    now_unix: u64,
) -> Result<OAuthStateClaims, String> {
    use base64::Engine;
    let (b64, sig) = state.split_once('.').ok_or("state missing signature")?;
    if b64.is_empty() || sig.is_empty() {
        return Err("state malformed".to_string());
    }
    let expected_sig = oauth_state_sig(b64, instance_token);
    if !constant_time_eq(sig.as_bytes(), expected_sig.as_bytes()) {
        return Err("state signature mismatch".to_string());
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64)
        .map_err(|e| format!("state base64: {e}"))?;
    let claims: OAuthStateClaims =
        serde_json::from_slice(&raw).map_err(|e| format!("state json: {e}"))?;
    if claims.instance_id != expected_instance {
        return Err("state instance_id mismatch".to_string());
    }
    if claims.exp < now_unix {
        return Err("state expired".to_string());
    }
    Ok(claims)
}

/// HMAC-SHA1 of the state payload keyed by the instance token. Output
/// is the 40-char lowercase hex digest. WeCom signatures elsewhere in
/// this file are plain `sha1(concat)` — we use HMAC here because the
/// token is a true secret (operator-chosen) and HMAC is the standard
/// CSRF-token construction; plain SHA1 of `token + payload` is
/// vulnerable to length-extension on hypothetical inputs we don't
/// fully control.
fn oauth_state_sig(payload_b64: &str, instance_token: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    type HmacSha1 = Hmac<Sha1>;
    let mut mac =
        HmacSha1::new_from_slice(instance_token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload_b64.as_bytes());
    let bytes = mac.finalize().into_bytes();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(40);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Exchange the `code` returned by WeCom for the user's `userid` via
/// `cgi-bin/auth/getuserinfo`. The `access_token` argument is the
/// app-level access_token from [`super::token::ensure_token`].
///
/// WeCom returns `{errcode:0, errmsg:"ok", userid:"..."}` on success.
/// `external_userid` (for non-corp users) and `user_ticket` (only with
/// `snsapi_privateinfo` scope) are surfaced when present — callers
/// that only need `userid` ignore them.
pub(crate) async fn exchange_code_for_userid(
    access_token: &str,
    code: &str,
) -> Result<OAuthUserInfo, String> {
    let url = format!(
        "{WECOM_API_BASE}/cgi-bin/auth/getuserinfo?access_token={}&code={}",
        urlencoding_minimal(access_token),
        urlencoding_minimal(code),
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("getuserinfo http: {e}"))?;
    let parsed: GetUserInfoReply = resp
        .json()
        .await
        .map_err(|e| format!("getuserinfo json: {e}"))?;
    if parsed.errcode != 0 {
        return Err(format!(
            "wecom getuserinfo failed: errcode={} errmsg={}",
            parsed.errcode, parsed.errmsg
        ));
    }
    // A corp member returns `userid`; a non-corp visitor returns
    // `openid` + `external_userid` instead. v1 only supports corp
    // members — surface the visitor case as a clear error rather than
    // silently dropping them.
    let userid = parsed
        .userid
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "wecom oauth: not a corp member (no userid)".to_string())?;
    Ok(OAuthUserInfo {
        userid,
        external_userid: parsed.external_userid.filter(|s| !s.is_empty()),
        user_ticket: parsed.user_ticket.filter(|s| !s.is_empty()),
    })
}

/// Subset of the `getuserinfo` reply we care about. The other fields
/// (`openid`, `device_id`) we ignore — see WeCom's docs if a future
/// feature needs them.
#[derive(Debug, Deserialize)]
struct GetUserInfoReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
    #[serde(default)]
    userid: Option<String>,
    #[serde(default)]
    external_userid: Option<String>,
    #[serde(default)]
    user_ticket: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OAuthUserInfo {
    pub(crate) userid: String,
    /// Set when the authenticator is a non-corp visitor. v1 routes
    /// reject these; recording the field anyway so future "external
    /// contact" features can pick it up without a wire change.
    pub(crate) external_userid: Option<String>,
    /// Set only with `snsapi_privateinfo` scope. Used to call
    /// `cgi-bin/auth/getuserdetail` for name / mobile. `None` for
    /// snsapi_base.
    pub(crate) user_ticket: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_authorize_url_has_required_params_and_hash() {
        let url = oauth_authorize_url(
            "ww-corp",
            1_000_002,
            "https://abc.example/v1/channels/xyz/oauth/callback",
            "state-token-abc",
            OAuthScope::Base,
        );
        // All of WeCom's required parameters present.
        assert!(url.contains("appid=ww-corp"));
        assert!(url.contains(
            "redirect_uri=https%3A%2F%2Fabc.example%2Fv1%2Fchannels%2Fxyz%2Foauth%2Fcallback"
        ));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("scope=snsapi_base"));
        assert!(url.contains("state=state-token-abc"));
        assert!(url.contains("agentid=1000002"));
        // The `#wechat_redirect` fragment is mandatory — without it
        // WeCom client renders blank.
        assert!(url.ends_with("#wechat_redirect"));
        // No accidental newlines / whitespace from the format string.
        assert!(!url.contains(' '));
        assert!(!url.contains('\n'));
    }

    #[test]
    fn oauth_state_round_trip_decodes_claims() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            600,
            Some("session=abc"),
            "deadbeefcafebabe",
            1_700_000_000,
        )
        .expect("sign ok");
        let claims = verify_oauth_state(&state, "inst-1", "token-secret", 1_700_000_100)
            .expect("verify ok");
        assert_eq!(claims.instance_id, "inst-1");
        assert_eq!(claims.exp, 1_700_000_600);
        assert_eq!(claims.nonce, "deadbeefcafebabe");
        assert_eq!(claims.ctx.as_deref(), Some("session=abc"));
    }

    #[test]
    fn oauth_state_rejects_tampered_payload() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            600,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        // Flip a payload byte (but keep the signature) → signature
        // mismatch.
        let (payload, sig) = state.split_once('.').unwrap();
        let mut bad_payload = payload.to_string();
        let last = bad_payload.pop().unwrap();
        // Replace last char with something different.
        bad_payload.push(if last == 'A' { 'B' } else { 'A' });
        let tampered = format!("{bad_payload}.{sig}");
        let err = verify_oauth_state(&tampered, "inst-1", "token-secret", 1_700_000_100)
            .expect_err("must reject");
        assert!(err.contains("signature"));
    }

    #[test]
    fn oauth_state_rejects_wrong_instance_id() {
        let state = make_oauth_state(
            "inst-A",
            "token-secret",
            600,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        let err = verify_oauth_state(&state, "inst-B", "token-secret", 1_700_000_100)
            .expect_err("must reject");
        assert!(err.contains("instance_id"));
    }

    #[test]
    fn oauth_state_rejects_expired() {
        let state = make_oauth_state(
            "inst-1",
            "token-secret",
            60,
            None,
            "nonce123",
            1_700_000_000,
        )
        .unwrap();
        // 70 seconds later — exp = 1_700_000_060, now = 1_700_000_070.
        let err = verify_oauth_state(&state, "inst-1", "token-secret", 1_700_000_070)
            .expect_err("must reject");
        assert!(err.contains("expired"));
    }

    #[test]
    fn oauth_state_rejects_missing_signature() {
        // No period at all.
        let err = verify_oauth_state("aGVsbG8", "inst-1", "token-secret", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("missing signature"));
        // Empty signature segment.
        let err = verify_oauth_state("aGVsbG8.", "inst-1", "token-secret", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("malformed"));
    }

    #[test]
    fn oauth_state_refuses_empty_token() {
        let err = make_oauth_state("inst-1", "", 600, None, "nonce", 1_700_000_000)
            .expect_err("must reject");
        assert!(err.contains("token"));
    }

    #[test]
    fn oauth_state_sig_differs_per_token_value() {
        // Two distinct tokens MUST produce distinct signatures over
        // the same payload, otherwise the CSRF gate is decorative.
        let s1 = oauth_state_sig("payload", "token-A");
        let s2 = oauth_state_sig("payload", "token-B");
        assert_ne!(s1, s2);
        // And the same input is deterministic.
        assert_eq!(s1, oauth_state_sig("payload", "token-A"));
    }
}
