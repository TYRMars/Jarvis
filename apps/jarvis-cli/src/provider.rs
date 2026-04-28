//! Env-only provider construction for the CLI.
//!
//! Deliberately simpler than `apps/jarvis::serve::build_provider`:
//! no auth-store, no config file, no Codex OAuth flow — those
//! belong to the server binary's onboarding wizard. The CLI is
//! a "quick local turn" tool; if you want OAuth flows or stored
//! credentials, run `jarvis serve` and talk to it instead.
//!
//! Supported:
//!
//! | provider     | env vars                                            | default model              |
//! |--------------|-----------------------------------------------------|----------------------------|
//! | `openai`     | `OPENAI_API_KEY`, `OPENAI_BASE_URL`                 | `gpt-4o-mini`              |
//! | `anthropic`  | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`           | `claude-3-5-sonnet-latest` |
//! | `google`     | `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `GOOGLE_BASE_URL` | `gemini-1.5-flash`      |
//! | `ollama`     | `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`), `OLLAMA_API_KEY` (optional) | `llama3.2` |

use std::sync::Arc;

use anyhow::{Context, Result};
use harness_core::LlmProvider;
use harness_llm::{
    AnthropicConfig, AnthropicProvider, GoogleConfig, GoogleProvider, OpenAiConfig, OpenAiProvider,
};

pub fn build(
    provider: &str,
    model_override: Option<String>,
) -> Result<(Arc<dyn LlmProvider>, String)> {
    let env_model = std::env::var("JARVIS_MODEL").ok();
    let model_pick = model_override.or(env_model);
    match provider {
        "openai" => {
            let api_key = std::env::var("OPENAI_API_KEY")
                .context("OPENAI_API_KEY is required for provider=openai")?;
            let model = model_pick.unwrap_or_else(|| "gpt-4o-mini".into());
            let mut cfg = OpenAiConfig::new(api_key).with_default_model(&model);
            if let Ok(base) = std::env::var("OPENAI_BASE_URL") {
                cfg = cfg.with_base_url(base);
            }
            Ok((Arc::new(OpenAiProvider::new(cfg)), model))
        }
        "anthropic" => {
            let api_key = std::env::var("ANTHROPIC_API_KEY")
                .context("ANTHROPIC_API_KEY is required for provider=anthropic")?;
            let model = model_pick.unwrap_or_else(|| "claude-3-5-sonnet-latest".into());
            let mut cfg = AnthropicConfig::new(api_key);
            if let Ok(base) = std::env::var("ANTHROPIC_BASE_URL") {
                cfg = cfg.with_base_url(base);
            }
            if let Ok(version) = std::env::var("ANTHROPIC_VERSION") {
                cfg = cfg.with_anthropic_version(version);
            }
            Ok((Arc::new(AnthropicProvider::new(cfg)), model))
        }
        "google" => {
            let api_key = std::env::var("GOOGLE_API_KEY")
                .ok()
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .context("GOOGLE_API_KEY or GEMINI_API_KEY is required for provider=google")?;
            let model = model_pick.unwrap_or_else(|| "gemini-1.5-flash".into());
            let mut cfg = GoogleConfig::new(api_key);
            if let Ok(base) = std::env::var("GOOGLE_BASE_URL") {
                cfg = cfg.with_base_url(base);
            }
            Ok((Arc::new(GoogleProvider::new(cfg)), model))
        }
        "ollama" => {
            // Ollama is OpenAI-compat at `<base>/chat/completions`.
            // No key required for the local server; some hosted
            // proxies (OpenWebUI etc.) gate via OLLAMA_API_KEY.
            let api_key = std::env::var("OLLAMA_API_KEY").unwrap_or_else(|_| "ollama".into());
            let base = std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:11434/v1".into());
            let model = model_pick.unwrap_or_else(|| "llama3.2".into());
            let cfg = OpenAiConfig::new(api_key)
                .with_base_url(base)
                .with_default_model(&model);
            Ok((Arc::new(OpenAiProvider::new(cfg)), model))
        }
        other => anyhow::bail!(
            "unknown provider `{other}`; CLI supports openai / anthropic / google / ollama"
        ),
    }
}
