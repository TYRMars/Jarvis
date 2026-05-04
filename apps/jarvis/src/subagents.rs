//! Composition-root wiring for the four built-in subagents.
//!
//! Called from [`crate::serve::run`] once the canonical tool
//! registry, primary LLM provider, and (optional) requirement +
//! activity stores are all in hand. Each subagent gets:
//!
//! 1. A per-subagent **tool subset** carved out of the canonical
//!    registry — read-only for `read_doc`, read+verdict for
//!    `review`, full coding for `codex`. The recursion guard drops
//!    every `subagent.*` tool from each subset (a subagent can't
//!    delegate to another subagent in v1.0).
//! 2. A pinned **system prompt** + **model** (cheap models for
//!    read_doc) — handled by the per-kind factory functions in
//!    `harness_subagents::{doc_reader, reviewer, codex}`.
//! 3. **Approval gating** at the wrapping `subagent.<name>` tool —
//!    `claude_code` and `codex` mutate the workspace and need the
//!    operator's OK once per dispatch.
//!
//! Failure modes are non-fatal: if the ClaudeCode SDK isn't on the
//! host, only `subagent.claude_code` is skipped (with one INFO log
//! line); the other three keep working.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use harness_core::{LlmProvider, ToolRegistry};
use harness_subagents::{
    claude_code, claude_code::ClaudeCodeSubAgent, codex, doc_reader, reviewer, SubAgent,
    SubAgentTool,
};
use harness_tools::RequirementReviewVerdictTool;
use tracing::{info, warn};

/// Drop in-place every tool whose name starts with `subagent.` —
/// ensures the inner agent can't call back into another subagent
/// (no recursion in v1.0). Mirrors `ToolRegistry::unregister_prefix`
/// but operates on a working clone.
fn strip_subagents(reg: &mut ToolRegistry) {
    reg.unregister_prefix("subagent");
}

/// Carve the canonical registry down to a read-only subset for the
/// doc reader. Drops every write / shell / mutating tool. Errs on
/// the side of inclusion: `time.now`, `echo`, and `git.*` (git read
/// suite) are kept as harmless context tools.
fn build_doc_reader_tools(canonical: &ToolRegistry) -> ToolRegistry {
    let mut reg = canonical.clone();
    strip_subagents(&mut reg);
    for n in [
        "fs.write",
        "fs.edit",
        "fs.patch",
        "shell.exec",
        "claude_code.run",
        "codex.run",
        "requirement.create",
        "requirement.update",
        "requirement.delete",
        "requirement.start",
        "requirement.block",
        "requirement.complete",
        "requirement.review_verdict",
        "roadmap.import",
        "todo.add",
        "todo.update",
        "todo.delete",
        "doc.upsert",
        "doc.delete",
        "project.create",
        "project.update",
        "project.delete",
        "project.archive",
        "project.restore",
    ] {
        reg.unregister(n);
    }
    reg
}

/// Reviewer's tool subset: read + git + shell.exec (for running
/// tests) + the verdict tool. Drops everything that would let it
/// edit code, mutate requirement state outside the verdict, or
/// recurse.
fn build_reviewer_tools(
    canonical: &ToolRegistry,
    requirement_store: Option<Arc<dyn harness_core::RequirementStore>>,
    activity_store: Option<Arc<dyn harness_core::ActivityStore>>,
) -> ToolRegistry {
    let mut reg = canonical.clone();
    strip_subagents(&mut reg);
    for n in [
        "fs.write",
        "fs.edit",
        "fs.patch",
        "claude_code.run",
        "codex.run",
        "requirement.create",
        "requirement.update",
        "requirement.delete",
        "requirement.start",
        "requirement.block",
        "requirement.complete",
        "roadmap.import",
        "todo.add",
        "todo.update",
        "todo.delete",
        "doc.upsert",
        "doc.delete",
        "project.create",
        "project.update",
        "project.delete",
        "project.archive",
        "project.restore",
    ] {
        reg.unregister(n);
    }
    // Reviewer's only mutation surface — only when the stores it
    // needs are configured. Without them, the reviewer can still
    // run but can't write its verdict; it'll error out at the tool
    // call, which the auto loop interprets as a fail verdict (safe
    // default).
    if let (Some(req), Some(act)) = (requirement_store, activity_store) {
        reg.register(RequirementReviewVerdictTool::new(req, act));
    }
    reg
}

/// Codex's tool subset: full coding tools, minus subagent recursion
/// and the requirement-state-mutating helpers (the work agent owns
/// requirement state; codex is a delegated coder, not a project
/// manager). `requirement.review_verdict` is also dropped — only
/// the reviewer subagent gets that.
fn build_codex_tools(canonical: &ToolRegistry) -> ToolRegistry {
    let mut reg = canonical.clone();
    strip_subagents(&mut reg);
    for n in [
        "claude_code.run",
        "codex.run",
        "requirement.create",
        "requirement.update",
        "requirement.delete",
        "requirement.start",
        "requirement.block",
        "requirement.complete",
        "requirement.review_verdict",
        "roadmap.import",
        "project.create",
        "project.update",
        "project.delete",
        "project.archive",
        "project.restore",
    ] {
        reg.unregister(n);
    }
    reg
}

