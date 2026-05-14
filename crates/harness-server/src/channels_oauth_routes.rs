//! Inbound OAuth2 routes — WeCom 自建应用 user-identity 免登 flow.
//!
//! Endpoints:
//! - `GET /v1/channels/:id/oauth/start[?ctx=...&next=...]` — generates
//!   a signed CSRF state, builds the WeCom authorize URL, and 302s
//!   the user into WeCom's authorize page (which they're already
//!   logged into via the WeCom client).
//! - `GET /v1/channels/:id/oauth/callback?code=...&state=...` — WeCom
//!   redirects here after the user grants. We verify the state's
//!   HMAC signature + expiry, fetch an access_token for the kind's
//!   corp, exchange `code` → `userid`, then either:
//!     - redirect to the `next` URL (carrying `userid` as a query
//!       param) when the originator passed one, or
//!     - render a tiny HTML "verified as X" page for the user.
//!
//! Why this lives next to (not inside) `channels_inbound_routes`:
//! - Different lifecycle (one-shot user click vs. continuous platform
//!   POST stream).
//! - Different verify path (HMAC state instead of the platform's
//!   signature header).
//! - Future kinds (Slack OAuth, Feishu 第三方应用 OAuth) will share
//!   exactly this start/callback shape — keeping it separate makes
//!   widening to a trait obvious.
//!
//! v1 ships only `wecom_app`. Other inbound-capable kinds returning
//! `Some(handler)` from `inbound_handler()` but without OAuth get a
//! 405. The route gates on kind to avoid pretending to OAuth-support
//! every channel.
//!
//! Reference: <https://developer.work.weixin.qq.com/document/path/91022>

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use harness_channel::{resolve_env_templates, ChannelInstanceStatus};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

use crate::channel_adapter::ChannelOAuthCapability;
use crate::state::AppState;
use crate::state_layers::ChannelLayer;

/// 10 minutes is plenty for "user taps link → WeCom redirects back".
/// Any longer and an intercepted state survives long enough to be
/// useful; any shorter and a slow tap fails the round trip.
const STATE_TTL_SECS: u64 = 600;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/channels/:id/oauth/start", get(oauth_start))
        .route("/v1/channels/:id/oauth/callback", get(oauth_callback))
}

#[derive(Debug, Deserialize)]
struct StartQuery {
    /// Optional opaque correlation token. Surfaces verbatim in the
    /// state claims so the caller (e.g. a Jarvis web session) can
    /// match the redirect back to the request that started it.
    /// Common values: `session=<ws-id>`, `chat=<channel_chat_id>`,
    /// `pair=<bot-issued-token>`.
    #[serde(default)]
    ctx: Option<String>,
    /// Optional post-callback redirect target (e.g. a deep link back
    /// into jarvis-web). When set, the callback handler 302s to
    /// `{next}?userid=<userid>&ctx=<ctx>` instead of rendering the
    /// "verified" HTML page. The route validates the URL is HTTP(S)
    /// — `javascript:` / `data:` schemes are rejected to block
    /// open-redirect → XSS chains.
    #[serde(default)]
    next: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    /// WeCom omits these on success but sends `error=access_denied`
    /// (or similar) when the user dismisses the authorize dialog
    /// (only meaningful with `snsapi_privateinfo`; `snsapi_base`
    /// doesn't show a dialog).
    #[serde(default)]
    error: Option<String>,
}

