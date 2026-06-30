// Persistent Requirement kanban tools — `requirement.{list,start,block,
// complete,create,update,delete,review_verdict}`. Ported from
// crates/harness-tools/src/requirement.rs.
//
// Surfaces the @jarvis/project RequirementStore + ActivityStore APIs to the
// LLM. Mirrors the status-mutation paths in the REST requirements routes but
// with typed schemas instead of HTTP-shaped bodies.
//
// Scope decisions (verbatim from the Rust):
//
// - `requirement.start` only flips status (Backlog/Review → InProgress). It
//   does NOT mint a fresh Conversation or trigger a run — that lives in the
//   server's start_run handler and the auto-mode scheduler. Tools mutate
//   metadata, not execution.
//
// - `requirement.block` does NOT change status — the wire RequirementStatus
//   has no Blocked variant (4-column kanban: Backlog / InProgress / Review /
//   Done). Instead the tool appends a `blocked` Activity row with the reason.
//
// - `requirement.complete` flips into Review and stops there. The final Done
//   transition is reserved for the human — structurally barred here.
//
// - `requirement.create / update / delete` create or remove backlog rows.
//   New agent-created rows default to triage_state=`proposed_by_agent` so
//   they sit in the triage queue until a human approves. `delete` is the only
//   approval-gated tool — it discards run history irrecoverably.
//
// - `requirement.review_verdict` is the reviewer subagent's terminal call:
//   `pass` flips Review → Done, `fail` bounces back to InProgress.
//
// Activity actor: tool-driven mutations record actor as Agent with a
// placeholder profile_id (`"tool"`).
import type { JsonValue, Tool, ToolCategory, ToolRegistry } from "@jarvis/core";
import type {
  ActivityKind,
  ActivityStore,
  ProjectStore,
  Requirement,
  RequirementStatus,
  RequirementStore,
  RequirementTodo,
  RequirementTodoCreator,
  RequirementTodoEvidence,
  RequirementTodoKind,
  RequirementTodoStatus,
  TriageState,
  VerificationPlan,
} from "@jarvis/project";
import {
  ensureExecutionChecklist,
  newActivity,
  newRequirement,
  newRequirementTodo,
  requirementStatusFromWire,
  requirementToWire,
  requirementTodoCreatorFromWire,
  requirementTodoKindFromWire,
  requirementTodoStatusFromWire,
  touchRequirement,
  triageStateFromWire,
} from "@jarvis/project";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

/**
 * Placeholder profile id used in the Agent actor when a tool-driven mutation
 * can't resolve the calling agent's identity. See the Rust module docs.
 */
const TOOL_ACTOR_PLACEHOLDER = "tool";

/** Serialise a requirement to its public wire object (matches the Rust). */
function requirementToJson(r: Requirement): JsonValue {
  return requirementToWire(r) as unknown as JsonValue;
}

/** Parse a wire status string, throwing on unknown values. */
function parseStatus(s: string): RequirementStatus {
  const status = requirementStatusFromWire(s);
  if (status === undefined) {
    throw new Error(
      `unknown status \`${s}\` — expected one of backlog / in_progress / review / done`,
    );
  }
  return status;
}

/**
 * Fire-and-forget audit append. Failures are swallowed (the Rust logs at
 * WARN) — losing a telemetry row should never break the user-visible
 * mutation.
 */
async function recordActivity(
  store: ActivityStore,
  requirementId: string,
  kind: ActivityKind,
  body: JsonValue,
): Promise<void> {
  const activity = newActivity(
    requirementId,
    kind,
    { type: "agent", profile_id: TOOL_ACTOR_PLACEHOLDER },
    body,
  );
  try {
    await store.append(activity);
  } catch {
    // Telemetry append failed — intentionally ignored so the mutation result
    // still returns. (Rust: tracing::warn!.)
  }
}

function asObject(args: JsonValue): { [k: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as { [k: string]: JsonValue };
  }
  return {};
}

function asString(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: JsonValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new Error("expected an array of strings");
  }
  return v.map((item) => {
    if (typeof item !== "string") {
      throw new Error("expected an array of strings");
    }
    return item;
  });
}

