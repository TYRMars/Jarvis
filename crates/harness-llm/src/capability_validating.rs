//! Capability-validating provider wrapper.
//!
//! Wraps any [`LlmProvider`] together with a snapshot of
//! [`ModelCapability`] entries from the provider's catalog. Every
//! request is validated against the matching model's flags before
//! forwarding:
//!
//! - **Tool calls vs `supports_tool_calls=false`** — when the request
//!   carries `tools` and the model is known to lack tool support, we
//!   short-circuit with a clear `Error::Provider` so the caller sees
//!   "model X doesn't do tools" instead of an obscure 400 from the
//!   upstream API.
//! - **Parallel tool calls vs `supports_parallel_tool_calls=false`** —
//!   when the request opts in but the catalog says no, we silently
//!   downgrade `parallel_tool_calls` to `None` and emit a
//!   `tracing::warn!`. The agent loop's parallel dispatch is
//!   harmless on a model that emits one call at a time, so we don't
//!   need to bubble this back to the caller.
//!
//! Models *not* in the catalog pass through unchanged — capability
//! data is best-effort, not a gate. Composition roots that want
//! strict gating can populate the catalog more aggressively.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{ChatRequest, ChatResponse, Error, LlmProvider, LlmStream, Result, TokenEstimator};
use tracing::{debug, warn};

use crate::profile::ModelCapability;

/// Wraps a primary provider with capability validation. Identical
/// surface to [`LlmProvider`] so callers have nothing to migrate.
pub struct CapabilityValidatingProvider {
    inner: Arc<dyn LlmProvider>,
    /// Snapshot of capability rows for this provider's catalog. Cheap
    /// to clone (Arc'd) and the lookup is a linear scan — model
    /// catalogs are small (~10s of rows) so a HashMap would be more
    /// machinery than payoff.
    capabilities: Arc<Vec<ModelCapability>>,
}

impl CapabilityValidatingProvider {
    pub fn new(inner: Arc<dyn LlmProvider>, capabilities: Vec<ModelCapability>) -> Self {
        Self {
            inner,
            capabilities: Arc::new(capabilities),
        }
    }

    /// Reuse an already-shared capability snapshot. Useful when the
    /// composition root holds an `Arc<Vec<ModelCapability>>` keyed off
    /// the provider's profile and constructs many wrappers without
    /// re-cloning the table per call.
    pub fn with_shared(inner: Arc<dyn LlmProvider>, capabilities: Arc<Vec<ModelCapability>>) -> Self {
        Self { inner, capabilities }
    }

    /// Look up the row for `model`, if any. Match by exact `model`
    /// string only — the catalog stores wire model ids and the
    /// caller's `ChatRequest::model` is what we send upstream, so
    /// these strings line up by construction.
    fn lookup(&self, model: &str) -> Option<&ModelCapability> {
        self.capabilities.iter().find(|c| c.model == model)
    }

    /// Apply the gating rules. Returns the (possibly-mutated) request
    /// or a hard error when the request is incompatible with the
    /// model. Mutations:
    /// - Set `parallel_tool_calls` to `None` when the model is known
    ///   to not support it (silent downgrade + warn).
    fn validate_and_adjust(&self, mut req: ChatRequest) -> Result<ChatRequest> {
        let cap = match self.lookup(&req.model) {
            Some(c) => c,
            // Unknown model → passthrough. Don't gate what we don't
            // know — composition roots can populate the catalog more
            // aggressively when stricter behaviour is wanted.
            None => return Ok(req),
        };

        if !req.tools.is_empty() && cap.supports_tool_calls == Some(false) {
            return Err(Error::Provider(format!(
                "model `{}` does not support tool calls; pick another model or remove tools from the request",
                req.model
            )));
        }

        if req.parallel_tool_calls == Some(true)
            && cap.supports_parallel_tool_calls == Some(false)
        {
            warn!(
                model = %req.model,
                "downgrading parallel_tool_calls=true to None — model lacks supports_parallel_tool_calls",
            );
            req.parallel_tool_calls = None;
        }

        Ok(req)
    }
}

