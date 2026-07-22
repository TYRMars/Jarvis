// WorkflowStore trait + WorkflowError.
// Ported from harness-workflow/src/lib.rs (the store + error subset).
//
// Persistence for WorkflowDefinitions and their WorkflowRuns. One trait
// covers both because runs live beside the definition they belong to (the
// same way RequirementRun rows hang off a Requirement). Concrete backends
// land in @jarvis/store later — this package only owns the interface.
//
// Rust→TS mapping for the trait methods:
//   - `Result<T, BoxError>` → `Promise<T>` (failures throw / reject).
//   - `Option<T>`           → `T | undefined`.
//   - `&str` args           → `string`; `Option<&str>` → `string | undefined`.
import type { WorkflowDefinition } from "./definition.ts";
import type { WorkflowRun } from "./run.ts";

/**
 * Persistence for {@link WorkflowDefinition}s and their {@link WorkflowRun}s.
 *
 * Implementations must be safe to share across async tasks (Rust:
 * `Send + Sync`). Backends live in `@jarvis/store`.
 */
export interface WorkflowStore {
  /** All definitions (newest-first not required). */
  list(): Promise<WorkflowDefinition[]>;
  /** Fetch one definition by id. `undefined` when absent. */
  get(id: string): Promise<WorkflowDefinition | undefined>;
  /** Create or replace a definition (last-write-wins). */
  upsert(def: WorkflowDefinition): Promise<void>;
  /** Remove a definition. `false` when it didn't exist. */
  delete(id: string): Promise<boolean>;

  /**
   * Runs, optionally filtered by `workflowId` and/or `requirementId` (both
   * `undefined` = every run).
   */
  listRuns(
    workflowId: string | undefined,
    requirementId: string | undefined,
  ): Promise<WorkflowRun[]>;
  /** Fetch one run by id. `undefined` when absent. */
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  /** Create or replace a run. */
  upsertRun(run: WorkflowRun): Promise<void>;
}

/**
 * Errors surfaced when validating workflow definitions. Mirrors the Rust
 * `WorkflowError` enum (`thiserror`); the `message` matches the Rust
 * `#[error(...)]` text so wire/log output is unchanged.
 */
export class WorkflowError extends Error {
  /** Discriminant mirroring the Rust enum variant. */
  readonly kind: "empty" | "empty_prompt" | "invalid_kind" | "missing_steps" | "too_deep";

  private constructor(
    kind: "empty" | "empty_prompt" | "invalid_kind" | "missing_steps" | "too_deep",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
    this.kind = kind;
  }

  /** A definition had no executable steps. */
  static empty(): WorkflowError {
    return new WorkflowError("empty", "workflow must contain at least one agent step");
  }

  /** A step carried an empty prompt (`name` is the offending step's name). */
  static emptyPrompt(name: string): WorkflowError {
    return new WorkflowError("empty_prompt", `agent step '${name}' has an empty prompt`);
  }

  /** A step's `kind.type` was outside the known set (client typo). */
  static invalidKind(name: string, type: unknown): WorkflowError {
    return new WorkflowError(
      "invalid_kind",
      `step '${name}' has an unknown kind '${String(type)}'`,
    );
  }

  /** A container step (`pipeline`/`phase`/`parallel`) was missing its `steps` array. */
  static missingSteps(name: string, type: string): WorkflowError {
    return new WorkflowError(
      "missing_steps",
      `step '${name}' of kind '${type}' must carry a 'steps' array`,
    );
  }

  /** Step nesting exceeded the allowed depth (guards unbounded recursion). */
  static tooDeep(max: number): WorkflowError {
    return new WorkflowError("too_deep", `workflow step nesting exceeds the maximum depth of ${max}`);
  }
}
