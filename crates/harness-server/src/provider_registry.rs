//! Multi-provider routing for the HTTP / WS layer.
//!
//! Holds a `name → (provider, default_model)` map plus a default
//! key. Requests can target a provider by:
//!
//! 1. Explicit `provider` field in the request body (wins).
//! 2. `provider/model` form on the `model` field (e.g.
//!    `kimi/kimi-k2-thinking`).
//! 3. Configured prefix rules on the `model` (e.g. `kimi-*` →
//!    `kimi`). The binary populates these from `[provider].enabled`
//!    so unconfigured prefixes don't surprise-route to a missing
//!    provider.
//! 4. Fallback to the registry's default provider.

use std::collections::HashMap;
use std::sync::Arc;

use harness_core::LlmProvider;
use thiserror::Error;

#[derive(Clone)]
pub struct ProviderEntry {
    pub provider: Arc<dyn LlmProvider>,
    pub default_model: String,
    /// Models advertised to the UI via `GET /v1/providers`.
    /// Always contains `default_model` — `insert` dedupes the
    /// caller's list, so passing one without it is fine.
    pub models: Vec<String>,
}

impl std::fmt::Debug for ProviderEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderEntry")
            .field("default_model", &self.default_model)
            .field("models", &self.models)
            .finish_non_exhaustive()
    }
}

pub struct ProviderRegistry {
    by_name: HashMap<String, ProviderEntry>,
    default_name: String,
    prefix_rules: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub name: String,
    pub default_model: String,
    pub models: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Error)]
pub enum RouteError {
    #[error("provider `{0}` is not configured on this server")]
    UnknownProvider(String),
    #[error("no providers are configured on this server")]
    Empty,
}

impl ProviderRegistry {
    /// Build a registry with `default_name` as the fallback. The
    /// provider keyed by `default_name` must be inserted before
    /// `pick` is called — `Empty` is returned otherwise.
    pub fn new(default_name: impl Into<String>) -> Self {
        Self {
            by_name: HashMap::new(),
            default_name: default_name.into(),
            prefix_rules: Vec::new(),
        }
    }

    /// Insert a provider with just a default model. Convenience
    /// for tests / single-model deployments — `models` ends up
    /// containing only the default. Use `insert_with_models` to
    /// expose more.
    pub fn insert(
        &mut self,
        name: impl Into<String>,
        provider: Arc<dyn LlmProvider>,
        default_model: impl Into<String>,
    ) {
        let default_model: String = default_model.into();
        let models = vec![default_model.clone()];
        self.insert_with_models(name, provider, default_model, models);
    }

    /// Insert a provider with a curated `models` list. The
    /// `default_model` is auto-added to the list if missing, and
    /// duplicates collapse — order is preserved otherwise so
    /// operators control the picker order.
    pub fn insert_with_models(
        &mut self,
        name: impl Into<String>,
        provider: Arc<dyn LlmProvider>,
        default_model: impl Into<String>,
        models: Vec<String>,
    ) {
        let default_model: String = default_model.into();
        let mut deduped: Vec<String> = Vec::with_capacity(models.len() + 1);
        let mut seen = std::collections::HashSet::new();
        // Default first so it's the visual default in pickers.
        seen.insert(default_model.clone());
        deduped.push(default_model.clone());
        for m in models {
            if seen.insert(m.clone()) {
                deduped.push(m);
            }
        }
        self.by_name.insert(
            name.into(),
            ProviderEntry {
                provider,
                default_model,
                models: deduped,
            },
        );
    }

    /// Add a model-prefix routing rule. Rules are checked in
    /// insertion order; first match wins. The mapped provider must
    /// also be in `by_name` for the rule to take effect — unknown
    /// names are skipped silently so partial configurations don't
    /// blow up routing.
    pub fn with_prefix_rule(
        mut self,
        prefix: impl Into<String>,
        provider_name: impl Into<String>,
    ) -> Self {
        self.prefix_rules
            .push((prefix.into(), provider_name.into()));
        self
    }

    pub fn default_name(&self) -> &str {
        &self.default_name
    }

