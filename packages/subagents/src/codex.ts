// `subagent.codex` — coding-style subagent backed by the OpenAI Codex
// Responses endpoint (path A: drive the same provider Jarvis authenticates
// against rather than shelling out to a Codex CLI). Ported from
// harness-subagents/src/codex.rs.
//
// The composition root supplies a `createAgent` factory whose inner registry
// holds the full coding suite (fs.*, shell.exec, git.*, code.grep,
// workspace.context) and MUST NOT include any subagent.* tools.
import { InternalSubAgent, type CreateAgent } from "./internal.ts";

export const DESCRIPTION =
  "Codex-style coding subagent backed by the ChatGPT-OAuth Responses endpoint. Can read, edit, and run shell commands inside the workspace. Use for coding tasks that benefit from a fresh context (refactors, focused bug fixes); the main agent stays on the conversation thread.";

export const SYSTEM_PROMPT = `You are a coding subagent. The caller has handed you a focused task and a workspace. Your job is to read the relevant code, make the change, run the existing tests / type-checks to verify, and report what you did.

Operating rules:
- Inspect before editing. Use \`fs.read\`, \`code.grep\`, and \`git.*\` to understand the surrounding code first. Don't pattern-match on the task description alone.
- Prefer small, reviewable patches. Use \`fs.edit\` for surgical changes; reach for \`fs.write\` only when creating a new file. \`fs.patch\` is for multi-hunk diffs.
- Verify. After editing, run \`shell.exec\` with the project's test / type-check / lint commands as appropriate. Don't claim success without evidence.
- Report concisely. Final assistant message should be: (1) what changed, (2) the files affected, (3) the verification commands you ran and their result.
- If the task is impossible or out-of-scope, say so and stop. Do not refactor adjacent code that wasn't asked for.

You do not have access to \`subagent.*\` tools — recursion is forbidden. Stay focused on the immediate task.
`;

/**
 * Build the codex subagent. Coding tasks need more iterations than read /
 * review (inspect + edit + verify cycle). Will mutate the workspace, so the
 * wrapping tool is approval-gated; per-tool gates inside the inner loop give
 * the user a second level of review.
 */
export function build(createAgent: CreateAgent, model?: string): InternalSubAgent {
  const config = {
    name: "codex",
    description: DESCRIPTION,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: 16,
    createAgent,
    requiresApproval: true,
  } as const;
  return new InternalSubAgent(model === undefined ? config : { ...config, model });
}