// ---------- requirement.list ----------------------------------------------

export class RequirementListTool implements Tool {
  readonly name = "requirement.list";
  readonly category: ToolCategory = "read";
  readonly description =
    "List the kanban requirements under a project, newest-updated " +
    "first. Requires `project_id` (UUID); call `project.list` " +
    "first if you don't have it. Optional `status` narrows to one " +
    "column (backlog / in_progress / review / done). Optional " +
    "`limit` caps results (default 50, max 500).";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project UUID. Use `project.list` to find it.",
      },
      status: {
        type: "string",
        enum: ["backlog", "in_progress", "review", "done"],
        description: "Optional column filter.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
        description: "Max rows to return. Defaults to 50.",
      },
    },
    required: ["project_id"],
  };

  readonly #store: RequirementStore;

  constructor(store: RequirementStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const projectId = (asString(obj["project_id"]) ?? "").trim();
    if (projectId === "") {
      throw new Error("requirement.list: `project_id` must not be blank");
    }
    const statusRaw = asString(obj["status"]);
    const statusFilter = statusRaw !== undefined ? parseStatus(statusRaw) : undefined;
    const limitRaw = obj["limit"];
    let limit = DEFAULT_LIST_LIMIT;
    if (typeof limitRaw === "number" && Number.isFinite(limitRaw)) {
      // Lower-clamp to the schema's `minimum: 1`; the JSON-schema bound is not
      // enforced at runtime, and a negative value would reach `slice(0, -N)`
      // and silently drop the last N rows instead of erroring.
      limit = Math.max(1, Math.min(Math.trunc(limitRaw), MAX_LIST_LIMIT));
    }
    let items = await this.#store.list(projectId);
    if (statusFilter !== undefined) {
      items = items.filter((r) => r.status === statusFilter);
    }
    items = items.slice(0, limit);
    return JSON.stringify({
      project_id: projectId,
      items: items.map(requirementToJson),
      count: items.length,
    });
  }
}

// ---------- requirement.start ---------------------------------------------

export class RequirementStartTool implements Tool {
  readonly name = "requirement.start";
  readonly category: ToolCategory = "write";
  readonly description =
    "Mark a requirement as actively being worked on (flips status " +
    "to `in_progress`). Use when picking up a `backlog` card or " +
    "re-opening a `review` card after rework. Errors if the card " +
    "is already `done` — explicitly re-open via PATCH if that's " +
    "intended. Does NOT mint a fresh conversation or kick off an " +
    "agent run; the actual run is started by the auto-mode " +
    "scheduler or by a human pressing Run in the UI. This tool " +
    "only advances board state.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string", description: "Requirement UUID." },
      note: {
        type: "string",
        description: "Optional one-liner for the audit timeline.",
      },
    },
    required: ["id"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.start: bad args: missing `id`");
    }
    const note = asString(obj["note"]);
    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`requirement.start: id \`${id}\` not found`);
    }
    if (item.status === "done") {
      throw new Error(
        `requirement.start: id \`${id}\` is already \`done\` — ` +
          "PATCH the status explicitly if you want to re-open it",
      );
    }
    const prior = item.status;
    if (prior === "in_progress") {
      // Idempotent: status already InProgress, leave the row alone but let the
      // activity timeline carry the note so the agent's intent is recorded.
      if (note !== undefined && note.trim() !== "") {
        await recordActivity(this.#activity, item.id, "comment", { text: note.trim() });
      }
      return JSON.stringify(requirementToJson(item));
    }
    item.status = "in_progress";
    touchRequirement(item);
    await this.#store.upsert(item);
    await recordActivity(this.#activity, item.id, "status_change", {
      from: prior,
      to: item.status,
    });
    if (note !== undefined && note.trim() !== "") {
      await recordActivity(this.#activity, item.id, "comment", { text: note.trim() });
    }
    return JSON.stringify(requirementToJson(item));
  }
}

// ---------- requirement.block ---------------------------------------------

