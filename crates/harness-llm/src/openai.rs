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

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    pub api_key: String,
    pub base_url: String,
}

impl OpenAiConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }
}

pub struct OpenAiProvider {
    cfg: OpenAiConfig,
    http: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(cfg: OpenAiConfig) -> Self {
        Self { cfg, http: reqwest::Client::new() }
    }

    pub fn with_client(cfg: OpenAiConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let body = OpenAiRequest::from_request(req, false);
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

        parsed.into_chat_response()
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let body = OpenAiRequest::from_request(req, true);
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
            let mut acc = StreamAccumulator::default();

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
}

#[derive(Debug, Serialize)]
struct OaMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
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

impl OpenAiRequest {
    fn from_request(r: ChatRequest, stream: bool) -> Self {
        Self {
            model: r.model,
            messages: r.messages.into_iter().map(OaMessage::from).collect(),
            tools: r.tools.into_iter().map(OaTool::from).collect(),
            temperature: r.temperature,
            max_tokens: r.max_tokens,
            stream,
        }
    }
}

impl From<Message> for OaMessage {
    fn from(m: Message) -> Self {
        match m {
            Message::System { content } => OaMessage {
                role: "system",
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            Message::User { content } => OaMessage {
                role: "user",
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            Message::Assistant { content, tool_calls } => OaMessage {
                role: "assistant",
                content,
                tool_calls: tool_calls
                    .into_iter()
                    .map(|tc| OaToolCallOut {
                        id: tc.id,
                        kind: "function",
                        function: OaFunctionCallOut {
                            name: tc.name,
                            arguments: tc.arguments.to_string(),
                        },
                    })
                    .collect(),
                tool_call_id: None,
            },
            Message::Tool { tool_call_id, content } => OaMessage {
                role: "tool",
                content: Some(content),
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
                name: t.name,
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
    fn into_chat_response(mut self) -> Result<ChatResponse> {
        let choice = self
            .choices
            .pop()
            .ok_or_else(|| Error::Provider("response had no choices".into()))?;

        let tool_calls = choice
            .message
            .tool_calls
            .into_iter()
            .map(|tc| parse_tool_call(tc.id, tc.function.name, &tc.function.arguments))
            .collect::<Result<Vec<_>>>()?;

        let finish_reason = map_finish_reason(choice.finish_reason.as_deref(), &tool_calls);

        Ok(ChatResponse {
            message: Message::Assistant { content: choice.message.content, tool_calls },
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
    Ok(ToolCall { id, name, arguments })
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
    choices: Vec<StreamChoice>,
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
}

impl StreamAccumulator {
    fn ingest(&mut self, chunk: StreamChunk) -> Result<Vec<LlmChunk>> {
        let mut out = Vec::new();
        let Some(choice) = chunk.choices.into_iter().next() else {
            return Ok(out);
        };

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
                        slot.name = Some(name.clone());
                        name_update = Some(name);
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
                (Some(id), Some(name)) => {
                    parse_tool_call(id, name, &b.arguments).ok()
                }
                _ => None,
            })
            .collect();

        let finish_reason = map_finish_reason(self.finish_reason.as_deref(), &tool_calls);

        let content = if self.content.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.content))
        };

        LlmChunk::Finish {
            message: Message::Assistant { content, tool_calls },
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
            [LlmChunk::Finish { message, finish_reason }] => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant { content, tool_calls } => {
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
            [LlmChunk::Finish { message, finish_reason }] => {
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
}
