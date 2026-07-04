// REST surface for scheduled automations. Ported from
// harness-server/src/automation_routes.rs.
//
// Every handler 503s when `state.automations` is unset, so tests / specialised
// binaries that don't wire the store get a clean "not configured" signal
// instead of a panic — mirrors the conversations-routes `requireStore` pattern.
//
//   - GET    /v1/automations          — list every task (newest-updated first).
//   - POST   /v1/automations          — create (validates schedule + title/prompt) → 201.
//   - GET    /v1/automations/:id       — fetch one (404 when absent).
//   - PATCH  /v1/automations/:id       — partial update (recomputes next_run when
//                                        the schedule changes and the task isn't running).
//   - DELETE /v1/automations/:id       — hard delete → 204 / 404.
//   - POST   /v1/automations/:id/run   — on-demand trigger → 202 / 404 / 409.
//
// The on-demand trigger reserves a process-wide {@link AutomationClaims} slot
// synchronously before spawning, so a manual trigger can't race a just-spawned
// scheduled run (the persisted `running` flag may not have landed yet) — exactly
// the ordering the Rust handler uses (`is_running` 409 → `try_claim` 409 → spawn).
//
// Node adaptation: the Rust handler reads `state.automation_claims` +
// `state.build_agent(provider, model)`. The Node `AppState` carries neither and
// must not be edited from this step, so the runtime owns a process-wide
// {@link sharedAutomationClaims} singleton (shared with the scheduler loop) and
// the route builds an {@link AutomationDeps} from `state.createAgent` for the
// trigger. Per-task provider/model overrides aren't honoured by the current
// `createAgent` signature; the run still proceeds on the default agent.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, type Agent } from "@jarvis/core";
import {
  newAutomationTask,
  parseTimestamp,
  recomputeNextRun,
  toRfc3339,
  type AutomationStatus,
  type AutomationStore,
  type AutomationTask,
  type ScheduleSpec,
} from "@jarvis/automation";
import type { AppState } from "./state.ts";
import {
  isRunning,
  triggerAutomationNow,
  type AutomationDeps,
} from "./automation-runtime.ts";

// ---------- request bodies --------------------------------------------------

interface CreateAutomationRequest {
  title?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  status?: unknown;
  provider?: unknown;
  model?: unknown;
  conversation_id?: unknown;
}

interface PatchAutomationRequest {
  title?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  status?: unknown;
  // `provider` / `model` / `conversation_id` use double-Option in Rust: present
  // with a string sets it, present with null clears it, absent leaves it as-is.
  provider?: unknown;
  model?: unknown;
  conversation_id?: unknown;
}

// ---------- store guard -----------------------------------------------------

/** Return the automation store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): AutomationStore | undefined {
  if (!state.automations) {
    reply.code(503).send({ error: "automation store not configured" });
    return undefined;
  }
  return state.automations;
}

// ---------- helpers ---------------------------------------------------------

/**
 * Upper bound for `interval.every_seconds` — 100 years. Longer than any real
 * schedule, and small enough that `now + every_seconds*1000` stays well within
 * the valid epoch-ms range (max ≈ 8.64e15) so {@link toRfc3339} never throws.
 */
const MAX_INTERVAL_SECONDS = 100 * 365 * 24 * 60 * 60;

/**
 * Validate a {@link ScheduleSpec}. Returns an error string when invalid,
 * `undefined` when valid. Mirrors Rust's `validate_schedule`.
 */
function validateSchedule(schedule: unknown): string | undefined {
  if (typeof schedule !== "object" || schedule === null) {
    return "schedule is required";
  }
  if ("once" in schedule) {
    const once = (schedule as { once?: unknown }).once;
    const runAt = (once as { run_at?: unknown } | undefined)?.run_at;
    if (typeof runAt !== "string" || parseTimestamp(runAt) === undefined) {
      return "schedule.once.run_at must be RFC3339";
    }
    return undefined;
  }
  if ("interval" in schedule) {
    const interval = (schedule as { interval?: unknown }).interval as
      | { every_seconds?: unknown; start_at?: unknown }
      | undefined;
    const every = interval?.every_seconds;
    if (typeof every !== "number" || !Number.isFinite(every) || every <= 0) {
      return "schedule.interval.every_seconds must be greater than zero";
    }
    // Upper bound: `scheduleNextAfter` computes `now + every_seconds*1000`, and a
    // large-but-finite value (e.g. 9e18) overflows the valid epoch-ms range so
    // `toRfc3339(new Date(nextMs))` throws `RangeError`. Cap well below overflow
    // (100 years is longer than any real interval) so the create/update handler
    // returns a clean 400 instead of a 500, and the scheduler tick can never
    // throw on a persisted task.
    if (every > MAX_INTERVAL_SECONDS) {
      return `schedule.interval.every_seconds must be <= ${MAX_INTERVAL_SECONDS}`;
    }
    const startAt = interval?.start_at;
    if (startAt !== undefined && startAt !== null) {
      if (typeof startAt !== "string" || parseTimestamp(startAt) === undefined) {
        return "schedule.interval.start_at must be RFC3339";
      }
    }
    return undefined;
  }
  return "schedule must be `once` or `interval`";
}