export class RequirementBlockTool implements Tool {
  readonly name = "requirement.block";
  readonly category: ToolCategory = "write";
  readonly description =
    "Record that a requirement is blocked, with a reason. Use " +
    "when you've identified a blocker the user needs to resolve " +
    "(missing design, missing credentials, upstream bug). The " +
    "kanban does NOT have a Blocked column — the requirement " +
    "stays in its current column but gains a `blocked` row in " +
    "the audit timeline that the UI surfaces as a banner. Pair " +
    "with `requirement.start` once the blocker clears.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string", description: "Requirement UUID." },
      reason: {
        type: "string",
        description: "Why it's blocked. One sentence; user-readable.",
      },
    },
    required: ["id", "reason"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.block: bad args: missing `id`");
    }
    const reason = (asString(obj["reason"]) ?? "").trim();
    if (reason === "") {
      throw new Error("requirement.block: `reason` must not be blank");
    }
    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`requirement.block: id \`${id}\` not found`);
    }
    await recordActivity(this.#activity, item.id, "blocked", { reason });
    return JSON.stringify({
      id: item.id,
      blocked: true,
      reason,
    });
  }
}

// ---------- requirement.complete ------------------------------------------

export class RequirementCompleteTool implements Tool {
  readonly name = "requirement.complete";
  readonly category: ToolCategory = "write";
  readonly description =
    "Mark a requirement as ready for review (flips status to " +
    "`review`) and record a completion summary. The model NEVER " +
    "writes `done` — final acceptance is the human's call, " +
    "observed by reading the review and flipping the column. " +
    "Errors if the card is already `done`. If the card is " +
    "already in `review`, this tool only appends the completion " +
    "summary to the audit timeline.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string", description: "Requirement UUID." },
      summary: {
        type: "string",
        description: "What was done. 1-3 sentences; user-readable.",
      },
    },
    required: ["id", "summary"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.complete: bad args: missing `id`");
    }
    const summary = (asString(obj["summary"]) ?? "").trim();
    if (summary === "") {
      throw new Error("requirement.complete: `summary` must not be blank");
    }
    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`requirement.complete: id \`${id}\` not found`);
    }
    if (item.status === "done") {
      throw new Error(
        `requirement.complete: id \`${id}\` is already \`done\` — ` +
          "the human has accepted; no further mutation is allowed",
      );
    }
    const prior = item.status;
    // Structurally barred from writing Done — the only target is Review.
    if (prior !== "review") {
      item.status = "review";
      touchRequirement(item);
      await this.#store.upsert(item);
      await recordActivity(this.#activity, item.id, "status_change", {
        from: prior,
        to: item.status,
      });
    }
    await recordActivity(this.#activity, item.id, "comment", {
      text: summary,
      kind: "completion_summary",
    });
    return JSON.stringify(requirementToJson(item));
  }
}

// ---------- requirement.review_verdict ------------------------------------
//
// Tool the reviewer subagent uses to record its verdict. NOT part of the
// default tool registration — the composition root adds it ONLY to the
// reviewer subagent's tool registry so the work agent can never write `Done`
// directly.
//
//   - `pass`  → status: Review → Done, two Activity rows (StatusChange + Comment).
//   - `fail`  → status: Review → InProgress, two Activity rows.
//   - Errors out if the row isn't currently in `Review`.

