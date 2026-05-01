//! Google Gemini (`generativelanguage.googleapis.com`) provider.
//!
//! Wire shape diverges from OpenAI in three load-bearing ways:
//!
//! 1. **System prompts live in `systemInstruction`**, top-level with a
//!    `parts: [{text}]` shape — separate from `contents`.
//! 2. **Roles are `user` / `model`** (no `assistant` / `tool`), and each
//!    message has a `parts` array. A model-side tool call is a
//!    `functionCall` part; a tool's reply travels back as a
//!    `functionResponse` part inside a `user` role message.
//! 3. **Tool calls don't carry an id.** Gemini reports them positionally
//!    by name; we synthesise stable ids of the form `gem_<index>` so
//!    the harness's id-keyed routing keeps working, and resolve the
//!    name from the prior assistant message when sending tool results
//!    back.
//!
//! Streaming uses `streamGenerateContent?alt=sse` — without `alt=sse`
//! Gemini ships a JSON *array* (not JSONL), which is brittle to parse
//! incrementally. Each SSE event is a complete `GenerateContentResponse`
//! slice: text parts are deltas to concatenate, `functionCall` parts
//! arrive **whole** in a single chunk (Gemini does not fragment tool-
//! call arguments the way OpenAI / Anthropic do). The terminal
//! `LlmChunk::Finish` is synthesised from accumulated state once the
//! HTTP body closes.

use async_stream::try_stream;
use async_trait::async_trait;
use futures::StreamExt;
use harness_core::{
    ChatRequest, ChatResponse, Error, FinishReason, LlmChunk, LlmProvider, LlmStream, Message,
    Result, TokenEstimator, ToolCall, ToolSpec, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::debug;

use crate::tokens::TiktokenEstimator;

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

#[derive(Debug, Clone)]
pub struct GoogleConfig {
    pub api_key: String,
    pub base_url: String,
}

impl GoogleConfig {
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

pub struct GoogleProvider {
    cfg: GoogleConfig,
    http: reqwest::Client,
}

impl GoogleProvider {
    pub fn new(cfg: GoogleConfig) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn with_client(cfg: GoogleConfig, http: reqwest::Client) -> Self {
        Self { cfg, http }
    }

    fn endpoint(&self, model: &str) -> String {
        format!(
            "{}/models/{}:generateContent?key={}",
            self.cfg.base_url, model, self.cfg.api_key
        )
    }

    fn stream_endpoint(&self, model: &str) -> String {
        format!(
            "{}/models/{}:streamGenerateContent?alt=sse&key={}",
            self.cfg.base_url, model, self.cfg.api_key
        )
    }
}

#[async_trait]
impl LlmProvider for GoogleProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let body = GoogleRequest::from_request(&req);
        let url = self.endpoint(&req.model);
        debug!(model = %req.model, "google request");

        let resp = self
            .http
            .post(&url)
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

        let parsed: GoogleResponse = serde_json::from_str(&text)
            .map_err(|e| Error::Provider(format!("decode: {e}; body={text}")))?;

        parsed.into_chat_response()
    }

    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> {
        let body = GoogleRequest::from_request(&req);
        let url = self.stream_endpoint(&req.model);
        debug!(model = %req.model, "google stream request");

        let resp = self
            .http
            .post(&url)
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
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        let response: GoogleResponse = serde_json::from_str(data).map_err(|e| {
                            Error::Provider(format!("decode chunk: {e}; raw={data}"))
                        })?;
                        for ch in acc.ingest(response) {
                            yield ch;
                        }
                    }
                }
            }

            // Gemini has no `[DONE]` / `message_stop` sentinel; the
            // server simply closes the body. Synthesise the terminal
            // `Finish` from whatever we collected. `finalise()` may
            // also yield a leading `Usage` chunk first.
            if !acc.finished {
                for chunk in acc.finalise() {
                    yield chunk;
                }
            }
        };

        Ok(Box::pin(s))
    }

    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        // Gemini's BPE is closer to GPT's `cl100k_base` than to chars/4;
        // a 10 % safety margin absorbs the rest. The exact answer is
        // the async `countTokens` REST endpoint, but a per-compaction
        // round trip isn't worth the latency.
        Arc::new(TiktokenEstimator::cl100k().with_safety_margin(0.10))
    }
}

// ---------- Wire types ----------

