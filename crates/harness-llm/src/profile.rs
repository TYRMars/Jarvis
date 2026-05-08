//! Provider profiles: a data-driven catalog of LLM provider kinds.
//!
//! The composition root (`apps/jarvis::serve::build_provider`)
//! historically grew an 8-arm `match name` block — every new
//! OpenAI-compatible backend (OpenRouter, NVIDIA NIM, Moonshot,
//! MiniMax, MiMo, LM Studio, …) needed a code change. A profile
//! captures the *data* that differs between those backends —
//! default base URL, default model, env-var name for the API key,
//! transport family (Chat Completions vs Responses vs Anthropic
//! Messages vs Google generateContent) — so the binary's match
//! collapses to a handful of `ProviderTransport` arms while new
//! backends become a single static entry in
//! [`BUILTIN_PROFILES`].
//!
//! Profiles also carry a static [`ModelCapability`] catalog so the
//! Web UI can render capability badges (tools / vision / reasoning
//! / long-context / local) without making the user type each
//! field by hand. The catalog is best-effort — entries that aren't
//! known are returned as `None` and the UI falls through to a
//! conservative "unknown" rendering rather than blocking the
//! request.
//!
//! Phase 0 deliberately keeps the catalog *static*. A later phase
//! can plug in dynamic discovery (OpenRouter `/v1/models`, etc.)
//! without changing this surface.

use serde::{Deserialize, Serialize};

/// Wire-shape family the provider speaks. Determines which
/// `LlmProvider` impl in this crate the binary should construct
/// for an entry of this kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTransport {
    /// `POST /chat/completions` — the de facto standard. OpenAI,
    /// OpenRouter, Nous, NIM, Moonshot, MiniMax, MiMo, LM Studio,
    /// Ollama all speak this.
    OpenAiChatCompletions,
    /// `POST /responses` — OpenAI's reasoning-aware endpoint.
    /// Both the public OpenAI Responses API and the Codex
    /// (ChatGPT subscription) backend share this transport.
    OpenAiResponses,
    /// Anthropic Messages — `POST /v1/messages` with `system` /
    /// `messages` / `tools` shape distinct from OpenAI.
    AnthropicMessages,
    /// Google Gemini `generateContent` — `parts` / `functionCall`
    /// / `systemInstruction` shape.
    GoogleGenerateContent,
}

/// How the provider authenticates outbound requests. The binary
/// uses this to decide whether to read an API key from the env /
/// auth-store, or to load OAuth tokens from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AuthKind {
    /// Send an API key on a custom header. `scheme` is optional —
    /// when set, the value is rendered as `<scheme> <key>`. Use
    /// for Anthropic (`x-api-key`, no scheme) and similar.
    ApiKeyHeader {
        header: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheme: Option<String>,
    },
    /// Standard `Authorization: Bearer <key>`. Most OpenAI-compatible
    /// endpoints use this.
    Bearer,
    /// ChatGPT subscription OAuth — Codex backend. The binary
    /// resolves tokens via [`crate::CodexAuth`].
    CodexOAuth,
    /// No auth required at all (e.g. local Ollama with default
    /// config). Implementations may still send a placeholder
    /// bearer to satisfy clients that bake one in.
    None,
}

/// Modality the model accepts on input or produces on output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Text,
    Image,
    Audio,
    Video,
}

/// Rough cost band, surfaced as a UI badge. Always `Unknown` until
/// someone fills it in — never guess for a real model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostHint {
    /// Free / locally-run.
    FreeLocal,
    Low,
    Medium,
    High,
    #[default]
    Unknown,
}

/// Rough latency band (perception, not p50 numbers).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LatencyHint {
    Fast,
    Balanced,
    Slow,
    #[default]
    Unknown,
}

/// Privacy stance of the provider. Drives the "request travels
/// through a third-party router" warning in the picker.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrivacyHint {
    /// Runs on the user's machine.
    Local,
    /// Direct first-party cloud (OpenAI, Anthropic, Google).
    FirstPartyCloud,
    /// Routed via a third party (OpenRouter, generic relay).
    ThirdPartyRouter,
    #[default]
    Unknown,
}

