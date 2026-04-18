use async_trait::async_trait;
use harness_core::{
    ChatRequest, ChatResponse, Error, FinishReason, LlmProvider, Message, Result, ToolCall,
    ToolSpec,
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
        let body = OpenAiRequest::from(req);
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
}

// ---------- Wire types ----------

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
    /// OpenAI requires arguments as a JSON-encoded string, not an object.
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

impl From<ChatRequest> for OpenAiRequest {
    fn from(r: ChatRequest) -> Self {
        Self {
            model: r.model,
            messages: r.messages.into_iter().map(OaMessage::from).collect(),
            tools: r.tools.into_iter().map(OaTool::from).collect(),
            temperature: r.temperature,
            max_tokens: r.max_tokens,
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
    /// JSON-encoded arguments string.
    arguments: String,
}

impl OpenAiResponse {
    fn into_chat_response(mut self) -> Result<ChatResponse> {
        let choice = self
            .choices
            .pop()
            .ok_or_else(|| Error::Provider("response had no choices".into()))?;

        let tool_calls: Result<Vec<ToolCall>> = choice
            .message
            .tool_calls
            .into_iter()
            .map(|tc| {
                let arguments: Value = if tc.function.arguments.trim().is_empty() {
                    Value::Object(Default::default())
                } else {
                    serde_json::from_str(&tc.function.arguments).map_err(|e| {
                        Error::InvalidArguments {
                            name: tc.function.name.clone(),
                            message: format!("{e}; raw={}", tc.function.arguments),
                        }
                    })?
                };
                Ok(ToolCall { id: tc.id, name: tc.function.name, arguments })
            })
            .collect();
        let tool_calls = tool_calls?;

        let finish_reason = match choice.finish_reason.as_deref() {
            Some("stop") => FinishReason::Stop,
            Some("tool_calls") => FinishReason::ToolCalls,
            Some("length") => FinishReason::Length,
            Some(other) => FinishReason::Other(other.to_string()),
            None if !tool_calls.is_empty() => FinishReason::ToolCalls,
            None => FinishReason::Stop,
        };

        let message = Message::Assistant {
            content: choice.message.content,
            tool_calls,
        };

        Ok(ChatResponse { message, finish_reason })
    }
}
