// Persistent product requirements — the executable backlog under each Project.
//
// Ported from crates/harness-project/src/requirement.rs. `Requirement` is
// the server-side counterpart of the Web UI's /projects kanban (Backlog /
// In progress / Review / Done). The wire shape mirrors the frontend type at
// apps/jarvis-web/src/types/frames.ts so field names match verbatim.
import type { VerificationPlan } from "./requirement-run.ts";

// ---------- RequirementStatus ---------------------------------------------

/**
 * Kanban column / lifecycle state of a {@link Requirement}. Serialised
 * snake_case. Renderers should treat unknown statuses as `backlog`.
 */
export type RequirementStatus = "backlog" | "in_progress" | "review" | "done";

const REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  "backlog",
  "in_progress",
  "review",
  "done",
];

/** Parse a wire string. `undefined` for unrecognised values (REST → 400). */
export function requirementStatusFromWire(s: string): RequirementStatus | undefined {
  return (REQUIREMENT_STATUSES as readonly string[]).includes(s)
    ? (s as RequirementStatus)
    : undefined;
}

// ---------- RequirementTodo enums -----------------------------------------

/** Operational category of a {@link RequirementTodo}. Wire form snake_case. */
export type RequirementTodoKind = "work" | "check" | "ci" | "deploy" | "review" | "manual";

const REQUIREMENT_TODO_KINDS: readonly RequirementTodoKind[] = [
  "work",
  "check",
  "ci",
  "deploy",
  "review",
  "manual",
];

/** Parse a wire string. `undefined` for unrecognised values. */
export function requirementTodoKindFromWire(s: string): RequirementTodoKind | undefined {
  return (REQUIREMENT_TODO_KINDS as readonly string[]).includes(s)
    ? (s as RequirementTodoKind)
    : undefined;
}

/** Current state of a {@link RequirementTodo}. Wire form snake_case. */
export type RequirementTodoStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "blocked";

const REQUIREMENT_TODO_STATUSES: readonly RequirementTodoStatus[] = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "blocked",
];

/** Parse a wire string. `undefined` for unrecognised values. */
export function requirementTodoStatusFromWire(s: string): RequirementTodoStatus | undefined {
  return (REQUIREMENT_TODO_STATUSES as readonly string[]).includes(s)
    ? (s as RequirementTodoStatus)
    : undefined;
}

/** Who created a {@link RequirementTodo}. Wire form snake_case. */
export type RequirementTodoCreator = "human" | "agent" | "workflow";

const REQUIREMENT_TODO_CREATORS: readonly RequirementTodoCreator[] = ["human", "agent", "workflow"];

/** Parse a wire string. `undefined` for unrecognised values. */
export function requirementTodoCreatorFromWire(s: string): RequirementTodoCreator | undefined {
  return (REQUIREMENT_TODO_CREATORS as readonly string[]).includes(s)
    ? (s as RequirementTodoCreator)
    : undefined;
}

/** Latest proof attached to a {@link RequirementTodo}. */
export interface RequirementTodoEvidence {
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  run_id?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  exit_code?: number;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  stdout_excerpt?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  stderr_excerpt?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  artifact_url?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  note?: string;
}

/**
 * Structured TODO / check item scoped to one Requirement. The durable
 * execution ledger for a card — every item has a kind, status, optional
 * command, dependencies, and evidence.
 */
export interface RequirementTodo {
  /** Stable item id (UUID v4). */
  id: string;
  /** Short actionable label. */
  title: string;
  /** Operational category. */
  kind: RequirementTodoKind;
  /** Current state. */
  status: RequirementTodoStatus;
  /** Optional shell / workflow command. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  command?: string;
  /** Latest machine-readable proof. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  evidence?: RequirementTodoEvidence;
  /** Other TODO ids that must pass first. `#[serde(skip_serializing_if = "Vec::is_empty")]`. */
  depends_on?: string[];
  /** Who created the item. */
  created_by: RequirementTodoCreator;
  created_at: string;
  updated_at: string;
}

/** Mint a fresh todo (trimmed title, pending, created_by = human). */
export function newRequirementTodo(title: string, kind: RequirementTodoKind): RequirementTodo {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: title.trim(),
    kind,
    status: "pending",
    created_by: "human",
    created_at: now,
    updated_at: now,
  };
}

