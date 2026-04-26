use async_trait::async_trait;
use harness_core::{BoxError, Tool};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde_json::{json, Value};

/// HTTP client tool. Supports GET and POST; returns status + headers + body
/// as a single string. Response bodies larger than `max_bytes` are
/// truncated with a trailing marker.
pub struct HttpFetchTool {
    client: reqwest::Client,
    max_bytes: usize,
}

impl HttpFetchTool {
    pub fn new(max_bytes: usize) -> Self {
        Self { client: reqwest::Client::new(), max_bytes }
    }

    pub fn with_client(client: reqwest::Client, max_bytes: usize) -> Self {
        Self { client, max_bytes }
    }
}

#[async_trait]
impl Tool for HttpFetchTool {
    fn name(&self) -> &str {
        "http.fetch"
    }

    fn description(&self) -> &str {
        "Fetch an HTTP(S) URL. Returns status, response headers, and body. \
         Supports GET and POST. Body is truncated if very large."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Absolute http(s) URL." },
                "method": {
                    "type": "string",
                    "enum": ["GET", "POST"],
                    "description": "HTTP method. Defaults to GET."
                },
                "headers": {
                    "type": "object",
                    "description": "Optional request headers.",
                    "additionalProperties": { "type": "string" }
                },
                "body": {
                    "type": "string",
                    "description": "Optional request body (POST only)."
                }
            },
            "required": ["url"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `url` argument".into() })?;

        let method = args
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .to_ascii_uppercase();
        let method: Method = method
            .parse()
            .map_err(|e| -> BoxError { format!("invalid method: {e}").into() })?;

        let mut req = self.client.request(method.clone(), url);

        if let Some(hdrs) = args.get("headers").and_then(Value::as_object) {
            let mut map = HeaderMap::new();
            for (k, v) in hdrs {
                let name: HeaderName = k
                    .parse()
                    .map_err(|e| -> BoxError { format!("bad header name `{k}`: {e}").into() })?;
                let val = v
                    .as_str()
                    .ok_or_else(|| -> BoxError {
                        format!("header `{k}` must be a string").into()
                    })?;
                let val = HeaderValue::from_str(val)
                    .map_err(|e| -> BoxError { format!("bad header value: {e}").into() })?;
                map.insert(name, val);
            }
            req = req.headers(map);
        }

        if method == Method::POST {
            if let Some(body) = args.get("body").and_then(Value::as_str) {
                req = req.body(body.to_string());
            }
        }

        let resp = req.send().await?;
        let status = resp.status();
        let mut headers = String::new();
        for (k, v) in resp.headers().iter() {
            headers.push_str(k.as_str());
            headers.push_str(": ");
            headers.push_str(v.to_str().unwrap_or("<non-ascii>"));
            headers.push('\n');
        }

        let bytes = resp.bytes().await?;
        let (body, truncated) = if bytes.len() > self.max_bytes {
            let slice = &bytes[..self.max_bytes];
            (String::from_utf8_lossy(slice).into_owned(), true)
        } else {
            (String::from_utf8_lossy(&bytes).into_owned(), false)
        };

        let mut out = format!("HTTP {status}\n{headers}\n{body}");
        if truncated {
            out.push_str(&format!(
                "\n\n[... truncated at {} bytes ...]",
                self.max_bytes
            ));
        }
        Ok(out)
    }
}