    pub fn list(&self) -> Vec<ProviderInfo> {
        let mut out: Vec<ProviderInfo> = self
            .by_name
            .iter()
            .map(|(name, entry)| ProviderInfo {
                name: name.clone(),
                default_model: entry.default_model.clone(),
                models: entry.models.clone(),
                is_default: name == &self.default_name,
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Pick a provider + concrete model for a request.
    ///
    /// `model` may be:
    /// - `None` — uses the picked provider's `default_model`.
    /// - `provider/foo` — the leading segment is treated as an
    ///   explicit provider name, and `foo` is the model sent on
    ///   the wire.
    /// - `foo` — looked up against `prefix_rules` and falls back to
    ///   the default provider; passed through verbatim as the model.
    pub fn pick(
        &self,
        explicit_provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<Routed<'_>, RouteError> {
        if self.by_name.is_empty() {
            return Err(RouteError::Empty);
        }

        // 1. Explicit `provider` field wins.
        if let Some(name) = explicit_provider {
            let entry = self
                .by_name
                .get(name)
                .ok_or_else(|| RouteError::UnknownProvider(name.into()))?;
            let resolved_model = model
                .map(str::to_string)
                .unwrap_or_else(|| entry.default_model.clone());
            return Ok(Routed { entry, model: resolved_model });
        }

        // 2. `provider/model` form on the `model` field.
        if let Some(m) = model {
            if let Some((prefix_name, rest)) = m.split_once('/') {
                if let Some(entry) = self.by_name.get(prefix_name) {
                    let resolved = if rest.is_empty() {
                        entry.default_model.clone()
                    } else {
                        rest.to_string()
                    };
                    return Ok(Routed {
                        entry,
                        model: resolved,
                    });
                }
                // Unknown prefix — fall through to prefix rules /
                // default; treat the slash-separated string as a
                // literal model name. Some real model ids contain
                // `/` (e.g. `meta-llama/llama-3-70b` on relays) so
                // this is the right policy.
            }

            // 3. Prefix rules on the bare model name.
            for (prefix, provider_name) in &self.prefix_rules {
                if m.starts_with(prefix.as_str()) {
                    if let Some(entry) = self.by_name.get(provider_name) {
                        return Ok(Routed {
                            entry,
                            model: m.to_string(),
                        });
                    }
                }
            }
        }

        // 4. Default provider.
        let entry = self
            .by_name
            .get(&self.default_name)
            .ok_or_else(|| RouteError::UnknownProvider(self.default_name.clone()))?;
        let resolved_model = model
            .map(str::to_string)
            .unwrap_or_else(|| entry.default_model.clone());
        Ok(Routed { entry, model: resolved_model })
    }
}

#[derive(Debug)]
pub struct Routed<'a> {
    pub entry: &'a ProviderEntry,
    pub model: String,
}

use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{ChatRequest, ChatResponse, Result as CoreResult};

    #[allow(dead_code)]
    struct NoopLlm(&'static str);
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            unreachable!("test-only stub")
        }
    }

    fn fixture() -> ProviderRegistry {
        let mut r = ProviderRegistry::new("openai")
            .with_prefix_rule("kimi-", "kimi")
            .with_prefix_rule("moonshot-", "kimi")
            .with_prefix_rule("claude-", "anthropic");
        r.insert("openai", Arc::new(NoopLlm("o")), "gpt-4o-mini");
        r.insert("kimi", Arc::new(NoopLlm("k")), "kimi-k2-thinking");
        r.insert("anthropic", Arc::new(NoopLlm("a")), "claude-3-5-sonnet-latest");
        r
    }

    #[test]
    fn explicit_provider_wins_over_model_prefix() {
        let r = fixture();
        let picked = r.pick(Some("openai"), Some("kimi-k2-thinking")).unwrap();
        assert_eq!(picked.entry.default_model, "gpt-4o-mini");
        assert_eq!(picked.model, "kimi-k2-thinking");
    }

    #[test]
    fn slash_form_routes_to_provider_and_strips_prefix() {
        let r = fixture();
        let picked = r.pick(None, Some("kimi/kimi-k2-thinking")).unwrap();
        assert_eq!(picked.entry.default_model, "kimi-k2-thinking");
        assert_eq!(picked.model, "kimi-k2-thinking");
    }

    #[test]
    fn slash_form_with_empty_model_uses_provider_default() {
        let r = fixture();
        let picked = r.pick(None, Some("kimi/")).unwrap();
        assert_eq!(picked.model, "kimi-k2-thinking");
    }

    #[test]
    fn prefix_rule_routes_bare_model() {
        let r = fixture();
        let picked = r.pick(None, Some("kimi-k2-turbo-preview")).unwrap();
        assert_eq!(picked.entry.default_model, "kimi-k2-thinking");
        assert_eq!(picked.model, "kimi-k2-turbo-preview");
    }

    #[test]
    fn no_match_falls_back_to_default() {
        let r = fixture();
        let picked = r.pick(None, Some("gpt-5.5")).unwrap();
        // No prefix rule for `gpt-5.` → default openai.
        assert_eq!(picked.entry.default_model, "gpt-4o-mini");
        assert_eq!(picked.model, "gpt-5.5");
    }

    #[test]
    fn no_model_uses_default_provider_default_model() {
        let r = fixture();
        let picked = r.pick(None, None).unwrap();
        assert_eq!(picked.entry.default_model, "gpt-4o-mini");
        assert_eq!(picked.model, "gpt-4o-mini");
    }

    #[test]
    fn unknown_explicit_provider_errors() {
        let r = fixture();
        let err = r.pick(Some("nonsense"), Some("gpt-4o-mini")).unwrap_err();
        assert!(matches!(err, RouteError::UnknownProvider(_)));
    }

    #[test]
    fn empty_registry_errors() {
        let r = ProviderRegistry::new("openai");
        let err = r.pick(None, None).unwrap_err();
        assert!(matches!(err, RouteError::Empty));
    }

    #[test]
    fn list_is_alpha_sorted_with_default_flagged() {
        let r = fixture();
        let infos = r.list();
        assert_eq!(infos.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
                   vec!["anthropic", "kimi", "openai"]);
        assert!(infos.iter().find(|i| i.name == "openai").unwrap().is_default);
        assert!(!infos.iter().find(|i| i.name == "kimi").unwrap().is_default);
    }
}
