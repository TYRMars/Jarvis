//! ChatGPT-OAuth credentials for the Codex provider.
//!
//! Two construction paths:
//!
//! - [`CodexAuth::from_static`] — caller supplies a bearer token (and
//!   optional account id) directly. No on-disk state, no refresh
//!   capability. Useful for tests, scripts, and prototyping.
//! - [`CodexAuth::load_from_codex_home`] — reads
//!   `$CODEX_HOME/auth.json`, the file the official `codex` CLI writes
//!   when the user runs `codex login`. Carries the refresh token and
//!   the path so [`refresh`] can rotate the access token in place and
//!   write it back atomically.
//!
//! On a `401 Unauthorized` from the Responses backend the provider
//! locks this struct and calls [`refresh`]. We POST to
//! `https://auth.openai.com/oauth/token` with `grant_type=refresh_token`
//! using the same `client_id` the Codex CLI uses (we are extending the
//! same session, not impersonating a different client). The endpoint
//! can be overridden for tests via `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.
//!
//! `refresh` writes back to disk using a write-then-rename atomic
//! sequence so a crash mid-write doesn't leave the user with a
//! corrupt `auth.json`.

use std::path::{Path, PathBuf};

use harness_core::BoxError;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::debug;

/// OAuth client id used by the Codex CLI for ChatGPT login. We re-use
/// it on refresh so the same session keeps working — registering a
/// distinct client_id would require its own token issuance flow.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

/// Working credentials for the Codex Responses backend. Cheap to clone
/// (it's just a few `String`s) but the provider keeps a single
/// `tokio::sync::Mutex<CodexAuth>` so refresh-on-401 is serialised.
#[derive(Debug, Clone)]
pub struct CodexAuth {
    pub access_token: String,
    /// `None` for static / dev tokens — refresh will fail with a clear
    /// error if attempted.
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
    /// Where the credentials came from; `None` means "in-memory only,
    /// don't write back on refresh".
    persist_path: Option<PathBuf>,
}

impl CodexAuth {
    /// Static token — used when the caller supplies bearer credentials
    /// out-of-band (e.g. `CODEX_ACCESS_TOKEN` env var). No refresh.
    pub fn from_static(access_token: impl Into<String>, account_id: Option<String>) -> Self {
        Self {
            access_token: access_token.into(),
            refresh_token: None,
            account_id,
            persist_path: None,
        }
    }

    /// Read `<codex_home>/auth.json` and pull out the bearer token,
    /// refresh token, and ChatGPT account id. The on-disk format is
    /// the one the Codex CLI writes — we parse permissively and only
    /// require the fields we actually use.
    pub fn load_from_codex_home(codex_home: &Path) -> Result<Self, BoxError> {
        Self::load_from_file(&codex_home.join("auth.json"))
    }

