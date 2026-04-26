//! Generic OpenAI Responses-API provider.
//!
//! Speaks the **Responses API** wire shape:
//! `instructions` (top-level system prompt) + `input` array of typed
//! items (`message`, `function_call`, `function_call_output`) + typed
//! SSE events (`response.output_item.added`,
//! `response.output_text.delta`,
//! `response.function_call_arguments.delta`,
//! `response.output_item.done`, `response.completed`).
//!
//! One implementation, two endpoints out of the box (and any custom
//! third you point it at):
//!
//! - [`ResponsesProvider::codex`] — `chatgpt.com/backend-api/codex/responses`
//!   with **ChatGPT OAuth** (Codex CLI / ChatGPT Plus or Pro
//!   subscription). Bills against the user's subscription at flat
//!   rate. The endpoint is not a public OpenAI API and the path has
//!   changed before — operators should be aware they're piggy-backing
//!   on the same surface the official Codex CLI uses (we log a
//!   ToS-pointing `info!` on startup in `apps/jarvis`).
//! - [`ResponsesProvider::openai_responses`] —
//!   `api.openai.com/v1/responses` with an **OpenAI API key**.
//!   This is the public, supported Responses surface — useful for
//!   reasoning models (`o1`, `o3`, `gpt-5`) and any feature OpenAI
//!   ships only on Responses rather than Chat Completions.
//!
//! ## Auth
//!
//! [`ResponsesAuth`] is the one place auth strategies plug in:
//!
//! - `ApiKey` — static `sk-...` style bearer. No refresh; a 401 is
//!   surfaced verbatim to the caller.
//! - `ChatGptOauth` — refreshable [`CodexAuth`] (read from
//!   `~/.codex/auth.json` or a static dev token). On a 401 the
//!   provider locks the auth and refreshes against
//!   `auth.openai.com/oauth/token`, then retries once. Concurrent
//!   requests coalesce on a token snapshot so we don't refresh twice.
//!
//! ## Wire shape (vs. Chat Completions)
//!
//! Three load-bearing differences from `OpenAiProvider`:
//!
//! 1. **`system` becomes top-level `instructions`.** Multiple system
//!    messages are joined with `\n\n`.
//! 2. **Tool calls are first-class items, not embedded.** An
//!    `Assistant.tool_calls` doesn't ride inline; each call becomes a
//!    `{type:"function_call", call_id, name, arguments}` item in the
//!    top-level `input` array. Tool results become
//!    `{type:"function_call_output", call_id, output}` items.
//!    `tool_call_id` round-trips cleanly because the Responses API
//!    uses the same opaque-string semantics OpenAI Chat Completions
//!    uses.
//! 3. **Streaming uses typed events** — see the `StreamEvent` enum
//!    below. The `Finish` chunk is synthesised on
//!    `response.completed` (or on body close as a fallback).

use std::collections::HashMap;
use std::sync::Arc;

