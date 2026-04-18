use std::pin::Pin;

use async_trait::async_trait;
use futures::{stream, Stream};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::message::Message;
use crate::tool::ToolSpec;

/// A request to a chat-style LLM. Provider crates translate this into their
/// native wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    /// The assistant message returned by the provider. May contain tool_calls.
    pub message: Message,
    pub finish_reason: FinishReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Other(String),
}

/// One piece of a streamed LLM response. Providers emit `ContentDelta` for
/// each partial content token, optionally `ToolCallDelta` for tool-call
/// assembly progress, and finally exactly one `Finish` carrying the fully
/// reconstructed message.
#[derive(Debug, Clone)]
pub enum LlmChunk {
    ContentDelta(String),
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_fragment: Option<String>,
    },
    Finish {
        message: Message,
        finish_reason: FinishReason,
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
        };
        Ok(Box::pin(stream::once(async move { Ok(chunk) })))
    }
}
