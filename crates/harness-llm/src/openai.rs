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
use tracing::debug;

use crate::tokens::TiktokenEstimator;

/// Tool-name policy for OpenAI Chat Completions:
/// `^[a-zA-Z0-9_-]+$`. Some forks (Kimi Code, others) tighten
/// this to "must start with a letter". The harness uses dotted
/// names like `fs.read` — we sanitize on the way out and restore
/// on the way back so models / endpoints see only safe ids while
/// the agent loop still routes tools by their original name.
fn sanitize_tool_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut chars = name.chars();
    if let Some(first) = chars.next() {
        // Lead with a letter; if the original starts with a digit
        // or symbol, prepend `_` so we satisfy the strictest
        // dialect ("must start with a letter / underscore"). The
        // restore map is keyed off the full sanitized form so it
        // round-trips regardless of how aggressive the rewrite.
        if first.is_ascii_alphabetic() {
            out.push(first);
        } else {
            out.push('_');
            if first.is_ascii_digit() || first == '_' {
                out.push(first);
            }
        }
    }
    for c in chars {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

fn restore_tool_name(map: &HashMap<String, String>, sanitized: &str) -> String {
    map.get(sanitized)
        .cloned()
        .unwrap_or_else(|| sanitized.to_string())
}

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    pub api_key: String,
    pub base_url: String,
    pub include_empty_reasoning_content_for_tool_calls: bool,
    /// Model the provider expects to be called with. Used at provider
    /// construction time to pick the right BPE encoder for
    /// [`LlmProvider::estimator`] (`o200k_base` for the `gpt-4o` /
    /// `gpt-5` / `o1`-`o4` reasoning families, `cl100k_base`
    /// otherwise). The chat loop still passes `model` per request, so
    /// this is a hint only — leave `None` to fall back to `cl100k`.
    pub default_model: Option<String>,
}

impl OpenAiConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            include_empty_reasoning_content_for_tool_calls: false,
            default_model: None,
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Some OpenAI-compatible thinking endpoints (notably Kimi K2
    /// thinking) require assistant messages with historical tool calls
    /// to carry a `reasoning_content` field even when Jarvis does not
    /// persist hidden reasoning. Standard OpenAI does not need this,
    /// so the compatibility field stays opt-in.
    pub fn with_empty_reasoning_content_for_tool_calls(mut self, enabled: bool) -> Self {
        self.include_empty_reasoning_content_for_tool_calls = enabled;
        self
    }

    /// Hint the BPE encoder choice for [`LlmProvider::estimator`]; see
    /// [`OpenAiConfig::default_model`].
    pub fn with_default_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = Some(model.into());
        self
    }
}

pub struct OpenAiProvider {
    cfg: OpenAiConfig,
    http: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(cfg: OpenAiConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn with_client(cfg: OpenAiConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }

    fn build_estimator(&self) -> Arc<dyn TokenEstimator> {
        let est = match self.cfg.default_model.as_deref() {
            Some(m) => TiktokenEstimator::for_openai_model(m),
            None => TiktokenEstimator::cl100k(),
        };
        Arc::new(est)
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let Outbound {
            request: body,
            name_map,
        } = OpenAiRequest::from_request(
            req,
            false,
            self.cfg.include_empty_reasoning_content_for_tool_calls,
        );
        let url = format!("{}/chat/completions", self.cfg.base_url);
        debug!(%url, model = %body.model, "openai request");

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.api_key)
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

        let parsed: OpenAiResponse = serde_json::from_str(&text)
            .map_err(|e| Error::Provider(format!("decode: {e}; body={text}")))?;

        parsed.into_chat_response(&name_map)
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let Outbound {
            request: body,
            name_map,
        } = OpenAiRequest::from_request(
            req,
            true,
            self.cfg.include_empty_reasoning_content_for_tool_calls,
        );
        let url = format!("{}/chat/completions", self.cfg.base_url);
        debug!(%url, model = %body.model, "openai stream request");

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.api_key)
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
            let mut acc = StreamAccumulator::with_name_map(name_map);

            while let Some(chunk) = byte_stream.next().await {
                let bytes = chunk.map_err(|e| Error::Provider(format!("stream: {e}")))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buf.find("\n\n") {
                    // Take one SSE event block.
                    let event_block: String = buf.drain(..pos + 2).collect();

                    for line in event_block.lines() {
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data == "[DONE]" {
                            continue;
                        }
                        if data.is_empty() {
                            continue;
                        }

                        let delta: StreamChunk = serde_json::from_str(data).map_err(|e| {
                            Error::Provider(format!("decode chunk: {e}; raw={data}"))
                        })?;

                        for chunk in acc.ingest(delta)? {
                            yield chunk;
                        }
                    }
                }
            }

