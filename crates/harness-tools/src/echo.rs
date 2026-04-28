use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde_json::{json, Value};

/// Trivial echo tool — returns its `text` argument verbatim. Useful for
/// smoke-testing the tool loop end to end.
pub struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }

    fn description(&self) -> &str {
        "Echo the `text` argument back verbatim. Useful for testing the tool loop."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "Text to echo." }
            },
            "required": ["text"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `text` argument".into() })?;
        Ok(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echoes_text() {
        let out = EchoTool.invoke(json!({ "text": "hi" })).await.unwrap();
        assert_eq!(out, "hi");
    }

    #[tokio::test]
    async fn rejects_missing_text() {
        let err = EchoTool.invoke(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("text"));
    }
}