use async_stream::try_stream;
use async_trait::async_trait;
use futures::StreamExt;
use harness_core::{
    ChatRequest, ChatResponse, Error, FinishReason, LlmChunk, LlmProvider, LlmStream, Message,
    Result, TokenEstimator, ToolCall, ToolSpec, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::debug;

use crate::codex_auth::CodexAuth;
use crate::tokens::TiktokenEstimator;

// ---------- Auth ----------

/// How the provider obtains the bearer token. Add new variants for
/// future endpoints (Azure AD, Bedrock, etc.) — every consumer goes
/// through `snapshot` and `refresh_if_unchanged`, so the provider
/// loop stays the same.
#[derive(Clone)]
pub enum ResponsesAuth {
    /// Static bearer token (e.g. an OpenAI Platform API key
    /// `sk-...`). No refresh; a 401 surfaces upstream so the caller
    /// can rotate the key.
    ApiKey(String),
    /// Refreshable ChatGPT subscription OAuth, normally loaded from
    /// `~/.codex/auth.json` via `CodexAuth::load_from_codex_home`.
    /// Wrapped in `Arc<Mutex<...>>` so concurrent requests can share
    /// one in-flight refresh.
    ChatGptOauth(Arc<Mutex<CodexAuth>>),
}

/// What the request layer needs to put on the wire — bearer token +
/// optional `ChatGPT-Account-ID` header value.
#[derive(Debug, Clone)]
struct BearerSnapshot {
    token: String,
    account_id: Option<String>,
}

impl ResponsesAuth {
    /// Snapshot the current bearer + account id without holding any
    /// lock across `.await`s further down the request path. The
    /// returned `token` is also the coalescing key passed back to
    /// `refresh_if_unchanged` on a 401.
    async fn snapshot(&self) -> BearerSnapshot {
        match self {
            Self::ApiKey(k) => BearerSnapshot {
                token: k.clone(),
                account_id: None,
            },
            Self::ChatGptOauth(auth) => {
                let g = auth.lock().await;
                BearerSnapshot {
                    token: g.access_token.clone(),
                    account_id: g.account_id.clone(),
                }
            }
        }
    }

    /// Run a refresh only if the in-memory token is still the one the
    /// caller saw — this means concurrent 401s collapse into one
    /// network refresh, and stale callers just retry with the
    /// already-refreshed token.
    async fn refresh_if_unchanged(
        &self,
        http: &reqwest::Client,
        expected_token: &str,
    ) -> Result<()> {
        match self {
            Self::ApiKey(_) => Err(Error::Provider(
                "API-key auth cannot refresh; rotate the key".into(),
            )),
            Self::ChatGptOauth(auth) => {
                let mut g = auth.lock().await;
                if g.access_token != expected_token {
                    return Ok(());
                }
                g.refresh(http)
                    .await
                    .map_err(|e| Error::Provider(format!("oauth refresh: {e}")))
            }
        }
    }
}

// ---------- Config ----------

/// Configuration for [`ResponsesProvider`]. Construct via
/// [`ResponsesConfig::codex`] / [`ResponsesConfig::openai_responses`]
/// for the two supported flavours, then chain `with_*` mutators if
/// you need to customise reasoning / store / service_tier / etc.
#[derive(Clone)]
pub struct ResponsesConfig {
    pub auth: ResponsesAuth,
    /// e.g. `https://chatgpt.com/backend-api` or
    /// `https://api.openai.com/v1`. The request URL is `base_url +
    /// path`.
    pub base_url: String,
    /// e.g. `/codex/responses` or `/responses`.
    pub path: String,
    /// Sent as the `originator` header. Used by Codex specifically;
    /// public Responses ignores it. Defaults to `"jarvis"` for
    /// Codex, `None` for public OpenAI.
    pub originator: Option<String>,
    /// `OpenAI-Beta` header value. Codex sends `responses=v1`;
    /// public OpenAI doesn't require one for the GA path.
    pub openai_beta: Option<String>,
    /// `store` field on the request. We ship `false` so the provider
    /// doesn't keep server-side state (we use `harness-store`).
    /// Override only if you specifically want to use the provider's
    /// `previous_response_id` feature instead.
    pub store: bool,
    /// `service_tier` — `"auto"` / `"priority"` / `"flex"` / etc.
    /// `None` lets the server pick. Codex uses `"priority"` when the
    /// user opts in to its `/fast` toggle.
    pub service_tier: Option<String>,
    /// Whether to ask for `reasoning.encrypted_content` to be
    /// returned. Required for reasoning to participate in prompt
    /// caching across turns. Only meaningful when the model is a
    /// reasoning model.
    pub include_encrypted_reasoning: bool,
    /// Reasoning summary verbosity (`"auto"` / `"concise"` /
    /// `"detailed"`). `None` omits the field. The reasoning block
    /// itself still gets emitted if `reasoning_effort` is set.
    pub reasoning_summary: Option<String>,
    /// Reasoning effort tier (`"low"` / `"medium"` / `"high"` /
    /// `"xhigh"`, depending on what the active model exposes).
    /// Codex's `gpt-5.x` family typically defaults to medium when
    /// no value is sent.
    pub reasoning_effort: Option<String>,
    /// Hint used by [`LlmProvider::estimator`] to pick between
    /// `o200k_base` (gpt-4o / gpt-5 / o1-o4 reasoning families) and
    /// `cl100k_base` (everything else). Optional — `None` falls back
    /// to `cl100k`.
    pub default_model: Option<String>,
}

impl ResponsesConfig {
    /// Codex flavour: ChatGPT subscription OAuth +
    /// `chatgpt.com/backend-api/codex/responses`.
    pub fn codex(auth: CodexAuth) -> Self {
        Self {
            auth: ResponsesAuth::ChatGptOauth(Arc::new(Mutex::new(auth))),
            base_url: "https://chatgpt.com/backend-api".to_string(),
            path: "/codex/responses".to_string(),
            originator: Some("jarvis".to_string()),
            openai_beta: Some("responses=v1".to_string()),
            store: false,
            service_tier: None,
            include_encrypted_reasoning: false,
            reasoning_summary: None,
            reasoning_effort: None,
            default_model: None,
        }
    }

    /// Public OpenAI flavour: API key + `api.openai.com/v1/responses`.
    /// Suited to reasoning models (`o1`, `o3`, `gpt-5`) and any
    /// feature OpenAI ships only on the Responses surface.
    pub fn openai_responses(api_key: impl Into<String>) -> Self {
        Self {
            auth: ResponsesAuth::ApiKey(api_key.into()),
            base_url: "https://api.openai.com/v1".to_string(),
            path: "/responses".to_string(),
            originator: None,
            openai_beta: None,
            store: false,
            service_tier: None,
            include_encrypted_reasoning: false,
            reasoning_summary: None,
            reasoning_effort: None,
            default_model: None,
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = path.into();
        self
    }

    pub fn with_originator(mut self, name: impl Into<String>) -> Self {
        self.originator = Some(name.into());
        self
    }

    pub fn with_openai_beta(mut self, value: impl Into<String>) -> Self {
        self.openai_beta = Some(value.into());
        self
    }

    pub fn with_store(mut self, store: bool) -> Self {
        self.store = store;
        self
    }

    pub fn with_service_tier(mut self, tier: impl Into<String>) -> Self {
        self.service_tier = Some(tier.into());
        self
    }

    pub fn with_reasoning_summary(mut self, summary: impl Into<String>) -> Self {
        self.reasoning_summary = Some(summary.into());
        self
    }

    pub fn with_reasoning_effort(mut self, effort: impl Into<String>) -> Self {
        self.reasoning_effort = Some(effort.into());
        self
    }

    pub fn with_encrypted_reasoning(mut self, enabled: bool) -> Self {
        self.include_encrypted_reasoning = enabled;
        self
    }

    pub fn with_default_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = Some(model.into());
        self
    }
}

// ---------- Provider ----------

pub struct ResponsesProvider {
    cfg: ResponsesConfig,
    http: reqwest::Client,
}

impl ResponsesProvider {
    pub fn new(cfg: ResponsesConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn with_client(cfg: ResponsesConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }

    /// Codex flavour convenience constructor — equivalent to
    /// `Self::new(ResponsesConfig::codex(auth))`.
    pub fn codex(auth: CodexAuth) -> Self {
        Self::new(ResponsesConfig::codex(auth))
    }

    /// Public OpenAI Responses API convenience constructor.
    pub fn openai_responses(api_key: impl Into<String>) -> Self {
        Self::new(ResponsesConfig::openai_responses(api_key))
    }

    pub fn endpoint(&self) -> String {
        format!("{}{}", self.cfg.base_url, self.cfg.path)
    }

    fn build_request(
        &self,
        body: &ResponsesRequest,
        snapshot: &BearerSnapshot,
        stream: bool,
    ) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .post(self.endpoint())
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", snapshot.token),
            )
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            )
            .json(body);
        if let Some(beta) = &self.cfg.openai_beta {
            req = req.header("OpenAI-Beta", beta.as_str());
        }
        if let Some(originator) = &self.cfg.originator {
            req = req.header("originator", originator.as_str());
        }
        if let Some(account_id) = &snapshot.account_id {
            req = req.header("ChatGPT-Account-ID", account_id.as_str());
        }
        req
    }
}

