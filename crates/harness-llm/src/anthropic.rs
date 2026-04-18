//! Anthropic Messages API provider.
//!
//! Implements [`LlmProvider`] against <https://api.anthropic.com/v1/messages>.
//! Notable wire-shape differences from OpenAI that this module translates:
//!
//! - Anthropic takes the system prompt as a top-level `system` field rather
//!   than as a message. The first `Message::System` in the conversation is
//!   lifted out; additional system messages are concatenated.
//! - Anthropic messages alternate strictly between `user` and `assistant`.
//!   Our `Message::Tool` results are mapped to a `user` message containing a
//!   `tool_result` content block; consecutive tool-result or user messages
//!   are merged into one wire message to keep the alternation.
//! - `max_tokens` is **required** by the API. We default to 4096 when the
//!   caller didn't supply one.
//! - Stop reasons `end_turn` / `stop_sequence` → `FinishReason::Stop`;
//!   `tool_use` → `ToolCalls`; `max_tokens` → `Length`.

use async_stream::try_stream;
use async_trait::async_trait;
use futures::StreamExt;
use harness_core::{
    ChatRequest, ChatResponse, Error, FinishReason, LlmChunk, LlmProvider, LlmStream, Message,
    Result, ToolCall, ToolSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub api_key: String,
    pub base_url: String,
    pub anthropic_version: String,
    /// Fallback `max_tokens` applied when `ChatRequest::max_tokens` is
    /// `None`. Anthropic requires the field; we don't want every caller to
    /// re-learn that.
    pub default_max_tokens: u32,
}

impl AnthropicConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            anthropic_version: DEFAULT_ANTHROPIC_VERSION.to_string(),
            default_max_tokens: DEFAULT_MAX_TOKENS,
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

    pub fn with_default_max_tokens(mut self, n: u32) -> Self {
        self.default_max_tokens = n;
        self
    }
}

pub struct AnthropicProvider {
    cfg: AnthropicConfig,
    http: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(cfg: AnthropicConfig) -> Self {
        Self { cfg, http: reqwest::Client::new() }
    }

