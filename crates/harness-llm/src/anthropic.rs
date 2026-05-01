//! Anthropic Messages API provider.
//!
//! Wire shape diverges from OpenAI in three load-bearing ways and we
//! convert in both directions:
//!
//! 1. **System prompts are top-level**, not in the `messages` array.
//!    All `Message::System` entries from the conversation are pulled
//!    out and joined into the request's `system` string.
//! 2. **Tool calls and results are content blocks**, not separate
//!    message types. An assistant turn that uses a tool emits an array
//!    of `{"type":"text",...}` and `{"type":"tool_use",...}` blocks;
//!    the next user turn replies with one or more
//!    `{"type":"tool_result",...}` blocks. Multiple consecutive
//!    `Message::Tool` entries from the conversation are coalesced into
//!    a single user message with multiple `tool_result` blocks so
//!    Anthropic sees the natural pairing.
//! 3. **Streaming uses typed SSE events** (`message_start`,
//!    `content_block_start`, `content_block_delta`,
//!    `content_block_stop`, `message_delta`, `message_stop`, `ping`)
//!    rather than OpenAI's "everything in one delta envelope" shape.
//!    `tool_use` input arrives as `input_json_delta` fragments that
//!    must be concatenated and parsed at `content_block_stop`.

use async_stream::try_stream;
use async_trait::async_trait;
use futures::StreamExt;
use std::sync::Arc;

use harness_core::{
    CacheHint, ChatRequest, ChatResponse, Error, FinishReason, LlmChunk, LlmProvider, LlmStream,
    Message, Result, TokenEstimator, ToolCall, ToolSpec, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

use crate::tokens::TiktokenEstimator;

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic requires `max_tokens`; we pick a generous default that
/// matches Claude 3.5 Sonnet's per-request cap when the caller hasn't
/// supplied one.
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub api_key: String,
    pub base_url: String,
    pub anthropic_version: String,
}

impl AnthropicConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            anthropic_version: ANTHROPIC_VERSION.to_string(),
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_anthropic_version(mut self, version: impl Into<String>) -> Self {
        self.anthropic_version = version.into();
        self
    }
}

