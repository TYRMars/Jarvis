//! [`RoutingProvider`] — an `LlmProvider` that picks the downstream
//! model per call based on classified difficulty.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use harness_core::{
    ChatRequest, ChatResponse, LlmChunk, LlmProvider, LlmStream, Message, Result, TokenEstimator,
};

use crate::classify::Classifier;
use crate::tier::{RouterConfig, Tier};

/// Separator that stamps a routed `response_id` with the name of the
/// provider that minted it. ASCII unit separator — it never appears in a
/// real provider name or a provider-issued id, so the split back into
/// `(provider, id)` is unambiguous and round-trips losslessly.
const CHAIN_PROVIDER_SEP: char = '\u{1f}';

/// Prefix a provider-issued `response_id` with the routed provider name
/// so the *next* turn can tell which backend's server-side state the id
/// refers to. Inverse of [`unstamp_response_id`].
fn stamp_response_id(provider: &str, id: &str) -> String {
    format!("{provider}{CHAIN_PROVIDER_SEP}{id}")
}

/// Split a stamped id back into `(provider, original_id)`. Returns `None`
/// for an unstamped id (e.g. one minted before routing was enabled),
/// which the caller treats as "not safe to chain".
fn unstamp_response_id(stamped: &str) -> Option<(&str, &str)> {
    stamped.split_once(CHAIN_PROVIDER_SEP)
}

/// Wraps a set of already-built providers and routes each call to one of
/// them by tier. Construct it in the composition root and register it as
/// the primary provider entry: requests that resolve to the primary get
/// auto-tiered, while requests explicitly targeting a *different*
/// provider bypass routing (they never reach this wrapper).
pub struct RoutingProvider {
    /// Provider used when a tier's target names a provider absent from
    /// `providers` (misconfiguration) — and the source of the
    /// [`TokenEstimator`]. Always the primary provider in practice.
    fallback: Arc<dyn LlmProvider>,
    /// `provider name → impl`. The classifier picks a [`crate::ModelRef`];
    /// its `provider` field is looked up here.
    providers: HashMap<String, Arc<dyn LlmProvider>>,
    config: RouterConfig,
    classifier: Arc<dyn Classifier>,
}

impl RoutingProvider {
    pub fn new(
        fallback: Arc<dyn LlmProvider>,
        providers: HashMap<String, Arc<dyn LlmProvider>>,
        config: RouterConfig,
        classifier: Arc<dyn Classifier>,
    ) -> Self {
        Self {
            fallback,
            providers,
            config,
            classifier,
        }
    }

    /// Resolve a tier to a concrete `(provider, name, model)`. A tier whose
    /// target provider isn't registered falls back to `fallback` but
    /// keeps the configured provider name + model string — better to run
    /// the intended model on a working provider than to silently drop the
    /// request. The name identifies which backend a chain handle belongs
    /// to (see [`Self::reconcile_chain`]).
    fn resolve(&self, tier: Tier) -> (Arc<dyn LlmProvider>, String, String) {
        let target = self.config.target(tier);
        let provider = self
            .providers
            .get(&target.provider)
            .cloned()
            .unwrap_or_else(|| self.fallback.clone());
        (provider, target.provider.clone(), target.model.clone())
    }

    async fn decide(&self, req: &ChatRequest) -> (Arc<dyn LlmProvider>, String, String, Tier) {
        let tier = self.classifier.classify(last_user_text(&req.messages)).await;
        let (provider, name, model) = self.resolve(tier);
        (provider, name, model, tier)
    }

    /// Drop Responses-API chain handles when they were minted by a
    /// *different* provider than the one this call routes to. The router
    /// re-classifies every request, so two turns of one conversation can
    /// land on different backends; `previous_response_id` / `chain_origin`
    /// are opaque, provider-private server-state handles that are invalid
    /// when replayed against a backend that never issued them — best case
    /// silently ignored (the agent then trusts server-side state the new
    /// provider never had and drops real history), worst case a hard 400
    /// on a Responses target. When the provider matches, strip our stamp
    /// and forward the original id so chaining keeps working.
    fn reconcile_chain(&self, req: &mut ChatRequest, resolved: &str) {
        let original = req
            .previous_response_id
            .as_deref()
            .and_then(unstamp_response_id)
            .filter(|(provider, _)| *provider == resolved)
            .map(|(_, id)| id.to_string());
        match original {
            Some(id) => req.previous_response_id = Some(id),
            None => {
                req.previous_response_id = None;
                req.chain_origin = None;
            }
        }
    }
}

/// Latest user message text, scanning from the end. During a tool loop
/// the trailing message is a `Tool` result, so this naturally pins the
/// classification to the user's actual ask and keeps the tier stable
/// across the loop's iterations. Empty when there's no user message.
fn last_user_text(messages: &[Message]) -> &str {
    messages
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .unwrap_or("")
}