/** Bump a todo's `updated_at`. */
export function touchRequirementTodo(todo: RequirementTodo): void {
  todo.updated_at = new Date().toISOString();
}

// ---------- TriageState ----------------------------------------------------

/**
 * Triage gate for a {@link Requirement}. Distinguishes user-approved work
 * (default) from agent-proposed / scan-surfaced candidates. Wire form
 * snake_case. Older rows without the field deserialise as `approved`.
 */
export type TriageState = "approved" | "proposed_by_agent" | "proposed_by_scan";

const TRIAGE_STATES: readonly TriageState[] = ["approved", "proposed_by_agent", "proposed_by_scan"];

/** The default triage state (`approved`) for the `serde(default)` contract. */
export const DEFAULT_TRIAGE_STATE: TriageState = "approved";

/** Parse a wire string. `undefined` for unrecognised values (REST → 400). */
export function triageStateFromWire(s: string): TriageState | undefined {
  return (TRIAGE_STATES as readonly string[]).includes(s) ? (s as TriageState) : undefined;
}

/**
 * `true` for the `approved` default — used to decide whether `triage_state`
 * is skipped on the wire (`skip_serializing_if = "TriageState::is_default"`).
 */
export function triageStateIsDefault(s: TriageState): boolean {
  return s === "approved";
}

/** `true` when this gate requires a human to approve before auto execution. */
export function triageStateNeedsTriage(s: TriageState): boolean {
  return s !== "approved";
}

// ---------- AcceptancePolicy ----------------------------------------------

/**
 * Who decides Review → Done for a {@link Requirement}. Wire form snake_case.
 * Older rows without the field deserialise as the default `subagent`.
 *
 * NOTE: on the actual `Requirement`, `acceptance_policy` is a `#[serde(skip)]`
 * field — it never appears on the public wire shape. This type exists for the
 * standalone enum-mapping surface plus future internal use.
 */
export type AcceptancePolicy = "subagent" | "human";

const ACCEPTANCE_POLICIES: readonly AcceptancePolicy[] = ["subagent", "human"];

/** The default acceptance policy (`subagent`). */
export const DEFAULT_ACCEPTANCE_POLICY: AcceptancePolicy = "subagent";

/** Parse a wire string. `undefined` for unrecognised values (REST → 400). */
export function acceptancePolicyFromWire(s: string): AcceptancePolicy | undefined {
  return (ACCEPTANCE_POLICIES as readonly string[]).includes(s)
    ? (s as AcceptancePolicy)
    : undefined;
}

/** `true` for the `subagent` default. */
export function acceptancePolicyIsDefault(s: AcceptancePolicy): boolean {
  return s === "subagent";
}

// ---------- Requirement ----------------------------------------------------

/**
 * One persistent requirement scoped to a single Project. The wire shape
 * matches the JSON serialisation of this struct.
 *
 * Two Rust fields are `#[serde(skip)]` and therefore NEVER appear on the
 * public wire shape: `assignee_id` and `acceptance_policy`. They are kept on
 * the in-memory interface (optional) so internal callers can read them, but
 * {@link newRequirement} seeds the defaults and {@link requirementToWire}
 * strips them so JSON.stringify of a wire object matches Rust exactly.
 */
export interface Requirement {
  /** Stable identifier (UUID v4 string). */
  id: string;
  /** Foreign key into `Project.id`. Not enforced at the storage layer. */
  project_id: string;
  /** Headline. */
  title: string;
  /** Optional longer body. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  description?: string;
  /** Kanban column. */
  status: RequirementStatus;
  /** Conversations (by id) used to work on this requirement. `#[serde(default)]`. */
  conversation_ids: string[];
  /**
   * Legacy internal field. `#[serde(skip)]` — never on the public wire shape.
   * Stripped by {@link requirementToWire}.
   */
  assignee_id?: string;
  /** Optional pinned VerificationPlan. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  verification_plan?: VerificationPlan;
  /** Structured execution / verification checklist. `#[serde(skip_serializing_if = "Vec::is_empty")]`. */
  todos?: RequirementTodo[];
  /**
   * Triage gate (v1.0). `#[serde(skip_serializing_if = "TriageState::is_default")]`
   * — omitted on the wire when `approved`.
   */
  triage_state?: TriageState;
  /** Requirement ids that must reach `done` first. `#[serde(skip_serializing_if = "Vec::is_empty")]`. */
  depends_on?: string[];
  /** Project-scoped Label ids attached. `#[serde(skip_serializing_if = "Vec::is_empty")]`. */
  label_ids?: string[];
  /** Optional WorkflowDefinition bound to this requirement. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  workflow_id?: string;
  /**
   * Legacy internal field. `#[serde(skip)]` — never on the public wire shape.
   * Stripped by {@link requirementToWire}.
   */
  acceptance_policy?: AcceptancePolicy;
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp; bumped on every mutation. */
  updated_at: string;
}

