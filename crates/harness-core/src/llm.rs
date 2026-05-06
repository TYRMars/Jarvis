use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{stream, Stream};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::memory::{default_estimator, TokenEstimator};
use crate::message::Message;
use crate::tool::ToolSpec;

/// A request to a chat-style LLM. Provider crates translate this into their
/// native wire format.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Provider-issued response id from the previous turn in the same
    /// conversation. The Responses API uses this to reuse server-side
    /// cached state; when paired with `chain_origin` the provider sends
    /// only the *new* messages since the chain anchor and references
    /// the prior response. Other providers (OpenAI Chat Completions,
    /// Anthropic, Google) ignore this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    /// Index in `messages` where the chain anchored at
    /// `previous_response_id` begins. The provider sends
    /// `messages[chain_origin..]` as the request input when chaining.
    /// `None` means "send full history" (the historical default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_origin: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    /// The assistant message returned by the provider. May contain tool_calls.
    pub message: Message,
    pub finish_reason: FinishReason,
    /// Provider-issued response id, when the upstream surface ships
    /// one. Currently populated only by the Responses providers
    /// (OpenAI Responses + Codex) so the caller can chain into the
    /// next request via [`ChatRequest::previous_response_id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Other(String),
}

/// Per-call token accounting reported by the provider. Every field is
/// optional because not every endpoint reports every counter — `None`
/// means "the provider didn't tell us", not "zero".
///
/// Providers emit one [`LlmChunk::Usage`] per request whenever the
/// upstream surface exposes counts (OpenAI's `stream_options.include_usage`,
/// Anthropic's `message_delta.usage`, Gemini's `usageMetadata`,
/// Responses' `response.completed.usage`). The agent loop forwards
/// it as [`crate::AgentEvent::Usage`] so transports can show context
/// budget + cache hit savings without each transport re-deriving
/// counts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Input tokens billed for this request, including any cached portion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    /// Output tokens billed (assistant text + tool-call args).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    /// Subset of `prompt_tokens` served from the prompt cache. Useful
    /// for showing the user how much was discount-priced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<u32>,
    /// Hidden reasoning tokens billed (Anthropic / Responses reasoning
    /// surfaces). Surfaced separately so callers can attribute cost
    /// without confusing it with completion content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
}

/// One piece of a streamed LLM response. Providers emit `ContentDelta` for
/// each partial content token, optionally `ToolCallDelta` for tool-call
/// assembly progress, may emit `Usage` near the end, and finally exactly
/// one `Finish` carrying the fully reconstructed message.
#[derive(Debug, Clone)]
pub enum LlmChunk {
    ContentDelta(String),
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_fragment: Option<String>,
    },
    /// Token usage reported by the provider. Optional — most stream
    /// implementations emit zero or one of these, never several.
    Usage(Usage),
    Finish {
        message: Message,
        finish_reason: FinishReason,
        /// Provider-issued identifier for this completion, when the
        /// upstream surface returns one. The Responses API ships an
        /// `id` (e.g. `resp_abc...`) on `response.completed` that can
        /// be threaded into the next request as
        /// `previous_response_id` for server-side state reuse;
        /// non-Responses providers currently leave this `None`.
        #[allow(dead_code)]
        response_id: Option<String>,
    },
}

/// Boxed stream of `LlmChunk` results. The stream ends after the `Finish`
/// variant (or earlier on error).
pub type LlmStream = Pin<Box<dyn Stream<Item = Result<LlmChunk>> + Send>>;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse>;

    /// Stream a completion. The default implementation calls `complete` and
    /// emits a single synthesised `Finish` chunk, so providers that do not
    /// yet implement real streaming still satisfy the trait.
    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let resp = self.complete(req).await?;
        let chunk = LlmChunk::Finish {
            message: resp.message,
            finish_reason: resp.finish_reason,
            response_id: None,
        };
        Ok(Box::pin(stream::once(async move { Ok(chunk) })))
    }

    /// Token-counting strategy for this provider's models. Default: the
    /// `chars / 4 + 4` heuristic in [`crate::CharRatioEstimator`].
    /// Real providers override with a tokeniser-backed implementation
    /// when accuracy matters (memory budgeting, context-window guards).
    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        default_estimator()
    }
}