#[async_trait]
impl LlmProvider for RoutingProvider {
    async fn complete(&self, mut req: ChatRequest) -> Result<ChatResponse> {
        let (provider, name, model, tier) = self.decide(&req).await;
        tracing::debug!(tier = tier.as_str(), provider = %name, model = %model, "smart router picked model");
        req.model = model;
        self.reconcile_chain(&mut req, &name);
        let mut resp = provider.complete(req).await?;
        // Stamp the id we hand back so the next turn can detect a switch.
        if let Some(id) = resp.response_id {
            resp.response_id = Some(stamp_response_id(&name, &id));
        }
        Ok(resp)
    }

    async fn complete_stream(&self, mut req: ChatRequest) -> Result<LlmStream> {
        let (provider, name, model, tier) = self.decide(&req).await;
        tracing::debug!(tier = tier.as_str(), provider = %name, model = %model, "smart router picked model (stream)");
        req.model = model;
        self.reconcile_chain(&mut req, &name);
        let stream = provider.complete_stream(req).await?;
        // Mirror the blocking path: re-stamp the terminal Finish's
        // response_id with the routed provider so chaining stays correct.
        let stamped = stream.map(move |chunk| {
            chunk.map(|c| match c {
                LlmChunk::Finish {
                    message,
                    finish_reason,
                    response_id,
                } => LlmChunk::Finish {
                    message,
                    finish_reason,
                    response_id: response_id.map(|id| stamp_response_id(&name, &id)),
                },
                other => other,
            })
        });
        Ok(Box::pin(stamped))
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        self.fallback.estimator()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::FinishReason;

    use crate::tier::ModelRef;

    /// Echoes the provider tag + the model it was asked to run, so tests
    /// can assert both the chosen provider and the rewritten model.
    struct EchoProvider {
        tag: &'static str,
    }

    #[async_trait]
    impl LlmProvider for EchoProvider {
        async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text(format!("{}:{}", self.tag, req.model)),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    struct FixedClassifier(Tier);

    #[async_trait]
    impl Classifier for FixedClassifier {
        async fn classify(&self, _last_user_message: &str) -> Tier {
            self.0
        }
    }

    fn providers() -> HashMap<String, Arc<dyn LlmProvider>> {
        let mut m: HashMap<String, Arc<dyn LlmProvider>> = HashMap::new();
        m.insert("openai".into(), Arc::new(EchoProvider { tag: "openai" }));
        m.insert("anthropic".into(), Arc::new(EchoProvider { tag: "anthropic" }));
        m
    }

    fn body(resp: ChatResponse) -> String {
        match resp.message {
            Message::Assistant { content, .. } => content.unwrap_or_default(),
            _ => panic!("expected assistant message"),
        }
    }

    #[tokio::test]
    async fn routes_tier_to_configured_provider_and_model() {
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Complex, ModelRef::new("anthropic", "claude-opus"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(EchoProvider { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Complex)),
        );
        // Incoming model is ignored — routing overrides it.
        let resp = rp
            .complete(ChatRequest {
                model: "ignored".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(body(resp), "anthropic:claude-opus");
    }

    #[tokio::test]
    async fn unconfigured_tier_uses_default_target() {
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(EchoProvider { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Medium)),
        );
        let resp = rp.complete(ChatRequest::default()).await.unwrap();
        // Medium unmapped → default openai/gpt-4o-mini.
        assert_eq!(body(resp), "openai:gpt-4o-mini");
    }

    #[tokio::test]
    async fn unknown_provider_falls_back_but_keeps_model() {
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Simple, ModelRef::new("ghost", "tiny"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(EchoProvider { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Simple)),
        );
        let resp = rp.complete(ChatRequest::default()).await.unwrap();
        // "ghost" not registered → fallback provider, configured model.
        assert_eq!(body(resp), "fb:tiny");
    }

    #[tokio::test]
    async fn classification_reads_last_user_message() {
        // A real heuristic + a trailing tool result: the tier must be
        // taken from the user's ask, not the tool message.
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Simple, ModelRef::new("openai", "cheap"))
            .with_tier(Tier::Complex, ModelRef::new("anthropic", "claude-opus"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(EchoProvider { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            providers(),
            cfg,
            Arc::new(crate::HeuristicClassifier::default()),
        );
        let req = ChatRequest {
            messages: vec![
                Message::user("please refactor the parser"),
                Message::tool_result("call_1", "done"),
            ],
            ..Default::default()
        };
        // "refactor" keyword ⇒ Complex ⇒ anthropic/claude-opus.
        assert_eq!(body(rp.complete(req).await.unwrap()), "anthropic:claude-opus");
    }

    /// Echoes the provider tag plus the chain handles it received, and
    /// mints a fixed `response_id`, so chain-reconciliation can be
    /// asserted on both the blocking and streaming paths.
    struct ChainEcho {
        tag: &'static str,
    }

    impl ChainEcho {
        fn echo(req: &ChatRequest, tag: &str) -> Message {
            let prev = req
                .previous_response_id
                .clone()
                .unwrap_or_else(|| "none".into());
            let origin = req
                .chain_origin
                .map(|o| o.to_string())
                .unwrap_or_else(|| "none".into());
            Message::assistant_text(format!("{tag}|prev={prev}|origin={origin}"))
        }
    }

    #[async_trait]
    impl LlmProvider for ChainEcho {
        async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
            Ok(ChatResponse {
                message: Self::echo(&req, self.tag),
                finish_reason: FinishReason::Stop,
                response_id: Some("resp_xyz".into()),
                usage: None,
            })
        }

        async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
            let chunk = LlmChunk::Finish {
                message: Self::echo(&req, self.tag),
                finish_reason: FinishReason::Stop,
                response_id: Some("resp_xyz".into()),
            };
            Ok(Box::pin(futures::stream::once(async move { Ok(chunk) })))
        }
    }

    fn chain_providers() -> HashMap<String, Arc<dyn LlmProvider>> {
        let mut m: HashMap<String, Arc<dyn LlmProvider>> = HashMap::new();
        m.insert("openai".into(), Arc::new(ChainEcho { tag: "openai" }));
        m.insert("anthropic".into(), Arc::new(ChainEcho { tag: "anthropic" }));
        m
    }

    #[tokio::test]
    async fn same_provider_preserves_and_unstamps_chain() {
        // Last turn's id was minted by openai; this turn also routes to
        // openai, so the original id + chain_origin must be forwarded.
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(ChainEcho { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            chain_providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Simple)),
        );
        let req = ChatRequest {
            previous_response_id: Some(stamp_response_id("openai", "resp_xyz")),
            chain_origin: Some(3),
            ..Default::default()
        };
        let resp = rp.complete(req).await.unwrap();
        // Outgoing id is re-stamped for the next turn…
        assert_eq!(
            resp.response_id.as_deref(),
            Some(stamp_response_id("openai", "resp_xyz").as_str())
        );
        // …and the provider saw the unstamped id + origin.
        assert_eq!(body(resp), "openai|prev=resp_xyz|origin=3");
    }

    #[tokio::test]
    async fn cross_provider_clears_chain() {
        // Last turn's id was minted by openai but this turn routes to
        // anthropic: the foreign handle must be dropped, not forwarded.
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Complex, ModelRef::new("anthropic", "claude-opus"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(ChainEcho { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            chain_providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Complex)),
        );
        let req = ChatRequest {
            previous_response_id: Some(stamp_response_id("openai", "resp_xyz")),
            chain_origin: Some(3),
            ..Default::default()
        };
        let resp = rp.complete(req).await.unwrap();
        assert_eq!(body(resp), "anthropic|prev=none|origin=none");
    }

    #[tokio::test]
    async fn untagged_chain_is_cleared() {
        // A handle with no provider stamp (e.g. minted before routing was
        // enabled) can't be proven safe → drop it conservatively.
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(ChainEcho { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            chain_providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Simple)),
        );
        let req = ChatRequest {
            previous_response_id: Some("resp_legacy".into()),
            chain_origin: Some(2),
            ..Default::default()
        };
        let resp = rp.complete(req).await.unwrap();
        assert_eq!(body(resp), "openai|prev=none|origin=none");
    }

    #[tokio::test]
    async fn stream_cross_provider_clears_and_restamps() {
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Complex, ModelRef::new("anthropic", "claude-opus"));
        let fallback: Arc<dyn LlmProvider> = Arc::new(ChainEcho { tag: "fb" });
        let rp = RoutingProvider::new(
            fallback,
            chain_providers(),
            cfg,
            Arc::new(FixedClassifier(Tier::Complex)),
        );
        let req = ChatRequest {
            previous_response_id: Some(stamp_response_id("openai", "resp_xyz")),
            chain_origin: Some(3),
            ..Default::default()
        };
        let mut stream = rp.complete_stream(req).await.unwrap();
        let mut last = None;
        while let Some(item) = stream.next().await {
            last = Some(item.unwrap());
        }
        match last.expect("stream yielded no chunks") {
            LlmChunk::Finish {
                message,
                response_id,
                ..
            } => {
                let text = match message {
                    Message::Assistant { content, .. } => content.unwrap_or_default(),
                    _ => panic!("expected assistant message"),
                };
                assert_eq!(text, "anthropic|prev=none|origin=none");
                // Re-stamped with the routed provider (anthropic).
                assert_eq!(
                    response_id.as_deref(),
                    Some(stamp_response_id("anthropic", "resp_xyz").as_str())
                );
            }
            _ => panic!("expected Finish chunk"),
        }
    }
}