/**
 * Mint a new requirement with a fresh UUID and current timestamps. Status
 * defaults to `backlog`; triage_state defaults to `approved`. The two
 * `#[serde(skip)]` defaults (`assignee_id = None`, `acceptance_policy =
 * subagent`) are seeded in-memory only.
 */
export function newRequirement(projectId: string, title: string): Requirement {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    title,
    status: "backlog",
    conversation_ids: [],
    triage_state: "approved",
    acceptance_policy: "subagent",
    created_at: now,
    updated_at: now,
  };
}

/** Bump `updated_at` to "now". Called by every mutator. */
export function touchRequirement(req: Requirement): void {
  req.updated_at = new Date().toISOString();
}

/**
 * Append `conversationId` to `conversation_ids` if not already present, then
 * touch. Returns `true` when appended; a no-op (no touch) when already linked.
 */
export function linkConversation(req: Requirement, conversationId: string): boolean {
  if (req.conversation_ids.some((c) => c === conversationId)) {
    return false;
  }
  req.conversation_ids.push(conversationId);
  touchRequirement(req);
  return true;
}

/**
 * Self-dependency check, mirroring the REST + tool validation: a requirement
 * may not list its own id in `depends_on`. Returns a human-readable reason
 * when invalid, or `null` when the dependency list is acceptable.
 */
export function validateNoSelfDependency(id: string, dependsOn: readonly string[]): string | null {
  if (dependsOn.some((dep) => dep === id)) {
    return "a requirement must not depend on itself";
  }
  return null;
}

/**
 * Ensure every requirement has a Jarvis-owned execution checklist. Returns
 * `true` when a checklist was seeded (no-op + `false` when `todos` is
 * already non-empty). Mirrors `Requirement::ensure_execution_checklist`.
 */
export function ensureExecutionChecklist(req: Requirement): boolean {
  if (req.todos !== undefined && req.todos.length > 0) {
    return false;
  }

  const todos: RequirementTodo[] = [];
  const plan = req.verification_plan;
  if (plan !== undefined) {
    for (const raw of plan.commands) {
      const command = raw.trim();
      if (command.length === 0) {
        continue;
      }
      const todo = newRequirementTodo(`Run verification: ${command}`, "ci");
      todo.command = command;
      todo.created_by = "workflow";
      todos.push(todo);
    }
    if (plan.require_diff === true) {
      const todo = newRequirementTodo("Confirm the run produced the required diff", "check");
      todo.created_by = "workflow";
      todos.push(todo);
    }
    if (plan.require_tests === true) {
      const todo = newRequirementTodo("Confirm relevant tests were executed", "check");
      todo.created_by = "workflow";
      todos.push(todo);
    }
  }

  if (todos.length === 0) {
    const seed: ReadonlyArray<[string, RequirementTodoKind]> = [
      ["Confirm the requirement scope is understood", "check"],
      ["Implement the customer-visible requirement", "work"],
      ["Verify the requirement is complete", "review"],
    ];
    for (const [title, kind] of seed) {
      const todo = newRequirementTodo(title, kind);
      todo.created_by = "workflow";
      todos.push(todo);
    }
  }

  req.todos = todos;
  touchRequirement(req);
  return true;
}

/**
 * Completion is based on the execution checklist: non-empty and every todo
 * is `passed` or `skipped`.
 */
export function executionChecklistPassed(req: Requirement): boolean {
  const todos = req.todos;
  return (
    todos !== undefined &&
    todos.length > 0 &&
    todos.every((t) => t.status === "passed" || t.status === "skipped")
  );
}

