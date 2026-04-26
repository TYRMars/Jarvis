//! `jarvis login` — OAuth flows for providers that need them.
//!
//! Today this means **Codex**: ChatGPT subscription auth via the
//! `auth.openai.com` PKCE OAuth endpoint, written to
//! `<config>/auth/codex.json` in the same shape the official Codex
//! CLI uses (so the file is interchangeable between the two CLIs if
//! anyone wants to migrate). Two variants:
//!
//! - **Browser** (default) — opens the system browser, listens on
//!   `127.0.0.1:1455` for the callback, exchanges the auth code for
//!   tokens. Same flow as `codex login`. Requires a desktop session.
//! - **Device code** (`--device-code`) — prints a short user code +
//!   verification URL; the user opens that on any device, enters the
//!   code, and we poll the token endpoint until they finish. Suited
//!   for SSH / CI / no-browser environments.
//!
//! Other providers (`openai`, `anthropic`, `google`) don't have OAuth
//! today — `jarvis login --provider openai` falls back to prompting
//! for an API key, which is what `jarvis init` would do anyway.

use std::collections::HashMap;
use std::io::Write as _;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use dialoguer::{theme::ColorfulTheme, Input, Password};
use std::io::IsTerminal;
use std::io::Read as _;
use rand::RngCore;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::auth_store;
use crate::config::Config;
use crate::init::default_model_for;

/// Same client_id the Codex CLI uses. We're extending the same
/// session, not impersonating a different OAuth client; refresh
/// tokens issued by this id only work when refreshed under it.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const SCOPES: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
/// Loopback redirect — port 1455 matches the Codex CLI so the
/// OAuth client config on the issuer side already accepts it.
const LOOPBACK_PORT: u16 = 1455;
const LOOPBACK_PATH: &str = "/auth/callback";

pub async fn run(
    provider: Option<String>,
    key: Option<String>,
    device_code: bool,
    no_set_default: bool,
) -> Result<()> {
    let provider = provider.unwrap_or_else(|| "codex".to_string());
    match provider.as_str() {
        "codex" => {
            if key.is_some() {
                bail!("--key is for API-key providers; use `jarvis login --provider codex` for OAuth");
            }
            if device_code {
                login_codex_device_code().await?;
            } else {
                login_codex_browser().await?;
            }
        }
        "openai" | "openai-responses" | "anthropic" | "google" | "kimi" | "moonshot"
        | "kimi-code" => {
            login_api_key(&provider, key)?;
        }
        other => bail!(
            "`jarvis login --provider {other}` is not supported. \
             Try one of: openai, openai-responses, anthropic, google, codex, kimi, kimi-code."
        ),
    }

    // Auth's on disk; now make sure `jarvis serve` actually picks
    // this provider next time. Without this step the user lands
    // on a confusing error (`no OPENAI_API_KEY...`) because the
    // config still defaults to `openai`.
    if !no_set_default {
        match set_default_provider(&provider) {
            Ok(path) => {
                eprintln!(
                    "✓ Set `{provider}` as default provider in {}",
                    path.display()
                );
                eprintln!("  Run `jarvis serve` (or just `jarvis`) to start the server.");
            }
            Err(e) => {
                // Don't fail the whole login on a config-write
                // hiccup — auth is the bigger lift; the operator
                // can still set JARVIS_PROVIDER manually.
                eprintln!("⚠ Couldn't update config.toml ({e}).");
                eprintln!(
                    "  Run with `JARVIS_PROVIDER={provider} jarvis serve`, \
                     or edit ~/.config/jarvis/config.toml to set \
                     [provider].name = \"{provider}\"."
                );
            }
        }
    }
    Ok(())
}

/// Read `<config>/config.json` (or default), set
/// `default_provider`, ensure the provider's section exists with
/// `enabled = true` and a `default_model`, write back atomically.
/// Returns the path written.
fn set_default_provider(provider: &str) -> Result<std::path::PathBuf> {
    use crate::config::ProviderConfig;
    use crate::init::model_choices_for;

    let path = auth_store::config_file()?;
    let mut cfg = if path.is_file() {
        Config::load_from_path(&path)
            .with_context(|| format!("read existing {}", path.display()))?
    } else {
        Config::default()
    };
    cfg.default_provider = Some(provider.to_string());
    let entry = cfg
        .providers
        .entry(provider.to_string())
        .or_insert_with(ProviderConfig::default);
    entry.enabled = true;
    if entry.default_model.is_none() {
        entry.default_model = Some(default_model_for(provider).to_string());
    }
    if entry.models.is_empty() {
        entry.models = model_choices_for(provider)
            .iter()
            .map(|s| (*s).to_string())
            .collect();
    }
    let text = cfg
        .to_json_string()
        .context("serialize config.json")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("rename onto {}", path.display()))?;
    Ok(path)
}

