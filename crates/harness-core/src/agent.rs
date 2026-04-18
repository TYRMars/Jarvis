use std::pin::Pin;
use std::sync::Arc;

use async_stream::stream;
use futures::{Stream, StreamExt};
use serde::Serialize;
use tracing::{debug, info};

use crate::conversation::Conversation;
use crate::error::{Error, Result};
use crate::llm::{ChatRequest, FinishReason, LlmChunk, LlmProvider};
use crate::message::{Message, ToolCall};
use crate::tool::{invoke_tool, ToolRegistry};

/// Static configuration for an agent. Cheap to clone — wraps shared state in
/// `Arc`.
#[derive(Clone)]
pub struct AgentConfig {
    pub model: String,
    pub system_prompt: Option<String>,
    pub tools: Arc<ToolRegistry>,
    pub max_iterations: usize,
    pub temperature: Option<f32>,
}

impl AgentConfig {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system_prompt: None,
            tools: Arc::new(ToolRegistry::new()),
            max_iterations: 10,
            temperature: None,
        }
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    pub fn with_tools(mut self, tools: ToolRegistry) -> Self {
        self.tools = Arc::new(tools);
        self
    }

    pub fn with_max_iterations(mut self, n: usize) -> Self {
        self.max_iterations = n;
        self
    }

    pub fn with_temperature(mut self, t: f32) -> Self {
        self.temperature = Some(t);
        self
    }
}

/// What ended a `run` invocation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RunOutcome {
    /// The model returned a normal stop / final assistant message.
    Stopped { iterations: usize },
    /// The model truncated due to `max_tokens`.
    LengthLimited { iterations: usize },
}

/// An event emitted during `Agent::run_stream`. Transport layers (SSE, WS)
/// serialise these directly to clients.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A fragment of assistant text, streamed from the LLM.
    Delta { content: String },
    /// A complete assistant message (possibly with tool_calls) has arrived.
    AssistantMessage {
        message: Message,
        finish_reason: FinishReason,
    },
    /// The agent is about to invoke a tool.
    ToolStart {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// A tool finished. `content` is the text surfaced back to the model
    /// (may be the verbatim error text for failed tools).
    ToolEnd {
        id: String,
        name: String,
        content: String,
    },
    /// Terminal event: the agent loop has finished successfully.
    Done {
        outcome: RunOutcome,
        conversation: Conversation,
    },
    /// Terminal event: the agent loop aborted with an error.
    Error { message: String },
}

/// Boxed stream of `AgentEvent`s. After `Done` or `Error` the stream ends.
pub type AgentStream = Pin<Box<dyn Stream<Item = AgentEvent> + Send>>;

/// The harness-style agent loop. Holds an `LlmProvider` and a frozen config.
pub struct Agent {
    pub llm: Arc<dyn LlmProvider>,
    pub config: AgentConfig,
}

impl Agent {
    pub fn new(llm: Arc<dyn LlmProvider>, config: AgentConfig) -> Self {
        Self { llm, config }
    }