#[async_trait]
impl LlmProvider for ResponsesProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        // The Codex backend (and the public Responses API on most
        // models we use here) reject `stream: false` outright with
        // `400 Bad Request: Stream must be set to true`. Rather than
        // ship a non-streaming wire path that nobody can call, we
        // satisfy `LlmProvider::complete` by driving our own
        // `complete_stream` and collapsing the chunks into a
        // `ChatResponse`. Callers (e.g. `SummarizingMemory`) get the
        // shape they expect; the wire stays stream-only.
        let mut stream = self.complete_stream(req).await?;
        let mut last_finish: Option<(Message, FinishReason)> = None;
        while let Some(chunk) = stream.next().await {
            match chunk? {
                LlmChunk::ContentDelta(_)
                | LlmChunk::ToolCallDelta { .. }
                | LlmChunk::Usage(_) => {
                    // Aggregated form arrives in the trailing `Finish`
                    // chunk; the per-token deltas are noise here.
                }
                LlmChunk::Finish {
                    message,
                    finish_reason,
                } => {
                    last_finish = Some((message, finish_reason));
                }
            }
        }
        let (message, finish_reason) = last_finish.ok_or_else(|| {
            Error::Provider("responses stream ended without a Finish chunk".into())
        })?;
        Ok(ChatResponse { message, finish_reason })
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let Outbound {
            request: body,
            name_map,
        } = ResponsesRequest::from_chat_request(req, &self.cfg, true);
        debug!(model = %body.model, endpoint = %self.endpoint(), "responses stream request");

        let mut tried_refresh = false;
        let resp = loop {
            let snapshot = self.cfg.auth.snapshot().await;
            let request = self.build_request(&body, &snapshot, true);
            let r = request
                .send()
                .await
                .map_err(|e| Error::Provider(format!("transport: {e}")))?;
            let status = r.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && !tried_refresh {
                tried_refresh = true;
                self.cfg
                    .auth
                    .refresh_if_unchanged(&self.http, &snapshot.token)
                    .await?;
                continue;
            }
            if !status.is_success() {
                let text = r.text().await.unwrap_or_default();
                return Err(Error::Provider(format!("status {status}: {text}")));
            }
            break r;
        };

        let mut byte_stream = resp.bytes_stream();
        let s = try_stream! {
            let mut buf = String::new();
            let mut acc = StreamAccumulator::with_name_map(name_map);

            while let Some(chunk) = byte_stream.next().await {
                let bytes = chunk.map_err(|e| Error::Provider(format!("stream: {e}")))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buf.find("\n\n") {
                    let event_block: String = buf.drain(..pos + 2).collect();
                    for line in event_block.lines() {
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        let event: StreamEvent = serde_json::from_str(data).map_err(|e| {
                            Error::Provider(format!("decode chunk: {e}; raw={data}"))
                        })?;
                        for chunk in acc.ingest(event)? {
                            yield chunk;
                        }
                    }
                }
            }

            if !acc.finished {
                yield acc.finalise();
            }
        };

        Ok(Box::pin(s))
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        let est = match self.cfg.default_model.as_deref() {
            Some(m) => TiktokenEstimator::for_openai_model(m),
            None => TiktokenEstimator::cl100k(),
        };
        Arc::new(est)
    }
}

// ---------- Wire types: request ----------

#[derive(Debug, Serialize)]
struct ResponsesRequest {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    input: Vec<InputItem>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ResponsesTool>,
    tool_choice: &'static str,
    parallel_tool_calls: bool,
    store: bool,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_tier: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningConfig>,
}