    pub fn with_client(cfg: AnthropicConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let body = AnRequest::from_request(req, false, self.cfg.default_max_tokens);
        let url = format!("{}/messages", self.cfg.base_url);
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

        let parsed: AnResponse = serde_json::from_str(&text)
            .map_err(|e| Error::Provider(format!("decode: {e}; body={text}")))?;

        parsed.into_chat_response()
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let body = AnRequest::from_request(req, true, self.cfg.default_max_tokens);
        let url = format!("{}/messages", self.cfg.base_url);
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

                    for line in event_block.lines() {
                        // Anthropic SSE frames carry both `event:` and
                        // `data:` lines. The event name is duplicated inside
                        // the data payload as a `type` field, so we can
                        // ignore the `event:` line and just parse the JSON.
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() {
                            continue;
                        }

                        let event: StreamEvent = serde_json::from_str(data).map_err(|e| {
                            Error::Provider(format!("decode stream event: {e}; raw={data}"))
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
}

// ============================== Wire types ================================

#[derive(Debug, Serialize)]
struct AnRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
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
    content: Vec<AnContentBlock>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnContentBlock {
    Text { text: String },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
    },
}

#[derive(Debug, Serialize)]
struct AnTool {
    name: String,
    description: String,
    input_schema: Value,
}

impl AnRequest {
    fn from_request(r: ChatRequest, stream: bool, default_max_tokens: u32) -> Self {
        let (system, messages) = to_anthropic_messages(r.messages);
        let tools = r.tools.into_iter().map(AnTool::from).collect();
        Self {
            model: r.model,
            max_tokens: r.max_tokens.unwrap_or(default_max_tokens),
            system,
            messages,
            tools,
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
        }
    }
}

/// Split a harness message list into (system prompt, alternating wire
/// messages). Consecutive same-role entries are merged so content blocks
/// pile up inside one wire message — Anthropic rejects adjacent user or
/// assistant messages.
fn to_anthropic_messages(messages: Vec<Message>) -> (Option<String>, Vec<AnMessage>) {
    let mut system_prompt: Option<String> = None;
    let mut wire: Vec<AnMessage> = Vec::new();

    for msg in messages {
        match msg {
            Message::System { content } => {
                system_prompt = Some(match system_prompt {
                    Some(prev) => format!("{prev}\n\n{content}"),
                    None => content,
                });
            }
            Message::User { content } => {
                push_or_merge(&mut wire, "user", AnContentBlock::Text { text: content });
            }
            Message::Assistant { content, tool_calls } => {
                let mut blocks: Vec<AnContentBlock> = Vec::new();
                if let Some(text) = content {
                    if !text.is_empty() {
                        blocks.push(AnContentBlock::Text { text });
                    }
                }
                for tc in tool_calls {
                    blocks.push(AnContentBlock::ToolUse {
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments,
                    });
                }
                // An assistant turn must have at least one block. If the
                // model produced nothing (neither text nor tools), emit a
                // single empty text block to keep the API happy.
                if blocks.is_empty() {
                    blocks.push(AnContentBlock::Text { text: String::new() });
                }
                wire.push(AnMessage { role: "assistant", content: blocks });
            }
            Message::Tool { tool_call_id, content } => {
                push_or_merge(
                    &mut wire,
                    "user",
                    AnContentBlock::ToolResult { tool_use_id: tool_call_id, content },
                );
            }
        }
    }

    (system_prompt, wire)
}

fn push_or_merge(wire: &mut Vec<AnMessage>, role: &'static str, block: AnContentBlock) {
    if let Some(last) = wire.last_mut() {
        if last.role == role {
            last.content.push(block);
            return;
        }
    }
    wire.push(AnMessage { role, content: vec![block] });
}

// ==================== Non-streaming response decoding =====================

#[derive(Debug, Deserialize)]
struct AnResponse {
    #[serde(default)]
    content: Vec<AnResponseBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnResponseBlock {
    Text { text: String },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
}

impl AnResponse {
    fn into_chat_response(self) -> Result<ChatResponse> {
        let mut content_text: Option<String> = None;
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        for block in self.content {
            match block {
                AnResponseBlock::Text { text } => {
                    content_text = Some(match content_text {
                        Some(prev) => format!("{prev}{text}"),
                        None => text,
                    });
                }
                AnResponseBlock::ToolUse { id, name, input } => {
                    tool_calls.push(ToolCall { id, name, arguments: input });
                }
            }
        }

        let finish_reason = map_finish_reason(self.stop_reason.as_deref(), &tool_calls);

        Ok(ChatResponse {
            message: Message::Assistant { content: content_text, tool_calls },
            finish_reason,
        })
    }
}

fn map_finish_reason(raw: Option<&str>, tool_calls: &[ToolCall]) -> FinishReason {
    match raw {
        Some("end_turn") | Some("stop_sequence") => FinishReason::Stop,
        Some("tool_use") => FinishReason::ToolCalls,
        Some("max_tokens") => FinishReason::Length,
        Some(other) => FinishReason::Other(other.to_string()),
        None if !tool_calls.is_empty() => FinishReason::ToolCalls,
        None => FinishReason::Stop,
    }
}

// ============================== Streaming =================================

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamEvent {
    MessageStart,
    ContentBlockStart {
        index: usize,
        content_block: BlockStart,
    },
    ContentBlockDelta {
        index: usize,
        delta: BlockDelta,
    },
    ContentBlockStop {
        #[allow(dead_code)]
        index: usize,
    },
    MessageDelta {
        delta: MessageDeltaPayload,
    },
    MessageStop,
    Ping,
    #[serde(other)]
    Unknown,
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
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BlockDelta {
    TextDelta { text: String },
    InputJsonDelta { partial_json: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct MessageDeltaPayload {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug)]
enum BlockBuilder {
    Text { text: String },
    ToolUse { id: String, name: String, partial_json: String },
}

#[derive(Default)]
struct StreamAccumulator {
    blocks: Vec<Option<BlockBuilder>>,
    stop_reason: Option<String>,
    finished: bool,
}

impl StreamAccumulator {
    fn ingest(&mut self, event: StreamEvent) -> Result<Vec<LlmChunk>> {
        let mut out = Vec::new();
        match event {
            StreamEvent::MessageStart | StreamEvent::Ping | StreamEvent::Unknown => {}
            StreamEvent::ContentBlockStart { index, content_block } => {
                while self.blocks.len() <= index {
                    self.blocks.push(None);
                }
                match content_block {
                    BlockStart::Text { text } => {
                        self.blocks[index] = Some(BlockBuilder::Text { text });
                    }
                    BlockStart::ToolUse { id, name, input } => {
                        let initial_json = if input.is_null()
                            || matches!(&input, Value::Object(m) if m.is_empty())
                        {
                            String::new()
                        } else {
                            input.to_string()
                        };
                        self.blocks[index] = Some(BlockBuilder::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            partial_json: initial_json,
                        });
                        out.push(LlmChunk::ToolCallDelta {
                            index,
                            id: Some(id),
                            name: Some(name),
                            arguments_fragment: None,
                        });
                    }
                    BlockStart::Unknown => {
                        self.blocks[index] = None;
                    }
                }
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                let slot = self.blocks.get_mut(index).and_then(|s| s.as_mut());
                match (slot, delta) {
                    (Some(BlockBuilder::Text { text }), BlockDelta::TextDelta { text: t }) => {
                        if !t.is_empty() {
                            text.push_str(&t);
                            out.push(LlmChunk::ContentDelta(t));
                        }
                    }
                    (
                        Some(BlockBuilder::ToolUse { partial_json, .. }),
                        BlockDelta::InputJsonDelta { partial_json: frag },
                    ) => {
                        if !frag.is_empty() {
                            partial_json.push_str(&frag);
                            out.push(LlmChunk::ToolCallDelta {
                                index,
                                id: None,
                                name: None,
                                arguments_fragment: Some(frag),
                            });
                        }
                    }
                    _ => {
                        // Mismatched delta — ignore. Keeps us resilient to
                        // new block / delta variants the API might introduce.
                    }
                }
            }
            StreamEvent::ContentBlockStop { .. } => {}
            StreamEvent::MessageDelta { delta } => {
                if let Some(reason) = delta.stop_reason {
                    self.stop_reason = Some(reason);
                }
            }
            StreamEvent::MessageStop => {
                out.push(self.finalise());
            }
        }
        Ok(out)
    }

    fn finalise(&mut self) -> LlmChunk {
        self.finished = true;

        let mut content: Option<String> = None;
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        for slot in self.blocks.drain(..) {
            match slot {
                Some(BlockBuilder::Text { text }) => {
                    if !text.is_empty() {
                        content = Some(match content {
                            Some(prev) => format!("{prev}{text}"),
                            None => text,
                        });
                    }
                }
                Some(BlockBuilder::ToolUse { id, name, partial_json }) => {
                    let args = if partial_json.trim().is_empty() {
                        Value::Object(Default::default())
                    } else {
                        match serde_json::from_str(&partial_json) {
                            Ok(v) => v,
                            Err(_) => Value::Object(Default::default()),
                        }
                    };
                    tool_calls.push(ToolCall { id, name, arguments: args });
                }
                None => {}
            }
        }

        let finish_reason = map_finish_reason(self.stop_reason.as_deref(), &tool_calls);

        LlmChunk::Finish {
            message: Message::Assistant { content, tool_calls },
            finish_reason,
        }
    }
}

// ================================= Tests =================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_event(v: Value) -> StreamEvent {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn system_lifted_and_messages_alternate() {
        let conv = vec![
            Message::system("you are helpful"),
            Message::user("hi"),
            Message::assistant_text("hello"),
            Message::user("do the thing"),
        ];
        let (system, wire) = to_anthropic_messages(conv);
        assert_eq!(system.as_deref(), Some("you are helpful"));
        assert_eq!(wire.len(), 3);
        assert_eq!(wire[0].role, "user");
        assert_eq!(wire[1].role, "assistant");
        assert_eq!(wire[2].role, "user");
    }

    #[test]
    fn consecutive_tool_results_merge_into_one_user_message() {
        let conv = vec![
            Message::user("kick off"),
            Message::Assistant {
                content: None,
                tool_calls: vec![
                    ToolCall { id: "a".into(), name: "echo".into(), arguments: json!({}) },
                    ToolCall { id: "b".into(), name: "echo".into(), arguments: json!({}) },
                ],
            },
            Message::tool_result("a", "first"),
            Message::tool_result("b", "second"),
        ];
        let (_, wire) = to_anthropic_messages(conv);
        assert_eq!(wire.len(), 3);
        assert_eq!(wire[2].role, "user");
        assert_eq!(wire[2].content.len(), 2);
        match &wire[2].content[0] {
            AnContentBlock::ToolResult { tool_use_id, content } => {
                assert_eq!(tool_use_id, "a");
                assert_eq!(content, "first");
            }
            _ => panic!("expected tool_result block"),
        }
    }

    #[test]
    fn non_streaming_response_decodes_text_and_tool_use() {
        let resp: AnResponse = serde_json::from_value(json!({
            "content": [
                {"type": "text", "text": "let me "},
                {"type": "text", "text": "check"},
                {"type": "tool_use", "id": "toolu_1", "name": "echo", "input": {"text": "hi"}}
            ],
            "stop_reason": "tool_use"
        }))
        .unwrap();
        let out = resp.into_chat_response().unwrap();
        assert!(matches!(out.finish_reason, FinishReason::ToolCalls));
        match out.message {
            Message::Assistant { content, tool_calls } => {
                assert_eq!(content.as_deref(), Some("let me check"));
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].id, "toolu_1");
                assert_eq!(tool_calls[0].name, "echo");
                assert_eq!(tool_calls[0].arguments, json!({ "text": "hi" }));
            }
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn stream_accumulator_assembles_text_and_tool_use() {
        let mut acc = StreamAccumulator::default();

        acc.ingest(parse_event(json!({"type": "message_start"}))).unwrap();

        // Text block: "Hello"
        acc.ingest(parse_event(json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "" }
        })))
        .unwrap();
        let c1 = acc
            .ingest(parse_event(json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "Hel" }
            })))
            .unwrap();
        let c2 = acc
            .ingest(parse_event(json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "lo" }
            })))
            .unwrap();
        acc.ingest(parse_event(json!({"type": "content_block_stop", "index": 0})))
            .unwrap();

        assert!(matches!(c1.as_slice(), [LlmChunk::ContentDelta(s)] if s == "Hel"));
        assert!(matches!(c2.as_slice(), [LlmChunk::ContentDelta(s)] if s == "lo"));

        // Tool use block: echo({"text":"hi"})
        acc.ingest(parse_event(json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "toolu_1", "name": "echo", "input": {} }
        })))
        .unwrap();
        acc.ingest(parse_event(json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"te" }
        })))
        .unwrap();
        acc.ingest(parse_event(json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "xt\":\"hi\"}" }
        })))
        .unwrap();
        acc.ingest(parse_event(json!({"type": "content_block_stop", "index": 1})))
            .unwrap();

        acc.ingest(parse_event(json!({
            "type": "message_delta",
            "delta": { "stop_reason": "tool_use" }
        })))
        .unwrap();
        let done = acc
            .ingest(parse_event(json!({"type": "message_stop"})))
            .unwrap();

        match &done[..] {
            [LlmChunk::Finish { message, finish_reason }] => {
                assert!(matches!(finish_reason, FinishReason::ToolCalls));
                match message {
                    Message::Assistant { content, tool_calls } => {
                        assert_eq!(content.as_deref(), Some("Hello"));
                        assert_eq!(tool_calls.len(), 1);
                        assert_eq!(tool_calls[0].id, "toolu_1");
                        assert_eq!(tool_calls[0].arguments, json!({ "text": "hi" }));
                    }
                    _ => panic!("expected assistant"),
                }
            }
            other => panic!("unexpected terminal: {other:?}"),
        }
    }

    #[test]
    fn stop_reason_mapping() {
        assert!(matches!(map_finish_reason(Some("end_turn"), &[]), FinishReason::Stop));
        assert!(matches!(
            map_finish_reason(Some("stop_sequence"), &[]),
            FinishReason::Stop
        ));
        assert!(matches!(
            map_finish_reason(Some("tool_use"), &[]),
            FinishReason::ToolCalls
        ));
        assert!(matches!(
            map_finish_reason(Some("max_tokens"), &[]),
            FinishReason::Length
        ));
        assert!(matches!(
            map_finish_reason(Some("weird"), &[]),
            FinishReason::Other(_)
        ));
    }
}
