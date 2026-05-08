//! Provider-level fallback wrapper — Phase 4 retry layer.
//!
//! [`FallbackProvider`] wraps a primary [`LlmProvider`] plus an
//! ordered chain of `(name, Arc<dyn LlmProvider>)` fallbacks. On a
//! transient upstream failure (429 / 5xx / timeout / connect error)
//! it walks the chain in order, returning the first successful
//! result. Non-transient failures (auth / 4xx other than 429 / model-
//! invalid) propagate immediately — fallback semantics are "this
//! provider is unhealthy *right now*", not "this request is wrong".
//!
//! Streaming:
//! - If `complete_stream` resolves with `Err(...)` synchronously
//!   (e.g. the auth round-trip failed before the SSE handshake), we
//!   retry against the next fallback.
//! - If it resolves with `Ok(stream)` and the stream itself errors
//!   later, we propagate. Mid-stream retries would replay tokens
//!   the user already saw — bad UX. The single mode you'd want
//!   ("retry from scratch on early stream error") is rare enough
//!   to defer.
//!
//! Why a transparent wrapper rather than per-callsite retries:
//! - Every transport (HTTP / SSE / WS / CLI) and every internal
//!   subagent goes through the trait, so the retry policy applies
//!   uniformly.
//! - The wrapper adds zero overhead when the primary succeeds —
//!   it's an `Arc::clone` and one `match` on the result.
//!
//! The composition root (apps/jarvis) decides which providers get
//! wrapped. Today it wraps the *default* registry entry only.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    emit_fallback, ChatRequest, ChatResponse, Error, FallbackEvent, LlmProvider, LlmStream, Result,
    TokenEstimator,
};
use tracing::{info, warn};

/// One named entry in the fallback chain. `name` is informational
/// (logged + surfaced via tracing) and matches the registry-side
/// provider name when applicable.
#[derive(Clone)]
pub struct FallbackEntry {
    pub name: String,
    pub provider: Arc<dyn LlmProvider>,
}

impl FallbackEntry {
    pub fn new(name: impl Into<String>, provider: Arc<dyn LlmProvider>) -> Self {
        Self {
            name: name.into(),
            provider,
        }
    }
}

/// Wraps a primary provider + ordered fallback chain. Identical
/// surface to [`LlmProvider`] so callers have nothing to migrate.
pub struct FallbackProvider {
    primary_name: String,
    primary: Arc<dyn LlmProvider>,
    fallbacks: Vec<FallbackEntry>,
}

impl FallbackProvider {
    /// Construct a wrapper. `primary_name` is the registry name of
    /// the wrapped provider (used in tracing). `fallbacks` is the
    /// ordered chain — entries with the same name as `primary_name`
    /// are dropped to avoid retry-self.
    pub fn new(
        primary_name: impl Into<String>,
        primary: Arc<dyn LlmProvider>,
        fallbacks: Vec<FallbackEntry>,
    ) -> Self {
        let primary_name = primary_name.into();
        let fallbacks = fallbacks
            .into_iter()
            .filter(|f| f.name != primary_name)
            .collect();
        Self {
            primary_name,
            primary,
            fallbacks,
        }
    }

    /// Number of registered fallback entries (useful for startup
    /// log lines and tests).
    pub fn fallback_count(&self) -> usize {
        self.fallbacks.len()
    }
}

/// Heuristic — is this error worth retrying against the next
/// provider? Wraps the same string-matching logic the probe
/// endpoint uses for auth detection, but inverted: 4xx auth
/// failures are *not* transient (the next provider has the same
/// auth surface, retrying won't help), but 429 rate-limits and
/// 5xx server failures and connection-level errors are.
pub fn is_transient_error(err: &Error) -> bool {
    let msg = err.to_string().to_lowercase();
    // Definite-not-transient: auth + bad-request signals.
    let auth_or_bad_request = msg.contains("401")
        || msg.contains("403")
        || msg.contains("unauthorized")
        || msg.contains("invalid api key")
        || msg.contains("authentication");
    if auth_or_bad_request {
        return false;
    }
    // Transient: rate limit / server error / network.
    msg.contains("429")
        || msg.contains("rate limit")
        || msg.contains("rate-limit")
        || msg.contains("rate_limit")
        || msg.contains("500")
        || msg.contains("502")
        || msg.contains("503")
        || msg.contains("504")
        || msg.contains("timeout")
        || msg.contains("timed out")
        || msg.contains("connection")
        || msg.contains("network")
        || msg.contains("dns")
        || msg.contains("reset by peer")
}