#[derive(Debug, Serialize)]
struct ReasoningConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InputItem {
    Message {
        role: &'static str,
        content: Vec<MessagePart>,
    },
    FunctionCall {
        call_id: String,
        name: String,
        /// Stringified JSON, matching OpenAI Chat Completions
        /// semantics — Responses API also wants a string here.
        arguments: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MessagePart {
    InputText { text: String },
    OutputText { text: String },
}

#[derive(Debug, Serialize)]
struct ResponsesTool {
    /// Always `"function"` today; the Responses API has other tool
    /// types (`web_search`, `file_search`) we don't surface.
    #[serde(rename = "type")]
    kind: &'static str,
    name: String,
    description: String,
    parameters: Value,
}

/// What `from_chat_request` produces: the wire-shaped request body
/// plus a sanitized→original tool-name map for use when parsing the
/// response. The Responses API restricts tool names to
/// `^[a-zA-Z0-9_-]+$` (Codex / GPT-5 reject `fs.read` outright), so
/// we transliterate `.` → `_` (and anything else) on the way out and
/// reverse via the map on the way in. The harness's
/// `ToolRegistry` continues to use the original names.
struct Outbound {
    request: ResponsesRequest,
    name_map: HashMap<String, String>,
}

impl ResponsesRequest {
    fn from_chat_request(r: ChatRequest, cfg: &ResponsesConfig, stream: bool) -> Outbound {
        // Build sanitized↔original name map once. Used for both the
        // `tools` array we send and for restoring names on the response.
        let name_map: HashMap<String, String> = r
            .tools
            .iter()
            .map(|t| (sanitize_tool_name(&t.name), t.name.clone()))
            .collect();

        let (instructions, input) = convert_messages(r.messages);
        let mut include = Vec::new();
        if cfg.include_encrypted_reasoning {
            include.push("reasoning.encrypted_content".to_string());
        }
        // Emit the `reasoning` block when EITHER summary or effort
        // is configured. Both are optional independently.
        let reasoning = match (
            cfg.reasoning_summary.clone(),
            cfg.reasoning_effort.clone(),
        ) {
            (None, None) => None,
            (summary, effort) => Some(ReasoningConfig { summary, effort }),
        };
        let request = Self {
            model: r.model,
            instructions,
            input,
            tools: r.tools.into_iter().map(ResponsesTool::from).collect(),
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: cfg.store,
            stream,
            service_tier: cfg.service_tier.clone(),
            include,
            reasoning,
        };
        Outbound { request, name_map }
    }
}

impl From<ToolSpec> for ResponsesTool {
    fn from(t: ToolSpec) -> Self {
        ResponsesTool {
            kind: "function",
            name: sanitize_tool_name(&t.name),
            description: t.description,
            parameters: t.parameters,
        }
    }
}

/// Map any byte that isn't `[A-Za-z0-9_-]` to `_`. Idempotent for
/// names that already match the regex. Collisions on the inverse
/// (e.g. registering both `fs.read` and `fs_read`) silently resolve
/// to whichever was inserted into the map last; keep tool names
/// distinct under this transformation.
fn sanitize_tool_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Reverse via the build-time map; falls back to the literal
/// (sanitized) name if the model emits a tool name we never sent.
/// The agent loop will then surface `tool error: tool not found:
/// <name>` and the model can retry.
fn restore_tool_name(map: &HashMap<String, String>, sanitized: &str) -> String {
    map.get(sanitized)
        .cloned()
        .unwrap_or_else(|| sanitized.to_string())
}

/// Pull all `Message::System` out into top-level `instructions` and
/// rewrite the rest into Responses-API `input` items. Each
/// `Assistant.tool_calls` becomes a separate `function_call` item;
/// each `Tool` becomes a `function_call_output` item.
fn convert_messages(messages: Vec<Message>) -> (Option<String>, Vec<InputItem>) {
    let mut systems = String::new();
    let mut input: Vec<InputItem> = Vec::with_capacity(messages.len());

    for m in messages {
        match m {
            Message::System { content, .. } => {
                if !systems.is_empty() {
                    systems.push_str("\n\n");
                }
                systems.push_str(&content);
            }
            Message::User { content } => {
                input.push(InputItem::Message {
                    role: "user",
                    content: vec![MessagePart::InputText { text: content }],
                });
            }
            Message::Assistant {
                content,
                tool_calls, reasoning_content: _ } => {
                if let Some(text) = content {
                    if !text.is_empty() {
                        input.push(InputItem::Message {
                            role: "assistant",
                            content: vec![MessagePart::OutputText { text }],
                        });
                    }
                }
                for tc in tool_calls {
                    input.push(InputItem::FunctionCall {
                        call_id: tc.id,
                        // Same constraint as `tools[].name` —
                        // historical assistant function calls in
                        // `input` must also use sanitized names.
                        name: sanitize_tool_name(&tc.name),
                        arguments: tc.arguments.to_string(),
                    });
                }
            }
            Message::Tool {
                tool_call_id,
                content,
            } => {
                input.push(InputItem::FunctionCallOutput {
                    call_id: tool_call_id,
                    output: content,
                });
            }
        }
    }

    let instructions = if systems.is_empty() {
        None
    } else {
        Some(systems)
    };
    (instructions, input)
}

// ---------- Wire types: response ----------

// `ResponsesResponseBody` and friends still ride along on the
// `response.completed` SSE event (`StreamEvent::Completed { response }`)
// so deleting them would lose forward-compat with the wire shape; the
// non-streaming `complete()` path was removed (Codex rejects
// `stream:false` outright), so on the production code path we never
// reach `into_chat_response()` — but the tests exercise it as a pure
// decoder. Hence the `dead_code` allows below.
#[derive(Debug, Deserialize, Default)]
#[allow(dead_code)]
struct ResponsesResponseBody {
    #[serde(default)]
    output: Vec<OutputItem>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetails>,
    /// Token accounting on the terminal `response.completed` event.
    /// Schema mirrors Chat Completions but lives at the body root
    /// rather than under a per-chunk envelope. Optional because the
    /// Codex backend has historically been inconsistent about
    /// shipping it on every flavour of response.
    #[serde(default)]
    usage: Option<RespUsage>,
}

#[derive(Debug, Deserialize)]
struct RespUsage {
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
    #[serde(default)]
    input_tokens_details: Option<RespInputDetails>,
    #[serde(default)]
    output_tokens_details: Option<RespOutputDetails>,
}

#[derive(Debug, Deserialize)]
struct RespInputDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RespOutputDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

impl RespUsage {
    fn into_core(self) -> Usage {
        Usage {
            prompt_tokens: self.input_tokens,
            completion_tokens: self.output_tokens,
            cached_prompt_tokens: self.input_tokens_details.and_then(|d| d.cached_tokens),
            reasoning_tokens: self.output_tokens_details.and_then(|d| d.reasoning_tokens),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum OutputItem {
    Message {
        #[serde(default)]
        content: Vec<OutputPart>,
    },
    FunctionCall {
        call_id: String,
        name: String,
        #[serde(default)]
        arguments: String,
    },
    /// Reasoning blocks (visible-summary mode) appear here. We ignore
    /// them today — surfacing them belongs in a separate proposal
    /// (touches every transport).
    Reasoning {
        #[serde(default)]
        summary: Vec<Value>,
    },
    /// Forward-compat: drop unknown item types silently.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum OutputPart {
    OutputText {
        text: String,
    },
    /// Any future part type (annotations, refusal, …) is ignored.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct IncompleteDetails {
    #[serde(default)]
    reason: Option<String>,
}

impl ResponsesResponseBody {
    #[allow(dead_code)]
    fn into_chat_response(
        self,
        name_map: &HashMap<String, String>,
    ) -> Result<ChatResponse> {
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        for item in self.output {
            match item {
                OutputItem::Message { content } => {
                    for part in content {
                        if let OutputPart::OutputText { text: t } = part {
                            text.push_str(&t);
                        }
                    }
                }
                OutputItem::FunctionCall {
                    call_id,
                    name,
                    arguments,
                } => {
                    let original_name = restore_tool_name(name_map, &name);
                    let args = parse_function_args(&original_name, &arguments)?;
                    tool_calls.push(ToolCall {
                        id: call_id,
                        name: original_name,
                        arguments: args,
                    });
                }
                OutputItem::Reasoning { .. } | OutputItem::Unknown => {}
            }
        }
        let content = if text.is_empty() { None } else { Some(text) };
        let finish_reason = map_finish_reason(
            self.status.as_deref(),
            self.incomplete_details.as_ref(),
            &tool_calls,
        );
        Ok(ChatResponse {
            message: Message::Assistant {
                content,
                tool_calls, reasoning_content: None },
            finish_reason,
        })
    }
}

fn parse_function_args(name: &str, raw: &str) -> Result<Value> {
    if raw.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(raw).map_err(|e| Error::InvalidArguments {
        name: name.to_string(),
        message: format!("{e}; raw={raw}"),
    })
}

fn map_finish_reason(
    status: Option<&str>,
    incomplete: Option<&IncompleteDetails>,
    tool_calls: &[ToolCall],
) -> FinishReason {
    if status == Some("incomplete") {
        if let Some(d) = incomplete {
            return match d.reason.as_deref() {
                Some("max_output_tokens") => FinishReason::Length,
                Some(other) => FinishReason::Other(other.to_string()),
                None => FinishReason::Other("incomplete".to_string()),
            };
        }
        return FinishReason::Other("incomplete".to_string());
    }
    if !tool_calls.is_empty() {
        return FinishReason::ToolCalls;
    }
    match status {
        Some("completed") | None => FinishReason::Stop,
        Some(other) => FinishReason::Other(other.to_string()),
    }
}

// ---------- Streaming events + accumulator ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum StreamEvent {
    #[serde(rename = "response.output_item.added")]
    OutputItemAdded {
        output_index: usize,
        item: OutputItem,
    },
    #[serde(rename = "response.output_item.done")]
    OutputItemDone {
        #[allow(dead_code)]
        output_index: usize,
        item: OutputItem,
    },
    #[serde(rename = "response.output_text.delta")]
    OutputTextDelta { delta: String },
    #[serde(rename = "response.function_call_arguments.delta")]
    FunctionCallArgumentsDelta {
        #[serde(default)]
        output_index: usize,
        delta: String,
    },
    #[serde(rename = "response.completed")]
    Completed { response: ResponsesResponseBody },
    /// `response.created`, `response.in_progress`,
    /// `response.content_part.added`, `response.output_text.done`,
    /// `response.function_call_arguments.done`, `response.failed`,
    /// and any future event we haven't modelled — silently dropped.
    #[serde(other)]
    Unknown,
}

#[derive(Default)]
struct StreamAccumulator {
    text: String,
    tool_calls: Vec<ToolCall>,
    status: Option<String>,
    incomplete_reason: Option<String>,
    finished: bool,
    /// Sanitized→original tool-name map. Empty when no tools were
    /// registered for this turn.
    name_map: HashMap<String, String>,
}

impl StreamAccumulator {
    fn with_name_map(name_map: HashMap<String, String>) -> Self {
        Self {
            name_map,
            ..Default::default()
        }
    }

    fn ingest(&mut self, ev: StreamEvent) -> Result<Vec<LlmChunk>> {
        let mut out = Vec::new();
        match ev {
            StreamEvent::OutputItemAdded {
                output_index,
                item,
            } => {
                if let OutputItem::FunctionCall { call_id, name, .. } = &item {
                    let original = restore_tool_name(&self.name_map, name);
                    out.push(LlmChunk::ToolCallDelta {
                        index: output_index,
                        id: Some(call_id.clone()),
                        name: Some(original),
                        arguments_fragment: None,
                    });
                }
            }
            StreamEvent::OutputTextDelta { delta } => {
                if !delta.is_empty() {
                    self.text.push_str(&delta);
                    out.push(LlmChunk::ContentDelta(delta));
                }
            }
            StreamEvent::FunctionCallArgumentsDelta {
                output_index,
                delta,
            } => {
                if !delta.is_empty() {
                    out.push(LlmChunk::ToolCallDelta {
                        index: output_index,
                        id: None,
                        name: None,
                        arguments_fragment: Some(delta),
                    });
                }
            }
            StreamEvent::OutputItemDone { item, .. } => {
                if let OutputItem::FunctionCall {
                    call_id,
                    name,
                    arguments,
                } = item
                {
                    let original = restore_tool_name(&self.name_map, &name);
                    let args = parse_function_args(&original, &arguments)?;
                    self.tool_calls.push(ToolCall {
                        id: call_id,
                        name: original,
                        arguments: args,
                    });
                }
            }
            StreamEvent::Completed { response } => {
                if response.status.is_some() {
                    self.status = response.status;
                }
                if let Some(d) = response.incomplete_details {
                    self.incomplete_reason = d.reason;
                }
                if let Some(u) = response.usage {
                    out.push(LlmChunk::Usage(u.into_core()));
                }
                out.push(self.finalise());
            }
            StreamEvent::Unknown => {}
        }
        Ok(out)
    }

    fn finalise(&mut self) -> LlmChunk {
        self.finished = true;
        let tool_calls = std::mem::take(&mut self.tool_calls);
        let incomplete = self.incomplete_reason.take().map(|r| IncompleteDetails {
            reason: Some(r),
        });
        let finish_reason = map_finish_reason(
            self.status.as_deref(),
            incomplete.as_ref(),
            &tool_calls,
        );
        let content = if self.text.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.text))
        };
        LlmChunk::Finish {
            message: Message::Assistant {
                content,
                tool_calls, reasoning_content: None },
            finish_reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req_with(messages: Vec<Message>) -> ChatRequest {
        ChatRequest {
            model: "gpt-5-codex-mini".into(),
            messages,
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
        }
    }

    fn default_codex_cfg() -> ResponsesConfig {
        ResponsesConfig::codex(CodexAuth::from_static("test-token", None))
    }

    fn body_value(req: &ResponsesRequest) -> Value {
        serde_json::to_value(req).unwrap()
    }

    fn build(r: ChatRequest, cfg: &ResponsesConfig, stream: bool) -> ResponsesRequest {
        ResponsesRequest::from_chat_request(r, cfg, stream).request
    }

    // ---- conversion ----

    #[test]
    fn convert_pulls_system_to_instructions() {
        let body = build(
            req_with(vec![
                Message::system("you are jarvis"),
                Message::user("hi"),
            ]),
            &default_codex_cfg(),
            false,
        );
        let v = body_value(&body);
        assert_eq!(v["instructions"], "you are jarvis");
        let input = v["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn convert_concatenates_multiple_systems() {
        let body = build(
            req_with(vec![
                Message::system("first"),
                Message::system("second"),
                Message::user("hi"),
            ]),
            &default_codex_cfg(),
            false,
        );
        assert_eq!(body.instructions.as_deref(), Some("first\n\nsecond"));
    }

    #[test]
    fn convert_assistant_with_tool_calls_splits_into_items() {
        let body = build(
            req_with(vec![
                Message::user("ask"),
                Message::Assistant {
                    content: Some("sure".into()),
                    tool_calls: vec![ToolCall {
                        id: "fc_1".into(),
                        name: "echo".into(),
                        arguments: json!({"text": "hi"}),
                    }],
                    reasoning_content: None,
                },
            ]),
            &default_codex_cfg(),
            false,
        );
        let v = body_value(&body);
        let items = v["input"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["type"], "message");
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[1]["content"][0]["type"], "output_text");
        assert_eq!(items[1]["content"][0]["text"], "sure");
        assert_eq!(items[2]["type"], "function_call");
        assert_eq!(items[2]["call_id"], "fc_1");
        assert_eq!(items[2]["name"], "echo");
        assert_eq!(items[2]["arguments"].as_str().unwrap(), r#"{"text":"hi"}"#);
    }

    #[test]
    fn convert_assistant_tool_calls_only_skips_message_item() {
        let body = build(
            req_with(vec![
                Message::user("go"),
                Message::Assistant {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "fc_1".into(),
                        name: "echo".into(),
                        arguments: json!({}),
                    }],
                    reasoning_content: None,
                },
            ]),
            &default_codex_cfg(),
            false,
        );
        let v = body_value(&body);
        let items = v["input"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "message");
        assert_eq!(items[1]["type"], "function_call");
    }

    #[test]
    fn convert_tool_result_to_function_call_output() {
        let body = build(
            req_with(vec![
                Message::user("go"),
                Message::Assistant {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "fc_1".into(),
                        name: "echo".into(),
                        arguments: json!({}),
                    }],
                    reasoning_content: None,
                },
                Message::tool_result("fc_1", "the output"),
            ]),
            &default_codex_cfg(),
            false,
        );
        let v = body_value(&body);
        let items = v["input"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[2]["type"], "function_call_output");
        assert_eq!(items[2]["call_id"], "fc_1");
        assert_eq!(items[2]["output"], "the output");
    }