    /// Run the agent loop against `conversation` until the model stops calling
    /// tools, hits `max_tokens`, or exceeds `max_iterations`.
    ///
    /// On entry, if `conversation` has no system message and the config
    /// supplies one, it is prepended.
    pub async fn run(&self, conversation: &mut Conversation) -> Result<RunOutcome> {
        Self::ensure_system_prompt(conversation, self.config.system_prompt.as_deref());

        for iter in 1..=self.config.max_iterations {
            let req = self.build_request(conversation);

            debug!(iteration = iter, "calling llm");
            let resp = self.llm.complete(req).await?;
            conversation.messages.push(resp.message.clone());

            match (&resp.message, &resp.finish_reason) {
                (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                    if !tool_calls.is_empty() =>
                {
                    for call in tool_calls {
                        let output = Self::invoke_one(&self.config.tools, call).await;
                        conversation
                            .messages
                            .push(Message::tool_result(&call.id, output));
                    }
                }
                (_, FinishReason::Length) => {
                    info!(iteration = iter, "llm finished due to length");
                    return Ok(RunOutcome::LengthLimited { iterations: iter });
                }
                _ => {
                    info!(iteration = iter, "llm finished");
                    return Ok(RunOutcome::Stopped { iterations: iter });
                }
            }
        }

        Err(Error::MaxIterations(self.config.max_iterations))
    }

    /// Streaming variant of `run`. Returns an event stream; consumers rebuild
    /// conversation state from the events (the terminal `Done` event carries
    /// the full conversation).
    pub fn run_stream(self: Arc<Self>, mut conversation: Conversation) -> AgentStream {
        let agent = self.clone();
        Box::pin(stream! {
            Self::ensure_system_prompt(&mut conversation, agent.config.system_prompt.as_deref());

            for iter in 1..=agent.config.max_iterations {
                let req = agent.build_request(&conversation);

                debug!(iteration = iter, "calling llm (streaming)");
                let mut llm_stream = match agent.llm.complete_stream(req).await {
                    Ok(s) => s,
                    Err(e) => {
                        yield AgentEvent::Error { message: e.to_string() };
                        return;
                    }
                };

                let mut finish: Option<(Message, FinishReason)> = None;
                while let Some(chunk) = llm_stream.next().await {
                    match chunk {
                        Ok(LlmChunk::ContentDelta(content)) => {
                            yield AgentEvent::Delta { content };
                        }
                        Ok(LlmChunk::ToolCallDelta { .. }) => {
                            // Providers also deliver the assembled tool calls
                            // inside `Finish`; we surface them at that point
                            // rather than streaming partial arguments.
                        }
                        Ok(LlmChunk::Finish { message, finish_reason }) => {
                            finish = Some((message, finish_reason));
                            break;
                        }
                        Err(e) => {
                            yield AgentEvent::Error { message: e.to_string() };
                            return;
                        }
                    }
                }

                let (message, finish_reason) = match finish {
                    Some(x) => x,
                    None => {
                        yield AgentEvent::Error {
                            message: "llm stream ended without a Finish chunk".into(),
                        };
                        return;
                    }
                };

                conversation.messages.push(message.clone());
                yield AgentEvent::AssistantMessage {
                    message: message.clone(),
                    finish_reason: finish_reason.clone(),
                };

                match (&message, &finish_reason) {
                    (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                        if !tool_calls.is_empty() =>
                    {
                        for call in tool_calls {
                            yield AgentEvent::ToolStart {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                arguments: call.arguments.clone(),
                            };
                            let output = Self::invoke_one(&agent.config.tools, call).await;
                            conversation
                                .messages
                                .push(Message::tool_result(&call.id, output.clone()));
                            yield AgentEvent::ToolEnd {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                content: output,
                            };
                        }
                    }
                    (_, FinishReason::Length) => {
                        yield AgentEvent::Done {
                            outcome: RunOutcome::LengthLimited { iterations: iter },
                            conversation,
                        };
                        return;
                    }
                    _ => {
                        yield AgentEvent::Done {
                            outcome: RunOutcome::Stopped { iterations: iter },
                            conversation,
                        };
                        return;
                    }
                }
            }

            yield AgentEvent::Error {
                message: format!(
                    "agent reached max iterations ({}) without terminating",
                    agent.config.max_iterations
                ),
            };
        })
    }

    fn ensure_system_prompt(conv: &mut Conversation, prompt: Option<&str>) {
        let Some(prompt) = prompt else { return };
        let has_system = conv
            .messages
            .first()
            .map(|m| matches!(m, Message::System { .. }))
            .unwrap_or(false);
        if !has_system {
            conv.messages.insert(0, Message::system(prompt));
        }
    }

    fn build_request(&self, conv: &Conversation) -> ChatRequest {
        ChatRequest {
            model: self.config.model.clone(),
            messages: conv.messages.clone(),
            tools: self.config.tools.specs(),
            temperature: self.config.temperature,
            max_tokens: None,
        }
    }

    async fn invoke_one(tools: &ToolRegistry, call: &ToolCall) -> String {
        debug!(name = %call.name, id = %call.id, "invoking tool");
        invoke_tool(tools, &call.name, call.arguments.clone())
            .await
            .unwrap_or_else(|e| format!("tool error: {e}"))
    }
}