            // Some gateways close the body without sending [DONE] — emit a
            // Finish from whatever state we've accumulated.
            if !acc.finished {
                yield acc.finalise();
            }
        };

        Ok(Box::pin(s))
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        self.build_estimator()
    }
}

// ---------- Wire types (shared) ----------

#[derive(Debug, Serialize)]
struct OpenAiRequest {
    model: String,
    messages: Vec<OaMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<OaTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
    /// Opt into a final `usage:{...}` chunk on the SSE stream. Required
    /// because by default OpenAI omits usage from chunked responses;
    /// without this we never get token counts on the streaming path.
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<OaStreamOptions>,
}

#[derive(Debug, Serialize)]
struct OaStreamOptions {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
struct OaMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    tool_calls: Vec<OaToolCallOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct OaToolCallOut {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: OaFunctionCallOut,
}

#[derive(Debug, Serialize)]
struct OaFunctionCallOut {
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize)]
struct OaTool {
    #[serde(rename = "type")]
    kind: &'static str,
    function: OaFunctionDef,
}

#[derive(Debug, Serialize)]
struct OaFunctionDef {
    name: String,
    description: String,
    parameters: Value,
}

/// Wire request + the sanitized→original tool-name map. Used by
/// the response / streaming paths to restore harness-shaped names
/// before handing them back to the agent loop.
struct Outbound {
    request: OpenAiRequest,
    name_map: HashMap<String, String>,
}

impl OpenAiRequest {
    fn from_request(
        r: ChatRequest,
        stream: bool,
        include_empty_reasoning_content_for_tool_calls: bool,
    ) -> Outbound {
        // Build the sanitize→original map from the tool catalogue.
        // Both the `tools` array and any inline assistant
        // `tool_calls` get the same renaming so the wire payload is
        // self-consistent.
        let name_map: HashMap<String, String> = r
            .tools
            .iter()
            .map(|t| (sanitize_tool_name(&t.name), t.name.clone()))
            .collect();

        let request = OpenAiRequest {
            model: r.model,
            messages: r
                .messages
                .into_iter()
                .map(|m| OaMessage::from_message(m, include_empty_reasoning_content_for_tool_calls))
                .collect(),
            tools: r.tools.into_iter().map(OaTool::from).collect(),
            temperature: r.temperature,
            max_tokens: r.max_tokens,
            stream,
            stream_options: stream.then_some(OaStreamOptions {
                include_usage: true,
            }),
        };
        Outbound { request, name_map }
    }
}

impl OaMessage {
    fn from_message(m: Message, include_empty_reasoning_content_for_tool_calls: bool) -> Self {
        match m {
            Message::System { content, .. } => OaMessage {
                role: "system",
                content: Some(content),
                reasoning_content: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            Message::User { content, .. } => OaMessage {
                role: "user",
                content: Some(content),
                reasoning_content: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content: captured_reasoning,
                ..
            } => {
                let tool_calls: Vec<OaToolCallOut> = tool_calls
                    .into_iter()
                    .map(|tc| OaToolCallOut {
                        id: tc.id,
                        kind: "function",
                        function: OaFunctionCallOut {
                            name: sanitize_tool_name(&tc.name),
                            arguments: tc.arguments.to_string(),
                        },
                    })
                    .collect();
                // Send reasoning_content priority:
                //   1. real reasoning captured from the prior turn
                //   2. empty placeholder when the flag is on AND
                //      there's a tool_call (Kimi K2 thinking refuses
                //      conversations that lack the field on
                //      historical tool-call assistant messages)
                //   3. omit
                let reasoning_content = match captured_reasoning {
                    Some(r) => Some(r),
                    None if include_empty_reasoning_content_for_tool_calls
                        && !tool_calls.is_empty() =>
                    {
                        Some(String::new())
                    }
                    None => None,
                };
                OaMessage {
                    role: "assistant",
                    content,
                    reasoning_content,
                    tool_calls,
                    tool_call_id: None,
                }
            }
            Message::Tool {
                tool_call_id,
                content,
                ..
            } => OaMessage {
                role: "tool",
                content: Some(content),
                reasoning_content: None,
                tool_calls: Vec::new(),
                tool_call_id: Some(tool_call_id),
            },
        }
    }
}

impl From<ToolSpec> for OaTool {
    fn from(t: ToolSpec) -> Self {
        OaTool {
            kind: "function",
            function: OaFunctionDef {
                name: sanitize_tool_name(&t.name),
                description: t.description,
                parameters: t.parameters,
            },
        }
    }
}

// ---------- Non-streaming response ----------

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OaChoice>,
}