    #[test]
    fn convert_tool_spec_to_flat_function_shape() {
        let body = build(
            ChatRequest {
                model: "gpt-5-codex-mini".into(),
                messages: vec![Message::user("hi")],
                tools: vec![ToolSpec {
                    name: "echo".into(),
                    description: "echo it".into(),
                    parameters: json!({"type":"object"}),
                    cacheable: false,
                }],
                temperature: None,
                max_tokens: None,
            },
            &default_codex_cfg(),
            false,
        );
        let v = body_value(&body);
        let tools = v["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["name"], "echo");
        assert_eq!(tools[0]["description"], "echo it");
        assert!(tools[0]["parameters"].is_object());
        assert!(tools[0].get("function").is_none());
    }

    #[test]
    fn convert_sanitises_dotted_tool_names() {
        // Responses API requires tool names to match `^[a-zA-Z0-9_-]+`.
        // The harness uses dotted names like `fs.read`. Verify the wire
        // payload swaps `.` for `_` and the name_map preserves the
        // original for restoration on the response side.
        let outbound = ResponsesRequest::from_chat_request(
            ChatRequest {
                model: "gpt-5.4-mini".into(),
                messages: vec![
                    Message::user("read it"),
                    Message::Assistant {
                        content: None,
                        tool_calls: vec![ToolCall {
                            id: "fc_1".into(),
                            name: "fs.read".into(),
                            arguments: json!({"path": "x"}),
                        }],
                        reasoning_content: None,
                    },
                ],
                tools: vec![
                    ToolSpec {
                        name: "fs.read".into(),
                        description: "read a file".into(),
                        parameters: json!({"type":"object"}),
                        cacheable: false,
                    },
                    ToolSpec {
                        name: "code.grep".into(),
                        description: "grep".into(),
                        parameters: json!({"type":"object"}),
                        cacheable: false,
                    },
                ],
                temperature: None,
                max_tokens: None,
            },
            &default_codex_cfg(),
            false,
        );
        let v = serde_json::to_value(&outbound.request).unwrap();
        let tools = v["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "fs_read");
        assert_eq!(tools[1]["name"], "code_grep");
        // Inline assistant function_call also sanitised.
        let items = v["input"].as_array().unwrap();
        let function_call = items.iter().find(|i| i["type"] == "function_call").unwrap();
        assert_eq!(function_call["name"], "fs_read");
        // Map round-trips both directions.
        assert_eq!(outbound.name_map.get("fs_read").unwrap(), "fs.read");
        assert_eq!(outbound.name_map.get("code_grep").unwrap(), "code.grep");
    }

    #[test]
    fn response_restores_sanitised_tool_call_name() {
        // Server returns the sanitised name; harness should see the
        // original.
        let raw = json!({
            "status": "completed",
            "output": [
                { "type": "function_call",
                  "call_id": "fc_1", "name": "fs_read",
                  "arguments": "{\"path\":\"a.txt\"}" }
            ]
        });
        let parsed: ResponsesResponseBody = serde_json::from_value(raw).unwrap();
        let mut map = HashMap::new();
        map.insert("fs_read".to_string(), "fs.read".to_string());
        let resp = parsed.into_chat_response(&map).unwrap();
        match resp.message {
            Message::Assistant { tool_calls, .. } => {
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].name, "fs.read");
            }
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn stream_restores_sanitised_tool_call_name() {
        let mut map = HashMap::new();
        map.insert("fs_read".to_string(), "fs.read".to_string());
        let mut acc = StreamAccumulator::with_name_map(map);
        let r_added = acc
            .ingest(parse(json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "type": "function_call", "call_id": "fc_1",
                          "name": "fs_read", "arguments": "" }
            })))
            .unwrap();
        match r_added.as_slice() {
            [LlmChunk::ToolCallDelta { name, .. }] => {
                assert_eq!(name.as_deref(), Some("fs.read"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        let _ = acc
            .ingest(parse(json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": { "type": "function_call", "call_id": "fc_1",
                          "name": "fs_read", "arguments": "{}" }
            })))
            .unwrap();
        let r = acc
            .ingest(parse(json!({
                "type": "response.completed",
                "response": { "status": "completed", "output": [] }
            })))
            .unwrap();
        match &r[..] {
            [LlmChunk::Finish { message, .. }] => match message {
                Message::Assistant { tool_calls, .. } => {
                    assert_eq!(tool_calls[0].name, "fs.read");
                }
                _ => panic!("expected assistant"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn convert_default_omits_optional_fields() {
        let body = build(req_with(vec![Message::user("hi")]), &default_codex_cfg(), false);
        let v = body_value(&body);
        assert_eq!(v["store"], false);
        assert_eq!(v["tool_choice"], "auto");
        assert_eq!(v["parallel_tool_calls"], false);
        // service_tier / include / reasoning are skip_serializing when defaulted
        assert!(v.get("service_tier").is_none());
        assert!(v.get("include").is_none());
        assert!(v.get("reasoning").is_none());
    }

    #[test]
    fn convert_with_reasoning_and_includes_emits_blocks() {
        let cfg = default_codex_cfg()
            .with_reasoning_summary("auto")
            .with_reasoning_effort("high")
            .with_encrypted_reasoning(true)
            .with_service_tier("priority")
            .with_store(true);
        let body = build(req_with(vec![Message::user("hi")]), &cfg, true);
        let v = body_value(&body);
        assert_eq!(v["store"], true);
        assert_eq!(v["service_tier"], "priority");
        assert_eq!(v["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(v["reasoning"]["summary"], "auto");
        assert_eq!(v["reasoning"]["effort"], "high");
    }

    #[test]
    fn convert_reasoning_block_emitted_for_effort_alone() {
        // Reasoning block should appear with `effort` even if
        // `summary` is unset — they're independently optional.
        let cfg = default_codex_cfg().with_reasoning_effort("medium");
        let body = build(req_with(vec![Message::user("hi")]), &cfg, false);
        let v = body_value(&body);
        assert_eq!(v["reasoning"]["effort"], "medium");
        // summary skipped (None) — not present in JSON.
        assert!(v["reasoning"].get("summary").is_none(), "got: {v}");
    }

    // ---- constructors ----

    #[test]
    fn codex_constructor_sets_codex_defaults() {
        let cfg = ResponsesConfig::codex(CodexAuth::from_static("at", Some("acct".into())));
        assert_eq!(cfg.base_url, "https://chatgpt.com/backend-api");
        assert_eq!(cfg.path, "/codex/responses");
        assert_eq!(cfg.originator.as_deref(), Some("jarvis"));
        assert_eq!(cfg.openai_beta.as_deref(), Some("responses=v1"));
        assert!(matches!(cfg.auth, ResponsesAuth::ChatGptOauth(_)));
    }

    #[test]
    fn openai_responses_constructor_sets_public_defaults() {
        let cfg = ResponsesConfig::openai_responses("sk-abc");
        assert_eq!(cfg.base_url, "https://api.openai.com/v1");
        assert_eq!(cfg.path, "/responses");
        assert!(cfg.originator.is_none());
        assert!(cfg.openai_beta.is_none());
        match &cfg.auth {
            ResponsesAuth::ApiKey(k) => assert_eq!(k, "sk-abc"),
            _ => panic!("expected ApiKey auth"),
        }
    }

    // ---- auth ----

    #[tokio::test]
    async fn auth_apikey_snapshot_returns_token_no_account() {
        let auth = ResponsesAuth::ApiKey("sk-test".into());
        let snap = auth.snapshot().await;
        assert_eq!(snap.token, "sk-test");
        assert!(snap.account_id.is_none());
    }

    #[tokio::test]
    async fn auth_apikey_refresh_returns_error() {
        let auth = ResponsesAuth::ApiKey("sk-test".into());
        let err = auth
            .refresh_if_unchanged(&reqwest::Client::new(), "sk-test")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("API-key"), "got: {err}");
    }

    #[tokio::test]
    async fn auth_oauth_snapshot_returns_token_and_account() {
        let inner = CodexAuth::from_static("at", Some("acct".into()));
        let auth = ResponsesAuth::ChatGptOauth(Arc::new(Mutex::new(inner)));
        let snap = auth.snapshot().await;
        assert_eq!(snap.token, "at");
        assert_eq!(snap.account_id.as_deref(), Some("acct"));
    }

    // ---- response decode ----

    #[test]
    fn response_decodes_text_and_function_call() {
        let raw = json!({
            "status": "completed",
            "output": [
                { "type": "message", "content": [{"type":"output_text","text":"hello "}] },
                { "type": "message", "content": [{"type":"output_text","text":"world"}] },
                { "type": "function_call",
                  "call_id": "fc_1", "name": "echo",
                  "arguments": "{\"text\":\"hi\"}" }
            ]
        });
        let parsed: ResponsesResponseBody = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response(&HashMap::new()).unwrap();
        match resp.message {
            Message::Assistant {
                content,
                tool_calls, reasoning_content: _ } => {
                assert_eq!(content.as_deref(), Some("hello world"));
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].id, "fc_1");
                assert_eq!(tool_calls[0].arguments, json!({"text":"hi"}));
            }
            _ => panic!("expected assistant"),
        }
        assert!(matches!(resp.finish_reason, FinishReason::ToolCalls));
    }

    #[test]
    fn response_max_tokens_maps_to_length() {
        let raw = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": [
                { "type": "message", "content": [{"type":"output_text","text":"truncated"}] }
            ]
        });
        let parsed: ResponsesResponseBody = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response(&HashMap::new()).unwrap();
        assert!(matches!(resp.finish_reason, FinishReason::Length));
    }

