// REST routes for the per-project Requirement kanban.
//
// Ported from crates/harness-server/src/requirements_routes.rs (the core
// subset: list + CRUD + triage approve/reject + manual reviewer dispatch +
// fresh-session run mint). Mounted only when `state.requirements` is set;
// each handler returns 503 otherwise — same convention as conversations.
//
// Endpoints:
//
// - `GET    /v1/projects/:project_id/requirements` — list, newest-first,
//   with an optional `?triage_state=` filter (`approved` /
//   `proposed_by_agent` / `proposed_by_scan` / the synthetic `proposed`
//   matching both `proposed_by_*`; anything else → 400).
// - `POST   /v1/projects/:project_id/requirements` — create.
// - `PATCH  /v1/requirements/:id` — partial update; status / triage_state
//   changes emit Activity rows.
// - `DELETE /v1/requirements/:id` — hard delete.
// - `POST   /v1/requirements/:id/approve` — triage → Approved, idempotent
//   (`{no_op:true}` when already approved).
// - `POST   /v1/requirements/:id/reject` — `{reason}` required; writes a
//   `rejected` Activity then soft-discards (hard delete) the row.
// - `POST   /v1/requirements/:id/review` — validate Review status +
//   Subagent acceptance policy, then 202 `{dispatched:true}`.
// - `POST   /v1/requirements/:id/runs` — mint a fresh-session run (new
//   conversation seeded with a manifest summary, linked back, Backlog →
//   InProgress auto-advance). Does NOT auto-start any agent loop.
// - `GET    /v1/requirements/:id/runs` — run history, newest first.
// - `GET    /v1/requirements/:id/activities` — audit timeline.
// - `GET    /v1/runs/:id` — fetch one run.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, newConversation, systemMessage } from "@jarvis/core";
import type { JsonValue } from "@jarvis/core";
import { defaultMetadata } from "@jarvis/store";
import type {
  AcceptancePolicy,
  Activity,
  ActivityActor,
  ActivityKind,
  ActivityStore,
  Requirement,
  RequirementRun,
  RequirementRunStore,
  RequirementStore,
  RequirementTodo,
  RequirementTodoEvidence,
  TriageState,
  VerificationPlan,
  VerificationResult,
} from "@jarvis/project";
import {
  finishRequirementRun,
  linkConversation,
  newActivity,
  newRequirement,
  newRequirementRun,
  newRequirementTodo,
  pushRequirementRunLog,
  requirementRunStatusIsTerminal,
  requirementStatusFromWire,
  requirementToWire,
  requirementTodoCreatorFromWire,
  requirementTodoKindFromWire,
  requirementTodoStatusFromWire,
  touchRequirement,
  touchRequirementTodo,
  triageStateFromWire,
  triageStateNeedsTriage,
} from "@jarvis/project";
import { DEFAULT_TIMEOUT_MS, executePlan } from "./verification.ts";
import type { AppState } from "./state.ts";

// ---------- store guards (503 when absent) --------------------------------

/** Return the requirement store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): RequirementStore | undefined {
  if (!state.requirements) {
    reply.code(503).send({ error: "requirement store not configured" });
    return undefined;
  }
  return state.requirements;
}

/**
 * Validate a request-body field that must be an array of strings, returning the
 * trimmed-non-empty subset. These routes attach no Fastify body schema, so the
 * value is arbitrary JSON at runtime; a non-array (or non-string element) would
 * throw an uncaught `TypeError` on `.filter`/`.trim` *before* the surrounding
 * `try`, surfacing as a 500 with the raw error string. Instead we send a clean
 * 400 via `reply` and return `null` so the caller bails. A `undefined` input
 * returns `undefined` (the caller leaves the field untouched).
 */
function stringArrayField(
  value: unknown,
  field: string,
  reply: FastifyReply,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    reply.code(400).send({ error: `\`${field}\` must be an array of strings` });
    return null;
  }
  return (value as string[]).filter((v) => v.trim() !== "");
}