#[derive(Debug, Deserialize)]
struct OaChoice {
    message: OaResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OaResponseMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OaToolCallIn>,
    /// Hidden reasoning emitted by `kimi-for-coding` and other K2
    /// thinking endpoints. Captured here so we can hand it back on
    /// the next turn — Kimi rejects assistant tool_call messages
    /// that lack `reasoning_content` in conversation history.
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OaToolCallIn {
    id: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    kind: Option<String>,
    function: OaFunctionCallIn,
}

#[derive(Debug, Deserialize)]
struct OaFunctionCallIn {
    name: String,
    arguments: String,
}

impl OpenAiResponse {
    fn into_chat_response(mut self, name_map: &HashMap<String, String>) -> Result<ChatResponse> {
        let choice = self
            .choices
            .pop()
            .ok_or_else(|| Error::Provider("response had no choices".into()))?;

        let tool_calls = choice
            .message
            .tool_calls
            .into_iter()
            .map(|tc| {
                let original = restore_tool_name(name_map, &tc.function.name);
                parse_tool_call(tc.id, original, &tc.function.arguments)
            })
            .collect::<Result<Vec<_>>>()?;

        let finish_reason = map_finish_reason(choice.finish_reason.as_deref(), &tool_calls);

        Ok(ChatResponse {
            message: Message::Assistant {
                content: choice.message.content,
                tool_calls,
                reasoning_content: choice.message.reasoning_content,
                cache: None,
            },
            finish_reason,
        })
    }
}

fn parse_tool_call(id: String, name: String, raw_args: &str) -> Result<ToolCall> {
    let arguments = if raw_args.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str(raw_args).map_err(|e| Error::InvalidArguments {
            name: name.clone(),
            message: format!("{e}; raw={raw_args}"),
        })?
    };
    Ok(ToolCall {
        id,
        name,
        arguments,
    })
}

fn map_finish_reason(raw: Option<&str>, tool_calls: &[ToolCall]) -> FinishReason {
    match raw {
        Some("stop") => FinishReason::Stop,
        Some("tool_calls") => FinishReason::ToolCalls,
        Some("length") => FinishReason::Length,
        Some(other) => FinishReason::Other(other.to_string()),
        None if !tool_calls.is_empty() => FinishReason::ToolCalls,
        None => FinishReason::Stop,
    }
}

// ---------- Streaming wire types + accumulator ----------

#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    /// Final usage chunk (server emits when `stream_options.include_usage`
    /// is true). Has an empty `choices` array, so existing logic that
    /// skips chunks without choices keeps working — we just look here
    /// first.
    #[serde(default)]
    usage: Option<OaUsage>,
}

#[derive(Debug, Deserialize)]
struct OaUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    /// Per-call breakdown shipped on `gpt-4o*` and newer; carries
    /// `cached_tokens` for prompt-cache reporting.
    #[serde(default)]
    prompt_tokens_details: Option<OaPromptDetails>,
    /// Reasoning tokens billed by the o1 / o3 family.
    #[serde(default)]
    completion_tokens_details: Option<OaCompletionDetails>,
}

#[derive(Debug, Deserialize)]
struct OaPromptDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OaCompletionDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

impl OaUsage {
    fn into_core(self) -> Usage {
        Usage {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            cached_prompt_tokens: self.prompt_tokens_details.and_then(|d| d.cached_tokens),
            reasoning_tokens: self
                .completion_tokens_details
                .and_then(|d| d.reasoning_tokens),
        }
    }
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<StreamToolCallDelta>,
    /// Streamed reasoning fragments from K2-thinking-style endpoints.
    /// Concatenated by the accumulator and stamped onto the final
    /// assistant message so the next turn can hand it back.
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallDelta {
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Default)]
struct ToolCallBuilder {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

#[derive(Default)]
struct StreamAccumulator {
    content: String,
    tool_calls: Vec<ToolCallBuilder>,
    finish_reason: Option<String>,
    finished: bool,
    /// Concatenated `reasoning_content` fragments from the model.
    /// Empty when the endpoint doesn't emit reasoning. Stamped onto
    /// the final assistant message so subsequent turns can replay
    /// it back to thinking endpoints that require it.
    reasoning_content: String,
    /// Sanitized→original tool-name map (empty when no tools).
    name_map: HashMap<String, String>,
}

impl StreamAccumulator {
    fn with_name_map(name_map: HashMap<String, String>) -> Self {
        Self {
            name_map,
            ..Default::default()
        }
    }