    #[test]
    fn response_completed_no_tools_maps_to_stop() {
        let raw = json!({
            "status": "completed",
            "output": [
                { "type": "message", "content": [{"type":"output_text","text":"ok"}] }
            ]
        });
        let parsed: ResponsesResponseBody = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response(&HashMap::new()).unwrap();
        assert!(matches!(resp.finish_reason, FinishReason::Stop));
    }

    #[test]
    fn response_unknown_item_type_is_ignored() {
        let raw = json!({
            "status": "completed",
            "output": [
                { "type": "future_thing", "data": 42 },
                { "type": "message", "content": [{"type":"output_text","text":"real"}] }
            ]
        });
        let parsed: ResponsesResponseBody = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response(&HashMap::new()).unwrap();
        match resp.message {
            Message::Assistant { content, .. } => assert_eq!(content.as_deref(), Some("real")),
            _ => panic!("expected assistant"),
        }
    }

    // ---- streaming ----

    fn parse(v: serde_json::Value) -> StreamEvent {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn stream_accumulates_text_chunks() {
        let mut acc = StreamAccumulator::default();
        let r1 = acc
            .ingest(parse(json!({
                "type": "response.output_text.delta",
                "delta": "Hel"
            })))
            .unwrap();
        let r2 = acc
            .ingest(parse(json!({
                "type": "response.output_text.delta",
                "delta": "lo"
            })))
            .unwrap();
        let r3 = acc
            .ingest(parse(json!({
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": []
                }
            })))
            .unwrap();

        assert!(matches!(r1.as_slice(), [LlmChunk::ContentDelta(s)] if s == "Hel"));
        assert!(matches!(r2.as_slice(), [LlmChunk::ContentDelta(s)] if s == "lo"));
        match &r3[..] {
            [LlmChunk::Finish {
                message,
                finish_reason,
            }] => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls, reasoning_content: _ } => {
                        assert_eq!(content.as_deref(), Some("Hello"));
                        assert!(tool_calls.is_empty());
                    }
                    _ => panic!("expected assistant"),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn stream_handles_function_call_round_trip() {
        let mut acc = StreamAccumulator::default();
        let r_added = acc
            .ingest(parse(json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "type": "function_call", "call_id": "fc_1",
                          "name": "echo", "arguments": "" }
            })))
            .unwrap();
        match r_added.as_slice() {
            [LlmChunk::ToolCallDelta {
                index,
                id,
                name,
                arguments_fragment,
            }] => {
                assert_eq!(*index, 0);
                assert_eq!(id.as_deref(), Some("fc_1"));
                assert_eq!(name.as_deref(), Some("echo"));
                assert!(arguments_fragment.is_none());
            }
            other => panic!("unexpected: {other:?}"),
        }
        for frag in [r#"{"te"#, r#"xt":"#, r#""hi""#, r#"}"#] {
            let r = acc
                .ingest(parse(json!({
                    "type": "response.function_call_arguments.delta",
                    "output_index": 0,
                    "delta": frag
                })))
                .unwrap();
            assert!(matches!(
                r.as_slice(),
                [LlmChunk::ToolCallDelta {
                    arguments_fragment: Some(_),
                    ..
                }]
            ));
        }
        let _ = acc
            .ingest(parse(json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": { "type": "function_call", "call_id": "fc_1",
                          "name": "echo", "arguments": "{\"text\":\"hi\"}" }
            })))
            .unwrap();
        let r_final = acc
            .ingest(parse(json!({
                "type": "response.completed",
                "response": { "status": "completed", "output": [] }
            })))
            .unwrap();

        match &r_final[..] {
            [LlmChunk::Finish {
                message,
                finish_reason,
            }] => {
                assert!(matches!(finish_reason, FinishReason::ToolCalls));
                match message {
                    Message::Assistant { tool_calls, .. } => {
                        assert_eq!(tool_calls.len(), 1);
                        assert_eq!(tool_calls[0].id, "fc_1");
                        assert_eq!(tool_calls[0].name, "echo");
                        assert_eq!(tool_calls[0].arguments, json!({"text":"hi"}));
                    }
                    _ => panic!(),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn stream_unknown_event_is_ignored() {
        let mut acc = StreamAccumulator::default();
        let r = acc
            .ingest(parse(json!({"type":"response.in_progress","response":{}})))
            .unwrap();
        assert!(r.is_empty());
        let r = acc
            .ingest(parse(json!({"type":"future_event","x":1})))
            .unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn stream_empty_finalises_to_stop() {
        let mut acc = StreamAccumulator::default();
        let f = acc.finalise();
        match f {
            LlmChunk::Finish {
                message,
                finish_reason,
            } => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls, reasoning_content: _ } => {
                        assert!(content.is_none());
                        assert!(tool_calls.is_empty());
                    }
                    _ => panic!(),
                }
            }
            _ => panic!(),
        }
    }
}
