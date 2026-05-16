//! Access-token cache and fetch — the credentials half of WeCom
//! 自建应用 outbound.
//!
//! WeCom's self-built apps authenticate every API call with a short-
//! lived `access_token` derived from `corp_id + corp_secret`:
//!
//! ```text
//! GET /cgi-bin/gettoken?corpid=...&corpsecret=...
//!   → { errcode:0, access_token:"...", expires_in:7200 }
//! ```
//!
//! A token is good for ~2h. The cache here is a process-level
//! `HashMap<corp_id, CachedToken>` so multiple `ChannelInstance` rows
//! sharing the same corp don't each burn an `expires_in` budget
//! (WeCom enforces ~2000 gettoken calls/day per corp).
//!
//! `ensure_token` is the single externally-visible entry point —
//! also called by the OAuth callback handler in
//! [`super::oauth`](super::oauth) to authorise its `getuserinfo`
//! exchange.

use harness_channel::SendOutcome;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use super::{urlencoding_minimal, WECOM_API_BASE};

/// How early to refresh `access_token` before its declared
/// `expires_in`. WeCom hands out 7200-second tokens; refreshing 5
/// minutes before keeps every send well clear of the boundary.
const TOKEN_REFRESH_LEAD_SECS: u64 = 300;

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Process-level cache, keyed by `corp_id`. A separate
/// `RwLock<HashMap>` per binary (not per-instance) because access
/// tokens are corp-scoped, not app-scoped — multiple
/// `ChannelInstance` rows for the same `corp_id` share one token to
/// stay under WeCom's 2000-call/day refresh quota.
#[derive(Default)]
pub(super) struct AccessTokenCache {
    inner: RwLock<HashMap<String, CachedToken>>,
}

impl AccessTokenCache {
    pub(super) fn get(&self, corp_id: &str) -> Option<String> {
        let g = self.inner.read().ok()?;
        let cached = g.get(corp_id)?;
        if Instant::now() < cached.expires_at {
            Some(cached.token.clone())
        } else {
            None
        }
    }

    pub(super) fn set(&self, corp_id: &str, token: String, ttl_secs: u64) {
        let safe_ttl = ttl_secs.saturating_sub(TOKEN_REFRESH_LEAD_SECS);
        let expires_at = Instant::now() + Duration::from_secs(safe_ttl);
        if let Ok(mut g) = self.inner.write() {
            g.insert(
                corp_id.to_string(),
                CachedToken {
                    token,
                    expires_at,
                },
            );
        }
    }

    pub(super) fn invalidate(&self, corp_id: &str) {
        if let Ok(mut g) = self.inner.write() {
            g.remove(corp_id);
        }
    }
}

/// Singleton — every `WeComAppAdapter` invocation hits the same
/// cache so deployments with multiple instances behind one
/// `corp_id` share tokens. Lazy-init via `OnceLock`.
pub(super) fn token_cache() -> &'static AccessTokenCache {
    static CACHE: std::sync::OnceLock<AccessTokenCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(AccessTokenCache::default)
}

/// Reset helper for tests — never called from production code.
#[cfg(test)]
pub(super) fn reset_token_cache() {
    if let Ok(mut g) = token_cache().inner.write() {
        g.clear();
    }
}

/// Return a token from the cache, fetching one when missing /
/// expired / `force_refresh = true`. Externally reachable
/// (`pub(crate)`) because [`super::oauth`](super::oauth) needs it
/// for the OAuth code exchange.
pub(crate) async fn ensure_token(
    corp_id: &str,
    corp_secret: &str,
    force_refresh: bool,
) -> Result<String, SendOutcome> {
    if !force_refresh {
        if let Some(t) = token_cache().get(corp_id) {
            return Ok(t);
        }
    }
    fetch_token(corp_id, corp_secret).await
}

#[derive(Debug, Deserialize)]
struct GetTokenReply {
    errcode: i64,
    #[serde(default)]
    errmsg: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_in: u64,
}

/// Fetch a fresh access_token. Cache populated on success.
async fn fetch_token(corp_id: &str, corp_secret: &str) -> Result<String, SendOutcome> {
    let url = format!(
        "{WECOM_API_BASE}/cgi-bin/gettoken?corpid={}&corpsecret={}",
        urlencoding_minimal(corp_id),
        urlencoding_minimal(corp_secret),
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Err(SendOutcome::fail_retryable(format!(
                "HTTP client init: {e}"
            )))
        }
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Err(SendOutcome::fail_retryable(format!(
                "gettoken transport: {e}"
            )))
        }
    };
    let status = resp.status();
    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Err(SendOutcome::Failed {
                message: format!("gettoken reply unreadable: {e}"),
                code: Some("wecom_app:gettoken_reply_unreadable".into()),
                retryable: false,
            });
        }
    };
    if !status.is_success() {
        return Err(SendOutcome::Failed {
            message: format!("gettoken HTTP {}: {raw}", status.as_u16()),
            code: Some(format!("wecom_app:gettoken_http_{}", status.as_u16())),
            retryable: status.is_server_error(),
        });
    }
    let parsed: GetTokenReply = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            return Err(SendOutcome::Failed {
                message: format!("gettoken parse: {e}: {raw}"),
                code: Some("wecom_app:gettoken_reply_parse".into()),
                retryable: false,
            });
        }
    };
    if parsed.errcode != 0 || parsed.access_token.is_empty() {
        return Err(SendOutcome::Failed {
            message: format!(
                "gettoken errcode {}: {}",
                parsed.errcode, parsed.errmsg
            ),
            code: Some(format!("wecom_app:gettoken_errcode_{}", parsed.errcode)),
            retryable: false,
        });
    }
    token_cache().set(corp_id, parsed.access_token.clone(), parsed.expires_in);
    Ok(parsed.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    // All four cache tests touch the same process-level
    // `token_cache()` singleton. Cargo runs tests in parallel by
    // default, so we serialise just this group with a local mutex —
    // simpler than dragging `serial_test` into the workspace deps
    // and the cost is negligible (4 tests, each <2 ms).
    fn cache_test_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    #[test]
    fn token_cache_stores_and_returns_within_ttl() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-A", "tok-1".into(), 7200);
        assert_eq!(cache.get("corp-A"), Some("tok-1".into()));
    }

    #[test]
    fn token_cache_treats_short_ttl_as_expired_via_lead() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-B", "tok-2".into(), 30); // shorter than 300s lead
        // Cache stores expires_at = now() + 0s (saturating sub),
        // already in the past by the time `get` runs.
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(cache.get("corp-B"), None);
    }

    #[test]
    fn token_cache_invalidate_drops_entry() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-C", "tok-3".into(), 7200);
        cache.invalidate("corp-C");
        assert_eq!(cache.get("corp-C"), None);
    }

    #[test]
    fn token_cache_keys_by_corp_id() {
        let _g = cache_test_lock().lock().unwrap();
        reset_token_cache();
        let cache = token_cache();
        cache.set("corp-D", "tok-D".into(), 7200);
        cache.set("corp-E", "tok-E".into(), 7200);
        assert_eq!(cache.get("corp-D").as_deref(), Some("tok-D"));
        assert_eq!(cache.get("corp-E").as_deref(), Some("tok-E"));
    }
}