/** Return the run store, or send a 503 and return undefined. */
function requireRunStore(state: AppState, reply: FastifyReply): RequirementRunStore | undefined {
  if (!state.requirementRuns) {
    reply.code(503).send({ error: "requirement run store not configured" });
    return undefined;
  }
  return state.requirementRuns;
}

/** Return the activity store, or send a 503 and return undefined. */
function requireActivityStore(state: AppState, reply: FastifyReply): ActivityStore | undefined {
  if (!state.activities) {
    reply.code(503).send({ error: "activity store not configured" });
    return undefined;
  }
  return state.activities;
}

/**
 * Fire-and-forget audit append. Failures are swallowed (Rust logs at WARN) —
 * the caller's response still goes through, since losing a telemetry row
 * should never break the user-visible mutation.
 */
async function recordActivity(
  state: AppState,
  requirementId: string,
  kind: ActivityKind,
  actor: ActivityActor,
  body: JsonValue,
): Promise<void> {
  const store = state.activities;
  if (!store) return;
  const activity: Activity = newActivity(requirementId, kind, actor, body);
  try {
    await store.append(activity);
  } catch {
    /* tolerate audit-append failure */
  }
}

// ---------- triage filter --------------------------------------------------

type TriageFilter = { kind: "exact"; target: TriageState } | { kind: "any_proposed" };

function triageFilterMatches(filter: TriageFilter, ts: TriageState): boolean {
  switch (filter.kind) {
    case "exact":
      return ts === filter.target;
    case "any_proposed":
      return triageStateNeedsTriage(ts);
  }
}

/** Default triage state for the `serde(default)` contract: missing → approved. */
function requirementTriageState(req: Requirement): TriageState {
  return req.triage_state ?? "approved";
}

const HUMAN_ACTOR: ActivityActor = { type: "human" };
const SYSTEM_ACTOR: ActivityActor = { type: "system" };

// ---------- request body shapes -------------------------------------------

interface CreateBody {
  title?: string;
  description?: string;
  status?: string;
  triage_state?: string;
  depends_on?: string[];
  label_ids?: string[];
}

interface UpdateBody {
  title?: string;
  description?: string;
  status?: string;
  conversation_ids?: string[];
  triage_state?: string;
  depends_on?: string[];
  label_ids?: string[];
  // `verification_plan` / `workflow_id` three-state semantics are part of the
  // full Rust handler but out of scope for this port (no plan/workflow wiring
  // on the Node AppState yet); a future pass adds them.
}

interface RejectBody {
  reason?: string;
}