/// Register the four built-in subagents into the canonical
/// `ToolRegistry`. Returns the count of subagents actually added so
/// the caller can log it. Fully non-fatal: missing dependencies
/// (e.g. ClaudeCode SDK) just skip the affected subagent.
pub async fn register_builtins(
    canonical: &Arc<RwLock<ToolRegistry>>,
    primary_provider: Arc<dyn LlmProvider>,
    workspace_root: PathBuf,
    requirement_store: Option<Arc<dyn harness_core::RequirementStore>>,
    activity_store: Option<Arc<dyn harness_core::ActivityStore>>,
) -> usize {
    if std::env::var_os("JARVIS_DISABLE_SUBAGENTS").is_some() {
        info!("subagents disabled via JARVIS_DISABLE_SUBAGENTS");
        return 0;
    }

    // Snapshot the canonical registry once for read; the subagent
    // tool subsets are clones of this snapshot. We do NOT lock for
    // the whole function — only when adding the wrappers back to
    // the canonical registry at the end.
    let snapshot = canonical
        .read()
        .map(|r| r.clone())
        .unwrap_or_else(|_| ToolRegistry::new());

    let mut to_register: Vec<Arc<dyn harness_core::Tool>> = Vec::new();

    // -- doc reader --
    let read_doc_tools = Arc::new(build_doc_reader_tools(&snapshot));
    let read_doc_model = std::env::var("JARVIS_SUBAGENT_READER_MODEL").ok();
    let read_doc = doc_reader::build(primary_provider.clone(), read_doc_tools, read_doc_model);
    to_register.push(Arc::new(SubAgentTool::new(
        Arc::new(read_doc) as Arc<dyn SubAgent>,
        workspace_root.clone(),
    )));

    // -- reviewer --
    let reviewer_tools = Arc::new(build_reviewer_tools(
        &snapshot,
        requirement_store.clone(),
        activity_store.clone(),
    ));
    let reviewer_model = std::env::var("JARVIS_SUBAGENT_REVIEWER_MODEL").ok();
    let reviewer = reviewer::build(primary_provider.clone(), reviewer_tools, reviewer_model);
    to_register.push(Arc::new(SubAgentTool::new(
        Arc::new(reviewer) as Arc<dyn SubAgent>,
        workspace_root.clone(),
    )));

    // -- codex --
    // v1.0 path A: reuse the primary provider. Once the user
    // configures a dedicated Codex provider (`JARVIS_PROVIDER=codex`
    // or a `[providers.codex]` config block), the composition root
    // can be extended to thread that provider in here. For now the
    // primary provider is used so this subagent always works.
    let codex_tools = Arc::new(build_codex_tools(&snapshot));
    let codex_model = std::env::var("JARVIS_SUBAGENT_CODEX_MODEL").ok();
    let codex = codex::build(primary_provider.clone(), codex_tools, codex_model);
    to_register.push(Arc::new(SubAgentTool::new(
        Arc::new(codex) as Arc<dyn SubAgent>,
        workspace_root.clone(),
    )));

    // -- claude_code --
    // Only registers when the Node SDK is reachable. Probe failure
    // is logged at INFO so an operator notices it but startup
    // continues uninterrupted.
    let node_bin = std::env::var("JARVIS_SUBAGENT_CLAUDE_CODE_NODE")
        .unwrap_or_else(|_| "node".into());
    match claude_code::probe(&node_bin).await {
        Ok(()) => {
            let cc_cfg = claude_code::ClaudeCodeConfig {
                node_bin,
                model: std::env::var("JARVIS_SUBAGENT_CLAUDE_CODE_MODEL").ok(),
            };
            let cc = ClaudeCodeSubAgent::new(cc_cfg);
            to_register.push(Arc::new(SubAgentTool::new(
                Arc::new(cc) as Arc<dyn SubAgent>,
                workspace_root.clone(),
            )));
            info!("subagent.claude_code registered (Node SDK probe ok)");
        }
        Err(reason) => {
            info!(reason = %reason, "subagent.claude_code skipped (probe failed; install `npm i -g @anthropic-ai/claude-agent-sdk` to enable)");
        }
    }

    let count = to_register.len();
    match canonical.write() {
        Ok(mut reg) => {
            for tool in to_register {
                reg.register_arc(tool);
            }
        }
        Err(e) => {
            warn!(error = %e, "failed to lock canonical tool registry — subagents not registered");
            return 0;
        }
    }

    info!(count, "subagents registered as `subagent.*` tools");
    count
}
