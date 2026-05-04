use std::pin::Pin;
use std::sync::Arc;

use async_stream::stream;
use futures::{Stream, StreamExt};
use serde::Serialize;
use tracing::{debug, info};

use crate::approval::{ApprovalDecision, ApprovalRequest, Approver};
use crate::conversation::Conversation;
use crate::error::{Error, Result};
use crate::hitl::PendingHitl;
use crate::llm::{ChatRequest, FinishReason, LlmChunk, LlmProvider, Usage};
use crate::memory::Memory;
use crate::message::{Message, ToolCall};
use crate::tool::{Tool, ToolRegistry};

/// Predicate used by [`AgentConfig::tool_filter`]. Returning `false`
/// hides the tool from the LLM's catalogue (e.g. Plan Mode hiding
/// write/exec tools). Aliased so the `Arc<dyn Fn>` type doesn't
/// trigger clippy's `type_complexity` lint at every use site.
pub type ToolFilter = dyn Fn(&dyn Tool) -> bool + Send + Sync;

/// Static configuration for an agent. Cheap to clone — wraps shared state in
/// `Arc`.
#[derive(Clone)]
pub struct AgentConfig {
    pub model: String,
    pub system_prompt: Option<String>,
    pub tools: Arc<ToolRegistry>,
    pub max_iterations: usize,
    pub temperature: Option<f32>,
    /// Optional short-term memory hook. When set, every LLM iteration
    /// runs the canonical conversation through `memory.compact` and sends
    /// the result instead. The canonical `Conversation` is never mutated.
    pub memory: Option<Arc<dyn Memory>>,
    /// Optional approval gate. When set, every tool whose
    /// `Tool::requires_approval` returns `true` runs through this
    /// approver before invocation. Without an approver, all tools run
    /// unconditionally — preserves historical behaviour.
    pub approver: Option<Arc<dyn Approver>>,
    /// Optional native HITL channel used by tools such as `ask.text`.
    /// Interactive transports install a per-connection sender; tools
    /// invoked outside that scope surface a normal tool error instead.
    pub hitl_tx: Option<tokio::sync::mpsc::Sender<PendingHitl>>,
    /// Optional predicate that decides which registered tools reach
    /// the LLM's tool catalogue. Returning `false` filters the tool
    /// out of `ChatRequest::tools` for every iteration — Plan Mode
    /// uses this to hide write/exec/network tools so the model can't
    /// even attempt them. The tool is still resolvable via
    /// `ToolRegistry::resolve` (so any in-flight tool calls from a
    /// previous turn can finish), but new calls become impossible.
    pub tool_filter: Option<Arc<ToolFilter>>,
    /// Optional per-session workspace root. When set, every tool
    /// invocation in this agent's loop runs inside a
    /// [`crate::workspace::with_session_workspace`] scope, so any
    /// tool that calls [`crate::active_workspace_or`] uses this
    /// path instead of its constructor-time root. `None` means
    /// "no override — fall back to the tool's default", which is
    /// the historical behaviour.
    pub session_workspace: Option<std::path::PathBuf>,
}