/// How the wire shape encodes tool calls. Phase 0 just records the
/// value; Phase 4 routing/validation will consume it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCallStyle {
    /// `tool_calls` array on the assistant message (OpenAI, most
    /// OpenAI-compatible providers).
    OpenAi,
    /// `tool_use` content block (Anthropic).
    Anthropic,
    /// `functionCall` part inside `parts` (Google).
    Google,
    /// `function_call` items at the top level of `input`
    /// (OpenAI Responses).
    OpenAiResponses,
    /// Server doesn't expose tool calls. Requesting tools should
    /// fail validation.
    None,
    #[default]
    Unknown,
}

/// How the model accepts strict JSON / schema-typed output.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JsonSchemaStyle {
    /// `response_format: {type: json_schema, ...}` — OpenAI.
    OpenAi,
    /// Tool-with-schema pattern — Anthropic / Gemini.
    ToolSchema,
    None,
    #[default]
    Unknown,
}

/// How the model surfaces reasoning blocks (chain-of-thought).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningStyle {
    /// `reasoning.summary` field — OpenAI Responses, Codex.
    OpenAiReasoning,
    /// Anthropic-style `thinking` block.
    AnthropicThinking,
    None,
    #[default]
    Unknown,
}

/// Compatibility hints for request shaping. Phase 0 stores these
/// but doesn't act on them yet — the matching providers already
/// know how to format their wire shape. Phase 4 (auto routing)
/// will consume them for capability validation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestCompat {
    #[serde(default)]
    pub tool_call_style: ToolCallStyle,
    #[serde(default)]
    pub json_schema_style: JsonSchemaStyle,
    #[serde(default)]
    pub reasoning_style: ReasoningStyle,
    /// When `false`, the provider rejects requests with a `model`
    /// field different from its configured default. Most providers
    /// pass it through — Codex famously doesn't.
    #[serde(default = "default_true")]
    pub model_field_passthrough: bool,
}

fn default_true() -> bool {
    true
}

/// One model's capability snapshot. Surfaced via
/// `GET /v1/model-catalog` and used by the chat-input validator
/// to short-circuit "you're requesting tools but this model
/// doesn't do tools" requests.
///
/// Every capability field is [`Option`] so "we don't know" is
/// distinguishable from "no, definitively not". Unknown fields
/// fall through to "skip the validation" — never block a request
/// because we lack a catalog entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapability {
    /// Provider kind (matches [`ProviderProfile::kind`]).
    pub provider: String,
    /// The wire model id — what we send on `model:`.
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Family bucket for grouping in the picker (e.g. `"gpt-5"`,
    /// `"claude-3.5"`, `"gemini-1.5"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<Modality>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_modalities: Vec<Modality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tool_calls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_parallel_tool_calls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_json_schema: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_prompt_cache: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_embeddings: Option<bool>,
    #[serde(default, skip_serializing_if = "is_default_cost")]
    pub cost_hint: CostHint,
    #[serde(default, skip_serializing_if = "is_default_latency")]
    pub latency_hint: LatencyHint,
    #[serde(default, skip_serializing_if = "is_default_privacy")]
    pub privacy_hint: PrivacyHint,
}

fn is_default_cost(c: &CostHint) -> bool {
    matches!(c, CostHint::Unknown)
}
fn is_default_latency(l: &LatencyHint) -> bool {
    matches!(l, LatencyHint::Unknown)
}
fn is_default_privacy(p: &PrivacyHint) -> bool {
    matches!(p, PrivacyHint::Unknown)
}

impl ModelCapability {
    /// Quick UI badge list. Order is stable so renderers can rely
    /// on it without sorting.
    pub fn badges(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.supports_tool_calls == Some(true) {
            out.push("tools");
        }
        if self.supports_reasoning == Some(true) {
            out.push("reasoning");
        }
        if self.supports_images == Some(true) || self.input_modalities.contains(&Modality::Image) {
            out.push("vision");
        }
        if self.context_window.unwrap_or(0) >= 64_000 {
            out.push("64k+");
        }
        match self.privacy_hint {
            PrivacyHint::Local => out.push("local"),
            PrivacyHint::ThirdPartyRouter => out.push("router"),
            _ => {}
        }
        out
    }
}

