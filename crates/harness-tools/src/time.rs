use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Tool};
use serde_json::{json, Value};

/// Returns the current UTC time as both a Unix timestamp and an RFC3339
/// string.
pub struct TimeNowTool;

#[async_trait]
impl Tool for TimeNowTool {
    fn name(&self) -> &str {
        "time.now"
    }

    fn description(&self) -> &str {
        "Returns the current UTC time as {unix: <seconds>, iso: <RFC3339>}."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        let now = Utc::now();
        let body = json!({
            "unix": now.timestamp(),
            "iso": now.to_rfc3339(),
        });
        Ok(body.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_both_formats() {
        let s = TimeNowTool.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("unix").and_then(Value::as_i64).is_some());
        assert!(v.get("iso").and_then(Value::as_str).is_some());
    }
}
