//! [`RoutingProvider`] — an `LlmProvider` that picks the downstream
//! model per call based on classified difficulty.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{ChatRequest, ChatResponse, LlmProvider, LlmStream, Message, Result, TokenEstimator};

use crate::classify::Classifier;
use crate::tier::{RouterConfig, Tier};

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

    /// Resolve a tier to a concrete `(provider, model)`. A tier whose
    /// target provider isn't registered falls back to `fallback` but
    /// keeps the configured model string — better to run the intended
    /// model on a working provider than to silently drop the request.
    fn resolve(&self, tier: Tier) -> (Arc<dyn LlmProvider>, String) {
        let target = self.config.target(tier);
        let provider = self
            .providers
            .get(&target.provider)
            .cloned()
            .unwrap_or_else(|| self.fallback.clone());
        (provider, target.model.clone())
    }

    async fn decide(&self, req: &ChatRequest) -> (Arc<dyn LlmProvider>, String, Tier) {
        let tier = self.classifier.classify(last_user_text(&req.messages)).await;
        let (provider, model) = self.resolve(tier);
        (provider, model, tier)
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
        let (provider, model, tier) = self.decide(&req).await;
        tracing::debug!(tier = tier.as_str(), model = %model, "smart router picked model");
        req.model = model;
        provider.complete(req).await
    }

    async fn complete_stream(&self, mut req: ChatRequest) -> Result<LlmStream> {
        let (provider, model, tier) = self.decide(&req).await;
        tracing::debug!(tier = tier.as_str(), model = %model, "smart router picked model (stream)");
        req.model = model;
        provider.complete_stream(req).await
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
}
