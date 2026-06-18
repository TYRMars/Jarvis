// `plan.update` — push a structured plan snapshot into the agent event stream.
// Ported from harness-tools/src/plan.rs.
//
// The model calls this tool whenever it wants the UI to refresh the visible
// checklist of work-in-progress. The full plan is sent every time (REPLACE,
// not patch); transports surface it as a PlanUpdate event.
//
// Always-on, read-only with respect to the workspace: it touches no files,
// runs no processes, calls no network. The "side effect" is purely an event
// emission, relayed through the per-invocation plan channel (withPlan).
// Outside an agent loop the channel is absent and the emit is a no-op — so
// unit tests can invoke directly without standing up the whole harness.
import type { JsonValue, PlanItem, PlanStatus } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";
import { emitPlan } from "@jarvis/core";

const PLAN_STATUSES: readonly PlanStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

export class PlanUpdateTool implements Tool {
  readonly name = "plan.update";
  readonly category: ToolCategory = "read";
  readonly description =
    "Publish the agent's current plan as a structured checklist. " +
    "Each call REPLACES the previous plan snapshot — send every " +
    "step you want the user to see, not just the changed ones. " +
    "Use `id` (short kebab-case) to identify steps, `title` for " +
    "the headline, and `status` ∈ {pending, in_progress, " +
    'completed, cancelled}. Optional `note` is a one-line ' +
    'annotation (e.g. "blocked: missing fixture").';

  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
            note: { type: "string" },
          },
          required: ["id", "title", "status"],
        },
      },
    },
    required: ["items"],
  };

  async invoke(args: JsonValue): Promise<string> {
    const items = this.#parseItems(args);

    if (items.length === 0) {
      throw new Error(
        "plan.update: `items` must not be empty (use status=cancelled " +
          "on every item to clear the plan)",
      );
    }

    const n = items.length;
    emitPlan(items);
    // The model gets a tiny ack so the tool-call loop has a textual result to
    // feed back. Keep it short — the useful payload is the typed event the
    // transport relays.
    return `ok (${n} item(s))`;
  }

  // Parse + validate the `items` array, producing a friendly error containing
  // "invalid" when the model fumbles the schema (mirrors the Rust DTO-based
  // error message).
  #parseItems(args: JsonValue): PlanItem[] {
    const fail = (detail: string): never => {
      throw new Error(`plan.update: invalid \`items\` array: ${detail}`);
    };

    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return fail("expected an object with an `items` array");
    }
    const raw = args["items"];
    if (!Array.isArray(raw)) {
      return fail("`items` must be an array");
    }

    const out: PlanItem[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r === null || typeof r !== "object" || Array.isArray(r)) {
        return fail(`item ${i} must be an object`);
      }
      const id = r["id"];
      const title = r["title"];
      const status = r["status"];
      const note = r["note"];

      if (typeof id !== "string") return fail(`item ${i} is missing string field \`id\``);
      if (typeof title !== "string") return fail(`item ${i} is missing string field \`title\``);
      if (!isPlanStatus(status)) {
        return fail(
          `item ${i} has unknown \`status\` (expected one of ${PLAN_STATUSES.join(", ")})`,
        );
      }
      let noteValue: string | undefined;
      if (note !== undefined && note !== null) {
        if (typeof note !== "string") return fail(`item ${i} field \`note\` must be a string`);
        noteValue = note;
      }

      const item: PlanItem = { id, title, status };
      if (noteValue !== undefined) item.note = noteValue;
      out.push(item);
    }
    return out;
  }
}
