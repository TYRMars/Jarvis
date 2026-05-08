//! Model route policy — Phase 4 of the model & tool compatibility
//! rollout. Lets the operator route different *task slots* to
//! different (provider, model) targets. The main agent keeps using
//! `default`; subagents and background tasks (review,
//! summarisation, doc reading, vision) consult their slot before
//! falling back to default.
//!
//! Two motivations:
//!
//! 1. **Cost control** — summarisation and doc reading work fine
//!    on cheap small models; coding wants the strongest model the
//!    operator pays for. A single "primary provider" couldn't
//!    express that.
//! 2. **Privacy / data-boundary** — some workspaces want
//!    `local_private` to route to a local Ollama model so the
//!    text never leaves the host, while everything else uses a
//!    cloud provider. The policy is the structural place to express
//!    that without re-plumbing every callsite.
//!
//! Phase 4 (this PR) lands the **types + config + read-side
//! REST**. Wiring the slots into actual callsites is per-callsite
//! work — the [`SummarizingMemory`] gets it first, with subagent
//! factories able to opt in by name.
//!
//! 429/5xx **fallback chain** lives on the type as `fallbacks` but
//! is not yet enforced — that's a follow-up that touches every
//! `LlmProvider::complete` call. The data shape is here so the
//! eventual retry wrapper can read it without a config-shape
//! migration.

use serde::{Deserialize, Serialize};

/// One `(provider, model)` target the policy can point a slot at.
/// Both fields are required — empty strings are treated as "unset"
/// at the call site (the picker returns `None` and the caller
/// falls through to `default`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTarget {
    pub provider: String,
    pub model: String,
}

impl ModelTarget {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
        }
    }

    /// Wire format `<provider>/<model>` matches the existing
    /// `provider/model` slash form on chat requests, so operators
    /// can use the same syntax in `[routing]` config blocks.
    pub fn parse(s: &str) -> Option<Self> {
        let (p, m) = s.split_once('/')?;
        if p.is_empty() || m.is_empty() {
            return None;
        }
        Some(Self::new(p, m))
    }
}

/// Slot identifier for the route policy. The "default" slot is the
/// fallback every callsite uses when its slot has no explicit
/// target. Slots correspond to the proposal § Auto routing list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteSlot {
    /// The main agent's default. Mirrors the registry's
    /// `default_provider` value, exposed here so the policy and
    /// the registry agree on a single source of truth.
    Default,
    Coding,
    Review,
    Summarization,
    DocReader,
    Vision,
    /// Privacy-sensitive workloads — typically a local Ollama / LM
    /// Studio model.
    LocalPrivate,
}

impl RouteSlot {
    pub const ALL: &'static [RouteSlot] = &[
        RouteSlot::Default,
        RouteSlot::Coding,
        RouteSlot::Review,
        RouteSlot::Summarization,
        RouteSlot::DocReader,
        RouteSlot::Vision,
        RouteSlot::LocalPrivate,
    ];

    pub fn as_wire(&self) -> &'static str {
        match self {
            RouteSlot::Default => "default",
            RouteSlot::Coding => "coding",
            RouteSlot::Review => "review",
            RouteSlot::Summarization => "summarization",
            RouteSlot::DocReader => "doc_reader",
            RouteSlot::Vision => "vision",
            RouteSlot::LocalPrivate => "local_private",
        }
    }
}

/// Operator-supplied route table. Every slot is optional; the
/// picker resolves a slot by:
///
/// 1. Look up the slot's explicit target.
/// 2. Fall through to `default`.
/// 3. If `default` is also unset, the caller defaults to its own
///    primary provider (set by the binary at startup).
///
/// `fallbacks` is the ordered chain consulted when the chosen
/// target's provider is unhealthy or returns a transient error.
/// Phase 4 stores this; future iteration wires it into the
/// `LlmProvider::complete` retry path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ModelRoutePolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summarization: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_reader: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_private: Option<ModelTarget>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fallbacks: Vec<ModelTarget>,
}

