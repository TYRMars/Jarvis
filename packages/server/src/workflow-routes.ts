// REST surface for declarative workflows. Ported from
// harness-server/src/workflow_routes.rs (the CRUD + run-ledger subset).
//
// Every handler 503s when `state.workflows` is unset, so tests / specialised
// binaries that don't wire the store get a clean "not configured" signal
// instead of a panic — mirrors the conversations-routes `requireStore` pattern.
//
//   - GET/POST  /v1/workflows                 — list / create definitions.
//   - GET/PUT/DELETE /v1/workflows/:id         — fetch / update / delete.
//     (PATCH is also accepted as an alias for the update verb, since the Rust
//      source uses PATCH; both map to the same handler.)
//   - POST /v1/workflows/:id/run               — dispatch a run (optionally
//     bound to a requirement); returns 202 + the new WorkflowRun.
//   - GET  /v1/workflows/:id/runs              — run history for a definition.
//   - GET  /v1/workflow-runs/:run_id           — one run by id.
//   - POST /v1/workflow-runs/:run_id/cancel    — cancel an in-flight run.
//
// DEFERRAL (P-later): the Rust route reserves a process-wide concurrency slot
// (429 on exhaustion) and spawns `execute_workflow_run` in the background. The
// actual execution engine (workflow_runtime) + the concurrency gate / reaper
// land in a later phase. Until a runtime driver exists, `POST /:id/run` just
// persists a *Pending* run and returns 202 — nothing executes it yet, and
// there is no concurrency cap to enforce. `cancel` likewise has no live task to
// abort; it only finalises the persisted row.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  agentStepCount,
  finishWorkflowRun,
  newWorkflowDefinition,
  newWorkflowStep,
  touchDefinition,
  WorkflowError,
  workflowRunStatusIsTerminal,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowStore,
} from "@jarvis/workflow";
import { randomUUID } from "node:crypto";
import type { AppState } from "./state.ts";

// ---------- request bodies ----------

interface CreateWorkflowRequest {
  name?: string;
  description?: string;
  project_id?: string;
  steps?: WorkflowStep[];
}

interface PatchWorkflowRequest {
  name?: string;
  /** `""` clears the description; absent leaves it as-is. */
  description?: string;
  /** `""` clears the project scope; absent leaves it as-is. */
  project_id?: string;
  steps?: WorkflowStep[];
}

interface RunWorkflowRequest {
  requirement_id?: string;
}

// ---------- store guard ----------