export class RequirementReviewVerdictTool implements Tool {
  readonly name = "requirement.review_verdict";
  readonly category: ToolCategory = "write";
  readonly description =
    "Record a reviewer verdict on a requirement currently in Review. " +
    "`pass` flips it to Done; `fail` bounces it back to InProgress " +
    "with the commentary attached so the next work-agent pickup can " +
    "adapt. Reviewer subagents call this exactly once per run; the " +
    "main work agent does not have access to this tool.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Requirement UUID under review.",
      },
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
        description: "`pass` accepts the work; `fail` bounces it back.",
      },
      commentary: {
        type: "string",
        description:
          "1-2 sentence justification visible to humans and to the next work-agent pickup on `fail`.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional bullets — verification_plan items + their pass/fail status, file paths checked, etc.",
      },
    },
    required: ["id", "verdict", "commentary"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.review_verdict: bad args: missing `id`");
    }
    const commentary = (asString(obj["commentary"]) ?? "").trim();
    if (commentary === "") {
      throw new Error("requirement.review_verdict: `commentary` must not be blank");
    }
    const verdict = asString(obj["verdict"]);
    let pass: boolean;
    if (verdict === "pass") {
      pass = true;
    } else if (verdict === "fail") {
      pass = false;
    } else {
      throw new Error(
        `requirement.review_verdict: bad verdict \`${verdict ?? ""}\` — expected \`pass\` or \`fail\``,
      );
    }
    const evidence = asStringArray(obj["evidence"]) ?? [];

    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`requirement.review_verdict: id \`${id}\` not found`);
    }
    if (item.status !== "review") {
      throw new Error(
        `requirement.review_verdict: id \`${id}\` is \`${item.status}\`, not \`review\` — ` +
          "reviewer should only run after work agent flipped to Review",
      );
    }

    const prior = item.status;
    item.status = pass ? "done" : "in_progress";
    touchRequirement(item);
    await this.#store.upsert(item);

    await recordActivity(this.#activity, item.id, "status_change", {
      from: prior,
      to: item.status,
    });
    await recordActivity(this.#activity, item.id, "comment", {
      text: commentary,
      kind: pass ? "review_passed" : "review_failed",
      evidence,
    });
    return JSON.stringify(requirementToJson(item));
  }
}

// ---------- requirement.create --------------------------------------------

/**
 * Parse a string `triage_state` argument into the enum, or fall back to a
 * context-appropriate default.
 */
function parseTriageState(
  raw: string | undefined,
  defaultWhenMissing: TriageState,
): TriageState {
  if (raw === undefined) {
    return defaultWhenMissing;
  }
  const parsed = triageStateFromWire(raw.trim());
  if (parsed === undefined) {
    throw new Error(
      `unknown triage_state \`${raw}\` — expected one of ` +
        "approved / proposed_by_agent / proposed_by_scan",
    );
  }
  return parsed;
}

/** Shape of a single `todos[]` entry on the create/update wire. */
interface RequirementTodoInput {
  title: string;
  kind?: string;
  status?: string;
  command?: string;
  evidence?: RequirementTodoEvidence;
  depends_on?: string[];
  created_by?: string;
}

/** Coerce a raw JSON value into a {@link RequirementTodoInput}. */
function todoInputFromJson(raw: JsonValue): RequirementTodoInput {
  const obj = asObject(raw);
  const title = asString(obj["title"]);
  if (title === undefined) {
    throw new Error("requirement todo `title` must be a string");
  }
  const input: RequirementTodoInput = { title };
  const kind = asString(obj["kind"]);
  if (kind !== undefined) input.kind = kind;
  const status = asString(obj["status"]);
  if (status !== undefined) input.status = status;
  const command = asString(obj["command"]);
  if (command !== undefined) input.command = command;
  const dependsOn = asStringArray(obj["depends_on"]);
  if (dependsOn !== undefined) input.depends_on = dependsOn;
  const createdBy = asString(obj["created_by"]);
  if (createdBy !== undefined) input.created_by = createdBy;
  const evidence = obj["evidence"];
  if (evidence !== undefined && evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)) {
    input.evidence = evidence as RequirementTodoEvidence;
  }
  return input;
}

/** Build a {@link RequirementTodo} from its input, validating enums. */
function todoFromInput(input: RequirementTodoInput): RequirementTodo {
  const title = input.title.trim();
  if (title === "") {
    throw new Error("requirement todo `title` must not be blank");
  }
  const kindWire = input.kind ?? "work";
  const kind: RequirementTodoKind | undefined = requirementTodoKindFromWire(kindWire);
  if (kind === undefined) {
    throw new Error(`unknown requirement todo kind \`${kindWire}\``);
  }
  const todo = newRequirementTodo(title, kind);
  if (input.status !== undefined) {
    const status: RequirementTodoStatus | undefined = requirementTodoStatusFromWire(input.status);
    if (status === undefined) {
      throw new Error(`unknown requirement todo status \`${input.status}\``);
    }
    todo.status = status;
  }
  if (input.command !== undefined) {
    const trimmed = input.command.trim();
    todo.command = trimmed === "" ? undefined : trimmed;
  }
  if (input.evidence !== undefined) {
    todo.evidence = input.evidence;
  }
  const deps = (input.depends_on ?? []).map((s) => s.trim()).filter((s) => s !== "");
  if (deps.length > 0) {
    todo.depends_on = deps;
  }
  if (input.created_by !== undefined) {
    const creator: RequirementTodoCreator | undefined = requirementTodoCreatorFromWire(
      input.created_by,
    );
    if (creator === undefined) {
      throw new Error(`unknown requirement todo creator \`${input.created_by}\``);
    }
    todo.created_by = creator;
  }
  return todo;
}

