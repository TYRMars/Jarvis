//! Internal subagent — wraps a fresh `harness_core::Agent` loop with a
//! restricted system prompt + tool subset and translates its
//! `AgentEvent` stream into [`SubAgentEvent`] frames the outer loop
//! can relay to UIs.
//!
//! Used by `read_doc`, `review`, and the path-A `codex` built-ins.
//! Each one is just a thin factory that picks the right system
//! prompt + tool subset + (optionally) cheaper model; the runner
//! handles the agent-loop plumbing once.
//!
//! The runner does NOT itself install a `with_subagent` scope — the
//! outer agent loop already did when it set up the wrapping tool
//! invocation. That means [`harness_core::emit_subagent`] from
//! inside this runner reaches the outer task-local channel directly,
//! which is exactly what we want (UIs see the inner subagent's
//! events alongside the outer agent's).

use crate::{Artifact, SubAgent, SubAgentInput, SubAgentOutput};
use async_trait::async_trait;
use futures::StreamExt;
use harness_core::{
    emit_subagent, message::Message, Agent, AgentConfig, AgentEvent, BoxError, Conversation,
    LlmProvider, SubAgentEvent, SubAgentFrame, ToolRegistry,
};
use std::sync::Arc;
use tracing::warn;

/// Configuration for an [`InternalSubAgent`]. Built by the per-kind
/// factories (`doc_reader::build`, `reviewer::build`, etc.) and
/// passed straight through to [`InternalSubAgent::new`].
pub struct InternalSubAgentConfig {
    /// Tool name suffix — exposed to the main agent as
    /// `subagent.<name>`. Must be unique within the parent
    /// `SubAgentRegistry`.
    pub name: String,
    /// One-line description shown to the main agent in its tool
    /// catalogue. Must be specific enough that the model knows when
    /// to dispatch to this subagent vs. a sibling.
    pub description: String,
    /// System prompt installed on the inner agent's conversation.
    /// Should constrain the subagent's role + allowed tools + output
    /// shape. The reviewer's prompt for instance pins it to
    /// `requirement.review_verdict` as the only mutation surface.
    pub system_prompt: String,
    /// Inner LLM model identifier. `None` falls back to whatever the
    /// provider's default is.
    pub model: Option<String>,
    /// Hard ceiling on inner agent iterations — protects against
    /// runaway loops without a verification path.
    pub max_iterations: usize,
    /// Provider for the inner agent's LLM calls. Often the same
    /// shared provider as the main agent, but may be a cheaper one
    /// (e.g. doc reader → Haiku).
    pub provider: Arc<dyn LlmProvider>,
    /// ToolRegistry the inner agent gets to use. The composition
    /// root (`apps/jarvis`) builds this with the appropriate subset
    /// — read-only for doc reader / reviewer, full-coding for codex.
    /// Must NOT contain any `subagent.*` tools — recursion is
    /// forbidden in v1.0 to keep the resource budget bounded.
    pub tools: Arc<ToolRegistry>,
    /// Whether the wrapping `subagent.<name>` tool needs human
    /// approval before each invocation. `true` for subagents that
    /// can mutate the workspace (codex / claude_code); `false` for
    /// read-only ones (doc reader / reviewer).
    pub requires_approval: bool,
}

/// Generic Internal subagent runner. Constructors live in the
/// per-kind modules (`doc_reader.rs`, `reviewer.rs`, `codex.rs`) and
/// just pre-fill the config.
pub struct InternalSubAgent {
    config: InternalSubAgentConfig,
}

impl InternalSubAgent {
    pub fn new(config: InternalSubAgentConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl SubAgent for InternalSubAgent {
    fn name(&self) -> &str {
        &self.config.name
    }
    fn description(&self) -> &str {
        &self.config.description
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Natural-language task. The subagent's system prompt constrains how it interprets and answers."
                }
            },
            "required": ["task"],
            "additionalProperties": false
        })
    }
    fn requires_approval(&self) -> bool {
        self.config.requires_approval
    }

    async fn invoke(&self, input: SubAgentInput) -> Result<SubAgentOutput, BoxError> {
        let id = uuid::Uuid::new_v4().to_string();
        let push = |event: SubAgentEvent| {
            emit_subagent(SubAgentFrame {
                subagent_id: id.clone(),
                subagent_name: self.config.name.clone(),
                event,
            });
        };

        push(SubAgentEvent::Started {
            task: input.task.clone(),
            model: self.config.model.clone(),
        });

        // Build the inner agent. Conversation seeded with system
        // prompt + the user's task; nothing else.
        let mut conversation = Conversation::new();
        conversation
            .messages
            .push(Message::system(&self.config.system_prompt));
        conversation.messages.push(Message::user(&input.task));

        let mut cfg = AgentConfig::new(
            self.config
                .model
                .clone()
                .unwrap_or_else(|| "default".into()),
        );
        cfg.tools = self.config.tools.clone();
        cfg.max_iterations = self.config.max_iterations;
        // The system prompt is already in the conversation, so don't
        // double-install via AgentConfig.
        cfg.system_prompt = None;
        cfg.session_workspace = Some(input.workspace_root.clone());

        let agent = Arc::new(Agent::new(self.config.provider.clone(), cfg));

        let mut stream = agent.run_stream(conversation);

        let mut final_message = String::new();
        let mut error_message: Option<String> = None;

        while let Some(ev) = stream.next().await {
            match ev {
                AgentEvent::Delta { content } if !content.is_empty() => {
                    push(SubAgentEvent::Delta { text: content });
                }
                AgentEvent::ToolStart {
                    name, arguments, ..
                } => {
                    push(SubAgentEvent::ToolStart { name, arguments });
                }
                AgentEvent::ToolEnd { name, content, .. } => {
                    push(SubAgentEvent::ToolEnd {
                        name,
                        output: content,
                    });
                }
                AgentEvent::Usage { model, usage } => {
                    push(SubAgentEvent::Usage { model, usage });
                }
                AgentEvent::Error { message } => {
                    error_message = Some(message);
                    break;
                }
                AgentEvent::Done { conversation, .. } => {
                    final_message = conversation
                        .last_assistant_text()
                        .map(str::to_owned)
                        .unwrap_or_default();
                    break;
                }
                // Pass through nothing else — inner approval prompts /
                // plan updates / nested subagent events stay private
                // to the inner loop. We don't want the outer UI to
                // see internal-mechanics frames.
                _ => {}
            }
        }

        if let Some(msg) = error_message {
            push(SubAgentEvent::Error {
                message: msg.clone(),
            });
            warn!(subagent = %self.config.name, error = %msg, "subagent failed");
            return Err(format!("subagent error: {msg}").into());
        }

        push(SubAgentEvent::Done {
            final_message: final_message.clone(),
        });

        Ok(SubAgentOutput {
            message: final_message,
            artifacts: extract_artifacts(&self.config.name, &input),
        })
    }
}

/// Per-kind artifact extraction is a future enhancement: the
/// `requirement.review_verdict` tool will record a verdict that we'd
/// surface here as `Artifact::ReviewVerdict`. v1.0 returns no
/// artifacts — the final message is the load-bearing output.
fn extract_artifacts(_name: &str, _input: &SubAgentInput) -> Vec<Artifact> {
    Vec::new()
}