    /// Read an `auth.json`-shaped file at an arbitrary path. Used by
    /// callers (e.g. the `jarvis` binary) that store credentials
    /// outside `~/.codex/`. The persisted-write path on `refresh()`
    /// is set to this same file, so refresh updates land where they
    /// were loaded from.
    pub fn load_from_file(path: &Path) -> Result<Self, BoxError> {
        let bytes = std::fs::read(path)
            .map_err(|e| -> BoxError { format!("read {}: {e}", path.display()).into() })?;
        let value: Value = serde_json::from_str(std::str::from_utf8(&bytes).map_err(
            |e| -> BoxError { format!("auth.json is not utf-8: {e}").into() },
        )?)
        .map_err(|e| -> BoxError { format!("parse auth.json: {e}").into() })?;

        let tokens = value.get("tokens").ok_or_else(|| -> BoxError {
            "auth.json has no `tokens` block; run `jarvis login --provider codex`".into()
        })?;
        let access_token = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "auth.json missing tokens.access_token".into() })?
            .to_string();
        let refresh_token = tokens
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        let account_id = tokens
            .get("account_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(Self {
            access_token,
            refresh_token,
            account_id,
            persist_path: Some(path.to_path_buf()),
        })
    }

    /// POST to `auth.openai.com/oauth/token` with `grant_type=refresh_token`
    /// to rotate the access token. On success, in-memory state and the
    /// on-disk `auth.json` are both updated. Failures bubble up with
    /// the upstream status / body text.
    pub async fn refresh(&mut self, http: &reqwest::Client) -> Result<(), BoxError> {
        let refresh_token = self
            .refresh_token
            .as_deref()
            .ok_or_else(|| -> BoxError {
                "no refresh_token available; static-token mode cannot refresh".into()
            })?;
        let url = std::env::var(REFRESH_TOKEN_URL_OVERRIDE_ENV)
            .unwrap_or_else(|_| REFRESH_TOKEN_URL.to_string());

        debug!(%url, "refreshing codex access token");
        let resp = http
            .post(&url)
            .form(&[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .send()
            .await
            .map_err(|e| -> BoxError { format!("refresh transport: {e}").into() })?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| -> BoxError { format!("refresh read body: {e}").into() })?;
        if !status.is_success() {
            return Err(format!("refresh failed: status {status}: {body}").into());
        }

        let parsed: RefreshResponse = serde_json::from_str(&body)
            .map_err(|e| -> BoxError { format!("decode refresh response: {e}; body={body}").into() })?;

        self.access_token = parsed.access_token;
        if let Some(new_rt) = parsed.refresh_token {
            self.refresh_token = Some(new_rt);
        }

        if let Some(path) = self.persist_path.clone() {
            self.write_back(&path)?;
        }
        Ok(())
    }

    /// Atomic write to `auth.json`: read existing JSON, replace just
    /// the `tokens.access_token` (and `tokens.refresh_token` if it
    /// rotated), write to a sibling `*.tmp` and rename. Preserves any
    /// other fields the Codex CLI may have written
    /// (`auth_mode`, `OPENAI_API_KEY`, `last_refresh`,
    /// `agent_identity`) so we don't trash the user's setup.
    fn write_back(&self, path: &Path) -> Result<(), BoxError> {
        let mut value: Value = match std::fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        };
        let obj = value
            .as_object_mut()
            .ok_or_else(|| -> BoxError { "auth.json is not a JSON object".into() })?;
        let tokens = obj
            .entry("tokens".to_string())
            .or_insert_with(|| json!({}));
        let tokens = tokens
            .as_object_mut()
            .ok_or_else(|| -> BoxError { "auth.json `tokens` is not an object".into() })?;
        tokens.insert(
            "access_token".to_string(),
            Value::String(self.access_token.clone()),
        );
        if let Some(rt) = &self.refresh_token {
            tokens.insert("refresh_token".to_string(), Value::String(rt.clone()));
        }

        let pretty = serde_json::to_vec_pretty(&value)
            .map_err(|e| -> BoxError { format!("serialize auth.json: {e}").into() })?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &pretty)
            .map_err(|e| -> BoxError { format!("write {}: {e}", tmp.display()).into() })?;
        std::fs::rename(&tmp, path)
            .map_err(|e| -> BoxError { format!("rename onto {}: {e}", path.display()).into() })?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_auth_json(dir: &Path, contents: &str) {
        std::fs::write(dir.join("auth.json"), contents).unwrap();
    }

    #[test]
    fn loads_tokens_from_codex_home() {
        let dir = tempdir().unwrap();
        write_auth_json(
            dir.path(),
            r#"{
                "auth_mode": "chatgpt",
                "tokens": {
                    "id_token": "header.payload.sig",
                    "access_token": "at-1",
                    "refresh_token": "rt-1",
                    "account_id": "acct-1"
                },
                "last_refresh": "2026-04-01T12:00:00Z"
            }"#,
        );
        let auth = CodexAuth::load_from_codex_home(dir.path()).unwrap();
        assert_eq!(auth.access_token, "at-1");
        assert_eq!(auth.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(auth.account_id.as_deref(), Some("acct-1"));
        assert!(auth.persist_path.is_some());
    }

    #[test]
    fn rejects_missing_tokens_block() {
        let dir = tempdir().unwrap();
        write_auth_json(dir.path(), r#"{"auth_mode":"chatgpt"}"#);
        let err = CodexAuth::load_from_codex_home(dir.path()).unwrap_err();
        assert!(err.to_string().contains("tokens"), "got: {err}");
    }

    #[test]
    fn rejects_missing_access_token() {
        let dir = tempdir().unwrap();
        write_auth_json(
            dir.path(),
            r#"{"tokens":{"id_token":"x","refresh_token":"rt"}}"#,
        );
        let err = CodexAuth::load_from_codex_home(dir.path()).unwrap_err();
        assert!(err.to_string().contains("access_token"), "got: {err}");
    }

    #[test]
    fn rejects_missing_file() {
        let dir = tempdir().unwrap();
        let err = CodexAuth::load_from_codex_home(dir.path()).unwrap_err();
        assert!(err.to_string().contains("auth.json"), "got: {err}");
    }

    #[tokio::test]
    async fn from_static_no_refresh_capability() {
        let mut auth = CodexAuth::from_static("static-token", Some("acct".to_string()));
        assert_eq!(auth.access_token, "static-token");
        assert!(auth.refresh_token.is_none());
        let err = auth.refresh(&reqwest::Client::new()).await.unwrap_err();
        assert!(err.to_string().contains("static-token mode"), "got: {err}");
    }

    #[tokio::test]
    async fn write_back_preserves_unrelated_fields() {
        let dir = tempdir().unwrap();
        write_auth_json(
            dir.path(),
            r#"{
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": "sk-keep-me",
                "tokens": {
                    "id_token": "x",
                    "access_token": "old-at",
                    "refresh_token": "rt-1",
                    "account_id": "acct"
                }
            }"#,
        );
        let mut auth = CodexAuth::load_from_codex_home(dir.path()).unwrap();
        // Pretend a refresh happened.
        auth.access_token = "new-at".to_string();
        let path = auth.persist_path.clone().unwrap();
        auth.write_back(&path).unwrap();

        let after: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["auth_mode"], "chatgpt");
        assert_eq!(after["OPENAI_API_KEY"], "sk-keep-me");
        assert_eq!(after["tokens"]["access_token"], "new-at");
        assert_eq!(after["tokens"]["refresh_token"], "rt-1");
        assert_eq!(after["tokens"]["account_id"], "acct");
    }
}