/// The full description of a provider kind. Returned from
/// [`ProfileRegistry::get`] and consumed by the binary's
/// `build_provider` dispatch.
///
/// Serialize-only — built-in profiles are static data, never
/// reconstructed from JSON. The wire-side shape used by
/// `GET /v1/model-catalog` is [`CatalogEntry`], which carries
/// owned `String`s and is round-trippable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    /// Stable id used as the `kind` field in `ProviderConfig` and
    /// `ProviderDef`. Lowercase kebab-case (e.g. `"openrouter"`,
    /// `"nvidia-nim"`).
    pub kind: &'static str,
    /// Human-readable label for the provider wizard (e.g.
    /// `"OpenRouter"`, `"NVIDIA NIM"`).
    pub display_name: &'static str,
    pub transport: ProviderTransport,
    /// HTTP base URL applied when the user doesn't supply one.
    /// `None` only for Codex (the binary derives the URL from the
    /// `ResponsesConfig::codex` preset).
    pub default_base_url: Option<&'static str>,
    pub auth: AuthKind,
    /// Env vars the binary should consult, in order, when looking
    /// for an API key. The auth-store is always tried after these.
    pub api_key_env: &'static [&'static str],
    /// Default model id sent on the wire when no explicit override
    /// is configured.
    pub default_model: &'static str,
    /// Static catalog of known models for this provider. Empty is
    /// fine — the picker just renders no badges. Each entry's
    /// `provider` field must match `kind`.
    pub model_catalog: &'static [ModelCapability],
    /// Bare-model-name prefixes that route to this provider via
    /// `ProviderRegistry`'s prefix rules.
    pub model_prefixes: &'static [&'static str],
    pub request_compat: RequestCompat,
    /// `true` when the operator should treat the catalog defaults
    /// as "verify against the live endpoint before relying on
    /// them". Used for providers we have not yet fully smoke-
    /// tested (e.g. MiniMax / MiMo / Nous Portal). The wizard
    /// surfaces this as an inline warning.
    pub verification_required: bool,
}

impl ProviderProfile {
    pub fn capability_for(&self, model: &str) -> Option<&'static ModelCapability> {
        self.model_catalog.iter().find(|c| c.model == model)
    }
}

/// Built-in profile registry. Lookups are by `kind`. Static
/// content — once initialised on first access via [`LazyLock`],
/// the table never changes within a process.
pub struct ProfileRegistry;

impl ProfileRegistry {
    pub fn get(kind: &str) -> Option<&'static ProviderProfile> {
        BUILTIN_PROFILES.iter().find(|p| p.kind == kind)
    }

    pub fn all() -> &'static [ProviderProfile] {
        &BUILTIN_PROFILES
    }
}

/// Helper for the binary: best-effort capability lookup across all
/// built-in profiles. Returns `None` when no profile knows about
/// the `(kind, model)` pair — callers should treat that as
/// "unknown" rather than "definitively unsupported".
pub fn lookup_capability(kind: &str, model: &str) -> Option<&'static ModelCapability> {
    ProfileRegistry::get(kind).and_then(|p| p.capability_for(model))
}

