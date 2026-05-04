//! `subagent.codex` — coding-style subagent backed by the OpenAI
//! Codex Responses endpoint (the same `chatgpt.com/backend-api/codex/responses`
//! the existing `harness_llm::ResponsesProvider::codex(CodexAuth)`
//! already speaks to).
//!
//! Path A from the design doc (`docs/proposals/subagents.zh-CN.md`):
//! we don't shell out to an external Codex CLI; we drive the same
//! provider Jarvis already authenticates against, with a
//! Codex-style system prompt + the full coding tool subset. Cheap
//! to wire up, full streaming visibility for free, no extra
//! external dependency.
//!
//! Trade-off: this is not Codex-CLI-byte-for-byte. Some of Codex's
//! prompt-engineering details (their plan format, special tool
//! semantics) are not replicated here. The system prompt below is a
//! conservative coding-agent prompt; if a user wants the official
//! Codex behaviour they should still use the (future) sidecar
//! variant once OpenAI ships an embeddable SDK.

use crate::{InternalSubAgent, InternalSubAgentConfig};
use harness_core::{LlmProvider, ToolRegistry};
use std::sync::Arc;

pub const DESCRIPTION: &str =
    "Codex-style coding subagent backed by the ChatGPT-OAuth Responses endpoint. Can read, edit, and run shell commands inside the workspace. Use for coding tasks that benefit from a fresh context (refactors, focused bug fixes); the main agent stays on the conversation thread.";

pub const SYSTEM_PROMPT: &str = "\
You are a coding subagent. The caller has handed you a focused task \
and a workspace. Your job is to read the relevant code, make the \
change, run the existing tests / type-checks to verify, and report \
what you did.

Operating rules:
- Inspect before editing. Use `fs.read`, `code.grep`, and `git.*` \
  to understand the surrounding code first. Don't pattern-match on \
  the task description alone.
- Prefer small, reviewable patches. Use `fs.edit` for surgical \
  changes; reach for `fs.write` only when creating a new file. \
  `fs.patch` is for multi-hunk diffs.
- Verify. After editing, run `shell.exec` with the project's \
  test / type-check / lint commands as appropriate. Don't claim \
  success without evidence.
- Report concisely. Final assistant message should be: (1) what \
  changed, (2) the files affected, (3) the verification commands \
  you ran and their result.
- If the task is impossible or out-of-scope, say so and stop. Do \
  not refactor adjacent code that wasn't asked for.

You do not have access to `subagent.*` tools — recursion is \
forbidden. Stay focused on the immediate task.
";

/// Build the codex subagent. The caller supplies an LLM provider —
/// typically `harness_llm::ResponsesProvider::codex(CodexAuth)` —
/// and a tool registry containing the full coding suite (`fs.*`,
/// `shell.exec`, `git.*`, `code.grep`, `workspace.context`). The
/// composition root must NOT include any `subagent.*` tools to
/// preserve the recursion guard.
pub fn build(
    provider: Arc<dyn LlmProvider>,
    tools: Arc<ToolRegistry>,
    model: Option<String>,
) -> InternalSubAgent {
    InternalSubAgent::new(InternalSubAgentConfig {
        name: "codex".into(),
        description: DESCRIPTION.into(),
        system_prompt: SYSTEM_PROMPT.into(),
        model,
        // Coding tasks tend to need more iterations than read /
        // review (file inspection + edit + verify cycle).
        max_iterations: 16,
        provider,
        tools,
        // Will mutate the workspace — every dispatch must go
        // through human approval. Within the subagent, individual
        // `fs.edit` / `shell.exec` calls also go through approval,
        // giving the user two levels of review.
        requires_approval: true,
    })
}