    fn ingest(&mut self, chunk: StreamChunk) -> Result<Vec<LlmChunk>> {
        let mut out = Vec::new();
        // Final usage chunks ship on their own, with `choices: []`.
        // Surface them to the agent loop before we early-return.
        if let Some(usage) = chunk.usage {
            out.push(LlmChunk::Usage(usage.into_core()));
        }
        let Some(choice) = chunk.choices.into_iter().next() else {
            return Ok(out);
        };

        if let Some(reasoning) = choice.delta.reasoning_content {
            if !reasoning.is_empty() {
                self.reasoning_content.push_str(&reasoning);
            }
        }

        if let Some(text) = choice.delta.content {
            if !text.is_empty() {
                self.content.push_str(&text);
                out.push(LlmChunk::ContentDelta(text));
            }
        }

        for td in choice.delta.tool_calls {
            while self.tool_calls.len() <= td.index {
                self.tool_calls.push(ToolCallBuilder::default());
            }
            let slot = &mut self.tool_calls[td.index];
            if let Some(id) = td.id.clone() {
                slot.id = Some(id);
            }
            let mut name_update = None;
            let mut args_update = None;
            if let Some(fn_delta) = td.function {
                if let Some(name) = fn_delta.name {
                    if !name.is_empty() {
                        // Restore the original (dotted) name if we
                        // sanitized it on the way out — clients see
                        // the harness shape, not the wire shape.
                        let original = restore_tool_name(&self.name_map, &name);
                        slot.name = Some(original.clone());
                        name_update = Some(original);
                    }
                }
                if let Some(args) = fn_delta.arguments {
                    if !args.is_empty() {
                        slot.arguments.push_str(&args);
                        args_update = Some(args);
                    }
                }
            }
            if name_update.is_some() || args_update.is_some() || td.id.is_some() {
                out.push(LlmChunk::ToolCallDelta {
                    index: td.index,
                    id: td.id,
                    name: name_update,
                    arguments_fragment: args_update,
                });
            }
        }

        if let Some(fr) = choice.finish_reason {
            self.finish_reason = Some(fr);
            out.push(self.finalise());
        }

        Ok(out)
    }

