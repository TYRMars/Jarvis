//! Concrete `LlmProvider` implementations.
//!
//! | feature     | provider                                              |
//! |-------------|-------------------------------------------------------|
//! | `openai`    | [`OpenAiProvider`] — OpenAI chat-completions API      |
//! | `anthropic` | [`AnthropicProvider`] — Anthropic Messages API        |
//!
//! Both features are on by default. Disable `default-features` on this
//! crate and opt in individually if you want to trim the build.

#[cfg(feature = "openai")]
pub mod openai;
#[cfg(feature = "openai")]
pub use openai::{OpenAiConfig, OpenAiProvider};

#[cfg(feature = "anthropic")]
pub mod anthropic;
#[cfg(feature = "anthropic")]
pub use anthropic::{AnthropicConfig, AnthropicProvider};