/** Any todo is `failed` or `blocked`. */
export function executionChecklistFailedOrBlocked(req: Requirement): boolean {
  const todos = req.todos;
  return todos !== undefined && todos.some((t) => t.status === "failed" || t.status === "blocked");
}

/**
 * True iff the checklist is exclusively the seeded boilerplate — every todo
 * was created by the workflow, has no `command`, and is still pending.
 */
export function executionChecklistIsDefaultSeeded(req: Requirement): boolean {
  const todos = req.todos;
  return (
    todos !== undefined &&
    todos.length > 0 &&
    todos.every(
      (t) =>
        t.created_by === "workflow" &&
        (t.command === undefined || t.command.trim().length === 0) &&
        t.status === "pending",
    )
  );
}

/**
 * The public wire shape of a {@link Requirement}: the two `#[serde(skip)]`
 * fields (`assignee_id`, `acceptance_policy`) are gone at the type level —
 * they never appear on the wire in Rust, so they cannot appear here either.
 * A default `triage_state` (`approved`) is additionally stripped at runtime by
 * {@link requirementToWire} (it stays a `?`-optional field on the type so the
 * non-default case still type-checks).
 */
export type RequirementWire = Omit<Requirement, "assignee_id" | "acceptance_policy">;

/**
 * Produce the public wire object for a Requirement so
 * `JSON.stringify(requirementToWire(r))` matches the Rust serialisation:
 *
 * - drops the two `#[serde(skip)]` fields (`assignee_id`, `acceptance_policy`)
 *   — they never appear on the public wire shape;
 * - drops a default `triage_state` (`approved`), mirroring
 *   `#[serde(skip_serializing_if = "TriageState::is_default")]`.
 *
 * Other `skip_serializing_if` fields (optional / empty-collection) are simply
 * absent in-memory when defaulted, so `JSON.stringify` omits them naturally.
 */
export function requirementToWire(req: Requirement): RequirementWire {
  const { assignee_id: _assignee, acceptance_policy: _policy, ...wire } = req;
  void _assignee;
  void _policy;
  if (wire.triage_state !== undefined && triageStateIsDefault(wire.triage_state)) {
    delete wire.triage_state;
  }
  return wire;
}

// ---------- RequirementEvent ----------------------------------------------

/**
 * Broadcast envelope sent on every successful RequirementStore mutation.
 * Serde shape: `#[serde(tag = "type", rename_all = "snake_case")]`. The
 * `Upserted(Requirement)` newtype variant flattens the requirement's fields
 * next to `type`.
 *
 * The `upserted` payload is the {@link RequirementWire} shape, NOT the raw
 * in-memory {@link Requirement}: in Rust `RequirementEvent::Upserted` is
 * serialised through serde, which honours the `#[serde(skip)]` on
 * `assignee_id` / `acceptance_policy` and the `skip_serializing_if` on a
 * default `triage_state`. Producers MUST build the variant via
 * {@link requirementUpsertedEvent} (or spread `requirementToWire(req)`) so the
 * fanned-out frame never leaks those fields. Spreading a raw `Requirement`
 * here would put `acceptance_policy:"subagent"` / `triage_state:"approved"` on
 * the wire — a shape the Rust server never emits.
 */
export type RequirementEvent =
  | ({ type: "upserted" } & RequirementWire)
  | { type: "deleted"; project_id: string; id: string };

/**
 * Build the `upserted` broadcast event for `req`, applying
 * {@link requirementToWire} so the frame matches the Rust serialisation
 * exactly (no `assignee_id` / `acceptance_policy`, no default `triage_state`).
 */
export function requirementUpsertedEvent(req: Requirement): RequirementEvent {
  return { type: "upserted", ...requirementToWire(req) };
}

/**
 * Build the `deleted` broadcast event. Mirrors
 * `RequirementEvent::Deleted { project_id, id }`.
 */
export function requirementDeletedEvent(projectId: string, id: string): RequirementEvent {
  return { type: "deleted", project_id: projectId, id };
}

/** Project key the event targets — used by WS handlers to filter. */
export function requirementEventProjectId(ev: RequirementEvent): string {
  return ev.project_id;
}