/** Coerce a raw JSON value into a {@link VerificationPlan}. */
function verificationPlanFromJson(raw: JsonValue): VerificationPlan {
  const obj = asObject(raw);
  const commands = asStringArray(obj["commands"]) ?? [];
  const plan: VerificationPlan = { commands };
  if (obj["require_diff"] === true) plan.require_diff = true;
  if (obj["require_tests"] === true) plan.require_tests = true;
  if (obj["require_human_review"] === true) plan.require_human_review = true;
  return plan;
}

export class RequirementCreateTool implements Tool {
  readonly name = "requirement.create";
  readonly category: ToolCategory = "write";
  readonly description =
    "Create a new requirement card under a project. The agent " +
    "calls this when a user describes work to be done, or when " +
    "decomposing a spec/doc into kanban rows. New rows default to " +
    "status=`backlog` and triage_state=`proposed_by_agent` — they " +
    "appear in the project's Triage queue and DO NOT run " +
    "automatically until a human approves. Pass " +
    '`triage_state=approved` only when the user has explicitly ' +
    'confirmed the card (e.g. "yes, add these and start"). ' +
    "Optional `verification_plan.commands` (e.g. " +
    '["cargo test"]) pin the verification gate that runs after ' +
    "each agent run finishes. Optional `depends_on` lists other " +
    "requirement ids that must reach `done` first. `todos` is the " +
    "Jarvis-owned execution checklist used as the completion " +
    "contract; provide it when generating requirements, otherwise " +
    "Jarvis initializes a conservative default from the plan.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project UUID. Use project.list to find it." },
      title: { type: "string", description: "One-sentence headline." },
      description: { type: "string", description: "Optional longer body (markdown allowed)." },
      verification_plan: {
        type: "object",
        description:
          'Optional pinned verification template. Has a `commands` array of shell strings (e.g. ["cargo test -p foo"]) and optional `require_diff` / `require_tests` / `require_human_review` booleans.',
        properties: {
          commands: { type: "array", items: { type: "string" } },
          require_diff: { type: "boolean" },
          require_tests: { type: "boolean" },
          require_human_review: { type: "boolean" },
        },
      },
      depends_on: {
        type: "array",
        items: { type: "string" },
        description:
          "Other requirement ids that must reach `done` before this one is auto-eligible.",
      },
      todos: {
        type: "array",
        description:
          "Jarvis-owned execution checklist for this requirement. Use for work steps, CI/CD commands, deploy checks, QA, or review gates that should be inspectable later and used to decide completion.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            kind: { type: "string", enum: ["work", "check", "ci", "deploy", "review", "manual"] },
            status: {
              type: "string",
              enum: ["pending", "running", "passed", "failed", "skipped", "blocked"],
            },
            command: { type: "string" },
            depends_on: { type: "array", items: { type: "string" } },
            created_by: { type: "string", enum: ["human", "agent", "workflow"] },
            evidence: { type: "object" },
          },
          required: ["title"],
        },
      },
      triage_state: {
        type: "string",
        enum: ["approved", "proposed_by_agent", "proposed_by_scan"],
        description:
          "Triage gate. Defaults to `proposed_by_agent` so agent-created rows wait for human approval. Pass `approved` only when the user explicitly confirmed.",
      },
    },
    required: ["project_id", "title"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const projectId = (asString(obj["project_id"]) ?? "").trim();
    if (projectId === "") {
      throw new Error("requirement.create: `project_id` must not be blank");
    }
    const title = (asString(obj["title"]) ?? "").trim();
    if (title === "") {
      throw new Error("requirement.create: `title` must not be blank");
    }
    // Agent-driven creation defaults to ProposedByAgent — the model can
    // override to Approved when the user confirms.
    const triageState = parseTriageState(asString(obj["triage_state"]), "proposed_by_agent");

    const req = newRequirement(projectId, title);
    const descriptionRaw = asString(obj["description"]);
    if (descriptionRaw !== undefined) {
      const trimmed = descriptionRaw.trim();
      if (trimmed !== "") {
        req.description = trimmed;
      }
    }
    const planRaw = obj["verification_plan"];
    if (planRaw !== undefined) {
      req.verification_plan = verificationPlanFromJson(planRaw);
    }
    const dependsOn = asStringArray(obj["depends_on"]);
    if (dependsOn !== undefined) {
      req.depends_on = dependsOn.filter((d) => d.trim() !== "");
    }
    if ((req.depends_on ?? []).some((d) => d === req.id)) {
      throw new Error(
        "requirement.create: `depends_on` must not contain the " +
          "requirement's own id (self-dependency)",
      );
    }
    const todosRaw = obj["todos"];
    if (todosRaw !== undefined) {
      if (!Array.isArray(todosRaw)) {
        throw new Error("requirement.create: `todos` must be an array");
      }
      const todos = req.todos ?? [];
      for (const raw of todosRaw) {
        todos.push(todoFromInput(todoInputFromJson(raw)));
      }
      req.todos = todos;
    }
    ensureExecutionChecklist(req);
    req.triage_state = triageState;

    await this.#store.upsert(req);
    // Audit: log creation as a Comment with kind=created so the timeline
    // carries the source channel.
    await recordActivity(this.#activity, req.id, "comment", {
      kind: "created",
      title: req.title,
      triage_state: req.triage_state,
    });
    return JSON.stringify(requirementToJson(req));
  }
}