impl ModelRoutePolicy {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Resolve a slot. Returns the slot's target, or `default` if
    /// none, or `None` when neither is set (callers fall through
    /// to their primary provider).
    pub fn target_for(&self, slot: RouteSlot) -> Option<&ModelTarget> {
        let direct = match slot {
            RouteSlot::Default => self.default.as_ref(),
            RouteSlot::Coding => self.coding.as_ref(),
            RouteSlot::Review => self.review.as_ref(),
            RouteSlot::Summarization => self.summarization.as_ref(),
            RouteSlot::DocReader => self.doc_reader.as_ref(),
            RouteSlot::Vision => self.vision.as_ref(),
            RouteSlot::LocalPrivate => self.local_private.as_ref(),
        };
        direct.or(self.default.as_ref())
    }

    /// `true` iff at least one slot or fallback is set. Used by
    /// the binary to decide whether to log a startup line.
    pub fn is_empty(&self) -> bool {
        self.default.is_none()
            && self.coding.is_none()
            && self.review.is_none()
            && self.summarization.is_none()
            && self.doc_reader.is_none()
            && self.vision.is_none()
            && self.local_private.is_none()
            && self.fallbacks.is_empty()
    }

    pub fn set(&mut self, slot: RouteSlot, target: Option<ModelTarget>) {
        match slot {
            RouteSlot::Default => self.default = target,
            RouteSlot::Coding => self.coding = target,
            RouteSlot::Review => self.review = target,
            RouteSlot::Summarization => self.summarization = target,
            RouteSlot::DocReader => self.doc_reader = target,
            RouteSlot::Vision => self.vision = target,
            RouteSlot::LocalPrivate => self.local_private = target,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_parses_slash_form() {
        let t = ModelTarget::parse("openai/gpt-4o-mini").unwrap();
        assert_eq!(t.provider, "openai");
        assert_eq!(t.model, "gpt-4o-mini");
    }

    #[test]
    fn target_parse_rejects_empty_segments() {
        assert!(ModelTarget::parse("openai/").is_none());
        assert!(ModelTarget::parse("/foo").is_none());
        assert!(ModelTarget::parse("noslash").is_none());
    }

    #[test]
    fn slot_falls_back_to_default() {
        let mut p = ModelRoutePolicy::empty();
        p.default = Some(ModelTarget::new("openai", "gpt-4o-mini"));
        // No coding-specific target; falls back to default.
        let t = p.target_for(RouteSlot::Coding).unwrap();
        assert_eq!(t.provider, "openai");
    }

    #[test]
    fn explicit_slot_wins_over_default() {
        let mut p = ModelRoutePolicy::empty();
        p.default = Some(ModelTarget::new("openai", "gpt-4o-mini"));
        p.coding = Some(ModelTarget::new("codex", "gpt-5.4-codex"));
        let t = p.target_for(RouteSlot::Coding).unwrap();
        assert_eq!(t.provider, "codex");
        assert_eq!(t.model, "gpt-5.4-codex");
    }

    #[test]
    fn empty_policy_returns_none() {
        let p = ModelRoutePolicy::empty();
        assert!(p.is_empty());
        assert!(p.target_for(RouteSlot::Coding).is_none());
    }

    #[test]
    fn round_trip_through_serde() {
        let mut p = ModelRoutePolicy::empty();
        p.default = Some(ModelTarget::new(
            "openrouter",
            "anthropic/claude-sonnet-4.5",
        ));
        p.coding = Some(ModelTarget::new("codex", "gpt-5.4-codex"));
        p.fallbacks = vec![
            ModelTarget::new("openai", "gpt-5.4-mini"),
            ModelTarget::new("ollama", "qwen3:14b"),
        ];
        let s = serde_json::to_string(&p).unwrap();
        let back: ModelRoutePolicy = serde_json::from_str(&s).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn unknown_slots_are_rejected_by_serde() {
        // `deny_unknown_fields` keeps the schema strict so config
        // typos surface immediately at load time.
        let bad = r#"{ "summarisation": { "provider": "x", "model": "y" } }"#;
        assert!(serde_json::from_str::<ModelRoutePolicy>(bad).is_err());
    }
}
