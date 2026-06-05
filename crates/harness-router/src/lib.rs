//! Smart model routing for the Jarvis harness.
//!
//! `harness-router` sits between the agent loop and the concrete
//! [`harness_core::LlmProvider`] implementations. A [`RoutingProvider`]
//! is itself an `LlmProvider`: on each call it classifies the request's
//! difficulty into a [`Tier`] via a [`Classifier`], looks the tier up in
//! a [`RouterConfig`] tier→[`ModelRef`] table, rewrites
//! [`ChatRequest::model`](harness_core::ChatRequest), and delegates to the
//! matching downstream provider. Simple turns drop to a cheap model;
//! hard turns get the flagship — without the agent loop knowing routing
//! exists.
//!
//! ## Layering
//!
//! This crate depends on **`harness-core` only**. It names no provider
//! impl, no HTTP, no config format — the composition root
//! (`apps/jarvis`) reads env/config and constructs the
//! [`RoutingProvider`], handing it a `name → Arc<dyn LlmProvider>` map of
//! already-built providers to delegate to.
//!
//! ## Roadmap
//!
//! P0 (this module) ships the [`HeuristicClassifier`] — a zero-cost,
//! no-LLM difficulty heuristic — plus the routing wrapper. P1 adds a
//! `JudgeClassifier` (a cheap LLM scores difficulty) with sticky
//! per-session caching; P3 adds per-call cost stats. Both slot in behind
//! the [`Classifier`] trait and the `stats` hook without disturbing the
//! wiring established here.

pub mod classify;
pub mod provider;
pub mod tier;

pub use classify::{Classifier, HeuristicClassifier};
pub use provider::RoutingProvider;
pub use tier::{ModelRef, RouterConfig, Tier};
