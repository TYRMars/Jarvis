//! Runtime provider admin — the trait the binary implements so the
//! Web UI can add / edit / delete providers without restarting.
//!
//! Why a trait: provider construction in `apps/jarvis::serve::build_provider`
//! depends on the binary's `Config` shape, env-var fallbacks, and the
//! per-provider `auth_store` for secrets. Library crates can't see
//! `Config`, so the binary owns that logic and exposes a single
//! `ProviderAdmin` impl through `AppState`. The route handler
//! ([`crate::provider_admin_routes`]) just calls `provision` /
//! `unprovision` / `set_default` and routes the result onto the wire.
//!
//! Persistence contract:
//!
//! - `provision` writes `config.providers[<name>] = ProviderConfig { … }`
//!   to disk (via `Config::to_json_string()`), saves the api_key into
//!   `auth_store::save_api_key(<name>, …)` when one is supplied, and
//!   inserts the freshly-built `Arc<dyn LlmProvider>` into the runtime
//!   registry.
//! - `unprovision` removes the entry from disk + auth_store and drops
//!   it from the registry.
//! - `set_default` updates `config.default_provider` on disk and
//!   `ProviderRegistry::default_name` in memory.
//!
//! Errors are surfaced as `ProvisionError` (single sum type) so the
//! HTTP layer can map cleanly to status codes.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Wire shape for `POST /v1/providers` and `PATCH /v1/providers/:name`.
///
/// Matches the binary's `ProviderConfig` shape closely so the round-trip
/// between Web form ↔ on-disk `config.json` is verbatim. Optional
/// fields use `#[serde(skip_serializing_if = "Option::is_none")]` so a
/// minimal payload (`{ "name": "…", "kind": "openai", "default_model": "…" }`)
/// stays compact on the wire.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDef {
    /// User-chosen, must be unique within the registry. The auth-file
    /// is keyed off this — `~/.config/jarvis/auth/<name>.json` —
    /// so renaming is **not** an in-place edit; delete + re-add.
    pub name: String,
    /// Provider kind selects which `LlmProvider` impl is constructed.
    /// Allowed values mirror the keys recognised by the binary's
    /// `build_provider` switch:
    /// `"openai"` / `"openai-responses"` / `"anthropic"` / `"google"`
    /// / `"codex"` / `"kimi"` / `"kimi-code"` / `"ollama"`.
    /// Custom OpenAI-compatible endpoints use `"openai"` with a
    /// non-empty `base_url`.
    pub kind: String,
    /// API key in plaintext on the wire. The route handler
    /// **never echoes it back** in subsequent reads — `GET` only
    /// returns whether a key is present. Only sent on
    /// create / update; omitting it on `PATCH` leaves the existing
    /// auth-file untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// HTTP base URL override. Required for `kind = "openai"` when
    /// targeting non-OpenAI compatible endpoints (Ollama / local
    /// proxies / Together / OpenRouter etc.); optional otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Model id used when the request doesn't specify one. Should be
    /// in `models` (the route handler dedupes if not).
    pub default_model: String,
    /// Curated model list shown in the Web UI's model picker. Empty
    /// is fine — the registry adds `default_model` automatically.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    /// Anthropic `anthropic-version` header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Codex / OpenAI-Responses: `reasoning.summary` request field
    /// (`"auto"` / `"concise"` / `"detailed"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    /// Codex / OpenAI-Responses: `reasoning.effort` request field
    /// (`"low"` / `"medium"` / `"high"` / `"max"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Codex / OpenAI-Responses: include `reasoning.encrypted_content`
    /// in the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_encrypted_reasoning: Option<bool>,
    /// Codex / OpenAI-Responses: `service_tier` request field
    /// (`"auto"` / `"priority"` / `"flex"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    /// Codex: override the default `~/.codex` directory. Most users
    /// leave unset; advanced flag for sandboxes / custom installs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<String>,
    /// Codex: override the default `/codex/responses` endpoint path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_path: Option<String>,
    /// Codex: `originator` header (defaults to `"jarvis"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_originator: Option<String>,
}

/// Snapshot of a provider's state for the edit form. Mirrors
/// [`ProviderDef`] but **never** carries the api_key — the form
/// shows "Key on file: yes/no" and only writes a new one when the
/// user supplies it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderSnapshot {
    pub name: String,
    pub kind: String,
    /// `true` when an api-key auth file or env var is in scope.
    /// `false` when missing — the operator should supply one before
    /// the provider can serve requests.
    pub has_api_key: bool,
    pub default_model: String,
    pub models: Vec<String>,
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_encrypted_reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_originator: Option<String>,
}

/// Errors the binary's `ProviderAdmin` impl returns. Maps cleanly
/// onto HTTP status codes in the route handler.
#[derive(Debug, Error)]
pub enum ProvisionError {
    #[error("invalid provider config: {0}")]
    Invalid(String),
    #[error("provider `{0}` already exists")]
    AlreadyExists(String),
    #[error("provider `{0}` not found")]
    NotFound(String),
    #[error("provider construction failed: {0}")]
    Construction(String),
    #[error("persistence i/o error: {0}")]
    Persistence(String),
}

/// The interface every binary that wants Web-UI-driven provider
/// management has to implement. `apps/jarvis` is the one impl today;
/// future binaries (e.g. CI runners) can stub it out as
/// "always returns `Persistence`" so the routes return 503 cleanly.
///
/// Trait is `#[async_trait]`-decorated so it stays dyn-compatible
/// (we hold an `Arc<dyn ProviderAdmin>` in `AppState`); the
/// `Send + Sync` bound is required because the impl is shared
/// across handler tasks.
#[async_trait]
pub trait ProviderAdmin: Send + Sync {
    /// Create or fully-replace a provider. The handler's POST and
    /// PATCH endpoints both route here; the impl decides whether to
    /// accept overwrites based on the `allow_overwrite` flag (POST
    /// passes `false`, PATCH passes `true`).
    ///
    /// On success returns the live snapshot of the newly-installed
    /// provider — the same shape `GET /v1/providers/:name` would
    /// return — so the caller can immediately echo it back to the
    /// client without a separate read.
    async fn provision(
        &self,
        def: ProviderDef,
        allow_overwrite: bool,
    ) -> Result<ProviderSnapshot, ProvisionError>;

    /// Drop a provider. Returns `Ok(true)` if a row was removed,
    /// `Ok(false)` when the name wasn't installed (idempotent
    /// delete). Does **not** remove the auth-file by default —
    /// pass `purge_secret = true` to also wipe
    /// `~/.config/jarvis/auth/<name>.json` (typical for the Web
    /// UI's "Delete provider" button).
    async fn unprovision(
        &self,
        name: &str,
        purge_secret: bool,
    ) -> Result<bool, ProvisionError>;

    /// Set the registry-wide default provider. Must already be
    /// installed.
    async fn set_default(&self, name: &str) -> Result<(), ProvisionError>;

    /// Return the full snapshot of one provider — kind, persisted
    /// transport overrides, whether a secret is on file, model
    /// catalogue. Used by the Web UI's edit form on first open.
    async fn snapshot(&self, name: &str) -> Result<ProviderSnapshot, ProvisionError>;
}
