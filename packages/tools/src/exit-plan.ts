// `exit_plan` — terminal tool used by Plan Mode.
// Ported from harness-tools/src/exit_plan.rs.
//
// In Plan Mode the LLM tool catalogue is filtered to read-only + `exit_plan`.
// The agent explores the workspace, drafts a plan, then calls
// `exit_plan({plan: "..."})` to hand the plan to the user. The `isTerminal`
// flag tells the agent loop to stop the turn immediately after this call
// (skipping any later tool calls in the same batch) and to emit a
// PlanProposed event so the transport can surface the plan card.
//
// The mode does NOT auto-switch on exit_plan — the user picks the post-mode
// when accepting the plan. Returns the plan body verbatim so transports that
// look at the tool result before the PlanProposed event still see meaningful
// content.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

export class ExitPlanTool implements Tool {
  readonly name = "exit_plan";
  readonly description =
    "End Plan Mode by submitting your proposed plan to the user. " +
    "Pass the full plan as `plan` (markdown is fine — bullet steps, " +
    "file paths, expected diffs). The agent's turn stops immediately " +
    "after this call; the user reviews the plan and either accepts " +
    "(choosing the next mode — ask / accept-edits / auto) or asks " +
    "you to refine. **Only available in Plan Mode.**";

  // Read so it survives the Plan-Mode filter that hides Write/Exec/Network.
  readonly category: ToolCategory = "read";
  readonly isTerminal = true;
  readonly cacheable = true;

  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "The complete plan you want the user to review. Markdown formatting recommended.",
      },
    },
    required: ["plan"],
  };

  async invoke(args: JsonValue): Promise<string> {
    const plan =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? args["plan"]
        : undefined;
    if (typeof plan !== "string") {
      throw new Error("missing `plan` argument");
    }
    if (plan.trim().length === 0) {
      throw new Error("`plan` must not be empty");
    }
    // Return the plan body verbatim.
    return plan;
  }
}