// ---------- requirement.update --------------------------------------------

export class RequirementUpdateTool implements Tool {
  readonly name = "requirement.update";
  readonly category: ToolCategory = "write";
  readonly description =
    "Update mutable metadata on an existing requirement. Pass any " +
    "subset of {title, description, verification_plan, depends_on, " +
    "todos, triage_state} — omitted fields keep their current " +
    "value. To clear `description`, pass an empty string. `todos` " +
    "replaces the Jarvis-owned execution checklist used as the " +
    "completion contract. Status transitions go " +
    "through requirement.{start,complete,block} instead, not this " +
    "tool.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string", description: "Empty string clears." },
      verification_plan: { type: "object" },
      depends_on: { type: "array", items: { type: "string" } },
      todos: {
        type: "array",
        description:
          "Replace the full Jarvis-owned execution checklist. Each item supports title, kind, status, command, evidence, depends_on, created_by.",
        items: { type: "object" },
      },
      triage_state: {
        type: "string",
        enum: ["approved", "proposed_by_agent", "proposed_by_scan"],
      },
    },
    required: ["id"],
  };

  readonly #store: RequirementStore;
  readonly #activity: ActivityStore;

  constructor(store: RequirementStore, activity: ActivityStore) {
    this.#store = store;
    this.#activity = activity;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.update: bad args: missing `id`");
    }
    const item = await this.#store.get(id);
    if (item === undefined) {
      throw new Error(`requirement.update: id \`${id}\` not found`);
    }
    const priorTriage: TriageState = item.triage_state ?? "approved";
    let changed = false;

    if (obj["title"] !== undefined) {
      const trimmed = (asString(obj["title"]) ?? "").trim();
      if (trimmed === "") {
        throw new Error("requirement.update: `title` must not be blank");
      }
      if (item.title !== trimmed) {
        item.title = trimmed;
        changed = true;
      }
    }
    if (obj["description"] !== undefined) {
      const trimmed = (asString(obj["description"]) ?? "").trim();
      const newDesc = trimmed === "" ? undefined : trimmed;
      if (item.description !== newDesc) {
        item.description = newDesc;
        changed = true;
      }
    }
    if (obj["verification_plan"] !== undefined) {
      item.verification_plan = verificationPlanFromJson(obj["verification_plan"]);
      changed = true;
    }
    if (obj["depends_on"] !== undefined) {
      const cleaned = (asStringArray(obj["depends_on"]) ?? []).filter((d) => d.trim() !== "");
      if (cleaned.some((d) => d === item.id)) {
        throw new Error(
          "requirement.update: `depends_on` must not contain the " +
            "requirement's own id (self-dependency)",
        );
      }
      const current = item.depends_on ?? [];
      if (!arraysEqual(current, cleaned)) {
        item.depends_on = cleaned;
        changed = true;
      }
    }
    if (obj["todos"] !== undefined) {
      const todosRaw = obj["todos"];
      if (!Array.isArray(todosRaw)) {
        throw new Error("requirement.update: `todos` must be an array");
      }
      const parsedTodos: RequirementTodo[] = [];
      for (const raw of todosRaw) {
        parsedTodos.push(todoFromInput(todoInputFromJson(raw)));
      }
      item.todos = parsedTodos;
      changed = true;
    }
    const triageRaw = asString(obj["triage_state"]);
    if (triageRaw !== undefined) {
      const parsedState = parseTriageState(triageRaw, "approved");
      if ((item.triage_state ?? "approved") !== parsedState) {
        item.triage_state = parsedState;
        changed = true;
      }
    }
    if (ensureExecutionChecklist(item)) {
      changed = true;
    }
    if (!changed) {
      return JSON.stringify(requirementToJson(item));
    }
    touchRequirement(item);
    await this.#store.upsert(item);
    const newTriage: TriageState = item.triage_state ?? "approved";
    if (priorTriage !== newTriage) {
      await recordActivity(this.#activity, item.id, "comment", {
        kind: "triage_change",
        from: priorTriage,
        to: newTriage,
      });
    }
    return JSON.stringify(requirementToJson(item));
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------- requirement.delete --------------------------------------------