/** Return the workflow store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): WorkflowStore | undefined {
  if (!state.workflows) {
    reply.code(503).send({ error: "workflow store not configured" });
    return undefined;
  }
  return state.workflows;
}

// ---------- helpers ----------

/** Trim a string, returning undefined when it's empty/whitespace-only. */
function cleanOpt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate the wire shape of a step tree, returning a human-readable error
 * string (or `null` when well-formed). `normalizeSteps` reads `s.kind.type`
 * and recurses into container `steps`, so a malformed payload (non-array, a
 * non-object step, or a step missing its `kind`) would throw a raw TypeError
 * → 500. Checking the shape first lets the routes answer 400 (see issue #415).
 */
function stepsShapeError(steps: unknown): string | null {
  if (!Array.isArray(steps)) return "steps must be an array";
  for (const s of steps) {
    if (s === null || typeof s !== "object") return "each step must be an object";
    const kind = (s as { kind?: unknown }).kind;
    if (kind === null || typeof kind !== "object") return "each step requires a `kind` object";
    const type = (kind as { type?: unknown }).type;
    if (typeof type !== "string") return "each step's `kind.type` must be a string";
    if (type === "pipeline" || type === "phase" || type === "parallel") {
      const nested = stepsShapeError((kind as { steps?: unknown }).steps);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Assign a fresh UUID to any step (recursively) whose id is blank, so clients
 * can POST step trees without minting ids themselves. Mirrors `normalize_steps`.
 */
function normalizeSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((s) => {
    const id = s.id != null && s.id.trim().length > 0 ? s.id : randomUUID();
    let kind: WorkflowStepKind = s.kind;
    if (kind.type === "pipeline") {
      kind = { type: "pipeline", steps: normalizeSteps(kind.steps) };
    } else if (kind.type === "phase") {
      kind = { type: "phase", title: kind.title, steps: normalizeSteps(kind.steps) };
    } else if (kind.type === "parallel") {
      kind = { type: "parallel", steps: normalizeSteps(kind.steps), join: kind.join };
    }
    return { id, name: s.name, kind };
  });
}

/**
 * Validate a definition: it must carry at least one agent step, and every
 * agent step's prompt must be non-empty. Throws {@link WorkflowError} (whose
 * `.message` matches the Rust `#[error(...)]` text). Mirrors `validate_steps`.
 */
function validateSteps(def: WorkflowDefinition): void {
  if (agentStepCount(def) === 0) {
    throw WorkflowError.empty();
  }
  const walk = (steps: WorkflowStep[]): void => {
    for (const step of steps) {
      const kind = step.kind;
      if (kind.type === "agent") {
        if (kind.prompt.trim().length === 0) {
          throw WorkflowError.emptyPrompt(step.name);
        }
      } else {
        walk(kind.steps);
      }
    }
  };
  walk(def.steps);
}

// ---------- routes ----------

export function registerWorkflowRoutes(app: FastifyInstance, state: AppState): void {
  // list
  app.get("/v1/workflows", async (_req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const items = await store.list();
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // create
  app.post("/v1/workflows", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as CreateWorkflowRequest;
    const name = typeof body.name === "string" ? body.name : "";
    if (name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required" });
    }
    // Guard optional fields before `cleanOpt`/`normalizeSteps` dereference them:
    // a mistyped `description`/`project_id`/`steps` would otherwise throw a raw
    // TypeError → 500 instead of a clean 400 (see issue #415).
    if (body.description !== undefined && typeof body.description !== "string") {
      return reply.code(400).send({ error: "description must be a string" });
    }
    if (body.project_id !== undefined && typeof body.project_id !== "string") {
      return reply.code(400).send({ error: "project_id must be a string" });
    }
    if (body.steps !== undefined) {
      const stepsErr = stepsShapeError(body.steps);
      if (stepsErr) return reply.code(400).send({ error: stepsErr });
    }
    const def = newWorkflowDefinition(name.trim());
    def.description = cleanOpt(body.description);
    def.project_id = cleanOpt(body.project_id);
    def.steps = normalizeSteps(body.steps ?? []);
    try {
      validateSteps(def);
    } catch (e) {
      if (e instanceof WorkflowError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    try {
      await store.upsert(def);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(def);
  });

  // get one
  app.get("/v1/workflows/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const def = await store.get(id);
      if (!def) return reply.code(404).send({ error: "workflow not found" });
      return reply.send(def);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // update — Rust uses PATCH; the task asks for PUT. Register both pointing at
  // the same handler so the wire contract holds either way.
  const updateHandler = async (req: { params: unknown; body: unknown }, reply: FastifyReply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let def: WorkflowDefinition | undefined;
    try {
      def = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!def) return reply.code(404).send({ error: "workflow not found" });
    const body = (req.body ?? {}) as PatchWorkflowRequest;
    // Guard each optional field's type before dereferencing (issue #415):
    // `name`/`description`/`project_id` feed `.trim()`/`cleanOpt`, and `steps`
    // feeds `normalizeSteps` — a mistyped value would throw a raw TypeError → 500.
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }
      def.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return reply.code(400).send({ error: "description must be a string" });
      }
      def.description = cleanOpt(body.description);
    }
    if (body.project_id !== undefined) {
      if (typeof body.project_id !== "string") {
        return reply.code(400).send({ error: "project_id must be a string" });
      }
      def.project_id = cleanOpt(body.project_id);
    }
    if (body.steps !== undefined) {
      const stepsErr = stepsShapeError(body.steps);
      if (stepsErr) return reply.code(400).send({ error: stepsErr });
      def.steps = normalizeSteps(body.steps);
    }
    try {
      validateSteps(def);
    } catch (e) {
      if (e instanceof WorkflowError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    touchDefinition(def);
    try {
      await store.upsert(def);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(def);
  };
  app.put("/v1/workflows/:id", updateHandler);
  app.patch("/v1/workflows/:id", updateHandler);

  // delete
  app.delete("/v1/workflows/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      if (!deleted) return reply.code(404).send({ error: "workflow not found" });
      return reply.code(204).send();
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // dispatch a run. DEFERRAL: the execution engine (workflow_runtime) + the
  // concurrency gate land later. For now we persist a *Pending* run and 202;
  // nothing executes it yet.
  app.post("/v1/workflows/:id/run", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let def: WorkflowDefinition | undefined;
    try {
      def = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!def) return reply.code(404).send({ error: "workflow not found" });

    // Resolve an optional requirement binding for this run.
    const body = (req.body ?? {}) as RunWorkflowRequest;
    const reqId = cleanOpt(body.requirement_id);
    let requirementId: string | undefined;
    if (reqId !== undefined) {
      if (!state.requirements) {
        return reply.code(503).send({ error: "requirement store not configured" });
      }
      let requirement;
      try {
        requirement = await state.requirements.get(reqId);
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
      if (!requirement) {
        return reply.code(400).send({ error: `requirement \`${reqId}\` not found` });
      }
      requirementId = requirement.id;
    }

    // Mint a Pending run. (Rust mints `running` + spawns the executor; without
    // a runtime driver we leave it Pending so a later phase can pick it up.)
    const run: WorkflowRun = {
      id: randomUUID(),
      workflow_id: def.id,
      status: "pending",
      step_results: [],
      started_at: new Date().toISOString(),
    };
    if (requirementId !== undefined) run.requirement_id = requirementId;
    try {
      await store.upsertRun(run);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(202).send(run);
  });

  // run history for a definition
  app.get("/v1/workflows/:id/runs", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const items = await store.listRuns(id, undefined);
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // one run by id
  app.get("/v1/workflow-runs/:run_id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const runId = (req.params as { run_id: string }).run_id;
    try {
      const run = await store.getRun(runId);
      if (!run) return reply.code(404).send({ error: "workflow run not found" });
      return reply.send(run);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // cancel an in-flight run. DEFERRAL: no live task to abort yet — we only
  // finalise the persisted row. Idempotent on already-terminal runs.
  app.post("/v1/workflow-runs/:run_id/cancel", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const runId = (req.params as { run_id: string }).run_id;
    let run: WorkflowRun | undefined;
    try {
      run = await store.getRun(runId);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!run) return reply.code(404).send({ error: "workflow run not found" });
    if (workflowRunStatusIsTerminal(run.status)) {
      // Already finished — nothing to abort. Idempotent success.
      return reply.send(run);
    }
    if (run.error === undefined) {
      run.error = "run cancelled by operator";
    }
    finishWorkflowRun(run, "cancelled");
    try {
      await store.upsertRun(run);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(run);
  });
}

// Re-export so the test file (and Assemble step) can reference the helper used
// to mint step trees without re-importing from @jarvis/workflow.
export { newWorkflowStep };