/// `--provider openai|...` just stores an API key. Three input
/// modes, in priority order:
///
/// 1. `--key <KEY>` flag (handy for scripts; lands in shell history)
/// 2. stdin if it's piped (`echo "sk-..." | jarvis login --provider X`)
/// 3. Interactive prompt — `Input` (visible) when stdout is a TTY,
///    so users actually see what they're typing/pasting. Some
///    terminals + IME combinations swallow input to dialoguer's
///    `Password` widget, which is why we don't default to hidden.
///
/// Falls back to the same auth-store layout `jarvis init` uses so
/// the two commands stay consistent for re-keying.
fn login_api_key(provider: &str, cli_key: Option<String>) -> Result<()> {
    let env_var = match provider {
        "openai" | "openai-responses" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "google" => "GOOGLE_API_KEY",
        "kimi" | "moonshot" => "KIMI_API_KEY",
        "kimi-code" => "KIMI_CODE_API_KEY",
        _ => unreachable!(),
    };
    let key = if let Some(k) = cli_key {
        k
    } else if !std::io::stdin().is_terminal() {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("read key from stdin")?;
        buf
    } else {
        prompt_for_key(env_var)?
    };
    let key = key.trim().to_string();
    if key.is_empty() {
        bail!("empty key — refusing to write");
    }
    // Use canonical provider name for the auth file so
    // `openai-responses` shares with `openai`.
    let canonical = match provider {
        "openai-responses" => "openai",
        "moonshot" => "kimi", // both alias to one auth file
        other => other,
    };
    let path = auth_store::save_api_key(canonical, &key)?;
    eprintln!("✓ Stored {env_var} in {} (mode 0600 on unix)", path.display());
    Ok(())
}

/// Interactive prompt for an API key. Defaults to a **visible**
/// input (so paste / IME / Chinese terminals don't silently swallow
/// keystrokes), with an opt-in hidden mode confirmed by the user
/// when they don't want the value rendered.
fn prompt_for_key(env_var: &str) -> Result<String> {
    let theme = ColorfulTheme::default();
    eprintln!(
        "Tip: paste or type your key after the prompt. \
         Press Enter when done. To pipe instead: \
         `echo \"<key>\" | jarvis login --provider <name>`."
    );
    // Visible by default — Password (hidden) is what tripped users
    // up before. If the user really wants no echo, they can pipe.
    let key: String = Input::with_theme(&theme)
        .with_prompt(format!("Enter {env_var}"))
        .allow_empty(false)
        .interact_text()
        .or_else(|_| {
            // If the visible Input fails for some reason (no TTY
            // detection edge case), fall back to Password.
            Password::with_theme(&theme)
                .with_prompt(format!("Enter {env_var} (hidden)"))
                .interact()
                .context("api key prompt")
        })?;
    Ok(key)
}

// ---------- Codex: browser PKCE flow ----------

async fn login_codex_browser() -> Result<()> {
    let pkce = Pkce::generate();
    let state = random_url_safe(32);
    let redirect = format!("http://localhost:{LOOPBACK_PORT}{LOOPBACK_PATH}");

    let listener = TcpListener::bind(format!("127.0.0.1:{LOOPBACK_PORT}"))
        .await
        .with_context(|| {
            format!(
                "bind 127.0.0.1:{LOOPBACK_PORT} for OAuth callback. \
                 Is another `codex login` already running?"
            )
        })?;

    let url = build_authorize_url(&pkce.challenge, &state, &redirect)?;

    eprintln!("Opening browser to authorize Jarvis with ChatGPT...");
    eprintln!("If your browser didn't open, visit:\n  {url}");
    let _ = open::that(&url); // best-effort; falls back to the printed URL

    let callback = match wait_for_callback(listener, &state).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("✗ {e}");
            bail!("OAuth callback failed");
        }
    };

    eprintln!("Exchanging authorization code for tokens...");
    let http = reqwest::Client::new();
    let tokens = exchange_code(&http, &callback.code, &pkce.verifier, &redirect).await?;

    let path = persist_codex_tokens(&tokens)?;
    eprintln!("✓ Logged in. Wrote {}", path.display());
    if let Some(account) = &tokens.account_id_from_id_token() {
        eprintln!("  Account: {account}");
    }
    eprintln!("\nRun `jarvis serve` (or just `jarvis`) to start the server.");
    Ok(())
}