export function registerRequirementsRoutes(app: FastifyInstance, state: AppState): void {
  // ---------------------- GET /v1/projects/:project_id/requirements -------
  app.get("/v1/projects/:project_id/requirements", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const projectId = (req.params as { project_id: string }).project_id;
    const triageRaw = (req.query as { triage_state?: string }).triage_state;

    let filter: TriageFilter | undefined;
    if (triageRaw !== undefined && triageRaw !== "") {
      if (triageRaw === "proposed") {
        filter = { kind: "any_proposed" };
      } else {
        const parsed = triageStateFromWire(triageRaw);
        if (!parsed) {
          return reply.code(400).send({ error: `unknown triage_state \`${triageRaw}\`` });
        }
        filter = { kind: "exact", target: parsed };
      }
    }

    try {
      let items = await store.list(projectId);
      if (filter) {
        items = items.filter((r) => triageFilterMatches(filter, requirementTriageState(r)));
      }
      return reply.send({ project_id: projectId, items: items.map(requirementToWire) });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- POST /v1/projects/:project_id/requirements ------
  app.post("/v1/projects/:project_id/requirements", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const projectId = (req.params as { project_id: string }).project_id;
    const body = (req.body ?? {}) as CreateBody;

    const title = (body.title ?? "").trim();
    if (title === "") {
      return reply.code(400).send({ error: "`title` must not be blank" });
    }
    const item = newRequirement(projectId, title);

    if (body.status !== undefined) {
      const parsed = requirementStatusFromWire(body.status);
      if (!parsed) return reply.code(400).send({ error: `unknown status \`${body.status}\`` });
      item.status = parsed;
    }
    if (body.triage_state !== undefined) {
      const parsed = triageStateFromWire(body.triage_state);
      if (!parsed) {
        return reply.code(400).send({ error: `unknown triage_state \`${body.triage_state}\`` });
      }
      item.triage_state = parsed;
    }
    if (body.depends_on !== undefined) {
      const parsed = stringArrayField(body.depends_on, "depends_on", reply);
      if (parsed === null) return reply;
      item.depends_on = parsed;
    }
    if (item.depends_on?.some((d) => d === item.id)) {
      return reply
        .code(400)
        .send({ error: "`depends_on` must not contain the requirement's own id (self-dependency)" });
    }
    if (body.label_ids !== undefined) {
      const parsed = stringArrayField(body.label_ids, "label_ids", reply);
      if (parsed === null) return reply;
      item.label_ids = parsed;
    }
    if (body.description !== undefined) {
      const trimmed = body.description.trim();
      item.description = trimmed === "" ? undefined : trimmed;
    }

    try {
      await store.upsert(item);
      return reply.code(201).send(requirementToWire(item));
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- PATCH /v1/requirements/:id ----------------------
  app.patch("/v1/requirements/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as UpdateBody;

    let item: Requirement | undefined;
    try {
      item = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });

    if (body.title !== undefined) {
      const trimmed = body.title.trim();
      if (trimmed === "") return reply.code(400).send({ error: "`title` must not be blank" });
      item.title = trimmed;
    }
    if (body.description !== undefined) {
      const trimmed = body.description.trim();
      item.description = trimmed === "" ? undefined : trimmed;
    }
    const priorStatus = item.status;
    if (body.status !== undefined) {
      const parsed = requirementStatusFromWire(body.status);
      if (!parsed) return reply.code(400).send({ error: `unknown status \`${body.status}\`` });
      item.status = parsed;
    }
    if (body.conversation_ids !== undefined) {
      item.conversation_ids = body.conversation_ids;
    }
    const priorTriage = requirementTriageState(item);
    if (body.triage_state !== undefined) {
      const parsed = triageStateFromWire(body.triage_state);
      if (!parsed) {
        return reply.code(400).send({ error: `unknown triage_state \`${body.triage_state}\`` });
      }
      item.triage_state = parsed;
    }
    if (body.depends_on !== undefined) {
      const parsed = stringArrayField(body.depends_on, "depends_on", reply);
      if (parsed === null) return reply;
      item.depends_on = parsed;
    }
    if (item.depends_on?.some((d) => d === item!.id)) {
      return reply
        .code(400)
        .send({ error: "`depends_on` must not contain the requirement's own id (self-dependency)" });
    }
    if (body.label_ids !== undefined) {
      const parsed = stringArrayField(body.label_ids, "label_ids", reply);
      if (parsed === null) return reply;
      item.label_ids = parsed;
    }
    touchRequirement(item);

    try {
      await store.upsert(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }

    if (item.status !== priorStatus) {
      await recordActivity(state, item.id, "status_change", HUMAN_ACTOR, {
        from: priorStatus,
        to: item.status,
      });
    }
    const newTriage = requirementTriageState(item);
    if (newTriage !== priorTriage) {
      await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
        kind: "triage_change",
        from: priorTriage,
        to: newTriage,
      });
    }
    return reply.send(requirementToWire(item));
  });

  // ---------------------- DELETE /v1/requirements/:id ---------------------
  app.delete("/v1/requirements/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      if (deleted) return reply.send({ deleted: true });
      return reply.code(404).send({ deleted: false, error: `requirement \`${id}\` not found` });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- POST /v1/requirements/:id/approve ---------------
  app.post("/v1/requirements/:id/approve", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;

    let item: Requirement | undefined;
    try {
      item = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });

    const prior = requirementTriageState(item);
    if (prior === "approved") {
      // Idempotent: already approved, no audit row, no upsert.
      return reply.send({ approved: true, requirement: requirementToWire(item), no_op: true });
    }
    item.triage_state = "approved";
    touchRequirement(item);
    try {
      await store.upsert(item);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
      kind: "approved",
      from: prior,
      to: requirementTriageState(item),
    });
    return reply.send({ approved: true, requirement: requirementToWire(item) });
  });

  // ---------------------- POST /v1/requirements/:id/reject ----------------
  app.post("/v1/requirements/:id/reject", async (req, reply) => {
    const body = (req.body ?? {}) as RejectBody;
    const reason = body.reason?.trim();
    if (!reason) {
      return reply.code(400).send({ error: "`reason` must not be blank" });
    }
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;

    let item: Requirement | undefined;
    try {
      item = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });

    const prior = requirementTriageState(item);
    // Reject = soft-discard: leave status alone, write the structured reason
    // to the audit timeline BEFORE deleting the row.
    await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
      kind: "rejected",
      reason,
      from: prior,
    });
    try {
      const deleted = await store.delete(id);
      return reply.send({ rejected: true, deleted, reason });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- POST /v1/requirements/:id/review ----------------
  // Manually dispatch the reviewer subagent against a row at Review status
  // under the Subagent acceptance policy. Wire shape mirrors Rust:
  //   - 202 { dispatched: true, requirement_id }
  //   - 404 unknown id
  //   - 409 "requirement not at review"        — row isn't at Review
  //   - 409 "human-policy requirement; complete manually" — Human policy
  // The actual reviewer dispatch hook is wired later; for now we validate the
  // preconditions, write the audit row, and return 202.
  app.post("/v1/requirements/:id/review", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;

    let item: Requirement | undefined;
    try {
      item = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });

    if (item.status !== "review") {
      return reply.code(409).send({ error: "requirement not at review", status: item.status });
    }
    const policy: AcceptancePolicy = item.acceptance_policy ?? "subagent";
    if (policy !== "subagent") {
      return reply
        .code(409)
        .send({ error: "human-policy requirement; complete manually", acceptance_policy: policy });
    }

    await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
      kind: "reviewer_dispatched_manually",
    });
    return reply.code(202).send({ dispatched: true, requirement_id: item.id });
  });

  // ---------------------- POST /v1/requirements/:id/runs ------------------
  // Mint a fresh-session run: build a manifest summary, mint a conversation
  // seeded with it, link the conversation back, auto-advance Backlog →
  // InProgress, persist the run, and write audit rows. Does NOT invoke the
  // agent loop — the client drives the run over the conversation WS/REST.
  // Requires both the requirement store and a conversation store (503 else).
  app.post("/v1/requirements/:id/runs", async (req, reply) => {
    const reqStore = requireStore(state, reply);
    if (!reqStore) return reply;
    const convoStore = state.store;
    if (!convoStore) {
      return reply.code(503).send({ error: "conversation store not configured" });
    }
    const id = (req.params as { id: string }).id;

    // 1. Load requirement.
    let requirement: Requirement | undefined;
    try {
      requirement = await reqStore.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!requirement) return reply.code(404).send({ error: `requirement \`${id}\` not found` });

    // 2. Build a manifest summary. The full workspace context manifest builder
    // is not yet ported to Node, so the summary is a compact textual digest of
    // the requirement itself — enough to seed the run conversation.
    const summary = renderManifestSummary(requirement);

    // 3. Mint a fresh conversation seeded with the summary as a system message.
    const conversationId = randomUUID();
    const conv = newConversation();
    conv.messages.push(systemMessage(summary));
    const metadata = { ...defaultMetadata(), project_id: requirement.project_id };
    try {
      await convoStore.saveEnvelope(conversationId, conv, metadata);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }

    // 4. Link conversation back to the requirement.
    const appended = linkConversation(requirement, conversationId);
    // 5. Auto-advance Backlog → InProgress.
    let advanced = false;
    if (requirement.status === "backlog") {
      requirement.status = "in_progress";
      touchRequirement(requirement);
      advanced = true;
    }
    if (appended || advanced) {
      try {
        await reqStore.upsert(requirement);
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
    }

    // 6. Mint a typed Pending run record. Persistence failure is tolerated
    // (losing the telemetry row should never lose the response).
    const run: RequirementRun = newRequirementRun(requirement.id, conversationId);
    pushRequirementRunLog(run, "info", "Run created", {
      conversation_id: conversationId,
      project_id: requirement.project_id,
    });
    if (state.requirementRuns) {
      try {
        await state.requirementRuns.upsert(run);
      } catch {
        /* tolerate run-store persist failure */
      }
    }

    // 7. Audit trail. Backlog → InProgress is a System actor (no human dragged
    // the card); the run start itself is attributed to Human (a REST POST).
    if (advanced) {
      await recordActivity(state, requirement.id, "status_change", SYSTEM_ACTOR, {
        from: "backlog",
        to: "in_progress",
        reason: "run_started",
      });
    }
    await recordActivity(state, requirement.id, "run_started", HUMAN_ACTOR, {
      run_id: run.id,
      conversation_id: conversationId,
    });

    return reply.code(201).send({
      run,
      conversation_id: conversationId,
      manifest_summary: summary,
      requirement: requirementToWire(requirement),
    });
  });

  // ---------------------- GET /v1/requirements/:id/runs -------------------
  app.get("/v1/requirements/:id/runs", async (req, reply) => {
    const runStore = requireRunStore(state, reply);
    if (!runStore) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const runs = await runStore.listForRequirement(id);
      return reply.send({ requirement_id: id, items: runs });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- GET /v1/requirements/:id/activities -------------
  app.get("/v1/requirements/:id/activities", async (req, reply) => {
    const actStore = requireActivityStore(state, reply);
    if (!actStore) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const items = await actStore.listForRequirement(id);
      return reply.send({ requirement_id: id, items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---------------------- GET /v1/runs/:id --------------------------------
  app.get("/v1/runs/:id", async (req, reply) => {
    const runStore = requireRunStore(state, reply);
    if (!runStore) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const run = await runStore.get(id);
      if (!run) return reply.code(404).send({ error: `run \`${id}\` not found` });
      return reply.send(run);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- requirement TODO checklist (embedded in the Requirement row) ----

  app.get("/v1/requirements/:id/todos", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      return reply.send({ requirement_id: id, items: item.todos ?? [] });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  app.post("/v1/requirements/:id/todos", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      title?: unknown;
      kind?: unknown;
      status?: unknown;
      command?: unknown;
      evidence?: unknown;
      depends_on?: unknown;
      created_by?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "") return reply.code(400).send({ error: "`title` must not be blank" });
    const kind = requirementTodoKindFromWire(typeof body.kind === "string" ? body.kind : "work");
    if (!kind) return reply.code(400).send({ error: `unknown todo kind \`${String(body.kind)}\`` });
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      const todo = newRequirementTodo(title, kind);
      if (typeof body.status === "string") {
        const s = requirementTodoStatusFromWire(body.status);
        if (!s) return reply.code(400).send({ error: `unknown todo status \`${body.status}\`` });
        todo.status = s;
      }
      if (typeof body.command === "string" && body.command.trim() !== "") todo.command = body.command.trim();
      if (body.evidence !== undefined && body.evidence !== null) {
        todo.evidence = body.evidence as RequirementTodoEvidence;
      }
      if (Array.isArray(body.depends_on)) {
        todo.depends_on = body.depends_on
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      }
      if (typeof body.created_by === "string") {
        const c = requirementTodoCreatorFromWire(body.created_by);
        if (!c) return reply.code(400).send({ error: `unknown todo creator \`${body.created_by}\`` });
        todo.created_by = c;
      }
      item.todos = [...(item.todos ?? []), todo];
      touchRequirement(item);
      await store.upsert(item);
      await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
        kind: "requirement_todo_created",
        todo_id: todo.id,
        todo_kind: todo.kind,
        title: todo.title,
      });
      return reply.code(201).send({ todo, requirement: item });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // Batch status update — one read-modify-write avoids the lost-update race of
  // fanning out N per-item PATCHes against the same row.
  app.patch("/v1/requirements/:id/todos", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { ids?: unknown; status?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) return reply.code(400).send({ error: "`ids` must be a non-empty array" });
    const status = typeof body.status === "string" ? requirementTodoStatusFromWire(body.status) : undefined;
    if (!status) return reply.code(400).send({ error: `unknown todo status \`${String(body.status)}\`` });
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      const todos = item.todos ?? [];
      const updated: RequirementTodo[] = [];
      for (const tid of ids) {
        const todo = todos.find((t) => t.id === tid);
        if (!todo) return reply.code(404).send({ error: `todo \`${tid}\` not found` });
        todo.status = status;
        touchRequirementTodo(todo);
        updated.push(todo);
      }
      touchRequirement(item);
      await store.upsert(item);
      await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
        kind: "requirement_todos_batch_updated",
        todo_ids: ids,
        status,
      });
      return reply.send({ todos: updated, requirement: item });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  app.patch("/v1/requirements/:id/todos/:todo_id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id, todo_id: todoId } = req.params as { id: string; todo_id: string };
    const body = (req.body ?? {}) as {
      title?: unknown;
      status?: unknown;
      kind?: unknown;
      command?: unknown;
      evidence?: unknown;
      depends_on?: unknown;
    };
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      const todo = (item.todos ?? []).find((t) => t.id === todoId);
      if (!todo) return reply.code(404).send({ error: `todo \`${todoId}\` not found` });
      if (body.title !== undefined) {
        const t = typeof body.title === "string" ? body.title.trim() : "";
        if (t === "") return reply.code(400).send({ error: "`title` must not be blank" });
        todo.title = t;
      }
      if (body.status !== undefined) {
        const s = typeof body.status === "string" ? requirementTodoStatusFromWire(body.status) : undefined;
        if (!s) return reply.code(400).send({ error: `unknown todo status \`${String(body.status)}\`` });
        todo.status = s;
      }
      if (body.kind !== undefined) {
        const k = typeof body.kind === "string" ? requirementTodoKindFromWire(body.kind) : undefined;
        if (!k) return reply.code(400).send({ error: `unknown todo kind \`${String(body.kind)}\`` });
        todo.kind = k;
      }
      if (body.command !== undefined) {
        const c = typeof body.command === "string" ? body.command.trim() : "";
        todo.command = c === "" ? undefined : c;
      }
      if (body.evidence !== undefined) {
        todo.evidence = body.evidence === null ? undefined : (body.evidence as RequirementTodoEvidence);
      }
      if (Array.isArray(body.depends_on)) {
        todo.depends_on = body.depends_on
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      }
      touchRequirementTodo(todo);
      touchRequirement(item);
      await store.upsert(item);
      await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
        kind: "requirement_todo_updated",
        todo_id: todo.id,
        status: todo.status,
      });
      return reply.send({ todo, requirement: item });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  app.delete("/v1/requirements/:id/todos/:todo_id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id, todo_id: todoId } = req.params as { id: string; todo_id: string };
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      const before = item.todos ?? [];
      const after = before.filter((t) => t.id !== todoId);
      if (after.length !== before.length) {
        item.todos = after;
        touchRequirement(item);
        await store.upsert(item);
        await recordActivity(state, item.id, "comment", HUMAN_ACTOR, {
          kind: "requirement_todo_deleted",
          todo_id: todoId,
        });
      }
      return reply.send({ deleted: true, requirement: item });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // Idempotently link a conversation to a requirement.
  app.post("/v1/requirements/:id/conversations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { conversation_id?: unknown };
    if (typeof body.conversation_id !== "string" || body.conversation_id === "") {
      return reply.code(400).send({ error: "`conversation_id` is required" });
    }
    try {
      const item = await store.get(id);
      if (!item) return reply.code(404).send({ error: `requirement \`${id}\` not found` });
      const appended = linkConversation(item, body.conversation_id);
      if (appended) await store.upsert(item);
      return reply.send({ requirement: item, appended });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ---- run verification ----

  // Attach an externally-computed VerificationResult to a run.
  app.post("/v1/runs/:id/verification", async (req, reply) => {
    const runStore = requireRunStore(state, reply);
    if (!runStore) return reply;
    const id = (req.params as { id: string }).id;
    const result = (req.body ?? {}) as VerificationResult;
    if (typeof result.status !== "string") {
      return reply.code(400).send({ error: "body must be a VerificationResult" });
    }
    try {
      const run = await runStore.get(id);
      if (!run) return reply.code(404).send({ error: `run \`${id}\` not found` });
      return reply.send(await applyVerification(state, run, result));
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // Execute the plan's commands in the run's workspace, then attach the result.
  app.post("/v1/runs/:id/verify", async (req, reply) => {
    const runStore = requireRunStore(state, reply);
    if (!runStore) return reply;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      commands?: unknown;
      timeout_ms?: unknown;
      require_diff?: unknown;
      require_tests?: unknown;
      require_human_review?: unknown;
    };
    const commands = Array.isArray(body.commands)
      ? body.commands.filter((c): c is string => typeof c === "string")
      : [];
    if (commands.length === 0) {
      return reply.code(400).send({
        error: "`commands` must not be empty; POST /verification to attach a result without running anything",
      });
    }
    try {
      const run = await runStore.get(id);
      if (!run) return reply.code(404).send({ error: `run \`${id}\` not found` });
      const plan: VerificationPlan = {
        commands,
        require_diff: body.require_diff === true,
        require_tests: body.require_tests === true,
        require_human_review: body.require_human_review === true,
      };
      const workspace = await resolveRunWorkspace(state, run);
      const timeoutMs =
        typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : DEFAULT_TIMEOUT_MS;
      pushRequirementRunLog(run, "info", "Verification started", {
        workspace,
        commands: commands.length,
        timeout_ms: timeoutMs,
        manual: true,
      });
      await runStore.upsert(run);
      const result = await executePlan(workspace, plan, timeoutMs);
      return reply.send(await applyVerification(state, run, result));
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}

/** Where a run's verification commands execute: worktree → bound workspace → root. */
async function resolveRunWorkspace(state: AppState, run: RequirementRun): Promise<string> {
  const wt = run.worktree_path?.trim();
  if (wt) return wt;
  if (state.workspaces) {
    const bound = (await state.workspaces.lookup(run.conversation_id))?.trim();
    if (bound) return bound;
  }
  return state.workspaceRoot ?? ".";
}

/**
 * Persist + broadcast a verification result for a run (terminal flip on
 * pass/fail, Verified + Finished frames, Activity rows). Shared by /verify and
 * /verification. Mirrors `apply_verification`.
 */
async function applyVerification(
  state: AppState,
  run: RequirementRun,
  result: VerificationResult,
): Promise<RequirementRun> {
  const runStore = state.requirementRuns;
  if (!runStore) return run;
  const wasTerminal = requirementRunStatusIsTerminal(run.status);
  if (!wasTerminal) {
    if (result.status === "passed") finishRequirementRun(run, "completed");
    else if (result.status === "failed") finishRequirementRun(run, "failed");
    // needs_review / skipped: leave the run non-terminal.
  }
  run.verification = result;
  await runStore.upsert(run);
  runStore.broadcast({ type: "verified", run_id: run.id, result });
  if (requirementRunStatusIsTerminal(run.status)) runStore.broadcast({ type: "finished", ...run });
  await recordActivity(state, run.requirement_id, "verification_finished", SYSTEM_ACTOR, {
    run_id: run.id,
    status: result.status,
  });
  if (!wasTerminal && requirementRunStatusIsTerminal(run.status)) {
    await recordActivity(state, run.requirement_id, "run_finished", SYSTEM_ACTOR, {
      run_id: run.id,
      status: run.status,
      reason: "verification",
    });
  }
  return run;
}

/**
 * Render a compact textual digest of a Requirement to seed a fresh run's
 * conversation. Stand-in for the Rust `render_manifest_summary` until the
 * full workspace-context manifest builder is ported to Node.
 */
function renderManifestSummary(req: Requirement): string {
  const lines: string[] = [];
  lines.push(`# Requirement: ${req.title}`);
  lines.push(`Status: ${req.status}`);
  if (req.description && req.description.trim() !== "") {
    lines.push("");
    lines.push(req.description.trim());
  }
  return lines.join("\n");
}
