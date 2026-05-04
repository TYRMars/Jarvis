//! `subagent.review` — runs a `verification_plan` against the work
//! produced by an earlier work-agent run and decides pass / fail.
//!
//! The reviewer is intentionally weaker than the work agent:
//!
//! - No `fs.write` / `fs.edit` / `fs.patch` — it cannot fix things,
//!   only describe what's broken.
//! - `shell.exec` is allowed because verification often means
//!   running the test suite, but the reviewer prompt strongly
//!   constrains it to test commands.
//! - The only mutation surface is `requirement.review_verdict` (a
//!   tool the composition root registers exclusively for this
//!   subagent — see follow-up step in the proposal). Pass / fail
//!   verdicts go through that tool so the auto loop can pick them
//!   up structured rather than parsing the assistant's prose.
//!
//! When the verdict is `fail`, the auto loop bounces the requirement
//! back to `InProgress` with the reviewer's commentary attached, so
//! the next work-agent pickup reads the feedback and adapts.

use crate::{InternalSubAgent, InternalSubAgentConfig};
use harness_core::{LlmProvider, ToolRegistry};
use std::sync::Arc;

pub const DESCRIPTION: &str =
    "Verify a completed requirement against its verification_plan. Read-only + test-running tools; outputs pass / fail through `requirement.review_verdict`. Use after a work agent has flipped a requirement to Review, when you want a second-opinion check before declaring Done.";

pub const SYSTEM_PROMPT: &str = "\
You are a reviewer subagent, not an implementer. Your job is to run \
the supplied `verification_plan` against the workspace and decide \
whether the work meets it.

Rules:
- You CANNOT modify the workspace. There are no `fs.write`, \
  `fs.edit`, `fs.patch`, or `requirement.{create,update,delete}` \
  tools available to you.
- You CAN: read files, grep, inspect git history, and run test \
  commands via `shell.exec`. Restrict `shell.exec` to checks the \
  `verification_plan` calls for (test runs, type-checks, lints) — \
  do not use it to mutate state.
- Be strict. If the verification_plan isn't fully satisfied, the \
  verdict is `fail`. Ambiguous evidence is `fail` — describe what \
  would clarify it in the commentary so the work agent can act on \
  the feedback.
- End with a single call to `requirement.review_verdict` with \
  arguments `{ verdict: \"pass\" | \"fail\", commentary: <one or \
  two sentences>, evidence: [short bullets] }`. Do not call any \
  other tool after the verdict.

Output format: terse. Tool calls + a final assistant message that \
mirrors the verdict in plain text. The `requirement.review_verdict` \
call is the load-bearing output; the prose is for the human \
reading the activity timeline.
";

pub fn build(
    provider: Arc<dyn LlmProvider>,
    tools: Arc<ToolRegistry>,
    model: Option<String>,
) -> InternalSubAgent {
    InternalSubAgent::new(InternalSubAgentConfig {
        name: "review".into(),
        description: DESCRIPTION.into(),
        system_prompt: SYSTEM_PROMPT.into(),
        model,
        max_iterations: 8,
        provider,
        tools,
        // Reviewer can run shell commands, but those go through
        // their own approval (shell.exec already carries
        // requires_approval=true). The reviewer-as-tool itself
        // doesn't need a separate approval gate — it just delegates.
        requires_approval: false,
    })
}