    fn finalise(&mut self) -> LlmChunk {
        self.finished = true;

        let tool_calls: Vec<ToolCall> = self
            .tool_calls
            .drain(..)
            .filter_map(|b| match (b.id, b.name) {
                (Some(id), Some(name)) => parse_tool_call(id, name, &b.arguments).ok(),
                _ => None,
            })
            .collect();

        let finish_reason = map_finish_reason(self.finish_reason.as_deref(), &tool_calls);

        let content = if self.content.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.content))
        };

        let reasoning = if self.reasoning_content.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.reasoning_content))
        };

        LlmChunk::Finish {
            message: Message::Assistant {
                content,
                tool_calls,
                reasoning_content: reasoning,
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

    fn parse_chunk(v: serde_json::Value) -> StreamChunk {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn accumulates_content_deltas() {
        let mut acc = StreamAccumulator::default();
        let out1 = acc
            .ingest(parse_chunk(json!({
                "choices": [{ "delta": { "content": "Hel" } }]
            })))
            .unwrap();
        let out2 = acc
            .ingest(parse_chunk(json!({
                "choices": [{ "delta": { "content": "lo" } }]
            })))
            .unwrap();
        let out3 = acc
            .ingest(parse_chunk(json!({
                "choices": [{ "delta": {}, "finish_reason": "stop" }]
            })))
            .unwrap();

        assert!(matches!(out1.as_slice(), [LlmChunk::ContentDelta(s)] if s == "Hel"));
        assert!(matches!(out2.as_slice(), [LlmChunk::ContentDelta(s)] if s == "lo"));
        match &out3[..] {
            [LlmChunk::Finish {
                message,
                finish_reason,
            }] => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls,
                        ..
                    } => {
                        assert_eq!(content.as_deref(), Some("Hello"));
                        assert!(tool_calls.is_empty());
                    }
                    _ => panic!("expected assistant message"),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn accumulates_tool_call_across_chunks() {
        let mut acc = StreamAccumulator::default();
        acc.ingest(parse_chunk(json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_abc",
                        "function": { "name": "echo", "arguments": "{\"te" }
                    }]
                }
            }]
        })))
        .unwrap();
        acc.ingest(parse_chunk(json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": { "arguments": "xt\":\"hi\"}" }
                    }]
                }
            }]
        })))
        .unwrap();
        let out = acc
            .ingest(parse_chunk(json!({
                "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
            })))
            .unwrap();

        match &out[..] {
            [LlmChunk::Finish {
                message,
                finish_reason,
            }] => {
                assert!(matches!(finish_reason, FinishReason::ToolCalls));
                match message {
                    Message::Assistant { tool_calls, .. } => {
                        assert_eq!(tool_calls.len(), 1);
                        assert_eq!(tool_calls[0].id, "call_abc");
                        assert_eq!(tool_calls[0].name, "echo");
                        assert_eq!(tool_calls[0].arguments, json!({ "text": "hi" }));
                    }
                    _ => panic!("expected assistant"),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn sanitize_replaces_dot_and_keeps_letters() {
        assert_eq!(sanitize_tool_name("fs.read"), "fs_read");
        assert_eq!(sanitize_tool_name("code.grep"), "code_grep");
        assert_eq!(sanitize_tool_name("echo"), "echo");
        // Leading non-letter — strict dialects (Kimi Code) reject it.
        assert_eq!(sanitize_tool_name("9foo"), "_9foo");
    }

    #[test]
    fn outbound_request_renames_tools_and_assistant_calls() {
        let req = ChatRequest {
            model: "kimi-for-coding".into(),
            messages: vec![
                Message::user("read it"),
                Message::Assistant {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "call_1".into(),
                        name: "fs.read".into(),
                        arguments: json!({"path": "x"}),
                    }],
                    reasoning_content: None,
                cache: None,
                },
            ],
            tools: vec![ToolSpec {
                name: "fs.read".into(),
                description: "read a file".into(),
                parameters: json!({"type": "object"}),
                cacheable: false,
            }],
            temperature: None,
            max_tokens: None,
        };
        let outbound = OpenAiRequest::from_request(req, false, false);
        let body = serde_json::to_value(&outbound.request).unwrap();
        // Tool catalogue rewritten.
        assert_eq!(body["tools"][0]["function"]["name"], "fs_read");
        // Inline assistant tool_call also rewritten.
        let asst = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "assistant")
            .unwrap();
        assert_eq!(asst["tool_calls"][0]["function"]["name"], "fs_read");
        // Map round-trips both directions.
        assert_eq!(outbound.name_map.get("fs_read").unwrap(), "fs.read");
    }

    #[test]
    fn outbound_request_can_emit_reasoning_content_for_thinking_tool_calls() {
        let req = ChatRequest {
            model: "kimi-k2-thinking".into(),
            messages: vec![
                Message::user("read it"),
                Message::Assistant {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "call_1".into(),
                        name: "fs.read".into(),
                        arguments: json!({"path": "x"}),
                    }],
                    reasoning_content: None,
                cache: None,
                },
            ],
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
        };
        let outbound = OpenAiRequest::from_request(req, false, true);
        let body = serde_json::to_value(&outbound.request).unwrap();
        let asst = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "assistant")
            .unwrap();
        assert_eq!(asst["reasoning_content"], "");
    }

    #[test]
    fn response_restores_sanitised_tool_call_name() {
        let raw = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "fs_read", "arguments": "{\"path\":\"a.txt\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let parsed: OpenAiResponse = serde_json::from_value(raw).unwrap();
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
        let out = acc
            .ingest(parse_chunk(json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_1",
                            "function": { "name": "fs_read", "arguments": "{}" }
                        }]
                    }
                }]
            })))
            .unwrap();
        match out.as_slice() {
            [LlmChunk::ToolCallDelta { name, .. }] => {
                assert_eq!(name.as_deref(), Some("fs.read"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        let final_out = acc
            .ingest(parse_chunk(json!({
                "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
            })))
            .unwrap();
        match &final_out[..] {
            [LlmChunk::Finish { message, .. }] => match message {
                Message::Assistant { tool_calls, .. } => {
                    assert_eq!(tool_calls[0].name, "fs.read");
                }
                _ => panic!("expected assistant"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }
}
