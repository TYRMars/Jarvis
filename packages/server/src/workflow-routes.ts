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
// GOVERNANCE: when the composition root wires a `WorkflowRunGate` onto
// AppState (`state.workflowRunGate`), `POST /:id/run` reserves a process-wide
// concurrency permit (429 on exhaustion), mints a *Running* run, and drives it
// to completion in the background via `driveWorkflow` — with a cancel signal so
// `POST /workflow-runs/:id/cancel` can actually abort the live task. The
// stale-run reaper (spawned by the composition root) reclaims rows orphaned by
// a crash. When no gate is wired (a minimal embedder or a bare unit-test
// AppState), the route falls back to the historical deferral: persist a
// *Pending* run and 202 without executing, so gate-less setups still get a
// clean "queued" signal instead of a 500.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { Requirement } from "@jarvis/project";
import {
  agentStepCount,
  finishWorkflowRun,
  newWorkflowDefinition,
  newWorkflowRun,
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
import { driveWorkflow, failRunIfRunning, type DriveWorkflowOptions } from "./workflow-runtime.ts";

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
    if (body.name !== undefined) {
      if (body.name.trim().length === 0) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }
      def.name = body.name.trim();
    }
    if (body.description !== undefined) {
      def.description = cleanOpt(body.description);
    }
    if (body.project_id !== undefined) {
      def.project_id = cleanOpt(body.project_id);
    }
    if (body.steps !== undefined) {
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

  // dispatch a run. See the GOVERNANCE note at the top of this module: with a
  // run gate wired we reserve a permit, mint a Running run, and execute it in
  // the background; without one we fall back to persisting a Pending run.
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
    let requirement: Requirement | undefined;
    if (reqId !== undefined) {
      if (!state.requirements) {
        return reply.code(503).send({ error: "requirement store not configured" });
      }
      try {
        requirement = await state.requirements.get(reqId);
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
      if (!requirement) {
        return reply.code(400).send({ error: `requirement \`${reqId}\` not found` });
      }
    }

    const gate = state.workflowRunGate;
    if (gate) {
      // Governed path: reserve a concurrency permit BEFORE minting anything, so
      // a flood of POSTs at capacity 429s instead of fanning out unbounded.
      const permit = gate.tryAcquire();
      if (!permit) {
        return reply.code(429).send({ error: "workflow run concurrency limit reached" });
      }
      // Mint a Running run and persist it so an immediate GET reflects it.
      const run = newWorkflowRun(def.id, requirement?.id);
      try {
        await store.upsertRun(run);
      } catch (e) {
        permit.release();
        return reply.code(500).send({ error: errorText(e) });
      }
      // Register an abort controller so /cancel can stop the live task.
      const controller = new AbortController();
      gate.registerController(run.id, controller);
      const driveOpts: DriveWorkflowOptions = { run, signal: controller.signal };
      if (requirement) driveOpts.requirement = requirement;
      // Fire-and-forget: the run executes after we return 202. Guard the promise
      // so an unexpected throw reconciles the persisted row (never an
      // unhandledRejection), and always release the permit when it settles.
      void driveWorkflow(state, def, driveOpts)
        .catch((e) => failRunIfRunning(state, run.id, `workflow run crashed: ${errorText(e)}`))
        .finally(() => permit.release());
      return reply.code(202).send(run);
    }

    // Deferral path (no run gate wired): persist a Pending run and 202 without
    // executing — nothing picks it up until a gate/runtime is wired.
    const run: WorkflowRun = {
      id: randomUUID(),
      workflow_id: def.id,
      status: "pending",
      step_results: [],
      started_at: new Date().toISOString(),
    };
    if (requirement?.id !== undefined) run.requirement_id = requirement.id;
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

  // cancel an in-flight run. Aborts the live in-process task via the run gate
  // (a no-op when the run is orphaned or no gate is wired), then finalises the
  // persisted row. Idempotent on already-terminal runs.
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
    // Abort the live task (if any). The aborted run finalises itself as
    // `cancelled`; we still write the terminal row below so the response and
    // persisted state are consistent even when nothing live was aborted.
    state.workflowRunGate?.cancel(runId);
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
