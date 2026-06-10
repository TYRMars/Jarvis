//! Difficulty tiers + the tier→model routing table.

use std::collections::HashMap;

/// Difficulty tier a single turn is classified into. Mirrors the
/// four-level scheme used by comparable routers: trivial confirmations
/// at `Simple`, deep multi-file analysis at `Reasoning`.
///
/// The [`HeuristicClassifier`](crate::HeuristicClassifier) only emits
/// `Simple` / `Medium` / `Complex`; `Reasoning` is reserved for the
/// future LLM judge but is a valid routing target today (operators may
/// map it even if nothing emits it yet).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tier {
    Simple,
    Medium,
    Complex,
    Reasoning,
}

impl Tier {
    /// Stable lowercase wire/log name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Simple => "simple",
            Tier::Medium => "medium",
            Tier::Complex => "complex",
            Tier::Reasoning => "reasoning",
        }
    }
}

/// One `(provider, model)` routing target. `provider` is a key into the
/// [`RoutingProvider`](crate::RoutingProvider)'s provider map; `model` is
/// the string written onto the outgoing request.
///
/// The `provider/model` slash form matches the rest of the harness
/// (`ProviderRegistry`, `[routing]` config), so operators reuse the same
/// syntax in `JARVIS_ROUTER_TIER_*` env vars.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

impl ModelRef {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
        }
    }

    /// Parse the `<provider>/<model>` wire form. Returns `None` when
    /// either side is empty so a typo'd env var falls through to the
    /// default target rather than routing to a half-specified model.
    pub fn parse(s: &str) -> Option<Self> {
        let (p, m) = s.split_once('/')?;
        if p.is_empty() || m.is_empty() {
            return None;
        }
        Some(Self::new(p, m))
    }
}

/// Tier→model table with a mandatory `default` fallback. Any tier with
/// no explicit entry resolves to `default`, so a partially-configured
/// router (e.g. only `Simple` mapped) is always well-defined.
#[derive(Debug, Clone)]
pub struct RouterConfig {
    pub default: ModelRef,
    pub tiers: HashMap<Tier, ModelRef>,
}

impl RouterConfig {
    pub fn new(default: ModelRef) -> Self {
        Self {
            default,
            tiers: HashMap::new(),
        }
    }

    /// Builder: map `tier` to `target`. Later calls overwrite earlier
    /// ones for the same tier.
    pub fn with_tier(mut self, tier: Tier, target: ModelRef) -> Self {
        self.tiers.insert(tier, target);
        self
    }

    /// Resolve a tier to its target, falling back to `default`.
    pub fn target(&self, tier: Tier) -> &ModelRef {
        self.tiers.get(&tier).unwrap_or(&self.default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_slash_form() {
        let r = ModelRef::parse("anthropic/claude-opus").unwrap();
        assert_eq!(r.provider, "anthropic");
        assert_eq!(r.model, "claude-opus");
    }

    #[test]
    fn parse_rejects_empty_segments() {
        assert!(ModelRef::parse("openai/").is_none());
        assert!(ModelRef::parse("/m").is_none());
        assert!(ModelRef::parse("noslash").is_none());
    }

    #[test]
    fn target_falls_back_to_default() {
        let cfg = RouterConfig::new(ModelRef::new("openai", "gpt-4o-mini"))
            .with_tier(Tier::Complex, ModelRef::new("anthropic", "claude-opus"));
        assert_eq!(cfg.target(Tier::Complex).model, "claude-opus");
        // Medium is unset → default.
        assert_eq!(cfg.target(Tier::Medium).model, "gpt-4o-mini");
    }
}
