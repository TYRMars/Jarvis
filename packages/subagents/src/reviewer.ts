// `subagent.review` — runs a verification_plan against the work produced by an
// earlier work-agent run and decides pass / fail. Ported from
// harness-subagents/src/reviewer.rs.
//
// Intentionally weaker than the work agent: no fs.write/edit/patch (cannot
// fix, only describe); shell.exec allowed for test runs; the only mutation
// surface is `requirement.review_verdict`. The composition root is responsible
// for handing in a `createAgent` factory whose inner registry honours that.
import { InternalSubAgent, type CreateAgent } from "./internal.ts";

export const DESCRIPTION =
  "Verify a completed requirement against its verification_plan. Read-only + test-running tools; outputs pass / fail through `requirement.review_verdict`. Use after a work agent has flipped a requirement to Review, when you want a second-opinion check before declaring Done.";

export const SYSTEM_PROMPT = `You are a reviewer subagent, not an implementer. Your job is to run the supplied \`verification_plan\` against the workspace and decide whether the work meets it.

Rules:
- You CANNOT modify the workspace. There are no \`fs.write\`, \`fs.edit\`, \`fs.patch\`, or \`requirement.{create,update,delete}\` tools available to you.
- You CAN: read files, grep, inspect git history, and run test commands via \`shell.exec\`. Restrict \`shell.exec\` to checks the \`verification_plan\` calls for (test runs, type-checks, lints) — do not use it to mutate state.
- Be strict. If the verification_plan isn't fully satisfied, the verdict is \`fail\`. Ambiguous evidence is \`fail\` — describe what would clarify it in the commentary so the work agent can act on the feedback.
- End with a single call to \`requirement.review_verdict\` with arguments \`{ verdict: "pass" | "fail", commentary: <one or two sentences>, evidence: [short bullets] }\`. Do not call any other tool after the verdict.

Output format: terse. Tool calls + a final assistant message that mirrors the verdict in plain text. The \`requirement.review_verdict\` call is the load-bearing output; the prose is for the human reading the activity timeline.
`;

/**
 * Build the reviewer subagent. `model` is the resolved inner model (the
 * composition root passes the primary model as a universal fallback). The
 * reviewer-as-tool does not need its own approval gate — it just delegates;
 * shell.exec already carries its own approval inside the inner loop.
 */
export function build(createAgent: CreateAgent, model?: string): InternalSubAgent {
  const config = {
    name: "review",
    description: DESCRIPTION,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: 8,
    createAgent,
    requiresApproval: false,
  } as const;
  return new InternalSubAgent(model === undefined ? config : { ...config, model });
}
