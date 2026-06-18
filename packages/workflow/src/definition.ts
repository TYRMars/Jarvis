// WorkflowDefinition + WorkflowStep + WorkflowStepKind + JoinPolicy.
// Ported from harness-workflow/src/lib.rs (the definition subset).
//
// A WorkflowDefinition is a reusable, multi-step agent recipe: an ordered
// list of WorkflowSteps a server-side runtime executes by driving the agent
// loop. The step vocabulary mirrors Claude Code's Workflow primitives:
//
//   - Agent    ≈ agent(prompt, …)  — one agent step.
//   - Pipeline ≈ pipeline(…)       — sequential, output of step N threads
//                                     into step N+1.
//   - Phase    ≈ phase(title)      — labelled sequential group (progress
//                                     boundary).
//   - Parallel ≈ parallel([…])     — fan-out with a join policy.
//
// In the Rust crate these derive `ts_rs::TS`; here the TypeScript is the
// source of truth. Field names, snake_case, and optionality are preserved
// EXACTLY so the JSON wire shape is unchanged. `skip_serializing_if` fields
// become optional (`?`) and are simply absent when default.
import { randomUUID } from "node:crypto";

// ---------- WorkflowStepKind ----------------------------------------------

/**
 * The executable shape of a {@link WorkflowStep}. In Rust this is an
 * externally-tagged enum on `type` (`#[serde(tag = "type", rename_all =
 * "snake_case")]`), so the wire form is a discriminated union the SPA can
 * switch on: `{"type":"agent",…}` / `{"type":"pipeline",…}` / etc.
 *
 * Recursive: `pipeline` / `phase` / `parallel` nest further steps.
 */
export type WorkflowStepKind =
  | {
      type: "agent";
      /**
       * Step instruction. Supports `{{ prev }}` (previous step output) and
       * `{{ outputs.<key> }}` (any prior step's `output_key`).
       */
      prompt: string;
      /**
       * Optional `subagent.<name>` to delegate to. Absent runs the main
       * agent loop. (Executor: subagent path is forward-compat.)
       */
      subagent?: string;
      /** Optional per-step model override (else the run's default). */
      model?: string;
      /**
       * Optional name to record this step's output under, so later steps can
       * interpolate `{{ outputs.<key> }}`.
       */
      output_key?: string;
    }
  | {
      type: "pipeline";
      /**
       * Children run in order; each child's output threads forward as
       * `{{ prev }}` to the next. `#[serde(default)]` → defaults to `[]`.
       */
      steps: WorkflowStep[];
    }
  | {
      type: "phase";
      /** Phase title (progress marker). */
      title: string;
      /** Sequential children. `#[serde(default)]` → defaults to `[]`. */
      steps: WorkflowStep[];
    }
  | {
      type: "parallel";
      /** Children run in parallel. `#[serde(default)]` → defaults to `[]`. */
      steps: WorkflowStep[];
      /** Failure handling. `#[serde(default)]` → defaults to `all_required`. */
      join: JoinPolicy;
    };

/**
 * How a `parallel` group treats child failures. Mirrors the semantics of
 * `JoinStrategy` without a hard dependency. Serialised snake_case.
 */
export type JoinPolicy = "all_required" | "best_effort";

/** Default `JoinPolicy` — `#[default] AllRequired`. */
export const DEFAULT_JOIN_POLICY: JoinPolicy = "all_required";

/** Every valid {@link JoinPolicy} wire string. */
export const JOIN_POLICIES: readonly JoinPolicy[] = ["all_required", "best_effort"];

/**
 * Parse a wire string into a {@link JoinPolicy}. `undefined` for unrecognised
 * values (REST handlers turn that into a 400). Mirrors `JoinPolicy::from_wire`.
 */
export function joinPolicyFromWire(s: string): JoinPolicy | undefined {
  return s === "all_required" || s === "best_effort" ? s : undefined;
}

// ---------- WorkflowStep ---------------------------------------------------

/**
 * One node in a {@link WorkflowDefinition}. Carries presentation metadata
 * (`id`, `name`) plus the executable {@link WorkflowStepKind}.
 */
export interface WorkflowStep {
  /**
   * Stable id within the definition (UUID v4). Referenced by
   * `WorkflowStepResult.step_id`.
   */
  id: string;
  /** Short label for the step. */
  name: string;
  /** What the step actually does. */
  kind: WorkflowStepKind;
}

/** Mint a step with a fresh id. Mirrors `WorkflowStep::new`. */
export function newWorkflowStep(name: string, kind: WorkflowStepKind): WorkflowStep {
  return { id: randomUUID(), name, kind };
}

// ---------- WorkflowDefinition ---------------------------------------------

/**
 * A reusable, multi-step agent recipe.
 *
 * The wire shape matches the JSON serialisation of the Rust struct. Optional
 * fields use `skip_serializing_if` in Rust, so here they are optional (`?`)
 * and simply absent when default — older rows on disk keep deserialising.
 */
export interface WorkflowDefinition {
  /** Stable identifier (UUID v4 string), server-allocated. */
  id: string;
  /**
   * Optional Project scope. Absent = a global workflow not tied to a single
   * project. (`#[serde(skip_serializing_if = "Option::is_none")]`.)
   */
  project_id?: string;
  /** Human label shown in catalogues and pickers. */
  name: string;
  /** Optional longer description of what the recipe does. */
  description?: string;
  /**
   * Ordered top-level steps. Executed in sequence; nested `parallel`
   * introduces concurrency. `#[serde(default)]` → defaults to `[]`.
   */
  steps: WorkflowStep[];
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 timestamp; bumped on every mutation via {@link touchDefinition}. */
  updated_at: string;
}

/**
 * Mint a new definition with a fresh UUID and current timestamps.
 * Mirrors `WorkflowDefinition::new`.
 */
export function newWorkflowDefinition(name: string): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    steps: [],
    created_at: now,
    updated_at: now,
  };
}

/** Bump `updated_at` to "now". Mirrors `WorkflowDefinition::touch`. */
export function touchDefinition(def: WorkflowDefinition): void {
  def.updated_at = new Date().toISOString();
}

/**
 * Depth-first count of every leaf `agent` step. Used by REST validation to
 * reject empty recipes. Mirrors `WorkflowDefinition::agent_step_count`.
 */
export function agentStepCount(def: WorkflowDefinition): number {
  return walkAgentSteps(def.steps);
}

function walkAgentSteps(steps: WorkflowStep[]): number {
  let total = 0;
  for (const step of steps) {
    const kind = step.kind;
    if (kind.type === "agent") {
      total += 1;
    } else {
      // pipeline / phase / parallel all carry nested `steps`.
      total += walkAgentSteps(kind.steps);
    }
  }
  return total;
}
