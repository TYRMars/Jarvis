//! Static-asset routes for the bundled web UI.
//!
//! `apps/jarvis-web/dist/` is folded into the `harness-server` binary at
//! compile time via [`include_dir!`], so the server ships
//! self-contained — no separate static-files step at deploy.
//!
//! Routes mounted by [`router`]:
//!
//! - `GET /` — `index.html`.
//! - `GET /assets/*` (and any other extensioned path) — looked up
//!   against the bundled directory; 404 if missing.
//!
//! [`spa_fallback`] is exported so the main router can wire it as
//! the catch-all `.fallback(...)` handler. It serves `index.html`
//! for unknown extension-less paths (the SPA's client-side routes
//! like `/settings`) while still 404'ing missing assets and
//! anything under `/v1/` or `/health` (defence in depth — those
//! are exact-match in the parent router).
//!
//! `Content-Type` is picked by file extension via a tiny static map
//! to avoid pulling a `mime_guess` crate just for a handful of
//! types — extend the match arm when adding new asset types.

use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use include_dir::{include_dir, Dir};

use crate::state::AppState;

/// `apps/jarvis-web/dist/` relative to the `harness-server` crate manifest.
static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../apps/jarvis-web/dist");

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/", get(serve_index))
}

async fn serve_index() -> Response {
    serve("index.html")
}

/// Catch-all fallback the parent router wires up. Three behaviours,
/// chosen by the request path:
///
/// 1. Looks like an API surface (`/v1/...`, `/health`) → 404 JSON.
///    The parent router already routes those exactly; this branch
///    is defence-in-depth so a typo doesn't accidentally serve HTML.
/// 2. Has a file extension (e.g. `.js`, `.css`, `.png`) → look up
///    in the bundled asset tree, serve or 404. Asset typos must
///    fail loudly — silently serving HTML for a missing JS file
///    would mask deploy mistakes.
/// 3. Anything else → serve `index.html`. This is the SPA fallback
///    that lets React Router own `/settings`, `/conversations/:id`,
///    etc. without a server-side route entry per page.
pub(crate) async fn spa_fallback(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Defence in depth — these paths should never reach the fallback
    // because the parent router has exact handlers, but if a future
    // refactor drops one, returning HTML would be the worst outcome.
    if path == "health" || path.starts_with("v1/") || path == "v1" {
        return StatusCode::NOT_FOUND.into_response();
    }

    if path_looks_like_asset(path) {
        return match ASSETS.get_file(path) {
            Some(file) => (
                [(header::CONTENT_TYPE, content_type(path))],
                file.contents(),
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }

    serve("index.html")
}

/// "Asset-like" = has a file extension on the last path segment.
/// React Router paths (`/settings`, `/conversations/abc-123`) are
/// extension-less, so this cleanly partitions the namespace.
fn path_looks_like_asset(path: &str) -> bool {
    let last = path.rsplit_once('/').map(|(_, t)| t).unwrap_or(path);
    last.contains('.')
}

fn serve(path: &str) -> Response {
    // Defence in depth: `axum::extract::Path` already rejects `..`
    // segments at routing time, but check anyway in case the helper
    // is ever called with caller-supplied input.
    if path.contains("..") || path.starts_with('/') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let target = if path.is_empty() { "index.html" } else { path };
    match ASSETS.get_file(target) {
        Some(file) => (
            [(header::CONTENT_TYPE, content_type(target))],
            file.contents(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use crate::router as full_router;
    use crate::AppState;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    struct NoopLlm;
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
            })
        }
    }

    fn app() -> axum::Router {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        full_router(AppState::new(Arc::new(agent)))
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder().uri(path).body(Body::empty()).unwrap()
    }

    fn first_asset_with_ext(ext: &str) -> String {
        // Walk the bundled tree depth-first. Vite emits hashed JS/CSS
        // under `assets/` while `index.html` sits at the root, so a
        // shallow `files()` scan misses the most interesting cases.
        fn walk<'a>(dir: &'a include_dir::Dir<'a>, ext: &str) -> Option<String> {
            for f in dir.files() {
                let path = f.path().to_string_lossy();
                if path.ends_with(ext) {
                    return Some(format!("/{path}"));
                }
            }
            for d in dir.dirs() {
                if let Some(hit) = walk(d, ext) {
                    return Some(hit);
                }
            }
            None
        }
        walk(&super::ASSETS, ext).expect("frontend asset should exist")
    }

    #[tokio::test]
    async fn root_serves_index_html() {
        let resp = app().oneshot(get("/")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "text/html; charset=utf-8"
        );
        let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains("<!doctype html>"), "got: {text}");
        assert!(text.contains("Jarvis"), "got: {text}");
    }

    #[tokio::test]
    async fn spa_route_serves_index_html() {
        // `/settings` has no server-side handler — the SPA fallback
        // must serve `index.html` so React Router can render the
        // matching page client-side.
        let resp = app().oneshot(get("/settings")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn nested_spa_route_serves_index_html() {
        let resp = app().oneshot(get("/conversations/abc-123")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn serves_css_with_correct_mime() {
        let path = first_asset_with_ext(".css");
        let resp = app().oneshot(get(&path)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "text/css; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn serves_js_with_correct_mime() {
        let path = first_asset_with_ext(".js");
        let resp = app().oneshot(get(&path)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap(),
            "text/javascript; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn missing_asset_path_returns_404() {
        // Has an extension → fallback treats as asset and 404s
        // (vs. SPA route which has no extension and serves index.html).
        let resp = app().oneshot(get("/does-not-exist.txt")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_v1_endpoint_returns_404_not_html() {
        let resp = app().oneshot(get("/v1/missing-endpoint")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // Critical: must NOT serve HTML, otherwise SDK clients
        // would parse the SPA's `<!doctype html>` as JSON and explode
        // with confusing errors instead of a clean 404.
        let ctype = resp
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap_or(""))
            .unwrap_or("");
        assert!(!ctype.contains("text/html"), "got content-type: {ctype}");
    }
}
