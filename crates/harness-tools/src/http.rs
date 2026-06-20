use crate::ssrf::{classify_blocked, SsrfPolicy};
use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde_json::{json, Value};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::Arc;

/// Resolver hook: maps `(host, port)` to a set of IP addresses. Pulled out so
/// the SSRF guard can be exercised in tests without real DNS. The default
/// resolves through the system resolver (`getaddrinfo`).
pub type DnsResolver = Arc<dyn Fn(String, u16) -> Result<Vec<IpAddr>, String> + Send + Sync>;

fn system_resolver() -> DnsResolver {
    Arc::new(|host: String, port: u16| {
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.map(|sa| sa.ip()).collect())
            .map_err(|e| e.to_string())
    })
}

/// Build the default HTTP client. Redirect following is **disabled** so an
/// allowlisted/public host can't 302 the request onto a metadata IP without
/// re-validation — the model sees the 3xx and must decide explicitly.
fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// HTTP client tool. Supports GET and POST; returns status + headers + body
/// as a single string. Response bodies larger than `max_bytes` are
/// truncated with a trailing marker.
///
/// SSRF-guarded: the target URL must be `http`/`https` and must not resolve to
/// a loopback / link-local / private / reserved address (see [`SsrfPolicy`]).
pub struct HttpFetchTool {
    client: reqwest::Client,
    max_bytes: usize,
    ssrf: SsrfPolicy,
    resolver: DnsResolver,
}

impl HttpFetchTool {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            client: default_client(),
            max_bytes,
            ssrf: SsrfPolicy::default(),
            resolver: system_resolver(),
        }
    }

    pub fn with_client(client: reqwest::Client, max_bytes: usize) -> Self {
        Self {
            client,
            max_bytes,
            ssrf: SsrfPolicy::default(),
            resolver: system_resolver(),
        }
    }

    /// Override the SSRF policy (e.g. an operator allowlist, or
    /// [`SsrfPolicy::unrestricted`] to restore the legacy behaviour).
    pub fn with_ssrf_policy(mut self, policy: SsrfPolicy) -> Self {
        self.ssrf = policy;
        self
    }

    /// Inject a DNS resolver (tests).
    pub fn with_resolver(mut self, resolver: DnsResolver) -> Self {
        self.resolver = resolver;
        self
    }

    /// Validate `url` against the SSRF policy. Returns the parsed URL on success
    /// or a human-readable rejection reason. Public so the policy is testable.
    async fn guard_url(&self, url: &str) -> Result<(), BoxError> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|e| -> BoxError { format!("invalid url: {e}").into() })?;

        match parsed.scheme() {
            "http" | "https" => {}
            other => {
                return Err(format!(
                    "blocked: scheme `{other}` is not allowed (only http/https)"
                )
                .into())
            }
        }

        if !self.ssrf.block_private {
            return Ok(());
        }

        let host = parsed
            .host_str()
            .ok_or_else(|| -> BoxError { "blocked: url has no host".into() })?;

        if self.ssrf.is_allowlisted(host) {
            return Ok(());
        }

        // A literal IP in the URL needs no DNS round-trip.
        if let Ok(ip) = host.parse::<IpAddr>() {
            if let Some(reason) = classify_blocked(ip) {
                return Err(format!("blocked: {host} is a {reason}").into());
            }
            return Ok(());
        }

        // Resolve and reject if *any* resolved address is non-public — a host
        // returning a mix of public + private records is treated as hostile.
        let port = parsed.port_or_known_default().unwrap_or(80);
        let resolver = self.resolver.clone();
        let host_owned = host.to_string();
        let addrs = tokio::task::spawn_blocking(move || resolver(host_owned, port))
            .await
            .map_err(|e| -> BoxError { format!("dns resolution task failed: {e}").into() })?
            .map_err(|e| -> BoxError { format!("blocked: cannot resolve {host}: {e}").into() })?;

        if addrs.is_empty() {
            return Err(format!("blocked: {host} did not resolve to any address").into());
        }
        for ip in addrs {
            if let Some(reason) = classify_blocked(ip) {
                return Err(
                    format!("blocked: {host} resolves to {ip}, a {reason}").into(),
                );
            }
        }
        Ok(())
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

    fn category(&self) -> ToolCategory {
        ToolCategory::Network
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let method = args.get("method").and_then(Value::as_str).unwrap_or("GET");
        args.get("url")
            .and_then(Value::as_str)
            .map(|u| format!("{method} {u}"))
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

        // SSRF guard: reject non-http(s) schemes and private/loopback/link-local
        // targets before any network egress happens.
        self.guard_url(url).await?;

        let mut req = self.client.request(method.clone(), url);

        if let Some(hdrs) = args.get("headers").and_then(Value::as_object) {
            let mut map = HeaderMap::new();
            for (k, v) in hdrs {
                let name: HeaderName = k
                    .parse()
                    .map_err(|e| -> BoxError { format!("bad header name `{k}`: {e}").into() })?;
                let val = v.as_str().ok_or_else(|| -> BoxError {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssrf::SsrfPolicy;

    fn tool() -> HttpFetchTool {
        HttpFetchTool::new(1024)
    }

    /// A resolver that maps every host to a fixed set of IPs.
    fn fixed_resolver(ips: &'static [&'static str]) -> DnsResolver {
        Arc::new(move |_host, _port| Ok(ips.iter().map(|s| s.parse().unwrap()).collect()))
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let err = tool().guard_url("file:///etc/passwd").await.unwrap_err();
        assert!(err.to_string().contains("scheme"), "{err}");
    }

    #[tokio::test]
    async fn rejects_literal_metadata_ip() {
        let err = tool()
            .guard_url("http://169.254.169.254/latest/meta-data/")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("link-local"), "{err}");
    }

    #[tokio::test]
    async fn rejects_literal_loopback_and_private() {
        for url in [
            "http://127.0.0.1:7001/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://[::1]/",
        ] {
            assert!(tool().guard_url(url).await.is_err(), "expected {url} blocked");
        }
    }

    #[tokio::test]
    async fn rejects_hostname_resolving_to_private() {
        let t = tool().with_resolver(fixed_resolver(&["10.1.2.3"]));
        let err = t.guard_url("http://intranet.example/").await.unwrap_err();
        assert!(err.to_string().contains("resolves to"), "{err}");
    }

    #[tokio::test]
    async fn allows_hostname_resolving_to_public() {
        let t = tool().with_resolver(fixed_resolver(&["93.184.216.34"]));
        assert!(t.guard_url("http://example.com/").await.is_ok());
    }

    #[tokio::test]
    async fn allowlist_bypasses_private_check() {
        let t = tool()
            .with_ssrf_policy(SsrfPolicy::from_allow_hosts(vec!["intranet.example".into()]))
            .with_resolver(fixed_resolver(&["10.1.2.3"]));
        assert!(t.guard_url("http://intranet.example/").await.is_ok());
    }

    #[tokio::test]
    async fn unrestricted_policy_allows_loopback() {
        let t = tool().with_ssrf_policy(SsrfPolicy::unrestricted());
        assert!(t.guard_url("http://127.0.0.1:7001/").await.is_ok());
    }

    #[tokio::test]
    async fn rejects_mixed_public_and_private_resolution() {
        // A host that returns one public + one private record is hostile
        // (DNS-rebinding style); reject on the private one.
        let t = tool().with_resolver(fixed_resolver(&["93.184.216.34", "169.254.169.254"]));
        assert!(t.guard_url("http://rebind.example/").await.is_err());
    }
}