async fn oauth_start(
    State(layer): State<ChannelLayer>,
    Path(id): Path<String>,
    Query(q): Query<StartQuery>,
) -> Response {
    // Reject malicious `next` URLs early.
    if let Some(next) = q.next.as_deref() {
        if !is_safe_next_url(next) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "next URL must be http(s)://"})),
            )
                .into_response();
        }
    }

    let (oauth, resolved) = match load_oauth_capability(&layer, &id).await {
        Ok(triple) => triple,
        Err(resp) => return resp,
    };

    let public_host = match resolve_public_host() {
        Some(h) => h,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "JARVIS_PUBLIC_HOST not configured — required to build OAuth redirect URI"
                })),
            )
                .into_response()
        }
    };
    let redirect_uri = format!("{public_host}/v1/channels/{id}/oauth/callback");

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Pack `next` into the state's opaque `ctx` field so the
    // callback can recover it without a separate cookie. Keeps the
    // route stateless across redirects (and across replicas).
    let ctx_packed = pack_ctx(q.ctx.as_deref(), q.next.as_deref());
    let signed_state = match oauth.sign_state(
        &resolved,
        &id,
        STATE_TTL_SECS,
        ctx_packed.as_deref(),
        now,
    ) {
        Ok(s) => s,
        Err(e) => {
            warn!(channel_id = %id, error = %e, "OAuth state sign failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e})),
            )
                .into_response();
        }
    };

    let authorize_url = match oauth.authorize_url(&resolved, &redirect_uri, &signed_state) {
        Ok(u) => u,
        Err(e) => {
            warn!(channel_id = %id, error = %e, "OAuth authorize_url build failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e})),
            )
                .into_response();
        }
    };

    // Axum's `Redirect` strips the URL fragment by default because
    // browsers preserve `#…` from the *original* URL on a 302. WeCom's
    // mobile client honours the fragment in the `Location` header, so
    // hand-set the header instead of `Redirect::temporary`.
    (
        StatusCode::FOUND,
        [(header::LOCATION, authorize_url)],
        "",
    )
        .into_response()
}

async fn oauth_callback(
    State(layer): State<ChannelLayer>,
    Path(id): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> Response {
    if let Some(err) = q.error.as_deref() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("wecom oauth error: {err}")})),
        )
            .into_response();
    }
    let code = match q.code.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "missing `code` query param"})),
            )
                .into_response()
        }
    };
    let state_token = match q.state.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "missing `state` query param"})),
            )
                .into_response()
        }
    };

    let (oauth, resolved) = match load_oauth_capability(&layer, &id).await {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let packed_ctx = match oauth.verify_state(&resolved, state_token, &id, now) {
        Ok(c) => c,
        Err(e) => {
            warn!(channel_id = %id, error = %e, "OAuth state verify failed");
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": e})),
            )
                .into_response();
        }
    };
    let identity = match oauth.exchange_code(&resolved, code).await {
        Ok(i) => i,
        Err(e) => {
            warn!(channel_id = %id, error = %e, "OAuth code exchange failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": e})),
            )
                .into_response();
        }
    };

    // Unpack the originator's `ctx` and the optional `next` URL from
    // the (opaque) state claims' ctx field. If `next` is present and
    // safe, 302 to it carrying the verified userid. Otherwise render
    // the inline HTML.
    let (orig_ctx, next_url) = unpack_ctx(packed_ctx.as_deref());

    if let Some(next) = next_url {
        if is_safe_next_url(&next) {
            let sep = if next.contains('?') { '&' } else { '?' };
            let ctx_param = match orig_ctx.as_deref() {
                Some(c) if !c.is_empty() => {
                    format!("&ctx={}", urlencoded(c))
                }
                _ => String::new(),
            };
            let target = format!(
                "{next}{sep}userid={userid}{ctx_param}",
                userid = urlencoded(&identity.external_user_id)
            );
            return Redirect::to(&target).into_response();
        } else {
            warn!(channel_id = %id, next = %next, "ignoring unsafe `next` URL");
        }
    }

    let html = render_success_page(&identity.external_user_id, orig_ctx.as_deref());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

// --- helpers ---------------------------------------------------------------

/// Resolve `(adapter.oauth_capability(), env-resolved-config)` for a
/// channel instance, returning a typed `Response` for every failure
/// mode the route handlers need to surface:
///
/// - 503 — channel-instance store not wired in
/// - 404 — instance id unknown
/// - 503 — instance disabled
/// - 500 — kind registered but adapter missing from registry (boot
///   skew — registry was built without this kind)
/// - 405 — kind has no OAuth capability (returns `None` from
///   `oauth_capability()`)
///
/// This collapses what used to be two duplicated `if instance.kind
/// != "wecom_app"` gates into a single trait dispatch.
async fn load_oauth_capability(
    layer: &ChannelLayer,
    id: &str,
) -> Result<(Arc<dyn ChannelOAuthCapability>, serde_json::Value), Response> {
    let store = layer.instances.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "channel-instance store not configured"})),
        )
            .into_response()
    })?;
    let instance = match store.get(id).await {
        Ok(Some(i)) => i,
        Ok(None) => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({"error": "channel instance not found"})),
            )
                .into_response())
        }
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
                .into_response())
        }
    };
    if matches!(instance.status, ChannelInstanceStatus::Disabled) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": format!("channel instance '{}' is disabled", instance.display_name)})),
        )
            .into_response());
    }
    let adapter = layer.adapters.get(&instance.kind).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("kind '{}' not registered", instance.kind)})),
        )
            .into_response()
    })?;
    let oauth = adapter.oauth_capability().ok_or_else(|| {
        (
            StatusCode::METHOD_NOT_ALLOWED,
            Json(json!({"error": format!("kind '{}' does not support OAuth", instance.kind)})),
        )
            .into_response()
    })?;
    let resolved = resolve_env_templates(&instance.config);
    Ok((oauth, resolved))
}