#[async_trait]
impl LlmProvider for CapabilityValidatingProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let req = self.validate_and_adjust(req)?;
        debug!(model = %req.model, "capability-validated request");
        self.inner.complete(req).await
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let req = self.validate_and_adjust(req)?;
        debug!(model = %req.model, "capability-validated stream request");
        self.inner.complete_stream(req).await
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        self.inner.estimator()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{FinishReason, Message};

    #[derive(Default)]
    struct StubProvider {
        last_req: tokio::sync::Mutex<Option<ChatRequest>>,
    }

    #[async_trait]
    impl LlmProvider for StubProvider {
        async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
            *self.last_req.lock().await = Some(req.clone());
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    fn cap(model: &str) -> ModelCapability {
        ModelCapability {
            provider: "test".into(),
            model: model.into(),
            display_name: None,
            family: None,
            context_window: None,
            max_output_tokens: None,
            input_modalities: vec![],
            output_modalities: vec![],
            supports_streaming: None,
            supports_tool_calls: None,
            supports_parallel_tool_calls: None,
            supports_json_schema: None,
            supports_reasoning: None,
            supports_prompt_cache: None,
            supports_images: None,
            supports_embeddings: None,
            cost_hint: crate::profile::CostHint::Unknown,
            latency_hint: crate::profile::LatencyHint::Unknown,
            privacy_hint: crate::profile::PrivacyHint::Unknown,
        }
    }

    use harness_core::ToolSpec;
    use serde_json::json;

    fn req(model: &str) -> ChatRequest {
        ChatRequest {
            model: model.into(),
            messages: vec![Message::user("hi")],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn unknown_model_passes_through() {
        let stub = Arc::new(StubProvider::default());
        let mut c = cap("known");
        c.supports_tool_calls = Some(false);
        let wrapped = CapabilityValidatingProvider::new(stub.clone(), vec![c]);
        // model not in catalog — request goes through unmodified
        let mut r = req("unknown");
        r.tools.push(ToolSpec {
            name: "echo".into(),
            description: "".into(),
            parameters: json!({}),
            cacheable: false,
        });
        let res = wrapped.complete(r).await;
        assert!(res.is_ok());
    }

    #[tokio::test]
    async fn rejects_tool_request_when_model_lacks_support() {
        let stub = Arc::new(StubProvider::default());
        let mut c = cap("no-tools");
        c.supports_tool_calls = Some(false);
        let wrapped = CapabilityValidatingProvider::new(stub, vec![c]);
        let mut r = req("no-tools");
        r.tools.push(ToolSpec {
            name: "echo".into(),
            description: "".into(),
            parameters: json!({}),
            cacheable: false,
        });
        let err = wrapped.complete(r).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("does not support tool calls"), "{msg}");
        assert!(msg.contains("no-tools"), "{msg}");
    }

    #[tokio::test]
    async fn allows_tool_request_when_model_supports_it() {
        let stub = Arc::new(StubProvider::default());
        let mut c = cap("tools-ok");
        c.supports_tool_calls = Some(true);
        let wrapped = CapabilityValidatingProvider::new(stub.clone(), vec![c]);
        let mut r = req("tools-ok");
        r.tools.push(ToolSpec {
            name: "echo".into(),
            description: "".into(),
            parameters: json!({}),
            cacheable: false,
        });
        wrapped.complete(r).await.unwrap();
    }

    #[tokio::test]
    async fn allows_tool_request_when_capability_unknown() {
        let stub = Arc::new(StubProvider::default());
        let c = cap("dunno");
        // supports_tool_calls = None — best-effort: don't gate
        let wrapped = CapabilityValidatingProvider::new(stub, vec![c]);
        let mut r = req("dunno");
        r.tools.push(ToolSpec {
            name: "echo".into(),
            description: "".into(),
            parameters: json!({}),
            cacheable: false,
        });
        wrapped.complete(r).await.unwrap();
    }

    #[tokio::test]
    async fn downgrades_parallel_when_model_says_no() {
        let stub = Arc::new(StubProvider::default());
        let mut c = cap("serial-only");
        c.supports_parallel_tool_calls = Some(false);
        let wrapped = CapabilityValidatingProvider::new(stub.clone(), vec![c]);
        let mut r = req("serial-only");
        r.parallel_tool_calls = Some(true);
        wrapped.complete(r).await.unwrap();
        let last = stub.last_req.lock().await;
        let last = last.as_ref().expect("provider was called");
        assert_eq!(last.parallel_tool_calls, None);
    }

    #[tokio::test]
    async fn keeps_parallel_when_model_supports_it() {
        let stub = Arc::new(StubProvider::default());
        let mut c = cap("parallel-ok");
        c.supports_parallel_tool_calls = Some(true);
        let wrapped = CapabilityValidatingProvider::new(stub.clone(), vec![c]);
        let mut r = req("parallel-ok");
        r.parallel_tool_calls = Some(true);
        wrapped.complete(r).await.unwrap();
        let last = stub.last_req.lock().await;
        assert_eq!(last.as_ref().unwrap().parallel_tool_calls, Some(true));
    }
}