/**
 * Trim a string, returning undefined when it's empty/whitespace-only or not a
 * string. Mirrors Rust's `clean_opt`.
 */
function cleanOpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A non-empty trimmed string, else undefined. */
function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAutomationStatus(value: unknown): value is AutomationStatus {
  return value === "enabled" || value === "paused";
}

/** Current time as the canonical RFC-3339 millis+`Z` wire form. */
function nowStamp(): string {
  return toRfc3339(Date.now());
}

/**
 * Build the runtime deps for the on-demand trigger from `state`. `createAgent`
 * doesn't yet take provider/model overrides, so they're dropped here (the run
 * proceeds on the default agent) — a forward-compat seam matching the workflow
 * runtime's per-step-model degradation.
 */
function triggerDeps(state: AppState, store: AutomationStore): AutomationDeps {
  return {
    automations: store,
    store: state.store,
    buildAgent: (): Agent => state.createAgent(),
  };
}

// ---------- routes ----------------------------------------------------------

export function registerAutomationRoutes(app: FastifyInstance, state: AppState): void {
  // list
  app.get("/v1/automations", async (_req, reply) => {
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
  app.post("/v1/automations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as CreateAutomationRequest;

    const scheduleError = validateSchedule(body.schedule);
    if (scheduleError !== undefined) {
      return reply.code(400).send({ error: scheduleError });
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (title.length === 0 || prompt.trim().length === 0) {
      return reply.code(400).send({ error: "title and prompt are required" });
    }
    if (body.status !== undefined && !isAutomationStatus(body.status)) {
      return reply.code(400).send({ error: "status must be `enabled` or `paused`" });
    }

    const input = {
      title,
      prompt,
      schedule: body.schedule as ScheduleSpec,
      ...(isAutomationStatus(body.status) ? { status: body.status } : {}),
      ...(cleanOpt(body.provider) !== undefined ? { provider: cleanOpt(body.provider)! } : {}),
      ...(cleanOpt(body.model) !== undefined ? { model: cleanOpt(body.model)! } : {}),
      ...(cleanOpt(body.conversation_id) !== undefined
        ? { conversation_id: cleanOpt(body.conversation_id)! }
        : {}),
    };
    const task = newAutomationTask(input);
    try {
      await store.upsert(task);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(task);
  });

  // get one
  app.get("/v1/automations/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const task = await store.get(id);
      if (!task) return reply.code(404).send({ error: "automation not found" });
      return reply.send(task);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // patch
  app.patch("/v1/automations/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let task: AutomationTask | undefined;
    try {
      task = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!task) return reply.code(404).send({ error: "automation not found" });

    const body = (req.body ?? {}) as PatchAutomationRequest;

    if (body.title !== undefined) {
      const title = nonEmptyTrimmed(body.title);
      if (title === undefined) {
        return reply.code(400).send({ error: "title cannot be empty" });
      }
      task.title = title;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        return reply.code(400).send({ error: "prompt cannot be empty" });
      }
      task.prompt = body.prompt;
    }
    if (body.schedule !== undefined) {
      const scheduleError = validateSchedule(body.schedule);
      if (scheduleError !== undefined) {
        return reply.code(400).send({ error: scheduleError });
      }
      task.schedule = body.schedule as ScheduleSpec;
      // Only re-anchor next_run when the task isn't mid-run — a running task's
      // next_run was already advanced when it was picked up.
      if (!isRunning(task)) {
        recomputeNextRun(task, nowStamp());
      }
    }
    if (body.status !== undefined) {
      if (!isAutomationStatus(body.status)) {
        return reply.code(400).send({ error: "status must be `enabled` or `paused`" });
      }
      task.status = body.status;
    }
    // provider / model / conversation_id: present clears-or-sets, absent leaves.
    if (body.provider !== undefined) {
      const v = cleanOpt(body.provider);
      if (v === undefined) delete task.provider;
      else task.provider = v;
    }
    if (body.model !== undefined) {
      const v = cleanOpt(body.model);
      if (v === undefined) delete task.model;
      else task.model = v;
    }
    if (body.conversation_id !== undefined) {
      const v = cleanOpt(body.conversation_id);
      if (v === undefined) delete task.conversation_id;
      else task.conversation_id = v;
    }
    task.updated_at = nowStamp();
    try {
      await store.upsert(task);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(task);
  });

  // delete
  app.delete("/v1/automations/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      if (!deleted) return reply.code(404).send({ error: "automation not found" });
      return reply.code(204).send();
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // on-demand trigger
  app.post("/v1/automations/:id/run", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    const outcome = await triggerAutomationNow(triggerDeps(state, store), id);
    switch (outcome.kind) {
      case "accepted":
        return reply.code(202).send(outcome.task);
      case "not_found":
        return reply.code(404).send({ error: "automation not found" });
      case "conflict":
        return reply.code(409).send({ error: "automation is already running" });
      case "error":
        return reply.code(500).send({ error: outcome.error });
    }
  });
}
