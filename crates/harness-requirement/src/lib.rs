//! Execution orchestration for Project Requirements.
//!
//! Sibling to [`harness_core`]. Where `harness-core` owns the
//! Requirement *value type* (kanban row stored in
//! [`RequirementStore`](harness_core::RequirementStore)) **and** the
//! per-run records ([`RequirementRun`] etc., persisted via
//! [`RequirementRunStore`](harness_core::RequirementRunStore)), this
//! crate owns the *executable shape* of work: a context manifest
//! builder that gathers workspace instructions, plus thin re-exports
//! of the value types so existing import paths keep working.
//!
//! The single design rule: **`harness-core` knows nothing about
//! HTTP, providers, storage, or MCP.** This crate knows nothing about
//! HTTP either — it produces value types and helper functions. The
//! `harness-server` REST handlers and the binary's composition root
//! wire those into actual fresh-Conversation runs.
//!
//! Wire model parity: `RequirementRun` and friends serialise as
//! plain JSON. The frontend can reuse them in TypeScript without a
//! second translation layer.

pub mod events;
pub mod manifest;
pub mod model;

pub use events::RequirementRunEvent;
pub use harness_core::requirement_run::{
    CommandResult, RequirementRun, RequirementRunStatus, VerificationResult, VerificationStatus,
};
pub use manifest::{build_default_manifest, render_manifest_summary};
pub use model::{ContextKind, ContextRef, RequirementContextManifest, VerificationPlan};