#[async_trait]
impl LlmProvider for FallbackProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        match self.primary.complete(req.clone()).await {
            Ok(resp) => Ok(resp),
            Err(e) if !is_transient_error(&e) => Err(e),
            Err(first_error) => {
                warn!(
                    primary = %self.primary_name,
                    error = %first_error,
                    fallback_count = self.fallbacks.len(),
                    "primary provider failed; trying fallback chain",
                );
                let mut last = first_error;
                for entry in &self.fallbacks {
                    info!(
                        from = %self.primary_name,
                        to = %entry.name,
                        "trying fallback provider",
                    );
                    emit_fallback(FallbackEvent::new(
                        self.primary_name.clone(),
                        entry.name.clone(),
                        req.model.clone(),
                        last.to_string(),
                        false,
                    ));
                    match entry.provider.complete(req.clone()).await {
                        Ok(resp) => {
                            info!(
                                from = %self.primary_name,
                                to = %entry.name,
                                "fallback provider succeeded",
                            );
                            return Ok(resp);
                        }
                        Err(e) if !is_transient_error(&e) => return Err(e),
                        Err(e) => {
                            warn!(
                                provider = %entry.name,
                                error = %e,
                                "fallback provider also failed; trying next",
                            );
                            last = e;
                        }
                    }
                }
                Err(last)
            }
        }
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        match self.primary.complete_stream(req.clone()).await {
            Ok(stream) => Ok(stream),
            Err(e) if !is_transient_error(&e) => Err(e),
            Err(first_error) => {
                warn!(
                    primary = %self.primary_name,
                    error = %first_error,
                    fallback_count = self.fallbacks.len(),
                    "primary stream failed; trying fallback chain",
                );
                let mut last = first_error;
                for entry in &self.fallbacks {
                    info!(
                        from = %self.primary_name,
                        to = %entry.name,
                        "trying fallback provider (stream)",
                    );
                    emit_fallback(FallbackEvent::new(
                        self.primary_name.clone(),
                        entry.name.clone(),
                        req.model.clone(),
                        last.to_string(),
                        true,
                    ));
                    match entry.provider.complete_stream(req.clone()).await {
                        Ok(stream) => {
                            info!(
                                from = %self.primary_name,
                                to = %entry.name,
                                "fallback provider stream succeeded",
                            );
                            return Ok(stream);
                        }
                        Err(e) if !is_transient_error(&e) => return Err(e),
                        Err(e) => {
                            warn!(
                                provider = %entry.name,
                                error = %e,
                                "fallback provider stream also failed; trying next",
                            );
                            last = e;
                        }
                    }
                }
                Err(last)
            }
        }
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        // Token estimation is a per-provider concern (different
        // tokenisers per model family). The wrapper inherits the
        // primary's estimator since memory budgeting / cache-key
        // hashing should match the typical / non-fallback path.
        self.primary.estimator()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{ChatResponse, FinishReason, Message};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Stub provider that returns whatever its `outcome` callback
    /// produces, with an atomic counter to verify call ordering.
    struct StubProvider {
        outcome: Box<dyn Fn() -> Result<ChatResponse> + Send + Sync>,
        calls: AtomicUsize,
    }

    impl StubProvider {
        fn ok(label: &'static str) -> Arc<Self> {
            Arc::new(Self {
                outcome: Box::new(move || {
                    Ok(ChatResponse {
                        message: Message::assistant_text(label),
                        finish_reason: FinishReason::Stop,
                        response_id: None,
                        usage: None,
                    })
                }),
                calls: AtomicUsize::new(0),
            })
        }

        fn err(message: &'static str) -> Arc<Self> {
            Arc::new(Self {
                outcome: Box::new(move || Err(Error::Provider(message.to_string()))),
                calls: AtomicUsize::new(0),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl LlmProvider for StubProvider {
        async fn complete(&self, _req: ChatRequest) -> Result<ChatResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            (self.outcome)()
        }
    }

    fn req() -> ChatRequest {
        ChatRequest {
            model: "test".into(),
            messages: vec![Message::User {
                content: "hi".into(),
                cache: None,
            }],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn primary_success_skips_fallbacks() {
        let primary = StubProvider::ok("primary");
        let fb = StubProvider::ok("fb");
        let wrapper = FallbackProvider::new(
            "primary",
            primary.clone() as Arc<dyn LlmProvider>,
            vec![FallbackEntry::new("fb", fb.clone() as Arc<dyn LlmProvider>)],
        );
        let resp = wrapper.complete(req()).await.unwrap();
        assert_eq!(primary.calls(), 1);
        assert_eq!(
            fb.calls(),
            0,
            "fallback must not be called when primary succeeds"
        );
        match resp.message {
            Message::Assistant { content, .. } => {
                assert_eq!(content.as_deref(), Some("primary"));
            }
            _ => panic!("unexpected message"),
        }
    }

    #[tokio::test]
    async fn primary_429_walks_to_first_fallback() {
        let primary = StubProvider::err("HTTP 429 Too Many Requests");
        let fb1 = StubProvider::ok("fb1");
        let fb2 = StubProvider::ok("fb2");
        let wrapper = FallbackProvider::new(
            "primary",
            primary.clone() as Arc<dyn LlmProvider>,
            vec![
                FallbackEntry::new("fb1", fb1.clone() as Arc<dyn LlmProvider>),
                FallbackEntry::new("fb2", fb2.clone() as Arc<dyn LlmProvider>),
            ],
        );
        let resp = wrapper.complete(req()).await.unwrap();
        assert_eq!(primary.calls(), 1);
        assert_eq!(fb1.calls(), 1);
        assert_eq!(
            fb2.calls(),
            0,
            "second fallback shouldn't fire after fb1 succeeds"
        );
        match resp.message {
            Message::Assistant { content, .. } => {
                assert_eq!(content.as_deref(), Some("fb1"));
            }
            _ => panic!("unexpected message"),
        }
    }

    #[tokio::test]
    async fn auth_failure_does_not_walk_chain() {
        let primary = StubProvider::err("HTTP 401 Unauthorized: invalid api key");
        let fb = StubProvider::ok("fb");
        let wrapper = FallbackProvider::new(
            "primary",
            primary.clone() as Arc<dyn LlmProvider>,
            vec![FallbackEntry::new("fb", fb.clone() as Arc<dyn LlmProvider>)],
        );
        let err = wrapper.complete(req()).await.unwrap_err();
        assert!(err.to_string().contains("401"));
        assert_eq!(primary.calls(), 1);
        assert_eq!(fb.calls(), 0, "auth failures must not trigger fallback");
    }

    #[tokio::test]
    async fn all_transient_failures_returns_last_error() {
        let primary = StubProvider::err("503 Service Unavailable");
        let fb1 = StubProvider::err("502 Bad Gateway");
        let fb2 = StubProvider::err("connection reset by peer");
        let wrapper = FallbackProvider::new(
            "primary",
            primary.clone() as Arc<dyn LlmProvider>,
            vec![
                FallbackEntry::new("fb1", fb1.clone() as Arc<dyn LlmProvider>),
                FallbackEntry::new("fb2", fb2.clone() as Arc<dyn LlmProvider>),
            ],
        );
        let err = wrapper.complete(req()).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("connection reset by peer"), "got: {msg}");
        assert_eq!(primary.calls(), 1);
        assert_eq!(fb1.calls(), 1);
        assert_eq!(fb2.calls(), 1);
    }

    #[tokio::test]
    async fn self_referencing_fallback_is_dropped() {
        let primary = StubProvider::ok("primary");
        let fb_self = StubProvider::ok("primary");
        let wrapper = FallbackProvider::new(
            "primary",
            primary.clone() as Arc<dyn LlmProvider>,
            vec![FallbackEntry::new(
                "primary",
                fb_self.clone() as Arc<dyn LlmProvider>,
            )],
        );
        assert_eq!(
            wrapper.fallback_count(),
            0,
            "fallback that references the primary by name should be filtered out"
        );
    }

    #[test]
    fn is_transient_classifier_covers_common_signals() {
        assert!(is_transient_error(&Error::Provider(
            "HTTP 429 too many".into()
        )));
        assert!(is_transient_error(&Error::Provider("500 internal".into())));
        assert!(is_transient_error(&Error::Provider(
            "connection refused".into()
        )));
        assert!(is_transient_error(&Error::Provider(
            "request timed out".into()
        )));
        assert!(is_transient_error(&Error::Provider(
            "rate_limit_exceeded".into()
        )));

        assert!(!is_transient_error(&Error::Provider("HTTP 401".into())));
        assert!(!is_transient_error(&Error::Provider(
            "invalid api key".into()
        )));
        assert!(!is_transient_error(&Error::Provider(
            "model not found".into()
        )));
        assert!(!is_transient_error(&Error::Provider("400 bad json".into())));
    }
}