#[derive(Debug, Serialize)]
struct GoogleRequest {
    contents: Vec<GeContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "systemInstruction")]
    system_instruction: Option<GeContent>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<GeTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "generationConfig")]
    generation_config: Option<GeGenerationConfig>,
}

#[derive(Debug, Serialize)]
struct GeContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
    parts: Vec<GePart>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum GePart {
    Text {
        text: String,
    },
    FunctionCall {
        #[serde(rename = "functionCall")]
        function_call: GeFunctionCall,
    },
    FunctionResponse {
        #[serde(rename = "functionResponse")]
        function_response: GeFunctionResponse,
    },
}

#[derive(Debug, Serialize)]
struct GeFunctionCall {
    name: String,
    args: Value,
}

#[derive(Debug, Serialize)]
struct GeFunctionResponse {
    name: String,
    response: Value,
}

#[derive(Debug, Serialize)]
struct GeTool {
    #[serde(rename = "functionDeclarations")]
    function_declarations: Vec<GeFunctionDeclaration>,
}

#[derive(Debug, Serialize)]
struct GeFunctionDeclaration {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Debug, Serialize, Default)]
struct GeGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: Option<u32>,
}

impl GoogleRequest {
    fn from_request(r: &ChatRequest) -> Self {
        // Walk the harness messages once, accumulating systems + a name
        // lookup for tool result conversion, then a second pass builds
        // the contents array.
        let mut system_text = String::new();
        let mut id_to_name: HashMap<&str, &str> = HashMap::new();
        for m in &r.messages {
            match m {
                Message::System { content, .. } => {
                    if !system_text.is_empty() {
                        system_text.push_str("\n\n");
                    }
                    system_text.push_str(content);
                }
                Message::Assistant { tool_calls, .. } => {
                    for tc in tool_calls {
                        id_to_name.insert(tc.id.as_str(), tc.name.as_str());
                    }
                }
                _ => {}
            }
        }

        let mut contents: Vec<GeContent> = Vec::new();
        for m in &r.messages {
            match m {
                Message::System { .. } => {}
                Message::User { content, .. } => contents.push(GeContent {
                    role: Some("user"),
                    parts: vec![GePart::Text {
                        text: content.clone(),
                    }],
                }),
                Message::Assistant {
                    content,
                    tool_calls,
                    reasoning_content: _,
                    ..
                } => {
                    let mut parts: Vec<GePart> = Vec::new();
                    if let Some(text) = content {
                        if !text.is_empty() {
                            parts.push(GePart::Text { text: text.clone() });
                        }
                    }
                    for tc in tool_calls {
                        parts.push(GePart::FunctionCall {
                            function_call: GeFunctionCall {
                                name: tc.name.clone(),
                                args: tc.arguments.clone(),
                            },
                        });
                    }
                    if parts.is_empty() {
                        // Empty model turn — Gemini rejects; emit "" so
                        // we round-trip without panicking.
                        parts.push(GePart::Text {
                            text: String::new(),
                        });
                    }
                    contents.push(GeContent {
                        role: Some("model"),
                        parts,
                    });
                }
                Message::Tool {
                    tool_call_id,
                    content,
                    ..
                } => {
                    let name = id_to_name
                        .get(tool_call_id.as_str())
                        .copied()
                        .unwrap_or(tool_call_id.as_str())
                        .to_string();
                    let part = GePart::FunctionResponse {
                        function_response: GeFunctionResponse {
                            name,
                            // Gemini expects an object; wrap raw text so
                            // the model can read it via `.result`.
                            response: json!({ "result": content }),
                        },
                    };
                    // Fold consecutive tool replies into a single user
                    // message so the model sees the natural grouping.
                    if let Some(last) = contents.last_mut() {
                        if last.role == Some("user")
                            && last
                                .parts
                                .iter()
                                .all(|p| matches!(p, GePart::FunctionResponse { .. }))
                        {
                            last.parts.push(part);
                            continue;
                        }
                    }
                    contents.push(GeContent {
                        role: Some("user"),
                        parts: vec![part],
                    });
                }
            }
        }

        let system_instruction = (!system_text.is_empty()).then(|| GeContent {
            role: None,
            parts: vec![GePart::Text { text: system_text }],
        });

        let tools = if r.tools.is_empty() {
            Vec::new()
        } else {
            vec![GeTool {
                function_declarations: r
                    .tools
                    .iter()
                    .cloned()
                    .map(GeFunctionDeclaration::from)
                    .collect(),
            }]
        };

        let generation_config = if r.temperature.is_some() || r.max_tokens.is_some() {
            Some(GeGenerationConfig {
                temperature: r.temperature,
                max_output_tokens: r.max_tokens,
            })
        } else {
            None
        };

        GoogleRequest {
            contents,
            system_instruction,
            tools,
            generation_config,
        }
    }
}