/// Resolve the public host the operator pinned at startup (same env
/// var the `jarvis channels callback-url` CLI consults). Trims a
/// trailing slash so callers can safely concatenate `/v1/...`.
fn resolve_public_host() -> Option<String> {
    let raw = std::env::var("JARVIS_PUBLIC_HOST").ok()?;
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Pack the caller's `ctx` + the optional `next` URL into a single
/// state-claim field. We separate with a `|` sentinel — the `ctx`
/// payload is operator-supplied and could itself contain a `|`, so
/// strip + warn rather than letting it round-trip ambiguously.
fn pack_ctx(ctx: Option<&str>, next: Option<&str>) -> Option<String> {
    let ctx = ctx.unwrap_or("");
    let next = next.unwrap_or("");
    if ctx.is_empty() && next.is_empty() {
        return None;
    }
    let safe_ctx: String = ctx.chars().filter(|&c| c != '|').collect();
    Some(format!("{safe_ctx}|{next}"))
}

/// Reverse of `pack_ctx`. Returns `(ctx, next)`.
fn unpack_ctx(packed: Option<&str>) -> (Option<String>, Option<String>) {
    let raw = match packed {
        Some(s) => s,
        None => return (None, None),
    };
    if let Some((ctx, next)) = raw.split_once('|') {
        (
            (!ctx.is_empty()).then(|| ctx.to_string()),
            (!next.is_empty()).then(|| next.to_string()),
        )
    } else {
        ((!raw.is_empty()).then(|| raw.to_string()), None)
    }
}

/// Allowlist `next=` URL schemes. http/https only — no
/// `javascript:` (XSS), no `data:` (phishing), no protocol-relative
/// (`//evil.example/...` which inherits the page's scheme).
fn is_safe_next_url(s: &str) -> bool {
    if s.starts_with("//") {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Minimal URL-encode for inserting into a query value. Reuses the
/// same conservative scheme as the wecom_app adapter's
/// `urlencoding_minimal` — RFC 3986 unreserved chars only.
fn urlencoded(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn render_success_page(userid: &str, ctx: Option<&str>) -> String {
    // Minimal inline HTML — the audience is one tap inside the
    // WeCom client, no styling needed. Escape userid + ctx so an
    // operator-crafted userid can't smuggle script tags via the
    // identity surface.
    let userid_h = html_escape(userid);
    let ctx_h = ctx.map(html_escape).unwrap_or_default();
    let ctx_block = if ctx_h.is_empty() {
        String::new()
    } else {
        format!("<p>ctx: <code>{ctx_h}</code></p>")
    };
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head>\
         <meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>已验证身份</title>\
         <style>body{{font-family:-apple-system,sans-serif;padding:2rem;text-align:center;color:#1f2937}}\
         h1{{font-size:1.5rem;margin:1rem 0 .5rem}}code{{background:#f3f4f6;padding:.1rem .3rem;border-radius:.25rem}}</style>\
         </head><body><div style=\"font-size:3rem\">✅</div>\
         <h1>已验证身份</h1>\
         <p>userid: <code>{userid_h}</code></p>\
         {ctx_block}\
         <p style=\"color:#6b7280;margin-top:2rem\">可以关闭这个页面了。</p>\
         </body></html>"
    )
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_unpack_round_trips_ctx_only() {
        let packed = pack_ctx(Some("session=abc"), None);
        assert_eq!(packed.as_deref(), Some("session=abc|"));
        let (ctx, next) = unpack_ctx(packed.as_deref());
        assert_eq!(ctx.as_deref(), Some("session=abc"));
        assert_eq!(next, None);
    }

    #[test]
    fn pack_unpack_round_trips_next_only() {
        let packed = pack_ctx(None, Some("https://x.example/cb"));
        assert_eq!(packed.as_deref(), Some("|https://x.example/cb"));
        let (ctx, next) = unpack_ctx(packed.as_deref());
        assert_eq!(ctx, None);
        assert_eq!(next.as_deref(), Some("https://x.example/cb"));
    }

    #[test]
    fn pack_unpack_round_trips_both() {
        let packed = pack_ctx(Some("s=42"), Some("https://x.example"));
        let (ctx, next) = unpack_ctx(packed.as_deref());
        assert_eq!(ctx.as_deref(), Some("s=42"));
        assert_eq!(next.as_deref(), Some("https://x.example"));
    }

    #[test]
    fn pack_strips_pipe_in_ctx_to_prevent_injection() {
        // If a malicious ctx contained `|`, it'd shift the next-URL
        // boundary on unpack. Defensive: strip pipes from ctx, leave
        // a tracing breadcrumb via the test below.
        let packed = pack_ctx(Some("bad|injected=evil.com"), None);
        let (ctx, next) = unpack_ctx(packed.as_deref());
        assert_eq!(ctx.as_deref(), Some("badinjected=evil.com"));
        assert_eq!(next, None);
    }

    #[test]
    fn pack_returns_none_for_empty_pair() {
        assert!(pack_ctx(None, None).is_none());
        assert!(pack_ctx(Some(""), Some("")).is_none());
    }

    #[test]
    fn safe_next_url_blocks_dangerous_schemes() {
        assert!(is_safe_next_url("https://x.example/cb"));
        assert!(is_safe_next_url("http://x.example/cb"));
        assert!(!is_safe_next_url("javascript:alert(1)"));
        assert!(!is_safe_next_url("data:text/html,<script>"));
        assert!(!is_safe_next_url("//evil.example/cb"));
        assert!(!is_safe_next_url("file:///etc/passwd"));
        assert!(!is_safe_next_url(""));
    }

    #[test]
    fn render_success_escapes_html_in_userid() {
        let html = render_success_page("<script>", None);
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn render_success_omits_ctx_block_when_none() {
        let html = render_success_page("ZhangSan", None);
        assert!(html.contains("ZhangSan"));
        assert!(!html.contains("ctx:"));
    }

    #[test]
    fn render_success_includes_ctx_block_when_present() {
        let html = render_success_page("ZhangSan", Some("session=abc"));
        assert!(html.contains("session=abc"));
        assert!(html.contains("ctx:"));
    }

    #[test]
    fn urlencoded_escapes_reserved_chars() {
        assert_eq!(urlencoded("hello world"), "hello%20world");
        assert_eq!(urlencoded("a+b/c=d"), "a%2Bb%2Fc%3Dd");
        assert_eq!(urlencoded("abc_DEF.123-~"), "abc_DEF.123-~");
    }

    #[test]
    fn resolve_public_host_normalises_and_validates() {
        // No env var set → None.
        std::env::remove_var("JARVIS_PUBLIC_HOST");
        assert!(resolve_public_host().is_none());
        // Bare hostname → None (must be http(s)).
        std::env::set_var("JARVIS_PUBLIC_HOST", "abc.example");
        assert!(resolve_public_host().is_none());
        // Trailing slash trimmed.
        std::env::set_var("JARVIS_PUBLIC_HOST", "https://abc.example/");
        assert_eq!(resolve_public_host().as_deref(), Some("https://abc.example"));
        // Whitespace trimmed.
        std::env::set_var("JARVIS_PUBLIC_HOST", "  https://abc.example  ");
        assert_eq!(resolve_public_host().as_deref(), Some("https://abc.example"));
        std::env::remove_var("JARVIS_PUBLIC_HOST");
    }

    // `random_nonce_hex` was inlined into `WeComAppOAuth::sign_state`
    // when the OAuth flow moved behind the `ChannelOAuthCapability`
    // trait. The kind's own tests still exercise nonce inclusion in
    // the round-trip (see `channels_wecom_app::tests::oauth_state_*`).
}