impl AgentConfig {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system_prompt: None,
            tools: Arc::new(ToolRegistry::new()),
            max_iterations: 10,
            temperature: None,
            memory: None,
            approver: None,
            hitl_tx: None,
            tool_filter: None,
            session_workspace: None,
        }
    }

    /// Install a tool filter — typically used by Plan Mode to hide
    /// write/exec/network tools from the LLM. The filter is consulted
    /// on every iteration when assembling the `tools` field of
    /// `ChatRequest`.
    pub fn with_tool_filter(mut self, filter: Arc<ToolFilter>) -> Self {
        self.tool_filter = Some(filter);
        self
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

    pub fn with_memory(mut self, memory: Arc<dyn Memory>) -> Self {
        self.memory = Some(memory);
        self
    }

    pub fn with_approver(mut self, approver: Arc<dyn Approver>) -> Self {
        self.approver = Some(approver);
        self
    }

    pub fn with_hitl_sender(mut self, tx: tokio::sync::mpsc::Sender<PendingHitl>) -> Self {
        self.hitl_tx = Some(tx);
        self
    }

    /// Pin a per-agent workspace override. Tools that consult
    /// [`crate::active_workspace_or`] inside their `invoke` will see
    /// this path; the agent loop installs the task-local scope
    /// around every tool dispatch.
    pub fn with_session_workspace(mut self, path: std::path::PathBuf) -> Self {
        self.session_workspace = Some(path);
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
    /// The agent paused to consult an approver before invoking a
    /// sensitive tool. Emitted only when an approver is configured and
    /// the tool's `requires_approval()` is true.
    ApprovalRequest {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// The approver replied. Always paired with an immediately preceding
    /// `ApprovalRequest`. A `Deny` outcome means the tool will *not* run
    /// — the matching `ToolEnd` will carry `tool denied: <reason>`.
    /// `source` tells the UI **why** this decision was made — the user
    /// clicked, a stored rule fired, or the active mode's default
    /// took effect. Lets audit timelines render
    /// "auto-allowed by user-scope rule fs.edit" rather than silently
    /// running write-tools.
    ApprovalDecision {
        id: String,
        name: String,
        decision: ApprovalDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<crate::permission::HitSource>,
    },
    /// The agent is about to invoke a tool. Emitted even on the deny
    /// path so transports can keep `ToolStart` / `ToolEnd` paired.
    ToolStart {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Streaming chunk from a still-running tool — e.g. a line of
    /// stdout from `shell.exec`. Tools opt in by calling
    /// [`crate::progress::emit`] from inside their `invoke`; the
    /// agent loop relays each chunk as it arrives. Always wrapped
    /// by a matching `ToolStart` / `ToolEnd` pair.
    ToolProgress {
        id: String,
        name: String,
        /// Tool-defined stream label (`"stdout"` / `"stderr"` for
        /// shell, free-form for other tools).
        stream: String,
        chunk: String,
    },
    /// A tool finished. `content` is the text surfaced back to the model
    /// (may be the verbatim error text for failed tools, or the
    /// `tool denied: ...` sentinel when an approver rejected the call).
    ToolEnd {
        id: String,
        name: String,
        content: String,
    },
    /// The agent updated its working plan. Each event carries the
    /// **full latest snapshot** of the plan (replace, not patch) so
    /// transports can render the current state without replaying
    /// history. Emitted by the `plan.update` tool via
    /// [`crate::plan::emit`]. UIs typically render this as a
    /// checklist that updates in place.
    PlanUpdate { items: Vec<crate::plan::PlanItem> },
    /// One frame from a running subagent. Emitted while a
    /// `subagent.<name>` tool is executing — the subagent itself
    /// publishes via [`crate::subagent::emit`] and the agent loop
    /// relays each frame in step with `Tool::invoke`. Always wrapped
    /// by a matching outer `ToolStart` / `ToolEnd` pair (the
    /// subagent-as-tool surface). Transports surface this as both
    /// an inline collapsible card in the main message stream **and**
    /// a side-panel "running subagents" view, so users can watch
    /// the delegated work as it happens.
    SubAgentEvent { frame: crate::subagent::SubAgentFrame },
    /// In Plan Mode, the agent finished its read-only investigation
    /// and called the terminal `exit_plan` tool with the plan body.
    /// Transports surface this as a "review the plan" card with
    /// "Accept (and switch to mode X)" / "Refine" actions; the agent
    /// stays in Plan Mode until the user accepts via the WS frame
    /// `{type:"accept_plan", post_mode:"..."}`.
    PlanProposed { plan: String },
    /// Provider-reported token usage for the LLM call that just
    /// finished. Optional fields — see [`crate::Usage`]. Emitted at
    /// most once per LLM iteration; transports typically aggregate
    /// these for "context: X / Y · cached: Z" displays. Flattened
    /// onto the wire so the JSON shape is
    /// `{"type":"usage","prompt_tokens":...,...}` rather than nested
    /// under a tuple-style key.
    Usage {
        #[serde(flatten)]
        usage: Usage,
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

async fn run_one_with_optional_hitl<F, R>(
    tx: Option<tokio::sync::mpsc::Sender<PendingHitl>>,
    fut: F,
) -> R
where
    F: std::future::Future<Output = R>,
{
    match tx {
        Some(tx) => crate::hitl::with_hitl(tx, fut).await,
        None => fut.await,
    }
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
        // Each blocking-mode turn gets a fresh per-turn mutation
        // counter so `todo.{add,update,delete}` can't be hammered into
        // the backlog by a runaway loop. The streaming entry
        // (`run_stream`) leaves scoping to its transport callers
        // because async-stream `yield` can't traverse a
        // `LocalKey::scope` boundary.
        crate::todo::with_turn_budget(self.run_inner(conversation)).await
    }

    async fn run_inner(&self, conversation: &mut Conversation) -> Result<RunOutcome> {
        Self::ensure_system_prompt(conversation, self.config.system_prompt.as_deref());

        for iter in 1..=self.config.max_iterations {
            let req = self.build_request(conversation).await?;

            debug!(iteration = iter, "calling llm");
            let resp = self.llm.complete(req).await?;
            conversation.messages.push(resp.message.clone());
            // Mirror the streaming path: capture the Responses-API
            // chain anchor so subsequent iterations can use
            // `previous_response_id` + delta-mode.
            if let Some(rid) = resp.response_id.clone() {
                conversation.last_response_id = Some(rid);
                conversation.last_response_chain_origin = Some(conversation.messages.len());
            }

            match (&resp.message, &resp.finish_reason) {
                (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                    if !tool_calls.is_empty() =>
                {
                    for call in tool_calls {
                        let approval = Self::maybe_request_approval(
                            &self.config.tools,
                            self.config.approver.as_deref(),
                            call,
                        )
                        .await;
                        let output = crate::workspace::with_session_workspace(
                            self.config.session_workspace.clone(),
                            Self::run_one(
                                &self.config.tools,
                                call,
                                approval.as_ref().map(|(_, d)| d),
                            ),
                        )
                        .await;
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
                let req = match agent.build_request(&conversation).await {
                    Ok(r) => r,
                    Err(e) => {
                        yield AgentEvent::Error { message: e.to_string() };
                        return;
                    }
                };

                debug!(iteration = iter, "calling llm (streaming)");
                let mut llm_stream = match agent.llm.complete_stream(req).await {
                    Ok(s) => s,
                    Err(e) => {
                        yield AgentEvent::Error { message: e.to_string() };
                        return;
                    }
                };

                let mut finish: Option<(Message, FinishReason, Option<String>)> = None;
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
                        Ok(LlmChunk::Usage(usage)) => {
                            yield AgentEvent::Usage { usage };
                        }
                        Ok(LlmChunk::Finish { message, finish_reason, response_id }) => {
                            finish = Some((message, finish_reason, response_id));
                            break;
                        }
                        Err(e) => {
                            yield AgentEvent::Error { message: e.to_string() };
                            return;
                        }
                    }
                }

                let (message, finish_reason, response_id) = match finish {
                    Some(x) => x,
                    None => {
                        yield AgentEvent::Error {
                            message: "llm stream ended without a Finish chunk".into(),
                        };
                        return;
                    }
                };

                conversation.messages.push(message.clone());
                // Update Responses-API chain anchor so the next request
                // can send `previous_response_id` + only the post-anchor
                // delta. Other providers leave `response_id` as None and
                // this is a no-op. The chain origin points to the slot
                // *after* this newly-appended assistant — tool replies
                // landing later in this iteration become the delta for
                // the next request.
                if let Some(rid) = response_id {
                    conversation.last_response_id = Some(rid);
                    conversation.last_response_chain_origin = Some(conversation.messages.len());
                }
                yield AgentEvent::AssistantMessage {
                    message: message.clone(),
                    finish_reason: finish_reason.clone(),
                };

                match (&message, &finish_reason) {
                    (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                        if !tool_calls.is_empty() =>
                    {
                        for call in tool_calls {
                            // Decide whether this call goes through the
                            // approver. We check the trait flag inline
                            // so that the `ApprovalRequest` event lands
                            // BEFORE we await the approver — otherwise
                            // an interactive transport never has a
                            // chance to respond, because by the time it
                            // sees the request the decision is already
                            // sealed.
                            let needs_approval =
                                agent.config.approver.is_some()
                                    && agent
                                        .config
                                        .tools
                                        .resolve(&call.name)
                                        .map(|t| t.requires_approval())
                                        .unwrap_or(false);

                            let decision = if needs_approval {
                                let category = agent
                                    .config
                                    .tools
                                    .resolve(&call.name)
                                    .map(|t| t.category())
                                    .unwrap_or(crate::tool::ToolCategory::Write);
                                yield AgentEvent::ApprovalRequest {
                                    id: call.id.clone(),
                                    name: call.name.clone(),
                                    arguments: call.arguments.clone(),
                                };
                                let request = ApprovalRequest {
                                    tool_call_id: call.id.clone(),
                                    tool_name: call.name.clone(),
                                    arguments: call.arguments.clone(),
                                    category,
                                };
                                let approver = agent
                                    .config
                                    .approver
                                    .as_deref()
                                    .expect("checked needs_approval");
                                let (dec, source) = match approver
                                    .approve_with_source(request)
                                    .await
                                {
                                    Ok(pair) => pair,
                                    Err(e) => (
                                        ApprovalDecision::Deny {
                                            reason: Some(format!("approver failed: {e}")),
                                        },
                                        crate::permission::HitSource::UserPrompt,
                                    ),
                                };
                                yield AgentEvent::ApprovalDecision {
                                    id: call.id.clone(),
                                    name: call.name.clone(),
                                    decision: dec.clone(),
                                    source: Some(source),
                                };
                                Some(dec)
                            } else {
                                None
                            };

                            yield AgentEvent::ToolStart {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                arguments: call.arguments.clone(),
                            };
                            // Per-invocation channels. The tool
                            // publishes intermediate output via
                            // `emit_progress` and plan snapshots via
                            // `emit_plan` — both task_local lookups.
                            // We relay each chunk as a typed event
                            // in step with `invoke`. Receivers
                            // dropped implicitly on scope exit.
                            let (prog_tx, mut prog_rx) =
                                tokio::sync::mpsc::unbounded_channel::<crate::progress::ToolProgress>();
                            let (plan_tx, mut plan_rx) =
                                tokio::sync::mpsc::unbounded_channel::<Vec<crate::plan::PlanItem>>();
                            let (sub_tx, mut sub_rx) =
                                tokio::sync::mpsc::unbounded_channel::<crate::subagent::SubAgentFrame>();
                            let invoke = crate::workspace::with_session_workspace(
                                agent.config.session_workspace.clone(),
                                crate::progress::with_progress(
                                    prog_tx,
                                    crate::plan::with_plan(
                                        plan_tx,
                                        crate::subagent::with_subagent(
                                            sub_tx,
                                            run_one_with_optional_hitl(
                                                agent.config.hitl_tx.clone(),
                                                Self::run_one(
                                                    &agent.config.tools,
                                                    call,
                                                    decision.as_ref(),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            );
                            tokio::pin!(invoke);
                            let output = loop {
                                tokio::select! {
                                    biased;
                                    Some(p) = prog_rx.recv() => {
                                        yield AgentEvent::ToolProgress {
                                            id: call.id.clone(),
                                            name: call.name.clone(),
                                            stream: p.stream,
                                            chunk: p.chunk,
                                        };
                                    }
                                    Some(items) = plan_rx.recv() => {
                                        yield AgentEvent::PlanUpdate { items };
                                    }
                                    Some(frame) = sub_rx.recv() => {
                                        yield AgentEvent::SubAgentEvent { frame };
                                    }
                                    res = &mut invoke => {
                                        // Drain anything the tool
                                        // queued in the same wake as
                                        // its return so the client
                                        // sees it before ToolEnd.
                                        while let Ok(p) = prog_rx.try_recv() {
                                            yield AgentEvent::ToolProgress {
                                                id: call.id.clone(),
                                                name: call.name.clone(),
                                                stream: p.stream,
                                                chunk: p.chunk,
                                            };
                                        }
                                        while let Ok(items) = plan_rx.try_recv() {
                                            yield AgentEvent::PlanUpdate { items };
                                        }
                                        while let Ok(frame) = sub_rx.try_recv() {
                                            yield AgentEvent::SubAgentEvent { frame };
                                        }
                                        break res;
                                    }
                                }
                            };
                            conversation
                                .messages
                                .push(Message::tool_result(&call.id, output.clone()));
                            yield AgentEvent::ToolEnd {
                                id: call.id.clone(),
                                name: call.name.clone(),
                                content: output.clone(),
                            };
                            // Terminal tools (today: `exit_plan`) end
                            // the agent's turn even if the model
                            // emitted more tool calls in the same
                            // batch — Plan Mode uses this to hand the
                            // proposed plan to the user. We emit
                            // PlanProposed + Done immediately and
                            // skip processing any later calls in this
                            // batch (which would be moot anyway:
                            // mode hasn't changed yet, so the model's
                            // hypothetical next call would still be
                            // restricted to read-only tools).
                            let is_terminal = agent
                                .config
                                .tools
                                .resolve(&call.name)
                                .map(|t| t.is_terminal())
                                .unwrap_or(false);
                            if is_terminal {
                                yield AgentEvent::PlanProposed { plan: output };
                                yield AgentEvent::Done {
                                    conversation: conversation.clone(),
                                    outcome: RunOutcome::Stopped { iterations: iter },
                                };
                                return;
                            }
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

    async fn build_request(&self, conv: &Conversation) -> Result<ChatRequest> {
        // When the conversation has a Responses-API chain anchor,
        // compaction would shift `chain_origin` out of alignment with
        // the messages slice we hand the provider. The provider has a
        // bounds-check fallback (it drops chaining when the index is
        // off), but we can do better here: skip compaction entirely so
        // the chain stays alive request-after-request. The pre-anchor
        // history is on the server side anyway — the local
        // conversation only contributes the post-anchor delta to the
        // wire, so context-window pressure isn't a concern.
        let chained = conv.last_response_id.is_some() && conv.last_response_chain_origin.is_some();
        let messages = match (&self.config.memory, chained) {
            (Some(mem), false) => mem
                .compact(&conv.messages)
                .await
                .map_err(|e| Error::Memory(e.to_string()))?,
            _ => conv.messages.clone(),
        };
        let tools = match &self.config.tool_filter {
            Some(filter) => self.config.tools.specs_filtered(|t| filter(t)),
            None => self.config.tools.specs(),
        };
        Ok(ChatRequest {
            model: self.config.model.clone(),
            messages,
            tools,
            temperature: self.config.temperature,
            max_tokens: None,
            previous_response_id: conv.last_response_id.clone(),
            chain_origin: conv.last_response_chain_origin,
        })
    }

    /// Ask the configured approver about `call` if both an approver is
    /// set and the tool's `requires_approval()` is true. Returns the
    /// matched `(request, decision)` pair when an approval round-trip
    /// happened, or `None` to mean "no approval needed, just run". An
    /// approver `Err` is converted into a synthetic `Deny` so the agent
    /// can keep moving instead of aborting the whole turn.
    async fn maybe_request_approval(
        tools: &ToolRegistry,
        approver: Option<&dyn Approver>,
        call: &ToolCall,
    ) -> Option<(ApprovalRequest, ApprovalDecision)> {
        let approver = approver?;
        let tool = tools.resolve(&call.name)?;
        if !tool.requires_approval() {
            return None;
        }
        let request = ApprovalRequest {
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            arguments: call.arguments.clone(),
            category: tool.category(),
        };
        let decision = match approver.approve(request.clone()).await {
            Ok(d) => d,
            Err(e) => {
                debug!(error = %e, name = %call.name, "approver failed");
                ApprovalDecision::Deny {
                    reason: Some(format!("approver failed: {e}")),
                }
            }
        };
        Some((request, decision))
    }

    /// Invoke `call` if `decision` permits, else surface the deny reason
    /// as a synthetic tool result so the model can read it and adapt.
    /// Tool errors are caught and surfaced as text on either path —
    /// preserve that when editing.
    async fn run_one(
        tools: &ToolRegistry,
        call: &ToolCall,
        decision: Option<&ApprovalDecision>,
    ) -> String {
        if let Some(ApprovalDecision::Deny { reason }) = decision {
            let r = reason
                .clone()
                .unwrap_or_else(|| "no reason given".to_string());
            return format!("tool denied: {r}");
        }
        debug!(name = %call.name, id = %call.id, "invoking tool");
        match tools.resolve(&call.name) {
            Some(tool) => tool
                .invoke(call.arguments.clone())
                .await
                .unwrap_or_else(|e| format!("tool error: {e}")),
            None => format!("tool error: tool not found: {}", call.name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{AlwaysApprove, AlwaysDeny};
    use crate::error::BoxError;
    use crate::llm::{ChatResponse, FinishReason};
    use crate::message::ToolCall;
    use crate::tool::Tool;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Two-step LLM: first reply asks for one tool call; second reply stops.
    struct ScriptedLlm {
        iter: AtomicUsize,
        tool_name: String,
    }

    impl ScriptedLlm {
        fn new(tool_name: impl Into<String>) -> Arc<Self> {
            Arc::new(Self {
                iter: AtomicUsize::new(0),
                tool_name: tool_name.into(),
            })
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for ScriptedLlm {
        async fn complete(&self, _req: ChatRequest) -> Result<ChatResponse> {
            let i = self.iter.fetch_add(1, Ordering::SeqCst);
            if i == 0 {
                Ok(ChatResponse {
                    message: Message::Assistant {
                        content: None,
                        tool_calls: vec![ToolCall {
                            id: "call_1".into(),
                            name: self.tool_name.clone(),
                            arguments: json!({"x": 1}),
                        }],
                        reasoning_content: None,
                        cache: None,
                    },
                    finish_reason: FinishReason::ToolCalls,
                    response_id: None,
                })
            } else {
                Ok(ChatResponse {
                    message: Message::assistant_text("done"),
                    finish_reason: FinishReason::Stop,
                    response_id: None,
                })
            }
        }
    }

    struct CountingTool {
        name: &'static str,
        gated: bool,
        invoked: AtomicUsize,
    }

    impl CountingTool {
        fn new(name: &'static str, gated: bool) -> Arc<Self> {
            Arc::new(Self {
                name,
                gated,
                invoked: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait::async_trait]
    impl Tool for CountingTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "test tool"
        }
        fn parameters(&self) -> Value {
            json!({"type": "object"})
        }
        fn requires_approval(&self) -> bool {
            self.gated
        }
        async fn invoke(&self, _args: Value) -> std::result::Result<String, BoxError> {
            self.invoked.fetch_add(1, Ordering::SeqCst);
            Ok("ran".into())
        }
    }

    fn make_agent(tool: Arc<CountingTool>, approver: Option<Arc<dyn Approver>>) -> Arc<Agent> {
        let mut registry = ToolRegistry::new();
        let dynamic: Arc<dyn Tool> = tool.clone();
        registry.register_arc(dynamic);
        let mut cfg = AgentConfig::new("test-model").with_tools(registry);
        if let Some(a) = approver {
            cfg = cfg.with_approver(a);
        }
        Arc::new(Agent::new(ScriptedLlm::new(tool.name) as _, cfg))
    }

    #[tokio::test]
    async fn denies_gated_tool_when_approver_says_no() {
        let tool = CountingTool::new("danger", true);
        let agent = make_agent(tool.clone(), Some(Arc::new(AlwaysDeny)));

        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();

        assert_eq!(tool.invoked.load(Ordering::SeqCst), 0);
        let denied = conv.messages.iter().any(
            |m| matches!(m, Message::Tool { content, .. } if content.starts_with("tool denied:")),
        );
        assert!(
            denied,
            "expected a `tool denied:` message in {:?}",
            conv.messages
        );
    }

    #[tokio::test]
    async fn invokes_gated_tool_when_approver_says_yes() {
        let tool = CountingTool::new("danger", true);
        let agent = make_agent(tool.clone(), Some(Arc::new(AlwaysApprove)));

        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();

        assert_eq!(tool.invoked.load(Ordering::SeqCst), 1);
        assert!(conv
            .messages
            .iter()
            .any(|m| matches!(m, Message::Tool { content, .. } if content == "ran")));
    }

    #[tokio::test]
    async fn invokes_unconditionally_without_approver() {
        let tool = CountingTool::new("danger", true);
        let agent = make_agent(tool.clone(), None);

        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();

        assert_eq!(tool.invoked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn harmless_tool_skips_approver() {
        let tool = CountingTool::new("safe", false);
        let agent = make_agent(tool.clone(), Some(Arc::new(AlwaysDeny)));

        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();

        // Approver wasn't consulted because the tool is non-gated.
        assert_eq!(tool.invoked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn streaming_emits_approval_events_paired_with_tool_events() {
        use futures::StreamExt;
        let tool = CountingTool::new("danger", true);
        let agent = make_agent(tool.clone(), Some(Arc::new(AlwaysDeny)));

        let mut stream = agent.run_stream(Conversation::new());
        let mut saw = (false, false, false, false); // req, dec, start, end
        while let Some(ev) = stream.next().await {
            match ev {
                AgentEvent::ApprovalRequest { name, .. } if name == "danger" => saw.0 = true,
                AgentEvent::ApprovalDecision { decision, .. } => {
                    assert!(matches!(decision, ApprovalDecision::Deny { .. }));
                    saw.1 = true;
                }
                AgentEvent::ToolStart { name, .. } if name == "danger" => saw.2 = true,
                AgentEvent::ToolEnd { content, .. } => {
                    assert!(content.starts_with("tool denied:"), "got: {content}");
                    saw.3 = true;
                }
                _ => {}
            }
        }
        assert_eq!(saw, (true, true, true, true));
        assert_eq!(tool.invoked.load(Ordering::SeqCst), 0);
    }

    /// Wire-shape check for the `Usage` agent event. Both SSE and WS
    /// transports just call `serde_json::to_string(&ev)`, so the
    /// JSON layout here is the public contract clients build against.
    #[test]
    fn usage_event_serialises_flat_with_optional_fields_skipped() {
        let ev = AgentEvent::Usage {
            usage: Usage {
                prompt_tokens: Some(1234),
                completion_tokens: Some(56),
                cached_prompt_tokens: Some(800),
                reasoning_tokens: None,
            },
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(v["type"], "usage");
        assert_eq!(v["prompt_tokens"], 1234);
        assert_eq!(v["completion_tokens"], 56);
        assert_eq!(v["cached_prompt_tokens"], 800);
        // None fields are omitted, not serialised as null.
        assert!(v.get("reasoning_tokens").is_none(), "got: {v}");
    }

    #[test]
    fn usage_event_with_all_none_still_emits_type_tag() {
        let ev = AgentEvent::Usage {
            usage: Usage::default(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(v["type"], "usage");
        // Object should be exactly `{type: "usage"}` — every field None.
        assert_eq!(v.as_object().unwrap().len(), 1);
    }
}
