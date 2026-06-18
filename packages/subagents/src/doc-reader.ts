// `subagent.read_doc` — reads files / URLs and answers questions about them.
// Uses a cheap model because the work is summarisation + citation. Ported from
// harness-subagents/src/doc_reader.rs.
//
// Tool subset: read-only (fs.read, fs.list, code.grep, http.fetch). NO
// fs.write/edit/patch, shell.exec, requirement.*, or subagent.*. The
// composition root hands in a `createAgent` factory whose inner registry obeys
// that constraint — the runner doesn't enforce it.
import { InternalSubAgent, type CreateAgent } from "./internal.ts";

export const DESCRIPTION =
  "Read files or URLs and answer a question about their contents. Cheap, read-only, returns a short summary with `path:line` citations. Prefer this over directly grepping when the task is to summarise, explain, or locate info in long documents.";

export const SYSTEM_PROMPT = `You are a document-reading subagent. Your only job is to extract information from files and URLs the caller points you at, then answer their question.

Rules:
- Read-only. You have NO write tools. Do not propose code changes or edits — refuse and tell the caller to delegate to a coding subagent.
- Cite. Every load-bearing claim must include \`path:line\` (for files) or the URL (for web fetches).
- Concise. One paragraph of summary, then a bulleted list of citations. Never repeat verbatim more than 3 lines from a source.
- Stop when answered. If the first read covers the question, do not keep crawling — return the answer.
`;

/**
 * Build the doc-reader subagent. `model` should pin a cheap-tier model
 * (Haiku / 4o-mini / flash) when available. Read-only — no approval needed.
 */
export function build(createAgent: CreateAgent, model?: string): InternalSubAgent {
  const config = {
    name: "read_doc",
    description: DESCRIPTION,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: 6,
    createAgent,
    requiresApproval: false,
  } as const;
  return new InternalSubAgent(model === undefined ? config : { ...config, model });
}
