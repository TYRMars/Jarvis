//! Static-asset routes for the bundled web UI.
//!
//! `apps/jarvis-web/dist/` is folded into the `harness-server` binary at
//! compile time via [`include_dir!`], so the server ships
//! self-contained — no separate static-files step at deploy.
//!
//! Routes mounted by [`router`]:
//!
//! - `GET /ui`    — permanent redirect to `/ui/` (so trailing-slash
//!   relative paths in the HTML resolve correctly).
//! - `GET /ui/`   — `index.html`.
//! - `GET /ui/<path>` — file under the bundled directory; 404 if
//!   missing.
//!
//! `Content-Type` is picked by file extension via a tiny static map
//! to avoid pulling a `mime_guess` crate just for a handful of
//! types — extend the match arm when adding new asset types.

use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use include_dir::{include_dir, Dir};

use crate::state::AppState;

/// `apps/jarvis-web/dist/` relative to the `harness-server` crate manifest.
static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../apps/jarvis-web/dist");

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/ui", get(|| async { Redirect::permanent("/ui/") }))
        .route("/ui/", get(serve_index))
        .route("/ui/*path", get(serve_path))
}

async fn serve_index() -> Response {
    serve("index.html")
}

async fn serve_path(Path(path): Path<String>) -> Response {
    serve(&path)
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
            })
        }
    }

    fn app() -> axum::Router {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        full_router(AppState::new(Arc::new(agent)))
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .body(Body::empty())
            .unwrap()
    }

    fn first_asset_with_ext(ext: &str) -> String {
        // Walk the bundled tree depth-first. Vite emits hashed JS/CSS
        // under `assets/` while `index.html` sits at the root, so a
        // shallow `files()` scan misses the most interesting cases.
        fn walk<'a>(
            dir: &'a include_dir::Dir<'a>,
            ext: &str,
        ) -> Option<String> {
            for f in dir.files() {
                let path = f.path().to_string_lossy();
                if path.ends_with(ext) {
                    return Some(format!("/ui/{path}"));
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
    async fn redirect_from_ui_root() {
        let resp = app().oneshot(get("/ui")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::PERMANENT_REDIRECT);
        let location = resp.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "/ui/");
    }

    #[tokio::test]
    async fn serves_index_html() {
        let resp = app().oneshot(get("/ui/")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "text/html; charset=utf-8"
        );
        let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains("<!doctype html>"), "got: {text}");
        assert!(text.contains("Jarvis"), "got: {text}");
    }

    #[tokio::test]
    async fn serves_css_with_correct_mime() {
        let path = first_asset_with_ext(".css");
        let resp = app().oneshot(get(&path)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "text/css; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn serves_js_with_correct_mime() {
        let path = first_asset_with_ext(".js");
        let resp = app().oneshot(get(&path)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "text/javascript; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn missing_asset_returns_404() {
        let resp = app().oneshot(get("/ui/does-not-exist.txt")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