/// Phase 0 catalog. 13 profiles per spec § Built-in profiles
/// table — `openai`, `openai-responses`, `codex`, `anthropic`,
/// `google`, `openrouter`, `nous`, `nvidia-nim`, `huggingface`,
/// `moonshot`, `minimax`, `mimo`, `ollama`, `lmstudio`. (`kimi`
/// is an alias for `moonshot` — same profile, different config
/// key.)
fn build_builtin_profiles() -> Vec<ProviderProfile> {
    use CostHint::*;
    use LatencyHint::*;
    use PrivacyHint::*;
    use ProviderTransport::*;

    #[allow(clippy::too_many_arguments)]
    fn mc(
        provider: &str,
        model: &str,
        display: Option<&str>,
        family: Option<&str>,
        ctx: Option<u32>,
        tools: Option<bool>,
        reasoning: Option<bool>,
        vision: Option<bool>,
        cost: CostHint,
        latency: LatencyHint,
        privacy: PrivacyHint,
    ) -> ModelCapability {
        ModelCapability {
            provider: provider.to_string(),
            model: model.to_string(),
            display_name: display.map(str::to_string),
            family: family.map(str::to_string),
            context_window: ctx,
            max_output_tokens: None,
            input_modalities: Vec::new(),
            output_modalities: Vec::new(),
            supports_streaming: Some(true),
            supports_tool_calls: tools,
            supports_parallel_tool_calls: None,
            supports_json_schema: None,
            supports_reasoning: reasoning,
            supports_prompt_cache: None,
            supports_images: vision,
            supports_embeddings: None,
            cost_hint: cost,
            latency_hint: latency,
            privacy_hint: privacy,
        }
    }

    let openai_compat = RequestCompat {
        tool_call_style: ToolCallStyle::OpenAi,
        json_schema_style: JsonSchemaStyle::OpenAi,
        reasoning_style: ReasoningStyle::None,
        model_field_passthrough: true,
    };
    let openai_responses_compat = RequestCompat {
        tool_call_style: ToolCallStyle::OpenAiResponses,
        json_schema_style: JsonSchemaStyle::OpenAi,
        reasoning_style: ReasoningStyle::OpenAiReasoning,
        model_field_passthrough: true,
    };
    let anthropic_compat = RequestCompat {
        tool_call_style: ToolCallStyle::Anthropic,
        json_schema_style: JsonSchemaStyle::ToolSchema,
        reasoning_style: ReasoningStyle::AnthropicThinking,
        model_field_passthrough: true,
    };
    let google_compat = RequestCompat {
        tool_call_style: ToolCallStyle::Google,
        json_schema_style: JsonSchemaStyle::ToolSchema,
        reasoning_style: ReasoningStyle::None,
        model_field_passthrough: true,
    };
    let codex_compat = RequestCompat {
        tool_call_style: ToolCallStyle::OpenAiResponses,
        json_schema_style: JsonSchemaStyle::OpenAi,
        reasoning_style: ReasoningStyle::OpenAiReasoning,
        // Codex backend rejects `model:` overrides — see
        // `crates/harness-llm/src/responses.rs::Codex` notes.
        model_field_passthrough: false,
    };

    // Static `Vec<ModelCapability>`s leak intentionally so we can
    // hand out `&'static [ModelCapability]` slices. Catalog is
    // built once at process start; the leak is the standard
    // OnceLock-cached approach.
    fn leak<T: 'static>(v: Vec<T>) -> &'static [T] {
        Box::leak(v.into_boxed_slice())
    }

    fn lstrs(s: Vec<&str>) -> &'static [&'static str] {
        Box::leak(
            s.into_iter()
                .map(|x| Box::leak(x.to_string().into_boxed_str()) as &'static str)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        )
    }

    let openai_models = leak(vec![
        mc(
            "openai",
            "gpt-4o",
            Some("GPT-4o"),
            Some("gpt-4o"),
            Some(128_000),
            Some(true),
            Some(false),
            Some(true),
            Medium,
            Balanced,
            FirstPartyCloud,
        ),
        mc(
            "openai",
            "gpt-4o-mini",
            Some("GPT-4o mini"),
            Some("gpt-4o"),
            Some(128_000),
            Some(true),
            Some(false),
            Some(true),
            Low,
            Fast,
            FirstPartyCloud,
        ),
    ]);
    let openai_responses_models = leak(vec![
        mc(
            "openai-responses",
            "gpt-4o",
            Some("GPT-4o (Responses)"),
            Some("gpt-4o"),
            Some(128_000),
            Some(true),
            Some(false),
            Some(true),
            Medium,
            Balanced,
            FirstPartyCloud,
        ),
        mc(
            "openai-responses",
            "o1",
            Some("o1 (reasoning)"),
            Some("o-series"),
            Some(200_000),
            Some(true),
            Some(true),
            Some(true),
            High,
            Slow,
            FirstPartyCloud,
        ),
    ]);
    let codex_models = leak(vec![
        mc(
            "codex",
            "gpt-5.4-mini",
            Some("GPT-5.4 mini (Codex)"),
            Some("gpt-5.4"),
            Some(200_000),
            Some(true),
            Some(true),
            None,
            CostHint::Low,
            Fast,
            FirstPartyCloud,
        ),
        mc(
            "codex",
            "gpt-5.4",
            Some("GPT-5.4 (Codex)"),
            Some("gpt-5.4"),
            Some(200_000),
            Some(true),
            Some(true),
            None,
            High,
            Balanced,
            FirstPartyCloud,
        ),
    ]);
    let anthropic_models = leak(vec![
        mc(
            "anthropic",
            "claude-3-5-sonnet-latest",
            Some("Claude 3.5 Sonnet"),
            Some("claude-3.5"),
            Some(200_000),
            Some(true),
            Some(false),
            Some(true),
            High,
            Balanced,
            FirstPartyCloud,
        ),
        mc(
            "anthropic",
            "claude-3-5-haiku-latest",
            Some("Claude 3.5 Haiku"),
            Some("claude-3.5"),
            Some(200_000),
            Some(true),
            Some(false),
            Some(true),
            CostHint::Low,
            Fast,
            FirstPartyCloud,
        ),
    ]);
    let google_models = leak(vec![
        mc(
            "google",
            "gemini-1.5-flash",
            Some("Gemini 1.5 Flash"),
            Some("gemini-1.5"),
            Some(1_000_000),
            Some(true),
            Some(false),
            Some(true),
            CostHint::Low,
            Fast,
            FirstPartyCloud,
        ),
        mc(
            "google",
            "gemini-1.5-pro",
            Some("Gemini 1.5 Pro"),
            Some("gemini-1.5"),
            Some(2_000_000),
            Some(true),
            Some(false),
            Some(true),
            High,
            Balanced,
            FirstPartyCloud,
        ),
    ]);
    let openrouter_models = leak(vec![
        mc(
            "openrouter",
            "anthropic/claude-sonnet-4.5",
            Some("Claude Sonnet 4.5 (via OpenRouter)"),
            Some("claude-4"),
            Some(200_000),
            Some(true),
            Some(false),
            Some(true),
            High,
            Balanced,
            ThirdPartyRouter,
        ),
        mc(
            "openrouter",
            "openai/gpt-5.4",
            Some("GPT-5.4 (via OpenRouter)"),
            Some("gpt-5.4"),
            Some(200_000),
            Some(true),
            Some(true),
            Some(true),
            High,
            Balanced,
            ThirdPartyRouter,
        ),
        mc(
            "openrouter",
            "nousresearch/hermes-4",
            Some("Hermes 4 (via OpenRouter)"),
            Some("hermes-4"),
            Some(128_000),
            Some(true),
            Some(false),
            None,
            CostHint::Low,
            Balanced,
            ThirdPartyRouter,
        ),
    ]);
    let moonshot_models = leak(vec![
        mc(
            "moonshot",
            "kimi-k2-thinking",
            Some("Kimi k2 (thinking)"),
            Some("kimi-k2"),
            Some(200_000),
            Some(true),
            Some(true),
            None,
            CostHint::Low,
            Balanced,
            FirstPartyCloud,
        ),
        mc(
            "moonshot",
            "kimi-k2-turbo-preview",
            Some("Kimi k2 turbo (preview)"),
            Some("kimi-k2"),
            Some(128_000),
            Some(true),
            Some(false),
            None,
            CostHint::Low,
            Fast,
            FirstPartyCloud,
        ),
    ]);
    let nim_models = leak(vec![mc(
        "nvidia-nim",
        "meta/llama-3.3-70b-instruct",
        Some("Llama 3.3 70B (NIM)"),
        Some("llama-3.3"),
        Some(131_072),
        Some(true),
        Some(false),
        None,
        Medium,
        Balanced,
        FirstPartyCloud,
    )]);
    let nous_models = leak(vec![mc(
        "nous",
        "hermes-4",
        Some("Hermes 4 (Nous)"),
        Some("hermes-4"),
        Some(128_000),
        Some(true),
        Some(false),
        None,
        Medium,
        Balanced,
        FirstPartyCloud,
    )]);
    let minimax_models = leak(vec![mc(
        "minimax",
        "abab6.5",
        Some("MiniMax abab6.5"),
        Some("abab6"),
        Some(245_000),
        Some(true),
        Some(false),
        None,
        Medium,
        Balanced,
        FirstPartyCloud,
    )]);
    let mimo_models = leak(vec![mc(
        "mimo",
        "mimo-7b-rl",
        Some("Xiaomi MiMo 7B RL"),
        Some("mimo"),
        Some(32_000),
        Some(true),
        Some(false),
        None,
        CostHint::Low,
        Fast,
        FirstPartyCloud,
    )]);
    let ollama_models = leak(vec![
        mc(
            "ollama",
            "llama3.2",
            Some("Llama 3.2"),
            Some("llama-3.2"),
            Some(128_000),
            Some(true),
            Some(false),
            None,
            FreeLocal,
            Balanced,
            Local,
        ),
        mc(
            "ollama",
            "qwen3:14b",
            Some("Qwen 3 14B"),
            Some("qwen-3"),
            Some(32_000),
            Some(true),
            Some(false),
            None,
            FreeLocal,
            Balanced,
            Local,
        ),
    ]);
    let lmstudio_models = leak(vec![mc(
        "lmstudio",
        "openai/gpt-oss-20b",
        Some("LM Studio (loaded model)"),
        None,
        Some(32_000),
        Some(true),
        Some(false),
        None,
        FreeLocal,
        Balanced,
        Local,
    )]);
    let huggingface_models: &'static [ModelCapability] = leak(Vec::new());

    vec![
        ProviderProfile {
            kind: "openai",
            display_name: "OpenAI",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://api.openai.com/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["OPENAI_API_KEY"]),
            default_model: "gpt-4o-mini",
            model_catalog: openai_models,
            model_prefixes: lstrs(vec!["gpt-", "o1", "o3", "o4"]),
            request_compat: openai_compat.clone(),
            verification_required: false,
        },
        ProviderProfile {
            kind: "openai-responses",
            display_name: "OpenAI Responses",
            transport: OpenAiResponses,
            default_base_url: Some("https://api.openai.com/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["OPENAI_API_KEY"]),
            default_model: "gpt-4o-mini",
            model_catalog: openai_responses_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_responses_compat,
            verification_required: false,
        },
        ProviderProfile {
            kind: "codex",
            display_name: "Codex (ChatGPT)",
            transport: OpenAiResponses,
            default_base_url: None, // ResponsesConfig::codex sets endpoint
            auth: AuthKind::CodexOAuth,
            api_key_env: lstrs(vec![]),
            default_model: "gpt-5.4-mini",
            model_catalog: codex_models,
            model_prefixes: lstrs(vec![]),
            request_compat: codex_compat,
            verification_required: false,
        },
        ProviderProfile {
            kind: "anthropic",
            display_name: "Anthropic",
            transport: AnthropicMessages,
            default_base_url: Some("https://api.anthropic.com"),
            auth: AuthKind::ApiKeyHeader {
                header: "x-api-key".to_string(),
                scheme: None,
            },
            api_key_env: lstrs(vec!["ANTHROPIC_API_KEY"]),
            default_model: "claude-3-5-sonnet-latest",
            model_catalog: anthropic_models,
            model_prefixes: lstrs(vec!["claude-"]),
            request_compat: anthropic_compat,
            verification_required: false,
        },
        ProviderProfile {
            kind: "google",
            display_name: "Google Gemini",
            transport: GoogleGenerateContent,
            default_base_url: Some("https://generativelanguage.googleapis.com"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["GOOGLE_API_KEY", "GEMINI_API_KEY"]),
            default_model: "gemini-1.5-flash",
            model_catalog: google_models,
            model_prefixes: lstrs(vec!["gemini-"]),
            request_compat: google_compat,
            verification_required: false,
        },
        ProviderProfile {
            kind: "openrouter",
            display_name: "OpenRouter",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://openrouter.ai/api/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["OPENROUTER_API_KEY"]),
            default_model: "openai/gpt-5.4-mini",
            model_catalog: openrouter_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_compat.clone(),
            verification_required: false,
        },
        ProviderProfile {
            kind: "moonshot",
            display_name: "Moonshot (Kimi)",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://api.moonshot.cn/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["KIMI_API_KEY", "MOONSHOT_API_KEY"]),
            default_model: "kimi-k2-thinking",
            model_catalog: moonshot_models,
            model_prefixes: lstrs(vec!["kimi-", "moonshot-"]),
            request_compat: openai_compat.clone(),
            verification_required: false,
        },
        ProviderProfile {
            kind: "nvidia-nim",
            display_name: "NVIDIA NIM",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://integrate.api.nvidia.com/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["NVIDIA_API_KEY", "NIM_API_KEY"]),
            default_model: "meta/llama-3.3-70b-instruct",
            model_catalog: nim_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_compat.clone(),
            verification_required: true,
        },
        ProviderProfile {
            kind: "nous",
            display_name: "Nous Portal",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://inference-api.nousresearch.com/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["NOUS_API_KEY"]),
            default_model: "hermes-4",
            model_catalog: nous_models,
            model_prefixes: lstrs(vec!["hermes-"]),
            request_compat: openai_compat.clone(),
            verification_required: true,
        },
        ProviderProfile {
            kind: "minimax",
            display_name: "MiniMax",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://api.minimax.chat/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["MINIMAX_API_KEY"]),
            default_model: "abab6.5",
            model_catalog: minimax_models,
            model_prefixes: lstrs(vec!["abab"]),
            request_compat: openai_compat.clone(),
            verification_required: true,
        },
        ProviderProfile {
            kind: "mimo",
            display_name: "Xiaomi MiMo",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://mimo.xiaomi.com/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["MIMO_API_KEY"]),
            default_model: "mimo-7b-rl",
            model_catalog: mimo_models,
            model_prefixes: lstrs(vec!["mimo-"]),
            request_compat: openai_compat.clone(),
            verification_required: true,
        },
        ProviderProfile {
            kind: "ollama",
            display_name: "Ollama (local)",
            transport: OpenAiChatCompletions,
            default_base_url: Some("http://localhost:11434/v1"),
            auth: AuthKind::None,
            api_key_env: lstrs(vec!["OLLAMA_API_KEY"]),
            default_model: "llama3.2",
            model_catalog: ollama_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_compat.clone(),
            verification_required: false,
        },
        ProviderProfile {
            kind: "lmstudio",
            display_name: "LM Studio (local)",
            transport: OpenAiChatCompletions,
            default_base_url: Some("http://localhost:1234/v1"),
            auth: AuthKind::None,
            api_key_env: lstrs(vec!["LMSTUDIO_API_KEY"]),
            default_model: "openai/gpt-oss-20b",
            model_catalog: lmstudio_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_compat.clone(),
            verification_required: false,
        },
        ProviderProfile {
            kind: "huggingface",
            display_name: "Hugging Face Inference",
            transport: OpenAiChatCompletions,
            default_base_url: Some("https://api-inference.huggingface.co/v1"),
            auth: AuthKind::Bearer,
            api_key_env: lstrs(vec!["HF_API_KEY", "HUGGINGFACE_API_KEY"]),
            default_model: "meta-llama/Llama-3.3-70B-Instruct",
            model_catalog: huggingface_models,
            model_prefixes: lstrs(vec![]),
            request_compat: openai_compat,
            verification_required: true,
        },
    ]
}

/// All built-in profiles. Lazily initialised once per process.
pub static BUILTIN_PROFILES: std::sync::LazyLock<Vec<ProviderProfile>> =
    std::sync::LazyLock::new(build_builtin_profiles);

/// Aliases — historical / config-file kind names that map onto a
/// canonical built-in profile. `kimi` is the long-standing alias
/// for `moonshot` so existing configs keep working without
/// rewriting `kind: "kimi"` → `kind: "moonshot"`.
pub fn canonical_kind(kind: &str) -> &str {
    match kind {
        "kimi" => "moonshot",
        other => other,
    }
}

/// Wire-shape for the `GET /v1/model-catalog` route. Flattens the
/// per-provider catalogs into one list, with the provider's
/// `display_name` and a hint at default-ness baked in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// The profile kind (matches [`ProviderProfile::kind`]).
    /// Distinct from the user's per-deployment provider name; in
    /// Phase 0 they coincide because each kind is registered once.
    pub provider_kind: String,
    pub provider_display_name: String,
    /// `true` when this is the provider's default model (the one
    /// the picker pre-selects).
    pub is_provider_default: bool,
    /// Capability snapshot — `provider` and `model` fields name
    /// the kind / wire model id directly.
    #[serde(flatten)]
    pub capability: ModelCapability,
}

/// Build a flat catalog spanning all built-in profiles. Useful
/// for tests and Phase 0's static `/v1/model-catalog` response.
pub fn flat_builtin_catalog() -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    for p in ProfileRegistry::all() {
        for cap in p.model_catalog {
            out.push(CatalogEntry {
                provider_kind: p.kind.to_string(),
                provider_display_name: p.display_name.to_string(),
                is_provider_default: cap.model == p.default_model,
                capability: cap.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_each_builtin_kind() {
        for kind in [
            "openai",
            "openai-responses",
            "codex",
            "anthropic",
            "google",
            "openrouter",
            "moonshot",
            "nvidia-nim",
            "nous",
            "minimax",
            "mimo",
            "ollama",
            "lmstudio",
            "huggingface",
        ] {
            let p = ProfileRegistry::get(kind).unwrap_or_else(|| panic!("missing kind={kind}"));
            assert_eq!(p.kind, kind);
            assert!(!p.display_name.is_empty(), "empty display_name for {kind}");
        }
    }

    #[test]
    fn kimi_alias_canonicalises() {
        assert_eq!(canonical_kind("kimi"), "moonshot");
        assert_eq!(canonical_kind("openai"), "openai");
    }

    #[test]
    fn openrouter_has_router_privacy() {
        let p = ProfileRegistry::get("openrouter").unwrap();
        let cap = &p.model_catalog[0];
        assert_eq!(cap.privacy_hint, PrivacyHint::ThirdPartyRouter);
        assert!(cap.badges().contains(&"router"));
    }

    #[test]
    fn ollama_has_local_privacy_and_no_auth() {
        let p = ProfileRegistry::get("ollama").unwrap();
        assert!(matches!(p.auth, AuthKind::None));
        let cap = &p.model_catalog[0];
        assert_eq!(cap.privacy_hint, PrivacyHint::Local);
        assert!(cap.badges().contains(&"local"));
    }

    #[test]
    fn anthropic_uses_x_api_key_header() {
        let p = ProfileRegistry::get("anthropic").unwrap();
        match &p.auth {
            AuthKind::ApiKeyHeader { header, scheme } => {
                assert_eq!(header, "x-api-key");
                assert!(scheme.is_none());
            }
            other => panic!("expected ApiKeyHeader, got {other:?}"),
        }
    }

    #[test]
    fn codex_does_not_passthrough_model_field() {
        let p = ProfileRegistry::get("codex").unwrap();
        assert!(!p.request_compat.model_field_passthrough);
    }

    #[test]
    fn capability_for_resolves_known_model() {
        let p = ProfileRegistry::get("openai").unwrap();
        let cap = p.capability_for("gpt-4o-mini").unwrap();
        assert_eq!(cap.supports_tool_calls, Some(true));
        assert!(cap.badges().contains(&"tools"));
    }

    #[test]
    fn lookup_capability_returns_none_for_unknown_model() {
        assert!(lookup_capability("openai", "no-such-model").is_none());
        assert!(lookup_capability("no-such-kind", "anything").is_none());
    }

    #[test]
    fn flat_catalog_marks_provider_defaults() {
        let cat = flat_builtin_catalog();
        let openai_default = cat
            .iter()
            .find(|e| e.provider_kind == "openai" && e.capability.model == "gpt-4o-mini")
            .unwrap();
        assert!(openai_default.is_provider_default);
        let openai_other = cat
            .iter()
            .find(|e| e.provider_kind == "openai" && e.capability.model == "gpt-4o")
            .unwrap();
        assert!(!openai_other.is_provider_default);
    }

    #[test]
    fn profile_serializes_to_json() {
        let p = ProfileRegistry::get("openrouter").unwrap();
        let v: serde_json::Value = serde_json::to_value(p).unwrap();
        assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("openrouter"));
        assert_eq!(
            v.get("defaultBaseUrl").and_then(|x| x.as_str()),
            Some("https://openrouter.ai/api/v1"),
        );
    }

    #[test]
    fn catalog_entry_round_trips() {
        let entries = flat_builtin_catalog();
        let s = serde_json::to_string(&entries).unwrap();
        let back: Vec<CatalogEntry> = serde_json::from_str(&s).unwrap();
        assert_eq!(back.len(), entries.len());
    }

    #[test]
    fn verification_required_set_for_unverified_profiles() {
        for kind in ["nvidia-nim", "nous", "minimax", "mimo", "huggingface"] {
            let p = ProfileRegistry::get(kind).unwrap();
            assert!(p.verification_required, "{kind} should be flagged");
        }
        for kind in ["openai", "anthropic", "google", "openrouter", "moonshot"] {
            let p = ProfileRegistry::get(kind).unwrap();
            assert!(!p.verification_required, "{kind} should be verified");
        }
    }
}
