use std::sync::Arc;

use tracing::{debug, info};

use crate::conversation::Conversation;
use crate::error::{Error, Result};
use crate::llm::{ChatRequest, FinishReason, LlmProvider};
use crate::message::Message;
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
#[derive(Debug, Clone)]
pub enum RunOutcome {
    /// The model returned a normal stop / final assistant message.
    Stopped { iterations: usize },
    /// The model truncated due to `max_tokens`.
    LengthLimited { iterations: usize },
}

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
        if let Some(prompt) = &self.config.system_prompt {
            let has_system = conversation
                .messages
                .first()
                .map(|m| matches!(m, Message::System { .. }))
                .unwrap_or(false);
            if !has_system {
                conversation.messages.insert(0, Message::system(prompt));
            }
        }

        for iter in 1..=self.config.max_iterations {
            let req = ChatRequest {
                model: self.config.model.clone(),
                messages: conversation.messages.clone(),
                tools: self.config.tools.specs(),
                temperature: self.config.temperature,
                max_tokens: None,
            };

            debug!(iteration = iter, "calling llm");
            let resp = self.llm.complete(req).await?;
            conversation.messages.push(resp.message.clone());

            match (&resp.message, &resp.finish_reason) {
                (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                    if !tool_calls.is_empty() =>
                {
                    for call in tool_calls {
                        debug!(name = %call.name, id = %call.id, "invoking tool");
                        let output = invoke_tool(
                            &self.config.tools,
                            &call.name,
                            call.arguments.clone(),
                        )
                        .await
                        .unwrap_or_else(|e| format!("tool error: {e}"));
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
}
