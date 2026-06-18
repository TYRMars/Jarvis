// `enter_plan_mode` — agent-initiated entry into Plan Mode.
// Ported from harness-tools/src/enter_plan_mode.rs.
//
// Companion to ExitPlanTool. When the model itself realises a request is
// risky / large enough to warrant a plan-first round, calling this flips the
// session into read-only investigation territory until the model finishes
// drafting and calls `exit_plan`.
//
// DEFERRAL: the Rust version emits PermissionMode::Plan on the shared
// `mode_signal` task-local channel (harness_core::mode_signal::emit) so the
// agent loop can relay AgentEvent::ModeChanged to the transport. @jarvis/core
// does not yet expose a mode-signal channel, so this port only returns the ack
// string — the actual mode flip is a no-op until the channel lands in core.
// This tool is off by default in register_builtins regardless.
//
// Registration: off by default. The composition root opts in. Most coding
// deployments want this on; locked-down deployments leave it off.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

export class EnterPlanModeTool implements Tool {
  readonly name = "enter_plan_mode";
  readonly description =
    "Switch the agent into Plan Mode: write/exec/network tools " +
    "are hidden, only read-only investigation tools (`fs.read`, " +
    "`code.grep`, `git.*`, `workspace.context`, ...) plus " +
    "`exit_plan` are exposed. The mode change takes effect on " +
    "the **next** user turn, not mid-turn. Call this when a " +
    "request is large or risky and you want to draft a plan " +
    "before touching anything. End the plan-mode cycle by " +
    'calling `exit_plan({plan: "..."})` from inside it. No ' +
    "arguments.";

  // Listed as Read so the Plan-Mode tool_filter never accidentally hides this
  // tool from a Plan-Mode session that wants to flip back into Plan Mode after
  // a refinement (no-op, but harmless).
  readonly category: ToolCategory = "read";
  readonly cacheable = true;

  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };

  async invoke(_args: JsonValue): Promise<string> {
    // DEFERRED: emit PermissionMode::Plan on the mode-signal channel once
    // @jarvis/core exposes one. For now this is a no-op signal-wise.
    return "plan mode armed for next turn";
  }
}
