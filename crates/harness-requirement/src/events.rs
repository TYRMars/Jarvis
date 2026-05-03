//! Re-export shim for [`RequirementRunEvent`].
//!
//! The event type lived here historically. It moved to
//! [`harness_core::requirement_run::RequirementRunEvent`] so the
//! [`harness_core::RequirementRunStore`] trait could name it without
//! pulling `harness-requirement` into `harness-core`. Imports of
//! `harness_requirement::RequirementRunEvent` still work via this
//! re-export.

pub use harness_core::requirement_run::RequirementRunEvent;