impl From<ToolSpec> for GeFunctionDeclaration {
    fn from(t: ToolSpec) -> Self {
        GeFunctionDeclaration {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }
    }
}

// ---------- Response ----------

#[derive(Debug, Deserialize)]
struct GoogleResponse {
    #[serde(default)]
    candidates: Vec<GeCandidate>,
    /// Token accounting for this slice. Gemini ships rolling totals
    /// on every SSE chunk and a final authoritative roll-up just
    /// before the body closes, so the accumulator keeps the latest
    /// non-null observation.
    #[serde(default, rename = "usageMetadata")]
    usage_metadata: Option<GeUsageMetadata>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct GeUsageMetadata {
    #[serde(default, rename = "promptTokenCount")]
    prompt_token_count: Option<u32>,
    #[serde(default, rename = "candidatesTokenCount")]
    candidates_token_count: Option<u32>,
    /// Tokens served from `cachedContents` resources. Gemini reports
    /// this only when a cached prefix is wired in.
    #[serde(default, rename = "cachedContentTokenCount")]
    cached_content_token_count: Option<u32>,
    /// Reasoning surface ("thinking" tokens) on the 2.0 / 2.5 models.
    #[serde(default, rename = "thoughtsTokenCount")]
    thoughts_token_count: Option<u32>,
}

impl GeUsageMetadata {
    fn into_core(self) -> Usage {
        Usage {
            prompt_tokens: self.prompt_token_count,
            completion_tokens: self.candidates_token_count,
            cached_prompt_tokens: self.cached_content_token_count,
            reasoning_tokens: self.thoughts_token_count,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GeCandidate {
    content: GeResponseContent,
    #[serde(default)]
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeResponseContent {
    #[serde(default)]
    parts: Vec<GeResponsePart>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum GeResponsePart {
    FunctionCall {
        #[serde(rename = "functionCall")]
        function_call: GeFunctionCallIn,
    },
    Text {
        text: String,
    },
    /// Forward-compatible catch-all. Untagged enums try variants in
    /// order, so this sink swallows anything that didn't match the
    /// named ones rather than failing the whole turn. `IgnoredAny`
    /// drops the data on deserialise so we don't pay for it.
    Other(serde::de::IgnoredAny),
}

#[derive(Debug, Deserialize)]
struct GeFunctionCallIn {
    name: String,
    #[serde(default)]
    args: Value,
}

impl GoogleResponse {
    fn into_chat_response(mut self) -> Result<ChatResponse> {
        let candidate = self
            .candidates
            .pop()
            .ok_or_else(|| Error::Provider("response had no candidates".into()))?;

        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        for part in candidate.content.parts {
            match part {
                GeResponsePart::Text { text: t } => text.push_str(&t),
                GeResponsePart::FunctionCall { function_call } => {
                    let args = if function_call.args.is_null() {
                        Value::Object(Default::default())
                    } else {
                        function_call.args
                    };
                    let id = format!("gem_{}", tool_calls.len());
                    tool_calls.push(ToolCall {
                        id,
                        name: function_call.name,
                        arguments: args,
                    });
                }
                GeResponsePart::Other(_) => {}
            }
        }
        let content = if text.is_empty() { None } else { Some(text) };
        let finish_reason = map_finish_reason(candidate.finish_reason.as_deref(), &tool_calls);

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

fn map_finish_reason(raw: Option<&str>, tool_calls: &[ToolCall]) -> FinishReason {
    match raw {
        Some("STOP") => FinishReason::Stop,
        Some("MAX_TOKENS") => FinishReason::Length,
        Some(other) => FinishReason::Other(other.to_string()),
        None if !tool_calls.is_empty() => FinishReason::ToolCalls,
        None => FinishReason::Stop,
    }
}

// ---------- streaming accumulator ----------

/// Reassemble a Gemini SSE stream into the harness `LlmChunk` shape.
///
/// Gemini ships full `GenerateContentResponse` slices on each event,
/// not delta envelopes. Text parts are incremental (concatenate);
/// `functionCall` parts arrive whole, so we add them to the running
/// list and emit a `ToolCallDelta` carrying both id and name (no
/// `arguments_fragment`, since Gemini sent the args complete). The
/// terminal `Finish` is synthesised from accumulated state once the
/// HTTP body closes — Gemini has no in-band sentinel.
#[derive(Default)]
struct StreamAccumulator {
    text: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    finished: bool,
    /// Latest non-null `usageMetadata` snapshot. Gemini sends rolling
    /// totals on every chunk; we keep the freshest one and emit it
    /// once from `finalise` so consumers see exactly one
    /// `LlmChunk::Usage` per call.
    usage: Option<GeUsageMetadata>,
}

impl StreamAccumulator {
    fn ingest(&mut self, chunk: GoogleResponse) -> Vec<LlmChunk> {
        let mut out = Vec::new();
        if let Some(u) = chunk.usage_metadata {
            self.usage = Some(u);
        }
        for candidate in chunk.candidates {
            for part in candidate.content.parts {
                match part {
                    GeResponsePart::Text { text } => {
                        if !text.is_empty() {
                            self.text.push_str(&text);
                            out.push(LlmChunk::ContentDelta(text));
                        }
                    }
                    GeResponsePart::FunctionCall { function_call } => {
                        let args = if function_call.args.is_null() {
                            Value::Object(Default::default())
                        } else {
                            function_call.args
                        };
                        let index = self.tool_calls.len();
                        let id = format!("gem_{index}");
                        out.push(LlmChunk::ToolCallDelta {
                            index,
                            id: Some(id.clone()),
                            name: Some(function_call.name.clone()),
                            arguments_fragment: None,
                        });
                        self.tool_calls.push(ToolCall {
                            id,
                            name: function_call.name,
                            arguments: args,
                        });
                    }
                    GeResponsePart::Other(_) => {}
                }
            }
            if let Some(reason) = candidate.finish_reason {
                self.finish_reason = Some(reason);
            }
        }
        out
    }

    /// `finalise()` returns an iterator of chunks instead of one so
    /// the caller can yield Usage *before* Finish. Existing call
    /// sites (single-`yield acc.finalise()`) get a vec to flatten.
    fn finalise(&mut self) -> Vec<LlmChunk> {
        self.finished = true;
        let mut out = Vec::with_capacity(2);
        if let Some(u) = self.usage.take() {
            out.push(LlmChunk::Usage(u.into_core()));
        }
        let tool_calls = std::mem::take(&mut self.tool_calls);
        let finish_reason = map_finish_reason(self.finish_reason.as_deref(), &tool_calls);
        let content = if self.text.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.text))
        };
        out.push(LlmChunk::Finish {
            message: Message::Assistant {
                content,
                tool_calls,
                reasoning_content: None,
                cache: None,
            },
            finish_reason,
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req_with(messages: Vec<Message>) -> ChatRequest {
        ChatRequest {
            model: "gemini-1.5-pro".into(),
            messages,
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
        }
    }

    fn body_value(req: &GoogleRequest) -> Value {
        serde_json::to_value(req).unwrap()
    }

    #[test]
    fn convert_pulls_system_to_system_instruction() {
        let r = req_with(vec![Message::system("you are jarvis"), Message::user("hi")]);
        let body = GoogleRequest::from_request(&r);
        let v = body_value(&body);
        assert_eq!(v["systemInstruction"]["parts"][0]["text"], "you are jarvis");
        assert_eq!(v["contents"].as_array().unwrap().len(), 1);
        assert_eq!(v["contents"][0]["role"], "user");
    }

    #[test]
    fn convert_uses_model_role_for_assistant() {
        let r = req_with(vec![Message::user("hi"), Message::assistant_text("hello")]);
        let body = GoogleRequest::from_request(&r);
        let v = body_value(&body);
        assert_eq!(v["contents"][1]["role"], "model");
        assert_eq!(v["contents"][1]["parts"][0]["text"], "hello");
    }

    #[test]
    fn convert_assistant_tool_calls_to_function_call_parts() {
        let r = req_with(vec![
            Message::user("ask"),
            Message::Assistant {
                content: Some("sure".into()),
                tool_calls: vec![ToolCall {
                    id: "id_1".into(),
                    name: "echo".into(),
                    arguments: json!({"text": "hi"}),
                }],
                reasoning_content: None,
            cache: None,
            },
        ]);
        let body = GoogleRequest::from_request(&r);
        let v = body_value(&body);
        let parts = v["contents"][1]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], "sure");
        assert_eq!(parts[1]["functionCall"]["name"], "echo");
        assert_eq!(parts[1]["functionCall"]["args"]["text"], "hi");
    }

    #[test]
    fn convert_tool_results_resolve_name_via_lookup() {
        let r = req_with(vec![
            Message::user("ask"),
            Message::Assistant {
                content: None,
                tool_calls: vec![ToolCall {
                    id: "abc".into(),
                    name: "echo".into(),
                    arguments: json!({}),
                }],
                reasoning_content: None,
            cache: None,
            },
            Message::tool_result("abc", "got it"),
        ]);
        let body = GoogleRequest::from_request(&r);
        let v = body_value(&body);
        let parts = v["contents"][2]["parts"].as_array().unwrap();
        assert_eq!(v["contents"][2]["role"], "user");
        assert_eq!(parts[0]["functionResponse"]["name"], "echo");
        assert_eq!(parts[0]["functionResponse"]["response"]["result"], "got it");
    }

    #[test]
    fn convert_coalesces_consecutive_tool_results() {
        let r = req_with(vec![
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
        ]);
        let body = GoogleRequest::from_request(&r);
        let v = body_value(&body);
        // user, model, user (with two functionResponse parts)
        let contents = v["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        let parts = contents[2]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["functionResponse"]["name"], "x");
        assert_eq!(parts[1]["functionResponse"]["name"], "y");
    }

    #[test]
    fn response_decodes_text_and_function_call() {
        let raw = json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "text": "thinking..." },
                        { "functionCall": { "name": "echo", "args": { "text": "hi" } } }
                    ]
                },
                "finishReason": "STOP"
            }]
        });
        let parsed: GoogleResponse = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response().unwrap();
        match resp.message {
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content: _,
            cache: None,
            } => {
                assert_eq!(content.as_deref(), Some("thinking..."));
                assert_eq!(tool_calls.len(), 1);
                // Synthesised id format.
                assert!(tool_calls[0].id.starts_with("gem_"));
                assert_eq!(tool_calls[0].name, "echo");
                assert_eq!(tool_calls[0].arguments, json!({ "text": "hi" }));
            }
            _ => panic!("expected assistant"),
        }
        // STOP + tool_calls present → ToolCalls (we prefer the more
        // useful state because the agent loop dispatches off tool_calls).
        // Actually mapping says STOP → Stop verbatim. That's correct
        // because Gemini sets finishReason=STOP when the model just
        // happens to end with tool calls; the loop notices tool_calls
        // and dispatches anyway.
        assert!(matches!(resp.finish_reason, FinishReason::Stop));
    }

    #[test]
    fn response_no_finish_reason_with_tool_calls_maps_to_tool_calls() {
        let raw = json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "functionCall": { "name": "echo", "args": {} } }
                    ]
                }
            }]
        });
        let parsed: GoogleResponse = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response().unwrap();
        assert!(matches!(resp.finish_reason, FinishReason::ToolCalls));
    }

    #[test]
    fn response_max_tokens_maps_to_length() {
        let raw = json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{"text":"truncated"}] },
                "finishReason": "MAX_TOKENS"
            }]
        });
        let parsed: GoogleResponse = serde_json::from_value(raw).unwrap();
        let resp = parsed.into_chat_response().unwrap();
        assert!(matches!(resp.finish_reason, FinishReason::Length));
    }

    #[test]
    fn empty_candidates_errors() {
        let raw = json!({ "candidates": [] });
        let parsed: GoogleResponse = serde_json::from_value(raw).unwrap();
        let err = parsed.into_chat_response().unwrap_err();
        assert!(err.to_string().contains("no candidates"));
    }

    // ---------- streaming ----------

    fn parse_chunk(v: serde_json::Value) -> GoogleResponse {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn stream_accumulates_text_chunks() {
        let mut acc = StreamAccumulator::default();
        let r1 = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{"text": "Hel"}] }
            }]
        })));
        let r2 = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{"text": "lo"}] }
            }]
        })));
        let r3 = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{"text": " world"}] },
                "finishReason": "STOP"
            }]
        })));

        assert!(matches!(r1.as_slice(), [LlmChunk::ContentDelta(s)] if s == "Hel"));
        assert!(matches!(r2.as_slice(), [LlmChunk::ContentDelta(s)] if s == "lo"));
        assert!(matches!(r3.as_slice(), [LlmChunk::ContentDelta(s)] if s == " world"));

        let finish = acc.finalise().into_iter().last().unwrap();
        match finish {
            LlmChunk::Finish {
                message,
                finish_reason,
            } => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls,
                        reasoning_content: _,
                    cache: None,
                    } => {
                        assert_eq!(content.as_deref(), Some("Hello world"));
                        assert!(tool_calls.is_empty());
                    }
                    _ => panic!("expected assistant"),
                }
            }
            _ => panic!("expected finish"),
        }
    }

    #[test]
    fn stream_captures_function_call_in_one_chunk() {
        let mut acc = StreamAccumulator::default();
        let r = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "functionCall": { "name": "echo", "args": { "text": "hi" } } }
                    ]
                }
            }]
        })));
        // Gemini delivers the call whole — one ToolCallDelta carrying
        // id and name but no arguments_fragment.
        match r.as_slice() {
            [LlmChunk::ToolCallDelta {
                index,
                id,
                name,
                arguments_fragment,
            }] => {
                assert_eq!(*index, 0);
                assert!(id.as_deref().unwrap().starts_with("gem_"));
                assert_eq!(name.as_deref(), Some("echo"));
                assert!(arguments_fragment.is_none());
            }
            other => panic!("unexpected: {other:?}"),
        }

        let finish = acc.finalise().into_iter().last().unwrap();
        match finish {
            LlmChunk::Finish {
                message,
                finish_reason,
            } => {
                assert!(matches!(finish_reason, FinishReason::ToolCalls));
                match message {
                    Message::Assistant { tool_calls, .. } => {
                        assert_eq!(tool_calls.len(), 1);
                        assert_eq!(tool_calls[0].name, "echo");
                        assert_eq!(tool_calls[0].arguments, json!({"text":"hi"}));
                    }
                    _ => panic!("expected assistant"),
                }
            }
            _ => panic!("expected finish"),
        }
    }

    #[test]
    fn stream_handles_mixed_text_and_function_call() {
        let mut acc = StreamAccumulator::default();
        let _ = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": { "role": "model", "parts": [{"text": "thinking..."}] }
            }]
        })));
        let _ = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "functionCall": { "name": "echo", "args": {} } }
                    ]
                },
                "finishReason": "STOP"
            }]
        })));

        let finish = acc.finalise().into_iter().last().unwrap();
        match finish {
            LlmChunk::Finish {
                message,
                finish_reason,
            } => {
                // STOP is preserved verbatim — the agent loop dispatches
                // off `tool_calls` regardless of finish_reason for
                // ToolCalls vs Stop.
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls,
                        reasoning_content: _,
                    cache: None,
                    } => {
                        assert_eq!(content.as_deref(), Some("thinking..."));
                        assert_eq!(tool_calls.len(), 1);
                    }
                    _ => panic!("expected assistant"),
                }
            }
            _ => panic!("expected finish"),
        }
    }

    #[test]
    fn stream_empty_finalises_to_stop() {
        let mut acc = StreamAccumulator::default();
        let finish = acc.finalise().into_iter().last().unwrap();
        match finish {
            LlmChunk::Finish {
                message,
                finish_reason,
            } => {
                assert!(matches!(finish_reason, FinishReason::Stop));
                match message {
                    Message::Assistant {
                        content,
                        tool_calls,
                        reasoning_content: _,
                    cache: None,
                    } => {
                        assert!(content.is_none());
                        assert!(tool_calls.is_empty());
                    }
                    _ => panic!("expected assistant"),
                }
            }
            _ => panic!("expected finish"),
        }
    }

    #[test]
    fn stream_ignores_unknown_part_types() {
        let mut acc = StreamAccumulator::default();
        let r = acc.ingest(parse_chunk(json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [
                        { "futureFeature": "should not break" },
                        { "text": "real" }
                    ]
                }
            }]
        })));
        // Unknown part dropped, text part survives.
        assert!(matches!(r.as_slice(), [LlmChunk::ContentDelta(s)] if s == "real"));
    }
}
