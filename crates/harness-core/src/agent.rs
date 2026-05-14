use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_stream::stream;
use futures::{Stream, StreamExt};
use serde::Serialize;
use tracing::{debug, info, instrument, Instrument, Span};

/// Wraps a `Stream` so each `poll_next` happens inside the given
/// tracing span. `tracing::Instrument` covers Futures only; this is the
/// minimal Stream equivalent.
struct SpanStream<S> {
    inner: Pin<Box<S>>,
    span: Span,
}

impl<S> Unpin for SpanStream<S> {}

impl<S: Stream> Stream for SpanStream<S> {
    type Item = S::Item;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let span = self.span.clone();
        let _enter = span.enter();
        self.inner.as_mut().poll_next(cx)
    }
}

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
    /// Master switch for parallel tool-call dispatch. When `true`,
    /// `ChatRequest::parallel_tool_calls` is set to `Some(true)` (so
    /// capable providers may emit multiple `tool_calls` in one
    /// assistant turn) **and** the agent loop dispatches those calls
    /// concurrently. When `false` (the historical default), tool
    /// calls run strictly sequentially even when a provider returns
    /// several. Capability validation lives in the
    /// `CapabilityValidatingProvider` wrapper — when the model
    /// doesn't support parallel tool calls, the wrapper downgrades
    /// the request flag silently and the agent's still-parallel
    /// dispatch is harmless because the LLM only emits one call at
    /// a time.
    pub parallel_tool_calls: bool,
    /// When `true` (default), `ensure_system_prompt` will *replace* the
    /// first `System` message of a loaded conversation when its content
    /// no longer matches the configured `system_prompt`. The historical
    /// behaviour was insert-if-missing only, which silently locked old
    /// conversations into whatever prompt was active at creation —
    /// updates to the binary's prompt template never reached resumed
    /// sessions. Set to `false` for workflows that deliberately persist
    /// per-conversation custom prompts.
    pub refresh_system_prompt_on_resume: bool,
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
            parallel_tool_calls: false,
            refresh_system_prompt_on_resume: true,
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

    /// Toggle the parallel-tool-call dispatch path. See
    /// [`AgentConfig::parallel_tool_calls`].
    pub fn with_parallel_tool_calls(mut self, enabled: bool) -> Self {
        self.parallel_tool_calls = enabled;
        self
    }

    /// Toggle resume-time refresh of the system prompt. See
    /// [`AgentConfig::refresh_system_prompt_on_resume`].
    pub fn with_refresh_system_prompt_on_resume(mut self, enabled: bool) -> Self {
        self.refresh_system_prompt_on_resume = enabled;
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
    SubAgentEvent {
        frame: crate::subagent::SubAgentFrame,
    },
    /// The active LLM provider hit a transient error (429 / 5xx /
    /// timeout) and the harness fell through to the next entry in
    /// its fallback chain. Emitted by
    /// [`crate::FallbackEvent`]-aware provider wrappers; the agent
    /// loop forwards every `FallbackEvent` it sees on the
    /// `fallback_event` task-local channel during a `complete` /
    /// `complete_stream` call. Transports surface this as an
    /// inline banner so the operator knows their request landed on
    /// a different provider than the configured default.
    ProviderFallback {
        event: crate::fallback_event::FallbackEvent,
    },
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
        /// Concrete model this LLM call was routed to. The frontend
        /// records long-running totals by model so cost estimates
        /// don't get recomputed under whatever model happens to be
        /// selected later.
        model: String,
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
        let (outcome, _usage) = self.run_with_usage(conversation).await?;
        Ok(outcome)
    }

    /// Same as [`run`](Self::run) but also returns the aggregated
    /// [`Usage`] reported by the provider across every iteration.
    /// Counters with `None` from the provider are skipped (no `0`
    /// fabrication); the empty `Usage` is returned when no iteration
    /// reported usage.
    #[instrument(
        skip_all,
        name = "jarvis.agent.run",
        fields(
            jarvis.agent.model = %self.config.model,
            jarvis.agent.max_iterations = self.config.max_iterations,
            jarvis.agent.iterations = tracing::field::Empty,
            jarvis.agent.finish_reason = tracing::field::Empty,
            jarvis.agent.hit_max_iterations = tracing::field::Empty,
        ),
    )]
    pub async fn run_with_usage(
        &self,
        conversation: &mut Conversation,
    ) -> Result<(RunOutcome, Usage)> {
        // Each blocking-mode turn gets a fresh per-turn mutation
        // counter so `todo.{add,update,delete}` can't be hammered into
        // the backlog by a runaway loop. The streaming entry
        // (`run_stream`) leaves scoping to its transport callers
        // because async-stream `yield` can't traverse a
        // `LocalKey::scope` boundary.
        crate::todo::with_turn_budget(self.run_inner(conversation)).await
    }

    async fn run_inner(&self, conversation: &mut Conversation) -> Result<(RunOutcome, Usage)> {
        Self::ensure_system_prompt(
            conversation,
            self.config.system_prompt.as_deref(),
            self.config.refresh_system_prompt_on_resume,
        );

        let mut total_usage = Usage::default();
        let run_span = Span::current();

        for iter in 1..=self.config.max_iterations {
            let iter_span =
                tracing::info_span!(parent: &run_span, "jarvis.agent.iteration", iteration = iter);

            let outcome = async {
                let req = self.build_request(conversation).await?;

                debug!(iteration = iter, "calling llm");
                let resp = self.llm.complete(req).await?;
                conversation.messages.push(resp.message.clone());
                if let Some(u) = resp.usage.as_ref() {
                    total_usage.add(u);
                }
                if let Some(rid) = resp.response_id.clone() {
                    conversation.last_response_id = Some(rid);
                    conversation.last_response_chain_origin = Some(conversation.messages.len());
                }

                match (&resp.message, &resp.finish_reason) {
                    (Message::Assistant { tool_calls, .. }, FinishReason::ToolCalls)
                        if !tool_calls.is_empty() =>
                    {
                        // Parallel dispatch path: when the operator opted
                        // in *and* the model emitted >1 tool call this
                        // turn, run them concurrently and push the
                        // resulting `Message::Tool` rows in the original
                        // `tool_calls` index order. Order matters
                        // because OpenAI / Anthropic require tool
                        // replies paired with the assistant's
                        // tool_use ids — out-of-order or missing entries
                        // trip 400s on the next request.
                        if self.config.parallel_tool_calls && tool_calls.len() > 1 {
                            // Resolve approvals concurrently first so
                            // `run_one` sees a `Some(Deny { reason })`
                            // and surfaces the synthetic `tool denied:`
                            // message in step with the others.
                            let approvals = futures::future::join_all(
                                tool_calls.iter().map(|call| {
                                    Self::maybe_request_approval(
                                        &self.config.tools,
                                        self.config.approver.as_deref(),
                                        call,
                                    )
                                }),
                            )
                            .await;
                            // Then dispatch invokes concurrently. Each
                            // re-enters the session-workspace scope; no
                            // streaming channels because the blocking
                            // entry point doesn't yield events.
                            let outputs = futures::future::join_all(
                                tool_calls.iter().zip(approvals.iter()).map(
                                    |(call, approval)| {
                                        crate::workspace::with_session_workspace(
                                            self.config.session_workspace.clone(),
                                            Self::run_one(
                                                &self.config.tools,
                                                call,
                                                approval.as_ref().map(|(_, d)| d),
                                            ),
                                        )
                                    },
                                ),
                            )
                            .await;
                            // Stable order: index by `tool_calls`, not
                            // by completion time.
                            for (call, output) in tool_calls.iter().zip(outputs) {
                                conversation
                                    .messages
                                    .push(Message::tool_result(&call.id, output));
                            }
                        } else {
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
                        Ok::<Option<RunOutcome>, Error>(None)
                    }
                    (_, FinishReason::Length) => {
                        info!(iteration = iter, "llm finished due to length");
                        Ok(Some(RunOutcome::LengthLimited { iterations: iter }))
                    }
                    _ => {
                        info!(iteration = iter, "llm finished");
                        Ok(Some(RunOutcome::Stopped { iterations: iter }))
                    }
                }
            }
            .instrument(iter_span)
            .await?;

            if let Some(out) = outcome {
                let (reason, hit_max) = match &out {
                    RunOutcome::LengthLimited { .. } => ("length", false),
                    RunOutcome::Stopped { .. } => ("stop", false),
                };
                run_span.record("jarvis.agent.iterations", iter);
                run_span.record("jarvis.agent.finish_reason", reason);
                run_span.record("jarvis.agent.hit_max_iterations", hit_max);
                return Ok((out, total_usage));
            }
        }

        run_span.record("jarvis.agent.iterations", self.config.max_iterations);
        run_span.record("jarvis.agent.finish_reason", "max_iterations");
        run_span.record("jarvis.agent.hit_max_iterations", true);
        Err(Error::MaxIterations(self.config.max_iterations))
    }

    /// Streaming variant of `run`. Returns an event stream; consumers rebuild
    /// conversation state from the events (the terminal `Done` event carries
    /// the full conversation).
    pub fn run_stream(self: Arc<Self>, mut conversation: Conversation) -> AgentStream {
        let agent = self.clone();
        let run_span = tracing::info_span!(
            "jarvis.agent.run",
            jarvis.agent.model = %agent.config.model,
            jarvis.agent.max_iterations = agent.config.max_iterations,
            jarvis.transport = "stream",
        );
        let inner = stream! {
            Self::ensure_system_prompt(
                &mut conversation,
                agent.config.system_prompt.as_deref(),
                agent.config.refresh_system_prompt_on_resume,
            );

            for iter in 1..=agent.config.max_iterations {
                let req = match agent.build_request(&conversation).await {
                    Ok(r) => r,
                    Err(e) => {
                        yield AgentEvent::Error { message: e.to_string() };
                        return;
                    }
                };

                debug!(iteration = iter, "calling llm (streaming)");
                // Install the fallback listener for the duration of
                // the `complete_stream` call. Provider wrappers
                // (FallbackProvider) emit one [`FallbackEvent`] per
                // chain hop into this channel; the agent loop drains
                // it as `AgentEvent::ProviderFallback` so the UI can
                // render an inline banner. The channel is scope-
                // local to the LLM call: by the time we get the
                // stream back, all retry events are already queued.
                let (fb_tx, mut fb_rx) =
                    tokio::sync::mpsc::unbounded_channel::<crate::FallbackEvent>();
                let stream_result = crate::with_fallback_listener(
                    fb_tx,
                    agent.llm.complete_stream(req),
                )
                .await;
                while let Ok(event) = fb_rx.try_recv() {
                    yield AgentEvent::ProviderFallback { event };
                }
                let mut llm_stream = match stream_result {
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
                            yield AgentEvent::Usage {
                                model: agent.config.model.clone(),
                                usage,
                            };
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
                        // Two paths: sequential (the historical default)
                        // and parallel (opted in via
                        // `AgentConfig::parallel_tool_calls` and only
                        // engaged when the model emitted >1 call this
                        // turn). The parallel path runs invokes
                        // concurrently while still streaming
                        // per-call ToolProgress / PlanUpdate /
                        // SubAgentEvent through a shared mpsc; the
                        // sequential path is preserved verbatim so
                        // single-tool turns and small-LLM compatibility
                        // don't regress.
                        let parallel = agent.config.parallel_tool_calls
                            && tool_calls.len() > 1;

                        if !parallel {
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
                        } else {
                            // Parallel path. Three phases:
                            //
                            // 1. Approval. Emit `ApprovalRequest` for
                            //    every gated call up front (one per
                            //    `yield`), then await all approvers
                            //    concurrently. The transport sees
                            //    several pending approvals at once and
                            //    can show "3 approvals pending" rather
                            //    than dripping them out one at a time.
                            //
                            // 2. Dispatch. Emit `ToolStart` for every
                            //    call, then drive all `Tool::invoke`
                            //    futures via `FuturesUnordered`. Each
                            //    invoke pushes its
                            //    `ToolProgress` / `PlanUpdate` /
                            //    `SubAgentEvent` events into a shared
                            //    `mpsc<AgentEvent>` so they interleave
                            //    on the wire. Yield those events as
                            //    they arrive plus the per-call
                            //    `ToolEnd` once a future resolves.
                            //
                            // 3. Append `Message::tool_result` rows in
                            //    the *original* `tool_calls` index
                            //    order regardless of completion order
                            //    — OpenAI / Anthropic require tool
                            //    replies paired with the assistant's
                            //    tool_use ids and reject reorderings.
                            //
                            // Terminal tools: the moment the first
                            // terminal call resolves we drop the
                            // remaining futures (cancelling them) and
                            // emit `PlanProposed` + `Done`. This
                            // matches the sequential path's
                            // behaviour but races at the resolution
                            // point rather than at iteration time.
                            let n = tool_calls.len();

                            // Phase 1: build approval requests and
                            // emit ApprovalRequest events.
                            #[allow(clippy::type_complexity)]
                            let mut approval_reqs: Vec<Option<ApprovalRequest>> =
                                Vec::with_capacity(n);
                            for call in tool_calls {
                                let needs_approval =
                                    agent.config.approver.is_some()
                                        && agent
                                            .config
                                            .tools
                                            .resolve(&call.name)
                                            .map(|t| t.requires_approval())
                                            .unwrap_or(false);
                                if needs_approval {
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
                                    approval_reqs.push(Some(ApprovalRequest {
                                        tool_call_id: call.id.clone(),
                                        tool_name: call.name.clone(),
                                        arguments: call.arguments.clone(),
                                        category,
                                    }));
                                } else {
                                    approval_reqs.push(None);
                                }
                            }

                            // Await approvals concurrently. Result is
                            // `Vec<Option<(Decision, Source)>>` with
                            // `None` for calls that didn't need one.
                            let approver_opt = agent.config.approver.as_deref();
                            let approval_results = futures::future::join_all(
                                approval_reqs.iter().map(|maybe_req| async move {
                                    match (maybe_req, approver_opt) {
                                        (Some(req), Some(a)) => {
                                            match a
                                                .approve_with_source(req.clone())
                                                .await
                                            {
                                                Ok(pair) => Some(pair),
                                                Err(e) => Some((
                                                    ApprovalDecision::Deny {
                                                        reason: Some(format!(
                                                            "approver failed: {e}"
                                                        )),
                                                    },
                                                    crate::permission::HitSource::UserPrompt,
                                                )),
                                            }
                                        }
                                        _ => None,
                                    }
                                }),
                            )
                            .await;

                            // Yield ApprovalDecision events in original
                            // index order so transports render them in
                            // the same order as the matching ToolStart.
                            let mut decisions: Vec<Option<ApprovalDecision>> =
                                Vec::with_capacity(n);
                            for (call, res) in
                                tool_calls.iter().zip(approval_results.into_iter())
                            {
                                if let Some((dec, source)) = res {
                                    yield AgentEvent::ApprovalDecision {
                                        id: call.id.clone(),
                                        name: call.name.clone(),
                                        decision: dec.clone(),
                                        source: Some(source),
                                    };
                                    decisions.push(Some(dec));
                                } else {
                                    decisions.push(None);
                                }
                            }

                            // Phase 2: emit ToolStart for every call.
                            for call in tool_calls {
                                yield AgentEvent::ToolStart {
                                    id: call.id.clone(),
                                    name: call.name.clone(),
                                    arguments: call.arguments.clone(),
                                };
                            }

                            // Build the shared event channel.
                            // Per-invocation futures push their
                            // streamed events here; the outer select!
                            // drains and re-yields them.
                            let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<
                                AgentEvent,
                            >();

                            let mut invokes: futures::stream::FuturesUnordered<_> = tool_calls
                                .iter()
                                .cloned()
                                .zip(decisions.into_iter())
                                .enumerate()
                                .map(|(idx, (call, decision))| {
                                    let agent = agent.clone();
                                    let event_tx = event_tx.clone();
                                    async move {
                                        let (prog_tx, mut prog_rx) = tokio::sync::mpsc::unbounded_channel::<crate::progress::ToolProgress>();
                                        let (plan_tx, mut plan_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<crate::plan::PlanItem>>();
                                        let (sub_tx, mut sub_rx) = tokio::sync::mpsc::unbounded_channel::<crate::subagent::SubAgentFrame>();
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
                                                                &call,
                                                                decision.as_ref(),
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        );
                                        tokio::pin!(invoke);
                                        let id = call.id.clone();
                                        let name = call.name.clone();
                                        let output = loop {
                                            tokio::select! {
                                                biased;
                                                Some(p) = prog_rx.recv() => {
                                                    let _ = event_tx.send(AgentEvent::ToolProgress {
                                                        id: id.clone(),
                                                        name: name.clone(),
                                                        stream: p.stream,
                                                        chunk: p.chunk,
                                                    });
                                                }
                                                Some(items) = plan_rx.recv() => {
                                                    let _ = event_tx.send(AgentEvent::PlanUpdate { items });
                                                }
                                                Some(frame) = sub_rx.recv() => {
                                                    let _ = event_tx.send(AgentEvent::SubAgentEvent { frame });
                                                }
                                                res = &mut invoke => {
                                                    while let Ok(p) = prog_rx.try_recv() {
                                                        let _ = event_tx.send(AgentEvent::ToolProgress {
                                                            id: id.clone(),
                                                            name: name.clone(),
                                                            stream: p.stream,
                                                            chunk: p.chunk,
                                                        });
                                                    }
                                                    while let Ok(items) = plan_rx.try_recv() {
                                                        let _ = event_tx.send(AgentEvent::PlanUpdate { items });
                                                    }
                                                    while let Ok(frame) = sub_rx.try_recv() {
                                                        let _ = event_tx.send(AgentEvent::SubAgentEvent { frame });
                                                    }
                                                    break res;
                                                }
                                            }
                                        };
                                        let _ = event_tx.send(AgentEvent::ToolEnd {
                                            id: id.clone(),
                                            name: name.clone(),
                                            content: output.clone(),
                                        });
                                        (idx, output)
                                    }
                                })
                                .collect();

                            // Drop the original sender — when every
                            // per-call clone drops, `event_rx.recv()`
                            // returns `None` and we fall through.
                            drop(event_tx);

                            // Phase 3: pump events + collect outputs.
                            let mut outputs: Vec<Option<String>> =
                                std::iter::repeat_with(|| None).take(n).collect();
                            let mut terminal_idx: Option<usize> = None;
                            loop {
                                tokio::select! {
                                    biased;
                                    Some(ev) = event_rx.recv() => {
                                        yield ev;
                                    }
                                    Some((idx, output)) = invokes.next() => {
                                        // Detect terminal call. We
                                        // can't break out of the
                                        // dispatch yet — siblings'
                                        // events may still be in
                                        // flight on `event_rx`. Mark
                                        // the index, let `invokes`
                                        // drain (futures cancel on
                                        // drop after the loop), then
                                        // emit `PlanProposed` + Done.
                                        let is_terminal = agent
                                            .config
                                            .tools
                                            .resolve(&tool_calls[idx].name)
                                            .map(|t| t.is_terminal())
                                            .unwrap_or(false);
                                        outputs[idx] = Some(output);
                                        if is_terminal {
                                            terminal_idx = Some(idx);
                                            break;
                                        }
                                    }
                                    else => break,
                                }
                            }

                            // Drain any straggler events queued in the
                            // same wake as the last completion so the
                            // client sees them before the appended
                            // tool_result rows.
                            while let Ok(ev) = event_rx.try_recv() {
                                yield ev;
                            }

                            // Materialise per-call content strings.
                            // Calls cancelled by a terminal sibling
                            // get a synthetic "tool cancelled: …"
                            // sentinel so the assistant's tool_calls
                            // list still has a matching reply for
                            // every id (some providers reject the
                            // next request otherwise).
                            let final_contents: Vec<String> = (0..n)
                                .map(|idx| {
                                    outputs[idx].take().unwrap_or_else(|| {
                                        "tool cancelled: terminal sibling ended turn".to_string()
                                    })
                                })
                                .collect();

                            for (call, content) in
                                tool_calls.iter().zip(final_contents.iter())
                            {
                                conversation
                                    .messages
                                    .push(Message::tool_result(&call.id, content.clone()));
                            }

                            if let Some(idx) = terminal_idx {
                                yield AgentEvent::PlanProposed {
                                    plan: final_contents[idx].clone(),
                                };
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
        };
        Box::pin(SpanStream {
            inner: Box::pin(inner),
            span: run_span,
        })
    }

    fn ensure_system_prompt(conv: &mut Conversation, prompt: Option<&str>, refresh: bool) {
        let Some(prompt) = prompt else { return };
        match conv.messages.first() {
            Some(Message::System { content, .. }) if content == prompt => {
                // Already in sync — nothing to do.
            }
            Some(Message::System { .. }) if refresh => {
                // First message is a stale System (different content from
                // the configured prompt) and the refresh policy is on:
                // replace it. This is what unblocks resumed conversations
                // from staying stuck on whatever prompt was active when
                // they were originally created.
                conv.messages[0] = Message::system(prompt);
            }
            Some(Message::System { .. }) => {
                // Stale but refresh is off — historical behaviour, leave
                // the persisted custom prompt alone.
            }
            _ => {
                // No leading System at all — insert one.
                conv.messages.insert(0, Message::system(prompt));
            }
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
            parallel_tool_calls: self
                .config
                .parallel_tool_calls
                .then_some(true),
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
    #[instrument(
        skip_all,
        name = "gen_ai.tool.call",
        fields(
            gen_ai.tool.name = %call.name,
            jarvis.tool.id = %call.id,
            jarvis.tool.args.bytes = tracing::field::Empty,
            jarvis.tool.output.bytes = tracing::field::Empty,
            jarvis.tool.success = tracing::field::Empty,
        ),
    )]
    async fn run_one(
        tools: &ToolRegistry,
        call: &ToolCall,
        decision: Option<&ApprovalDecision>,
    ) -> String {
        let span = Span::current();
        let args_bytes = serde_json::to_vec(&call.arguments)
            .map(|v| v.len())
            .unwrap_or(0);
        span.record("jarvis.tool.args.bytes", args_bytes);

        if let Some(ApprovalDecision::Deny { reason }) = decision {
            let r = reason
                .clone()
                .unwrap_or_else(|| "no reason given".to_string());
            let out = format!("tool denied: {r}");
            span.record("jarvis.tool.output.bytes", out.len());
            span.record("jarvis.tool.success", false);
            return out;
        }
        debug!(name = %call.name, id = %call.id, "invoking tool");
        let out = match tools.resolve(&call.name) {
            Some(tool) => match tool.invoke(call.arguments.clone()).await {
                Ok(s) => {
                    span.record("jarvis.tool.success", true);
                    s
                }
                Err(e) => {
                    span.record("jarvis.tool.success", false);
                    format!("tool error: {e}")
                }
            },
            None => {
                span.record("jarvis.tool.success", false);
                format!("tool error: tool not found: {}", call.name)
            }
        };
        span.record("jarvis.tool.output.bytes", out.len());
        out
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
                    usage: None,
                })
            } else {
                Ok(ChatResponse {
                    message: Message::assistant_text("done"),
                    finish_reason: FinishReason::Stop,
                    response_id: None,
                    usage: None,
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
            model: "gpt-test".into(),
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
        assert_eq!(v["model"], "gpt-test");
        assert_eq!(v["prompt_tokens"], 1234);
        assert_eq!(v["completion_tokens"], 56);
        assert_eq!(v["cached_prompt_tokens"], 800);
        // None fields are omitted, not serialised as null.
        assert!(v.get("reasoning_tokens").is_none(), "got: {v}");
    }

    #[test]
    fn usage_event_with_all_none_still_emits_type_tag() {
        let ev = AgentEvent::Usage {
            model: "gpt-test".into(),
            usage: Usage::default(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(v["type"], "usage");
        // Object should be exactly `{type, model}` — every count field None.
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    // ---------- Parallel tool-call dispatch tests ----------

    /// Two-step LLM scripted to emit *N* tool calls in a single
    /// assistant turn, then stop. Used by the parallel-dispatch
    /// tests to check ordering, mixed approve/deny, and that the
    /// sequential path still kicks in when only one tool is called.
    struct MultiCallLlm {
        iter: AtomicUsize,
        calls: Vec<ToolCall>,
    }

    impl MultiCallLlm {
        fn new(calls: Vec<ToolCall>) -> Arc<Self> {
            Arc::new(Self {
                iter: AtomicUsize::new(0),
                calls,
            })
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for MultiCallLlm {
        async fn complete(&self, _req: ChatRequest) -> Result<ChatResponse> {
            let i = self.iter.fetch_add(1, Ordering::SeqCst);
            if i == 0 {
                Ok(ChatResponse {
                    message: Message::Assistant {
                        content: None,
                        tool_calls: self.calls.clone(),
                        reasoning_content: None,
                        cache: None,
                    },
                    finish_reason: FinishReason::ToolCalls,
                    response_id: None,
                    usage: None,
                })
            } else {
                Ok(ChatResponse {
                    message: Message::assistant_text("done"),
                    finish_reason: FinishReason::Stop,
                    response_id: None,
                    usage: None,
                })
            }
        }
    }

    /// Tool that sleeps for `delay_ms` before returning a
    /// per-instance label. The sleep lets parallel-dispatch tests
    /// observe non-trivial ordering: a long-running call A and a
    /// short call B should still be appended to the conversation in
    /// `[A, B]` order even though B completes first.
    struct DelayTool {
        name: &'static str,
        label: String,
        delay_ms: u64,
    }

    impl DelayTool {
        fn new(name: &'static str, label: impl Into<String>, delay_ms: u64) -> Arc<Self> {
            Arc::new(Self {
                name,
                label: label.into(),
                delay_ms,
            })
        }
    }

    #[async_trait::async_trait]
    impl Tool for DelayTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "delay tool"
        }
        fn parameters(&self) -> Value {
            json!({"type": "object"})
        }
        async fn invoke(&self, _args: Value) -> std::result::Result<String, BoxError> {
            tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            Ok(self.label.clone())
        }
    }

    fn make_agent_with_tools(
        tools: Vec<Arc<dyn Tool>>,
        calls: Vec<ToolCall>,
        approver: Option<Arc<dyn Approver>>,
        parallel: bool,
    ) -> Arc<Agent> {
        let mut registry = ToolRegistry::new();
        for t in tools {
            registry.register_arc(t);
        }
        let mut cfg = AgentConfig::new("test-model").with_tools(registry);
        if let Some(a) = approver {
            cfg = cfg.with_approver(a);
        }
        if parallel {
            cfg = cfg.with_parallel_tool_calls(true);
        }
        Arc::new(Agent::new(MultiCallLlm::new(calls) as _, cfg))
    }

    fn tool_call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: json!({}),
        }
    }

    #[tokio::test]
    async fn parallel_dispatch_preserves_index_order() {
        // A is slow, B is fast. The model emits [A, B] in one turn.
        // With parallel dispatch on, B finishes first but the
        // resulting tool_result messages must still be appended in
        // [A, B] order so the next request's tool_use/tool_result
        // pairing stays intact for OpenAI/Anthropic.
        let a = DelayTool::new("a_slow", "A", 60);
        let b = DelayTool::new("b_fast", "B", 5);
        let calls = vec![
            tool_call("call_a", "a_slow"),
            tool_call("call_b", "b_fast"),
        ];
        let agent = make_agent_with_tools(vec![a.clone(), b.clone()], calls, None, true);
        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();
        let tool_msgs: Vec<_> = conv
            .messages
            .iter()
            .filter_map(|m| match m {
                Message::Tool {
                    tool_call_id,
                    content,
                    ..
                } => Some((tool_call_id.clone(), content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            tool_msgs,
            vec![
                ("call_a".into(), "A".into()),
                ("call_b".into(), "B".into()),
            ],
            "expected tool replies in original tool_calls index order"
        );
    }

    #[tokio::test]
    async fn parallel_dispatch_runs_concurrently() {
        // Two 80ms calls run in parallel should finish in ~80ms,
        // not ~160ms. Generous slack (300ms) keeps the test stable
        // on slow CI; the goal is to detect "ran serially" (160ms)
        // vs "ran concurrently" (~80ms).
        let a = DelayTool::new("a", "A", 80);
        let b = DelayTool::new("b", "B", 80);
        let calls = vec![tool_call("ca", "a"), tool_call("cb", "b")];
        let agent = make_agent_with_tools(vec![a, b], calls, None, true);
        let mut conv = Conversation::new();
        let start = std::time::Instant::now();
        agent.run(&mut conv).await.unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(300),
            "parallel run took {elapsed:?}, expected concurrent (~80ms)"
        );
    }

    #[tokio::test]
    async fn sequential_dispatch_runs_serially() {
        // Sanity: with parallel off, two 60ms calls take ~120ms.
        let a = DelayTool::new("a", "A", 60);
        let b = DelayTool::new("b", "B", 60);
        let calls = vec![tool_call("ca", "a"), tool_call("cb", "b")];
        let agent = make_agent_with_tools(vec![a, b], calls, None, false);
        let mut conv = Conversation::new();
        let start = std::time::Instant::now();
        agent.run(&mut conv).await.unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed >= std::time::Duration::from_millis(100),
            "sequential run took {elapsed:?}, expected ~120ms"
        );
    }

    #[tokio::test]
    async fn parallel_dispatch_with_mixed_approve_deny() {
        // Two gated tools, one approved (a) and one denied (b). The
        // approver always denies tool "b" by name. The conversation
        // should carry: assistant w/ both tool_calls, tool_result A
        // = "A", tool_result B = "tool denied: ...".
        struct ByNameApprover;
        #[async_trait::async_trait]
        impl Approver for ByNameApprover {
            async fn approve(
                &self,
                req: ApprovalRequest,
            ) -> std::result::Result<ApprovalDecision, crate::error::BoxError> {
                if req.tool_name == "b" {
                    Ok(ApprovalDecision::Deny {
                        reason: Some("hated".into()),
                    })
                } else {
                    Ok(ApprovalDecision::Approve)
                }
            }
        }

        struct GatedDelayTool {
            name: &'static str,
            label: String,
        }
        #[async_trait::async_trait]
        impl Tool for GatedDelayTool {
            fn name(&self) -> &str {
                self.name
            }
            fn description(&self) -> &str {
                "g"
            }
            fn parameters(&self) -> Value {
                json!({"type": "object"})
            }
            fn requires_approval(&self) -> bool {
                true
            }
            async fn invoke(&self, _args: Value) -> std::result::Result<String, BoxError> {
                Ok(self.label.clone())
            }
        }

        let a: Arc<dyn Tool> = Arc::new(GatedDelayTool {
            name: "a",
            label: "A".into(),
        });
        let b: Arc<dyn Tool> = Arc::new(GatedDelayTool {
            name: "b",
            label: "B".into(),
        });
        let calls = vec![tool_call("ca", "a"), tool_call("cb", "b")];
        let agent = make_agent_with_tools(
            vec![a, b],
            calls,
            Some(Arc::new(ByNameApprover) as _),
            true,
        );
        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();
        let tool_msgs: Vec<_> = conv
            .messages
            .iter()
            .filter_map(|m| match m {
                Message::Tool {
                    tool_call_id,
                    content,
                    ..
                } => Some((tool_call_id.clone(), content.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(tool_msgs.len(), 2, "got {tool_msgs:?}");
        assert_eq!(tool_msgs[0].0, "ca");
        assert_eq!(tool_msgs[0].1, "A");
        assert_eq!(tool_msgs[1].0, "cb");
        assert!(
            tool_msgs[1].1.starts_with("tool denied:"),
            "got: {}",
            tool_msgs[1].1
        );
    }

    #[tokio::test]
    async fn parallel_path_skipped_for_single_call() {
        // n=1 with parallel flag on still uses the sequential path
        // (the parallel branch is `n > 1`). Confirms we don't
        // regress single-tool turns under the new flag.
        let tool = CountingTool::new("safe", false);
        let calls = vec![tool_call("c1", "safe")];
        let agent = make_agent_with_tools(
            vec![tool.clone() as _],
            calls,
            None,
            true,
        );
        let mut conv = Conversation::new();
        agent.run(&mut conv).await.unwrap();
        assert_eq!(tool.invoked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn parallel_streaming_emits_paired_events_for_each_call() {
        // Streaming variant of `parallel_dispatch_preserves_index_order`.
        // We don't assert on event ordering across calls (interleaving
        // is allowed) but each tool_call_id must produce exactly one
        // ToolStart / ToolEnd pair, and the final conversation must
        // hold tool_result rows in original index order.
        use futures::StreamExt;
        let a = DelayTool::new("a_slow", "A", 40);
        let b = DelayTool::new("b_fast", "B", 5);
        let calls = vec![
            tool_call("call_a", "a_slow"),
            tool_call("call_b", "b_fast"),
        ];
        let agent = make_agent_with_tools(vec![a, b], calls, None, true);
        let mut stream = agent.run_stream(Conversation::new());
        let mut starts: Vec<String> = vec![];
        let mut ends: Vec<(String, String)> = vec![];
        let mut final_conv: Option<Conversation> = None;
        while let Some(ev) = stream.next().await {
            match ev {
                AgentEvent::ToolStart { id, .. } => starts.push(id),
                AgentEvent::ToolEnd { id, content, .. } => ends.push((id, content)),
                AgentEvent::Done { conversation, .. } => final_conv = Some(conversation),
                _ => {}
            }
        }
        assert_eq!(
            starts.len(),
            2,
            "expected one ToolStart per call, got {starts:?}"
        );
        assert!(starts.contains(&"call_a".to_string()));
        assert!(starts.contains(&"call_b".to_string()));
        assert_eq!(ends.len(), 2, "expected one ToolEnd per call");
        // Final conversation has tool_result rows in [a, b] order.
        let conv = final_conv.expect("Done event carries the final conversation");
        let tool_ids: Vec<_> = conv
            .messages
            .iter()
            .filter_map(|m| match m {
                Message::Tool { tool_call_id, .. } => Some(tool_call_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(tool_ids, vec!["call_a", "call_b"]);
    }

    #[test]
    fn build_request_propagates_parallel_flag() {
        // Smoke test the wiring from `AgentConfig::parallel_tool_calls`
        // → `ChatRequest::parallel_tool_calls`. We don't run a turn
        // here — just check `build_request` shapes the wire.
        let mut registry = ToolRegistry::new();
        registry.register_arc(CountingTool::new("safe", false) as _);
        let cfg = AgentConfig::new("m")
            .with_tools(registry)
            .with_parallel_tool_calls(true);
        let agent = Agent {
            llm: ScriptedLlm::new("safe") as _,
            config: cfg,
        };
        let conv = Conversation::new();
        let req = futures::executor::block_on(agent.build_request(&conv)).unwrap();
        assert_eq!(req.parallel_tool_calls, Some(true));
    }

    #[test]
    fn build_request_omits_parallel_flag_when_off() {
        let mut registry = ToolRegistry::new();
        registry.register_arc(CountingTool::new("safe", false) as _);
        let cfg = AgentConfig::new("m").with_tools(registry);
        let agent = Agent {
            llm: ScriptedLlm::new("safe") as _,
            config: cfg,
        };
        let conv = Conversation::new();
        let req = futures::executor::block_on(agent.build_request(&conv)).unwrap();
        assert_eq!(req.parallel_tool_calls, None);
    }

    #[test]
    fn ensure_system_prompt_inserts_when_missing() {
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));
        Agent::ensure_system_prompt(&mut conv, Some("PROMPT"), true);
        assert!(matches!(conv.messages[0], Message::System { ref content, .. } if content == "PROMPT"));
        assert_eq!(conv.messages.len(), 2);
    }

    #[test]
    fn ensure_system_prompt_skips_when_already_in_sync() {
        let mut conv = Conversation::new();
        conv.push(Message::system("PROMPT"));
        conv.push(Message::user("hi"));
        let before_len = conv.messages.len();
        Agent::ensure_system_prompt(&mut conv, Some("PROMPT"), true);
        assert_eq!(conv.messages.len(), before_len);
        assert!(matches!(conv.messages[0], Message::System { ref content, .. } if content == "PROMPT"));
    }

    #[test]
    fn ensure_system_prompt_replaces_stale_when_refresh_on() {
        let mut conv = Conversation::new();
        conv.push(Message::system("STALE"));
        conv.push(Message::user("hi"));
        Agent::ensure_system_prompt(&mut conv, Some("FRESH"), true);
        assert_eq!(conv.messages.len(), 2);
        assert!(matches!(conv.messages[0], Message::System { ref content, .. } if content == "FRESH"));
    }

    #[test]
    fn ensure_system_prompt_keeps_stale_when_refresh_off() {
        let mut conv = Conversation::new();
        conv.push(Message::system("STALE"));
        conv.push(Message::user("hi"));
        Agent::ensure_system_prompt(&mut conv, Some("FRESH"), false);
        assert_eq!(conv.messages.len(), 2);
        assert!(matches!(conv.messages[0], Message::System { ref content, .. } if content == "STALE"));
    }

    #[test]
    fn ensure_system_prompt_no_op_when_no_prompt_configured() {
        let mut conv = Conversation::new();
        conv.push(Message::system("KEEP"));
        conv.push(Message::user("hi"));
        Agent::ensure_system_prompt(&mut conv, None, true);
        assert!(matches!(conv.messages[0], Message::System { ref content, .. } if content == "KEEP"));
    }
}