// ---------- Codex: device-code flow ----------

async fn login_codex_device_code() -> Result<()> {
    let http = reqwest::Client::new();

    eprintln!("Requesting device code...");
    let dc: DeviceCodeResponse = http
        .post(format!("{ISSUER}/oauth/device/code"))
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPES)])
        .send()
        .await
        .context("device-code transport")?
        .error_for_status()
        .context("device-code request")?
        .json()
        .await
        .context("device-code decode")?;

    eprintln!();
    eprintln!("On any device, visit:");
    eprintln!(
        "  {}",
        dc.verification_uri_complete
            .clone()
            .unwrap_or_else(|| dc.verification_uri.clone())
    );
    eprintln!();
    eprintln!("And enter the code:");
    eprintln!("  {}", dc.user_code);
    eprintln!();
    eprintln!("Waiting for you to complete the flow (expires in {}s)...", dc.expires_in);

    let mut interval = Duration::from_secs(dc.interval.max(1) as u64);
    let deadline = std::time::Instant::now() + Duration::from_secs(dc.expires_in as u64);
    loop {
        if std::time::Instant::now() >= deadline {
            bail!("device-code flow timed out before you completed it");
        }
        tokio::time::sleep(interval).await;

        let resp = http
            .post(format!("{ISSUER}/oauth/token"))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", CLIENT_ID),
                ("device_code", &dc.device_code),
            ])
            .send()
            .await
            .context("device-code poll transport")?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .context("device-code poll body")?;

        if status.is_success() {
            let tokens: TokenResponse = serde_json::from_str(&body)
                .with_context(|| format!("decode token response: {body}"))?;
            let path = persist_codex_tokens(&tokens)?;
            eprintln!("✓ Logged in. Wrote {}", path.display());
            return Ok(());
        }

        // Standard OAuth device-flow error semantics.
        let err: DeviceCodeErr = serde_json::from_str(&body)
            .unwrap_or(DeviceCodeErr { error: "unknown".into() });
        match err.error.as_str() {
            "authorization_pending" => continue,
            "slow_down" => {
                interval += Duration::from_secs(5);
                continue;
            }
            "expired_token" => bail!("device code expired before login completed"),
            "access_denied" => bail!("login cancelled"),
            other => bail!("device-code poll failed: {other} (status {status}; body {body})"),
        }
    }
}

// ---------- shared OAuth helpers ----------