export class RequirementDeleteTool implements Tool {
  readonly name = "requirement.delete";
  readonly category: ToolCategory = "write";
  // The ONLY approval-gated requirement.* tool — it discards run history
  // irrecoverably.
  readonly requiresApproval = true;
  readonly description =
    "Permanently remove a requirement row. Use sparingly — the " +
    "row's run history and activity timeline disappear with it. " +
    'For "this no longer applies" the better move is ' +
    "requirement.update setting triage_state=approved + " +
    "requirement.complete (lands in Review for the human to flip " +
    "to Done). This tool is gated by approval.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  };

  readonly #store: RequirementStore;

  constructor(store: RequirementStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("requirement.delete: bad args: missing `id`");
    }
    const deleted = await this.#store.delete(id);
    return JSON.stringify({ id, deleted });
  }
}

// ---------- registration helper -------------------------------------------

/**
 * Stores needed to construct the `requirement.*` tool family. `projects` is
 * accepted for parity with the Rust signature / future use; none of the
 * status-mutation tools read it today.
 */
export interface RequirementToolStores {
  requirements: RequirementStore;
  activities: ActivityStore;
  projects?: ProjectStore;
}

/**
 * Construct and register the default `requirement.*` tools into `registry`.
 * `requirement.review_verdict` is intentionally NOT registered here — the
 * composition root adds it only to the reviewer subagent's registry so the
 * work agent can never write `Done` directly (matches the Rust
 * `register_builtins`).
 */
export function registerRequirementTools(
  registry: ToolRegistry,
  stores: RequirementToolStores,
): void {
  const { requirements, activities } = stores;
  registry.register(new RequirementListTool(requirements));
  registry.register(new RequirementStartTool(requirements, activities));
  registry.register(new RequirementBlockTool(requirements, activities));
  registry.register(new RequirementCompleteTool(requirements, activities));
  registry.register(new RequirementCreateTool(requirements, activities));
  registry.register(new RequirementUpdateTool(requirements, activities));
  registry.register(new RequirementDeleteTool(requirements));
}
