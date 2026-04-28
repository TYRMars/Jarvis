//! Text-based human-in-the-loop request tool.
//!
//! `ask.text` is intentionally the single text transport entry point:
//! it can render as confirmation, free-form input, or a short choice
//! list through its `kind` argument. Future modalities can live beside
//! it as `ask.voice`, `ask.video`, etc. while reusing the same native
//! HITL request/response protocol.

use async_trait::async_trait;
use harness_core::{
    request_human, BoxError, HitlKind, HitlOption, HitlRequest, HitlResponse, HitlTransport, Tool,
    ToolCategory,
};
use serde_json::{json, Value};

pub struct AskTextTool;

#[async_trait]
impl Tool for AskTextTool {
    fn name(&self) -> &str {
        "ask.text"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Ask the human operator a text-based question. Use when you need missing information, a confirmation, or a choice instead of guessing."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["input", "confirm", "choice", "review"],
                    "description": "How the text prompt should be rendered. Defaults to input."
                },
                "title": {
                    "type": "string",
                    "description": "Short prompt title."
                },
                "body": {
                    "type": "string",
                    "description": "Optional context, proposed action, or question details."
                },
                "options": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Required for kind=choice. Each string is used as both label and value."
                },
                "default_value": {
                    "type": "string",
                    "description": "Optional prefilled text or default choice value."
                },
                "multiline": {
                    "type": "boolean",
                    "description": "For kind=input, whether a multiline editor is preferred. Defaults to true."
                }
            },
            "required": ["title"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let title = required_string(&args, "title")?;
        let kind = parse_kind(optional_string(&args, "kind").as_deref())?;
        let mut req = HitlRequest::new(kind, title);
        req.transport = HitlTransport::Text;
        req.body = optional_string(&args, "body");
        req.default_value = optional_string(&args, "default_value").map(Value::String);
        req.metadata = Some(json!({
            "tool": "ask.text",
            "multiline": args.get("multiline").and_then(Value::as_bool).unwrap_or(true)
        }));

        if matches!(kind, HitlKind::Choice) {
            req.options = parse_options(&args)?;
        }

        response_json(request_human(req).await?)
    }
}

fn parse_kind(raw: Option<&str>) -> Result<HitlKind, BoxError> {
    match raw.unwrap_or("input") {
        "input" => Ok(HitlKind::Input),
        "confirm" => Ok(HitlKind::Confirm),
        "choice" => Ok(HitlKind::Choice),
        "review" => Ok(HitlKind::Review),
        other => Err(format!("unsupported ask.text kind `{other}`").into()),
    }
}

fn parse_options(args: &Value) -> Result<Vec<HitlOption>, BoxError> {
    let options = args
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| -> BoxError { "`options` must be an array for kind=choice".into() })?;
    let options = options
        .iter()
        .map(|v| {
            let s = v
                .as_str()
                .ok_or_else(|| -> BoxError { "every option must be a string".into() })?;
            Ok(HitlOption {
                value: s.to_string(),
                label: s.to_string(),
            })
        })
        .collect::<Result<Vec<_>, BoxError>>()?;
    if options.is_empty() {
        return Err("`options` must not be empty for kind=choice".into());
    }
    Ok(options)
}

fn response_json(response: HitlResponse) -> Result<String, BoxError> {
    serde_json::to_string(&response).map_err(Into::into)
}

fn required_string(args: &Value, key: &str) -> Result<String, BoxError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("`{key}` must be a non-empty string").into())
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_text_defaults_to_input() {
        assert_eq!(parse_kind(None).unwrap(), HitlKind::Input);
    }

    #[test]
    fn choice_requires_options() {
        let err = parse_options(&json!({ "options": [] })).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn schema_requires_only_title() {
        let tool = AskTextTool;
        let schema = tool.parameters();
        assert_eq!(schema["required"], json!(["title"]));
    }
}