pub struct AnthropicProvider {
    cfg: AnthropicConfig,
    http: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(cfg: AnthropicConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn with_client(cfg: AnthropicConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }

    fn endpoint(&self) -> String {
        format!("{}/messages", self.cfg.base_url)
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let body = AnthropicRequest::from_request(req, false);
        let url = self.endpoint();
        debug!(%url, model = %body.model, "anthropic request");

        let resp = self
            .http
            .post(&url)
            .header("x-api-key", &self.cfg.api_key)
            .header("anthropic-version", &self.cfg.anthropic_version)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Provider(format!("transport: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| Error::Provider(format!("read body: {e}")))?;

        if !status.is_success() {
            return Err(Error::Provider(format!("status {status}: {text}")));
        }

        let parsed: AnthropicResponse = serde_json::from_str(&text)
            .map_err(|e| Error::Provider(format!("decode: {e}; body={text}")))?;

        parsed.into_chat_response()
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let body = AnthropicRequest::from_request(req, true);
        let url = self.endpoint();
        debug!(%url, model = %body.model, "anthropic stream request");

        let resp = self
            .http
            .post(&url)
            .header("x-api-key", &self.cfg.api_key)
            .header("anthropic-version", &self.cfg.anthropic_version)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Provider(format!("transport: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Provider(format!("status {status}: {text}")));
        }

        let mut byte_stream = resp.bytes_stream();
        let s = try_stream! {
            let mut buf = String::new();
            let mut acc = StreamAccumulator::default();

            while let Some(chunk) = byte_stream.next().await {
                let bytes = chunk.map_err(|e| Error::Provider(format!("stream: {e}")))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buf.find("\n\n") {
                    let event_block: String = buf.drain(..pos + 2).collect();

                    // Each block is `event: <name>\ndata: <json>\n\n`. We
                    // ignore the event header — the JSON body always
                    // carries a `type` field that identifies it.
                    for line in event_block.lines() {
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        let event: StreamEvent = serde_json::from_str(data).map_err(|e| {
                            Error::Provider(format!("decode event: {e}; raw={data}"))
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
        // Anthropic doesn't ship a Rust tokeniser. `cl100k_base` is
        // close enough for English/code; the +20 % margin keeps memory
        // budgets on the safe side of Claude's actual count.
        Arc::new(TiktokenEstimator::cl100k().with_safety_margin(0.20))
    }
}

// ---------- Wire types ----------

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<AnSystem>,
    messages: Vec<AnMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<AnTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
}

#[derive(Debug, Serialize)]
struct AnMessage {
    role: &'static str,
    content: AnContent,
}

/// Anthropic accepts a content as either a plain string or an array of
/// content blocks. We always pick whichever fits — string for the
/// common one-text-block case, array when there are tool_use /
/// tool_result mixins.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnContent {
    Text(String),
    Blocks(Vec<AnContentBlock>),
}

/// Anthropic's `system` field accepts either a string or an array of
/// text blocks. We use the array form only when at least one of the
/// caller's `Message::System` entries opted in to a cache hint, so
/// existing callers see the previous wire shape.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnSystem {
    Text(String),
    Blocks(Vec<AnSystemBlock>),
}

#[derive(Debug, Serialize)]
struct AnSystemBlock {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<CacheControl>,
}

/// Wire shape of Anthropic's `cache_control` directive. The 1-hour
/// breakpoint rolled out as `{type:"ephemeral", ttl:"1h"}`; the
/// default 5-min form omits `ttl`.
#[derive(Debug, Serialize)]
struct CacheControl {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl: Option<&'static str>,
}

impl From<CacheHint> for CacheControl {
    fn from(h: CacheHint) -> Self {
        match h {
            CacheHint::Ephemeral => Self {
                kind: "ephemeral",
                ttl: None,
            },
            CacheHint::Persistent => Self {
                kind: "ephemeral",
                ttl: Some("1h"),
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnContentBlock {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
}

impl AnContentBlock {
    /// Set `cache_control` on this block in place. Used by the
    /// converter to attach a mid-conversation cache breakpoint to the
    /// last block of an assistant message, or to a specific
    /// `tool_result` block.
    fn set_cache_control(&mut self, cc: CacheControl) {
        match self {
            Self::Text { cache_control, .. }
            | Self::ToolUse { cache_control, .. }
            | Self::ToolResult { cache_control, .. } => {
                *cache_control = Some(cc);
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct AnTool {
    name: String,
    description: String,
    input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<CacheControl>,
}

impl AnthropicRequest {
    fn from_request(r: ChatRequest, stream: bool) -> Self {
        let (system, messages) = convert_messages(r.messages);
        Self {
            model: r.model,
            max_tokens: r.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            system,
            messages,
            tools: convert_tools(r.tools),
            temperature: r.temperature,
            stream,
        }
    }
}

impl From<ToolSpec> for AnTool {
    fn from(t: ToolSpec) -> Self {
        AnTool {
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
            cache_control: None,
        }
    }
}

/// If any tool's `cacheable` flag is set, attach `cache_control` to
/// the **last** tool entry. Anthropic interprets the breakpoint as
/// "everything up to and including this tool block stays cached" —
/// putting it on the last entry caches the whole tools list.
fn convert_tools(specs: Vec<ToolSpec>) -> Vec<AnTool> {
    let any_cacheable = specs.iter().any(|t| t.cacheable);
    let mut tools: Vec<AnTool> = specs.into_iter().map(AnTool::from).collect();
    if any_cacheable {
        if let Some(last) = tools.last_mut() {
            last.cache_control = Some(CacheControl {
                kind: "ephemeral",
                ttl: None,
            });
        }
    }
    tools
}

/// Pull all `Message::System` out into a top-level system prompt and
/// rewrite the rest into Anthropic's `messages` shape. Consecutive
/// `Message::Tool` entries are coalesced into one user message with
/// multiple `tool_result` blocks so Anthropic sees the canonical
/// pairing with the preceding assistant `tool_use` blocks.
///
/// The returned system value is `None` when no system messages were
/// present, `AnSystem::Text` when none carry a cache hint (preserves
/// the historical wire shape), and `AnSystem::Blocks` once any opt
/// in — the block form is the only one that accepts `cache_control`.
fn convert_messages(messages: Vec<Message>) -> (Option<AnSystem>, Vec<AnMessage>) {
    let mut systems: Vec<(String, Option<CacheHint>)> = Vec::new();
    let mut out: Vec<AnMessage> = Vec::with_capacity(messages.len());

    for m in messages {
        match m {
            Message::System { content, cache } => {
                systems.push((content, cache));
            }
            Message::User { content, cache } => {
                // Without a cache hint we keep the historical plain-text
                // wire shape; with one we promote to a single Text
                // block so `cache_control` has somewhere to land.
                let an_content = if let Some(hint) = cache {
                    AnContent::Blocks(vec![AnContentBlock::Text {
                        text: content,
                        cache_control: Some(hint.into()),
                    }])
                } else {
                    AnContent::Text(content)
                };
                out.push(AnMessage {
                    role: "user",
                    content: an_content,
                });
            }
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content: _,
                cache,
            } => {
                let mut blocks: Vec<AnContentBlock> = Vec::new();
                if let Some(text) = content {
                    if !text.is_empty() {
                        blocks.push(AnContentBlock::Text {
                            text,
                            cache_control: None,
                        });
                    }
                }
                for tc in tool_calls {
                    blocks.push(AnContentBlock::ToolUse {
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments,
                        cache_control: None,
                    });
                }
                if blocks.is_empty() {
                    // Empty assistant message — Anthropic rejects these,
                    // but emitting "" lets us round-trip and the model
                    // never sees it because we'd skip turns like this
                    // upstream anyway.
                    blocks.push(AnContentBlock::Text {
                        text: String::new(),
                        cache_control: None,
                    });
                }
                if let Some(hint) = cache {
                    if let Some(last) = blocks.last_mut() {
                        last.set_cache_control(hint.into());
                    }
                }
                out.push(AnMessage {
                    role: "assistant",
                    content: AnContent::Blocks(blocks),
                });
            }
            Message::Tool {
                tool_call_id,
                content,
                cache,
            } => {
                // Coalesce consecutive tool results into the previous
                // user message if it already collected tool_result
                // blocks; otherwise start a new one. We thread the
                // moved value through `Option::take` so it ends up in
                // exactly one place without needing `Clone`.
                let mut new_block = Some(AnContentBlock::ToolResult {
                    tool_use_id: tool_call_id,
                    content,
                    cache_control: cache.map(Into::into),
                });
                if let Some(last) = out.last_mut() {
                    if last.role == "user" {
                        if let AnContent::Blocks(blocks) = &mut last.content {
                            if blocks
                                .iter()
                                .all(|b| matches!(b, AnContentBlock::ToolResult { .. }))
                            {
                                blocks.push(new_block.take().expect("just constructed"));
                            }
                        }
                    }
                }
                if let Some(block) = new_block {
                    out.push(AnMessage {
                        role: "user",
                        content: AnContent::Blocks(vec![block]),
                    });
                }
            }
        }
    }

    let system = build_system(systems);
    (system, out)
}

/// Decide which `system` wire shape to emit. When no system carries a
/// cache hint we keep the historical joined-string form so existing
/// requests don't change. When at least one opts in, every entry
/// becomes its own text block (so `cache_control` lands on the right
/// boundary, not on a downstream concatenated chunk).
fn build_system(systems: Vec<(String, Option<CacheHint>)>) -> Option<AnSystem> {
    if systems.is_empty() {
        return None;
    }
    if systems.iter().all(|(_, c)| c.is_none()) {
        let joined = systems
            .into_iter()
            .map(|(t, _)| t)
            .collect::<Vec<_>>()
            .join("\n\n");
        if joined.is_empty() {
            return None;
        }
        return Some(AnSystem::Text(joined));
    }
    let blocks = systems
        .into_iter()
        .map(|(text, hint)| AnSystemBlock {
            kind: "text",
            text,
            cache_control: hint.map(CacheControl::from),
        })
        .collect();
    Some(AnSystem::Blocks(blocks))
}

// ---------- Non-streaming response ----------

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    #[serde(default)]
    content: Vec<AnResponseBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnResponseBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    /// Other / future block types we don't care about.
    #[serde(other)]
    Unknown,
}

impl AnthropicResponse {
    fn into_chat_response(self) -> Result<ChatResponse> {
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        for block in self.content {
            match block {
                AnResponseBlock::Text { text: t } => text.push_str(&t),
                AnResponseBlock::ToolUse { id, name, input } => {
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments: input,
                    });
                }
                AnResponseBlock::Unknown => {}
            }
        }
        let content = if text.is_empty() { None } else { Some(text) };
        let finish_reason = map_stop_reason(self.stop_reason.as_deref(), &tool_calls);

        Ok(ChatResponse {
            message: Message::Assistant {
                content,
                tool_calls,
                reasoning_content: None,
                cache: None,
            },
            finish_reason,
        })
    }
}

fn map_stop_reason(raw: Option<&str>, tool_calls: &[ToolCall]) -> FinishReason {
    match raw {
        Some("end_turn") | Some("stop_sequence") => FinishReason::Stop,
        Some("tool_use") => FinishReason::ToolCalls,
        Some("max_tokens") => FinishReason::Length,
        Some(other) => FinishReason::Other(other.to_string()),
        None if !tool_calls.is_empty() => FinishReason::ToolCalls,
        None => FinishReason::Stop,
    }
}

// ---------- Streaming events + accumulator ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamEvent {
    MessageStart {
        #[serde(default)]
        message: MessageStartBody,
    },
    ContentBlockStart {
        index: usize,
        content_block: BlockStart,
    },
    ContentBlockDelta {
        index: usize,
        delta: BlockDelta,
    },
    ContentBlockStop {
        index: usize,
    },
    MessageDelta {
        delta: MessageDelta,
        /// Final usage roll-up; Anthropic emits the full counts on
        /// the *last* `message_delta` event (running totals on
        /// intermediate ones). We accumulate the fields and forward
        /// them as one `LlmChunk::Usage` from `message_stop`.
        #[serde(default)]
        usage: AnUsage,
    },
    MessageStop,
    Ping,
    /// Anthropic occasionally adds new event types; ignore politely.
    #[serde(other)]
    Unknown,
}

/// Subset of `message_start.message` we care about. The wire shape
/// also carries `id`, `model`, `role`, etc. — we only need the usage
/// counters and let serde drop the rest.
#[derive(Debug, Default, Deserialize)]
struct MessageStartBody {
    #[serde(default)]
    usage: AnUsage,
}

/// Anthropic usage shape, shared between `message_start.message.usage`
/// and `message_delta.usage`. Every field is optional because each
/// event surfaces a different subset (input/cache_* on start,
/// output on the deltas).
#[derive(Debug, Default, Clone, Deserialize)]
struct AnUsage {
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
    /// Tokens added to the prompt cache this turn (priced ~1.25x of
    /// input). Surfaced separately from `cache_read_input_tokens`
    /// because the two have different cost characteristics.
    #[serde(default)]
    cache_creation_input_tokens: Option<u32>,
    /// Tokens served from the prompt cache (priced ~0.1x of input).
    /// This is the savings number users want to see.
    #[serde(default)]
    cache_read_input_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BlockStart {
    Text {
        #[serde(default)]
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    /// `tool_result` only appears in client-sent messages; defensive
    /// against future block kinds in responses.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BlockDelta {
    TextDelta {
        text: String,
    },
    InputJsonDelta {
        partial_json: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct MessageDelta {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Default, Debug)]
enum BlockBuilder {
    #[default]
    Pending,
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        partial_input: String,
    },
}

#[derive(Default)]
struct StreamAccumulator {
    blocks: Vec<BlockBuilder>,
    text: String,
    tool_calls: Vec<ToolCall>,
    stop_reason: Option<String>,
    finished: bool,
    /// Cumulative token counts pulled from `message_start.message.usage`
    /// (input / cache fields) and the rolling `message_delta.usage`
    /// (output_tokens). Forwarded as a single `LlmChunk::Usage` from
    /// `message_stop`, never per delta.
    pending_usage: AnUsage,
}

impl StreamAccumulator {
    /// Anthropic splits prompt-side counts across three keys:
    /// `input_tokens` (uncached), `cache_creation_input_tokens`
    /// (just-written), `cache_read_input_tokens` (cache hit).
    /// We sum them into our flat `prompt_tokens` and surface the
    /// hit-only count as `cached_prompt_tokens` so the UI can show
    /// "X cached / Y total".
    fn build_usage(&self) -> Option<Usage> {
        let u = &self.pending_usage;
        let any = u.input_tokens.is_some()
            || u.output_tokens.is_some()
            || u.cache_creation_input_tokens.is_some()
            || u.cache_read_input_tokens.is_some();
        if !any {
            return None;
        }
        let prompt = match (
            u.input_tokens,
            u.cache_creation_input_tokens,
            u.cache_read_input_tokens,
        ) {
            (None, None, None) => None,
            (a, b, c) => Some(a.unwrap_or(0) + b.unwrap_or(0) + c.unwrap_or(0)),
        };
        Some(Usage {
            prompt_tokens: prompt,
            completion_tokens: u.output_tokens,
            cached_prompt_tokens: u.cache_read_input_tokens,
            reasoning_tokens: None,
        })
    }

    fn merge_usage(&mut self, other: AnUsage) {
        if other.input_tokens.is_some() {
            self.pending_usage.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.pending_usage.output_tokens = other.output_tokens;
        }
        if other.cache_creation_input_tokens.is_some() {
            self.pending_usage.cache_creation_input_tokens = other.cache_creation_input_tokens;
        }
        if other.cache_read_input_tokens.is_some() {
            self.pending_usage.cache_read_input_tokens = other.cache_read_input_tokens;
        }
    }

    fn ingest(&mut self, ev: StreamEvent) -> Result<Vec<LlmChunk>> {
        let mut out = Vec::new();
        match ev {
            StreamEvent::MessageStart { message } => {
                self.merge_usage(message.usage);
            }
            StreamEvent::Ping | StreamEvent::Unknown => {}
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                while self.blocks.len() <= index {
                    self.blocks.push(BlockBuilder::Pending);
                }
                self.blocks[index] = match content_block {
                    BlockStart::Text { text } => BlockBuilder::Text { text },
                    BlockStart::ToolUse { id, name, input } => {
                        let partial_input = if input.is_null()
                            || input.is_object() && input.as_object().is_some_and(|o| o.is_empty())
                        {
                            String::new()
                        } else {
                            input.to_string()
                        };
                        out.push(LlmChunk::ToolCallDelta {
                            index,
                            id: Some(id.clone()),
                            name: Some(name.clone()),
                            arguments_fragment: None,
                        });
                        BlockBuilder::ToolUse {
                            id,
                            name,
                            partial_input,
                        }
                    }
                    BlockStart::Unknown => BlockBuilder::Pending,
                };
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                let slot = self
                    .blocks
                    .get_mut(index)
                    .ok_or_else(|| Error::Provider(format!("delta for unknown block {index}")))?;
                match (slot, delta) {
                    (BlockBuilder::Text { text }, BlockDelta::TextDelta { text: t })
                        if !t.is_empty() =>
                    {
                        text.push_str(&t);
                        out.push(LlmChunk::ContentDelta(t));
                    }
                    (
                        BlockBuilder::ToolUse { partial_input, .. },
                        BlockDelta::InputJsonDelta { partial_json },
                    ) if !partial_json.is_empty() => {
                        partial_input.push_str(&partial_json);
                        out.push(LlmChunk::ToolCallDelta {
                            index,
                            id: None,
                            name: None,
                            arguments_fragment: Some(partial_json),
                        });
                    }
                    // Empty deltas, mismatched (slot, delta) pairs, and
                    // forward-compatible event types fall through here
                    // — drop quietly rather than killing the stream.
                    _ => {}
                }
            }
            StreamEvent::ContentBlockStop { index } => {
                if let Some(slot) = self.blocks.get_mut(index) {
                    let taken = std::mem::replace(slot, BlockBuilder::Pending);
                    match taken {
                        BlockBuilder::Text { text } => {
                            if !text.is_empty() {
                                self.text.push_str(&text);
                            }
                        }
                        BlockBuilder::ToolUse {
                            id,
                            name,
                            partial_input,
                        } => {
                            let arguments = if partial_input.trim().is_empty() {
                                Value::Object(Default::default())
                            } else {
                                serde_json::from_str(&partial_input).map_err(|e| {
                                    Error::InvalidArguments {
                                        name: name.clone(),
                                        message: format!("{e}; raw={partial_input}"),
                                    }
                                })?
                            };
                            self.tool_calls.push(ToolCall {
                                id,
                                name,
                                arguments,
                            });
                        }
                        BlockBuilder::Pending => {}
                    }
                }
            }
            StreamEvent::MessageDelta { delta, usage } => {
                if let Some(reason) = delta.stop_reason {
                    self.stop_reason = Some(reason);
                }
                self.merge_usage(usage);
            }
            StreamEvent::MessageStop => {
                if let Some(usage) = self.build_usage() {
                    out.push(LlmChunk::Usage(usage));
                }
                out.push(self.finalise());
            }
        }
        Ok(out)
    }

    fn finalise(&mut self) -> LlmChunk {
        self.finished = true;

        let tool_calls = std::mem::take(&mut self.tool_calls);
        let finish_reason = map_stop_reason(self.stop_reason.as_deref(), &tool_calls);
        let content = if self.text.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.text))
        };

        LlmChunk::Finish {
            message: Message::Assistant {
                content,
                tool_calls,
                reasoning_content: None,
                cache: None,
            },
            finish_reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: serde_json::Value) -> StreamEvent {
        serde_json::from_value(v).unwrap()
    }

    fn system_text(sys: &Option<AnSystem>) -> String {
        match sys {
            Some(AnSystem::Text(s)) => s.clone(),
            other => panic!("expected AnSystem::Text, got {other:?}"),
        }
    }

    #[test]
    fn convert_pulls_system_to_top_level() {
        let messages = vec![Message::system("you are jarvis"), Message::user("hi")];
        let (system, msgs) = convert_messages(messages);
        assert_eq!(system_text(&system), "you are jarvis");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
    }

    #[test]
    fn convert_concatenates_multiple_systems() {
        let messages = vec![
            Message::system("first"),
            Message::system("second"),
            Message::user("hi"),
        ];
        let (system, _) = convert_messages(messages);
        assert_eq!(system_text(&system), "first\n\nsecond");
    }

    #[test]
    fn convert_assistant_with_tool_calls_uses_blocks() {
        let messages = vec![
            Message::user("call something"),
            Message::Assistant {
                content: Some("sure".into()),
                tool_calls: vec![ToolCall {
                    id: "tu_1".into(),
                    name: "echo".into(),
                    arguments: json!({"text": "hi"}),
                }],
                reasoning_content: None,
            cache: None,
            },
        ];
        let (_, msgs) = convert_messages(messages);
        assert_eq!(msgs.len(), 2);
        match &msgs[1].content {
            AnContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                assert!(matches!(&blocks[0], AnContentBlock::Text { text, .. } if text == "sure"));
                assert!(matches!(
                    &blocks[1],
                    AnContentBlock::ToolUse { id, name, .. } if id == "tu_1" && name == "echo"
                ));
            }
            _ => panic!("expected blocks"),
        }
    }

    #[test]
    fn convert_coalesces_consecutive_tool_results() {
        let messages = vec![
            Message::user("ask"),
            Message::Assistant {
                content: None,
                tool_calls: vec![
                    ToolCall {
                        id: "a".into(),
                        name: "x".into(),
                        arguments: json!({}),
                    },
                    ToolCall {
                        id: "b".into(),
                        name: "y".into(),
                        arguments: json!({}),
                    },
                ],
                reasoning_content: None,
            cache: None,
            },
            Message::tool_result("a", "first"),
            Message::tool_result("b", "second"),
        ];
        let (_, msgs) = convert_messages(messages);
        // user, assistant(blocks), user(2 tool_results)
        assert_eq!(msgs.len(), 3);
        match &msgs[2].content {
            AnContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                assert!(matches!(
                    &blocks[0],
                    AnContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "a"
                ));
                assert!(matches!(
                    &blocks[1],
                    AnContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "b"
                ));
            }
            _ => panic!("expected blocks"),
        }
    }

    #[test]
    fn response_decodes_text_and_tool_use() {
        let raw = json!({
            "content": [
                { "type": "text", "text": "before " },
                { "type": "text", "text": "after" },
                { "type": "tool_use", "id": "tu_x", "name": "echo",
                  "input": { "text": "hi" } }
            ],
            "stop_reason": "tool_use"
        });
        let parsed: AnthropicResponse = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response().unwrap();
        match resp.message {
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content: _,
            cache: None,
            } => {
                assert_eq!(content.as_deref(), Some("before after"));
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].arguments, json!({"text": "hi"}));
            }
            _ => panic!("expected assistant"),
        }
        assert!(matches!(resp.finish_reason, FinishReason::ToolCalls));
    }

    #[test]
    fn stream_accumulates_text_blocks() {
        let mut acc = StreamAccumulator::default();
        let _ = acc
            .ingest(parse(json!({"type":"message_start","message":{}})))
            .unwrap();
        let _ = acc
            .ingest(parse(json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            })))
            .unwrap();
        let r1 = acc
            .ingest(parse(json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "Hel" }
            })))
            .unwrap();
        let r2 = acc
            .ingest(parse(json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "lo" }
            })))
            .unwrap();
        let _ = acc
            .ingest(parse(json!({"type":"content_block_stop","index":0})))
            .unwrap();
        let _ = acc
            .ingest(parse(json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn" },
                "usage": {}
            })))
            .unwrap();
        let r3 = acc.ingest(parse(json!({"type":"message_stop"}))).unwrap();

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
                        tool_calls,
                        reasoning_content: _,
                    cache: None,
                    } => {
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
    fn stream_assembles_tool_use_input() {
        let mut acc = StreamAccumulator::default();
        let _ = acc
            .ingest(parse(json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": "tu_1", "name": "echo", "input": {} }
            })))
            .unwrap();
        for frag in [r#"{"te"#, r#"xt":"#, r#""hi""#, r#"}"#] {
            let _ = acc
                .ingest(parse(json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "input_json_delta", "partial_json": frag }
                })))
                .unwrap();
        }
        let _ = acc
            .ingest(parse(json!({"type":"content_block_stop","index":0})))
            .unwrap();
        let _ = acc
            .ingest(parse(json!({
                "type": "message_delta",
                "delta": { "stop_reason": "tool_use" },
                "usage": {}
            })))
            .unwrap();
        let r = acc.ingest(parse(json!({"type":"message_stop"}))).unwrap();

        match &r[..] {
            [LlmChunk::Finish {
                message,
                finish_reason,
            }] => {
                assert!(matches!(finish_reason, FinishReason::ToolCalls));
                match message {
                    Message::Assistant { tool_calls, .. } => {
                        assert_eq!(tool_calls.len(), 1);
                        assert_eq!(tool_calls[0].id, "tu_1");
                        assert_eq!(tool_calls[0].arguments, json!({"text":"hi"}));
                    }
                    _ => panic!(),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unknown_event_is_ignored() {
        let mut acc = StreamAccumulator::default();
        // Some hypothetical future event we haven't modelled.
        let r = acc
            .ingest(parse(json!({"type":"future_event","data":42})))
            .unwrap();
        assert!(r.is_empty());
    }

    // ---------- Cache-control behaviour ----------

    #[test]
    fn system_without_cache_serialises_as_string() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![Message::system("plain"), Message::user("hi")],
                tools: vec![],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["system"], json!("plain"));
    }

    #[test]
    fn system_with_ephemeral_emits_block_array_with_cache_control() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![
                    Message::system_cached("you are jarvis", CacheHint::Ephemeral),
                    Message::user("hi"),
                ],
                tools: vec![],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        let arr = v["system"].as_array().expect("blocks");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "you are jarvis");
        assert_eq!(arr[0]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn system_with_persistent_emits_ttl_one_hour() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![Message::system_cached("long", CacheHint::Persistent)],
                tools: vec![],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        let arr = v["system"].as_array().expect("blocks");
        assert_eq!(
            arr[0]["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );
    }

    #[test]
    fn mixed_systems_emit_blocks_with_cache_only_on_hinted_one() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![
                    Message::system_cached("rules", CacheHint::Ephemeral),
                    Message::system("dynamic header"),
                ],
                tools: vec![],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        let arr = v["system"].as_array().expect("blocks");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"], "rules");
        assert_eq!(arr[0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(arr[1]["text"], "dynamic header");
        // Second block has no cache_control — flag must not leak.
        assert!(arr[1].get("cache_control").is_none());
    }

    #[test]
    fn tools_no_opt_in_omits_cache_control() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![Message::user("hi")],
                tools: vec![ToolSpec {
                    name: "echo".into(),
                    description: "echo".into(),
                    parameters: json!({"type":"object"}),
                    cacheable: false,
                }],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        let tools = v["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1);
        assert!(tools[0].get("cache_control").is_none());
    }

    #[test]
    fn tools_any_opt_in_attaches_cache_control_to_last_only() {
        let req = AnthropicRequest::from_request(
            ChatRequest {
                model: "claude-3-5-sonnet-latest".into(),
                messages: vec![Message::user("hi")],
                tools: vec![
                    ToolSpec {
                        name: "echo".into(),
                        description: "echo".into(),
                        parameters: json!({"type":"object"}),
                        cacheable: true,
                    },
                    ToolSpec {
                        name: "time.now".into(),
                        description: "time".into(),
                        parameters: json!({"type":"object"}),
                        cacheable: false,
                    },
                ],
                temperature: None,
                max_tokens: None,
            },
            false,
        );
        let v = serde_json::to_value(&req).unwrap();
        let tools = v["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 2);
        // Cache breakpoint always lives on the LAST entry, regardless of
        // which entries opted in — that's how Anthropic interprets the
        // breakpoint (everything up to and including this block is cached).
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn user_without_hint_remains_plain_text() {
        let messages = vec![Message::user("hi")];
        let (_, msgs) = convert_messages(messages);
        let v = serde_json::to_value(&msgs[0]).unwrap();
        // String form, not an array — historical wire shape preserved.
        assert_eq!(v["content"], json!("hi"));
    }

    #[test]
    fn user_with_hint_emits_block_array_with_cache_control() {
        let messages = vec![Message::user("long context").with_cache(CacheHint::Ephemeral)];
        let (_, msgs) = convert_messages(messages);
        let v = serde_json::to_value(&msgs[0]).unwrap();
        let arr = v["content"].as_array().expect("blocks");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "long context");
        assert_eq!(arr[0]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn assistant_with_hint_attaches_cache_control_to_last_block() {
        // Text-only assistant: cache_control on the single text block.
        let text_only = vec![Message::assistant_text("hello").with_cache(CacheHint::Persistent)];
        let (_, msgs) = convert_messages(text_only);
        let v = serde_json::to_value(&msgs[0]).unwrap();
        let arr = v["content"].as_array().expect("blocks");
        assert_eq!(arr.len(), 1);
        assert_eq!(
            arr[0]["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );

        // Text + tool_use: cache_control lands on the tool_use (last block).
        let with_tool = vec![Message::Assistant {
            content: Some("sure".into()),
            tool_calls: vec![ToolCall {
                id: "tu_1".into(),
                name: "echo".into(),
                arguments: json!({"text": "hi"}),
            }],
            reasoning_content: None,
            cache: Some(CacheHint::Ephemeral),
        }];
        let (_, msgs) = convert_messages(with_tool);
        let v = serde_json::to_value(&msgs[0]).unwrap();
        let arr = v["content"].as_array().expect("blocks");
        assert_eq!(arr.len(), 2);
        assert!(arr[0].get("cache_control").is_none());
        assert_eq!(arr[1]["type"], "tool_use");
        assert_eq!(arr[1]["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn tool_result_with_hint_emits_cache_control_only_on_tagged_block() {
        let messages = vec![
            // Two consecutive tool results coalesce into one user message;
            // only the second carries a hint.
            Message::tool_result("call_a", "first"),
            Message::tool_result("call_b", "second").with_cache(CacheHint::Ephemeral),
        ];
        let (_, msgs) = convert_messages(messages);
        assert_eq!(msgs.len(), 1, "tool results should coalesce");
        let v = serde_json::to_value(&msgs[0]).unwrap();
        assert_eq!(v["role"], "user");
        let arr = v["content"].as_array().expect("blocks");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "tool_result");
        assert!(arr[0].get("cache_control").is_none());
        assert_eq!(arr[1]["type"], "tool_result");
        assert_eq!(arr[1]["cache_control"], json!({ "type": "ephemeral" }));
    }
}