#[derive(Debug, Clone)]
pub(crate) struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// 32 random bytes → 43-char base64url verifier → SHA-256 →
    /// base64url challenge. RFC 7636 S256 method.
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge_bytes = Sha256::digest(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
        Self { verifier, challenge }
    }
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn build_authorize_url(challenge: &str, state: &str, redirect: &str) -> Result<String> {
    let mut url = Url::parse(&format!("{ISSUER}/oauth/authorize"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("scope", SCOPES)
        .append_pair("redirect_uri", redirect)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.into())
}

#[derive(Debug)]
struct CallbackParams {
    code: String,
    #[allow(dead_code)]
    state: String,
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<CallbackParams> {
    // We accept a single connection — the browser. Any other hits
    // come back with a 404. Practically nobody else can reach
    // 127.0.0.1:1455 while we're listening, but defending against
    // bots probing localhost is cheap.
    loop {
        let (mut stream, _peer) = listener
            .accept()
            .await
            .context("accept on loopback")?;

        let mut buf = vec![0u8; 8192];
        let n = stream
            .read(&mut buf)
            .await
            .context("read OAuth callback request")?;
        let req = String::from_utf8_lossy(&buf[..n]);

        let first = req.lines().next().unwrap_or("");
        let target = first.split_whitespace().nth(1).unwrap_or("/");

        if !target.starts_with(LOOPBACK_PATH) {
            // Not our callback — politely 404 and keep listening.
            let body = b"<html><body><h1>Not the OAuth callback</h1></body></html>";
            let _ = write_response(&mut stream, 404, "text/html; charset=utf-8", body).await;
            continue;
        }

        let url = Url::parse(&format!("http://localhost{target}"))
            .context("parse callback url")?;
        let params: HashMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

        if let Some(err) = params.get("error") {
            let _ = write_response(
                &mut stream,
                400,
                "text/html; charset=utf-8",
                error_page(err).as_bytes(),
            )
            .await;
            bail!("OAuth provider returned error: {err}");
        }

        let code = params
            .get("code")
            .cloned()
            .ok_or_else(|| anyhow!("callback missing `code`"))?;
        let state = params
            .get("state")
            .cloned()
            .ok_or_else(|| anyhow!("callback missing `state`"))?;
        if state != expected_state {
            let _ = write_response(
                &mut stream,
                400,
                "text/html; charset=utf-8",
                error_page("state mismatch (CSRF)").as_bytes(),
            )
            .await;
            bail!("OAuth state mismatch — possible CSRF; aborting");
        }

        let _ = write_response(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            success_page().as_bytes(),
        )
        .await;
        return Ok(CallbackParams { code, state });
    }
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} OK\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(())
}

fn success_page() -> String {
    r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Jarvis login</title>
<style>body{font:14px system-ui,sans-serif;text-align:center;padding:60px 20px;}
h1{color:#22863a;}p{color:#586069;}</style></head>
<body>
<h1>✓ Logged in</h1>
<p>You can close this tab and return to your terminal.</p>
</body></html>"#
        .to_string()
}

fn error_page(error: &str) -> String {
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Jarvis login</title>
<style>body{{font:14px system-ui,sans-serif;text-align:center;padding:60px 20px;}}
h1{{color:#cb2431;}}code{{background:#f6f8fa;padding:2px 4px;border-radius:3px;}}</style></head>
<body>
<h1>✗ Login failed</h1>
<p>The OAuth provider returned: <code>{}</code></p>
<p>Return to your terminal for details.</p>
</body></html>"#,
        html_escape(error)
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ---------- Token exchange ----------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: String,
    #[serde(default)]
    #[allow(dead_code)]
    token_type: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    expires_in: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    scope: Option<String>,
}

impl TokenResponse {
    /// Best-effort: decode the JWT id_token, find
    /// `auth.chatgpt_account_id` (the OpenAI custom claim). Returns
    /// `None` on any parse failure — `account_id` is optional in the
    /// stored auth file anyway.
    fn account_id_from_id_token(&self) -> Option<String> {
        let parts: Vec<&str> = self.id_token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
        let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).ok()?;
        // The custom claim is namespaced.
        let auth = payload.get("https://api.openai.com/auth")?;
        auth.get("chatgpt_account_id")
            .and_then(|v| v.as_str())
            .map(String::from)
    }
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: i64,
    /// Suggested polling interval in seconds. OAuth spec says the
    /// server can ask us to slow down; we honour `slow_down` errors
    /// by adding 5s on top of this.
    #[serde(default = "default_interval")]
    interval: i64,
}

fn default_interval() -> i64 {
    5
}

#[derive(Debug, Deserialize)]
struct DeviceCodeErr {
    error: String,
}

async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let resp = http
        .post(format!("{ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .context("token exchange transport")?;

    let status = resp.status();
    let text = resp.text().await.context("token exchange body")?;
    if !status.is_success() {
        bail!("token exchange failed: status {status}; body {text}");
    }
    let tokens: TokenResponse = serde_json::from_str(&text)
        .with_context(|| format!("decode token response: {text}"))?;
    Ok(tokens)
}

// ---------- Persisting ----------

fn persist_codex_tokens(tokens: &TokenResponse) -> Result<std::path::PathBuf> {
    let path = auth_store::auth_path("codex")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perm = std::fs::Permissions::from_mode(0o700);
            let _ = std::fs::set_permissions(parent, perm);
        }
    }
    let account_id = tokens.account_id_from_id_token();
    let last_refresh = chrono::Utc::now().to_rfc3339();
    let body = serde_json::json!({
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token":      tokens.id_token,
            "access_token":  tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "account_id":    account_id,
        },
        "last_refresh": last_refresh,
    });
    let pretty = serde_json::to_vec_pretty(&body).context("serialize codex auth json")?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(&pretty)
            .with_context(|| format!("write {}", tmp.display()))?;
        f.flush().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&tmp, perm);
    }
    std::fs::rename(&tmp, &path)
        .with_context(|| format!("rename onto {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_is_43_chars_base64url() {
        let p = Pkce::generate();
        assert_eq!(p.verifier.len(), 43, "verifier was {:?}", p.verifier);
        for c in p.verifier.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "non-base64url char {c:?} in verifier"
            );
        }
    }

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let p = Pkce::generate();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expected);
    }

    #[test]
    fn pkce_pairs_differ_each_call() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn authorize_url_carries_required_params() {
        let url = build_authorize_url("CHALLENGE", "STATE", "http://localhost:1455/auth/callback")
            .unwrap();
        assert!(url.starts_with(ISSUER), "got: {url}");
        assert!(url.contains("response_type=code"), "got: {url}");
        assert!(url.contains("code_challenge=CHALLENGE"), "got: {url}");
        assert!(url.contains("code_challenge_method=S256"), "got: {url}");
        assert!(url.contains("state=STATE"), "got: {url}");
        assert!(
            url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"),
            "got: {url}"
        );
        assert!(url.contains(&format!("client_id={CLIENT_ID}")), "got: {url}");
    }

    #[test]
    fn account_id_extraction_from_jwt() {
        // Build a fake JWT: header.payload.sig (sig irrelevant, we
        // only decode the payload). Payload contains the namespaced
        // claim.
        let payload = serde_json::json!({
            "iss": "https://auth.openai.com/",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_test_123",
                "chatgpt_user_id": "user_xyz",
            }
        });
        let payload_b64 = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let jwt = format!("header.{payload_b64}.signature");

        let resp = TokenResponse {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            id_token: jwt,
            token_type: None,
            expires_in: None,
            scope: None,
        };
        assert_eq!(
            resp.account_id_from_id_token().as_deref(),
            Some("acct_test_123")
        );
    }

    /// Override the auth-store config-home so `set_default_provider`
    /// writes into a scratch dir. Holds [`crate::test_env::lock`] so
    /// tests serialise their env mutations.
    struct ConfigHomeGuard {
        saved: Vec<(&'static str, Option<String>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl ConfigHomeGuard {
        fn isolate(home: &std::path::Path) -> Self {
            let lock = crate::test_env::lock();
            let keys = [
                "JARVIS_CONFIG_HOME",
                "XDG_CONFIG_HOME",
                "HOME",
                "APPDATA",
            ];
            let mut saved = Vec::new();
            for k in keys {
                saved.push((k, std::env::var(k).ok()));
            }
            unsafe {
                std::env::set_var("JARVIS_CONFIG_HOME", home);
                std::env::remove_var("XDG_CONFIG_HOME");
                std::env::remove_var("HOME");
                std::env::remove_var("APPDATA");
            }
            ConfigHomeGuard { saved, _lock: lock }
        }
    }
    impl Drop for ConfigHomeGuard {
        fn drop(&mut self) {
            for (k, v) in self.saved.drain(..) {
                unsafe {
                    match v {
                        Some(val) => std::env::set_var(k, val),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    #[test]
    fn set_default_provider_creates_config_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let _g = ConfigHomeGuard::isolate(dir.path());

        let path = set_default_provider("codex").unwrap();
        assert!(path.is_file());

        let cfg = crate::config::Config::load_from_path(&path).unwrap();
        assert_eq!(cfg.default_provider.as_deref(), Some("codex"));
        let codex = cfg.providers.get("codex").expect("codex section");
        assert!(codex.enabled);
        // model defaulted from default_model_for(provider).
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5.4-mini"));
    }

    #[test]
    fn set_default_provider_preserves_existing_config_settings() {
        let dir = tempfile::tempdir().unwrap();
        let _g = ConfigHomeGuard::isolate(dir.path());

        // Pre-seed a config with a custom fs_root and a non-default
        // openai model — set_default_provider must keep both.
        let cfg_path = auth_store::config_file().unwrap();
        std::fs::create_dir_all(cfg_path.parent().unwrap()).unwrap();
        std::fs::write(
            &cfg_path,
            r#"{
                "default_provider": "openai",
                "providers": {
                    "openai": {
                        "enabled": true,
                        "default_model": "gpt-4o-mini"
                    }
                },
                "tools": { "fs_root": "/Users/me/work" }
            }"#,
        )
        .unwrap();

        let _ = set_default_provider("codex").unwrap();

        let cfg = crate::config::Config::load_from_path(&cfg_path).unwrap();
        // Default switched to codex...
        assert_eq!(cfg.default_provider.as_deref(), Some("codex"));
        // ...openai section's preserved with its custom model.
        let openai = cfg.providers.get("openai").expect("openai still present");
        assert_eq!(openai.default_model.as_deref(), Some("gpt-4o-mini"));
        // Other sections untouched.
        assert_eq!(
            cfg.tools.fs_root.as_deref(),
            Some(std::path::Path::new("/Users/me/work"))
        );
    }

    #[test]
    fn account_id_extraction_returns_none_on_garbage() {
        let resp = TokenResponse {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            id_token: "not.a.jwt".into(),
            token_type: None,
            expires_in: None,
            scope: None,
        };
        assert!(resp.account_id_from_id_token().is_none());
    }
}
