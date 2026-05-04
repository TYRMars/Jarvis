//! `subagent.read_doc` — reads files / URLs and answers questions
//! about them. Uses a cheap model (Haiku-class) because the work is
//! summarisation + citation, not generation.
//!
//! Tool subset: read-only (`fs.read`, `fs.list`, `code.grep`,
//! `http.fetch`). Crucially **no** `fs.write/edit/patch`,
//! `shell.exec`, `requirement.*`, or `subagent.*`. The composition
//! root is responsible for handing in a `ToolRegistry` that obeys
//! that constraint — the runner doesn't enforce it (just like
//! `harness-tools::register_builtins` doesn't second-guess the
//! caller's flags).

use crate::{InternalSubAgent, InternalSubAgentConfig};
use harness_core::{LlmProvider, ToolRegistry};
use std::sync::Arc;

/// One-line description fed to the main agent's tool catalogue. Keep
/// it terse + actionable so the model picks `subagent.read_doc` over
/// directly grepping when the task is "summarise / explain / find".
pub const DESCRIPTION: &str =
    "Read files or URLs and answer a question about their contents. Cheap, read-only, returns a short summary with `path:line` citations. Prefer this over directly grepping when the task is to summarise, explain, or locate info in long documents.";

/// System prompt installed on the inner agent. Constrains the
/// subagent's role tightly: read-only, must cite, must refuse
/// modification asks. Kept as a `&'static str` so it shows up in
/// audit logs verbatim.
pub const SYSTEM_PROMPT: &str = "\
You are a document-reading subagent. Your only job is to extract \
information from files and URLs the caller points you at, then \
answer their question.

Rules:
- Read-only. You have NO write tools. Do not propose code changes \
  or edits — refuse and tell the caller to delegate to a coding \
  subagent.
- Cite. Every load-bearing claim must include `path:line` (for \
  files) or the URL (for web fetches).
- Concise. One paragraph of summary, then a bulleted list of \
  citations. Never repeat verbatim more than 3 lines from a source.
- Stop when answered. If the first read covers the question, do not \
  keep crawling — return the answer.
";

/// Build the doc-reader subagent. The caller supplies an LLM
/// provider (cheap one ideally) and a tool registry that contains
/// only read-only tools. `model` is optional — pass `Some("...")` to
/// pin a cheap-tier model (Haiku / 4o-mini / flash).
pub fn build(
    provider: Arc<dyn LlmProvider>,
    tools: Arc<ToolRegistry>,
    model: Option<String>,
) -> InternalSubAgent {
    InternalSubAgent::new(InternalSubAgentConfig {
        name: "read_doc".into(),
        description: DESCRIPTION.into(),
        system_prompt: SYSTEM_PROMPT.into(),
        model,
        max_iterations: 6,
        provider,
        tools,
        // Read-only — no approval needed.
        requires_approval: false,
    })
}
