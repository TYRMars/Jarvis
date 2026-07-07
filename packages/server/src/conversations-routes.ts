// Persisted-conversation CRUD + list enrichment. Ported from
// harness-server/src/conversations.rs. Every route 503s when no
// ConversationStore is configured, so callers can tell "no persistence" from
// "not found". Ids starting with `__` (internal summary cache) are filtered
// from list and refused by get/delete/post; create rejects them.
//
// `GET /v1/conversations` is the load-bearing contract: a BARE newest-first
// JSON array, each row enriched with a derived `title` (first user message),
// `source` + `requirement_*` (joined from the RequirementStore),
// `workspace_path` (WorkspaceStore), and `lifecycle`. The web sidebar
// (ConvoListRow) and the iOS client both decode these fields; the iOS contract
// smoke test guards the bare-array shape.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assistantText,
  errorText,
  newConversation,
  systemMessage,
  userMessage,
  type Conversation,
  type Message,
} from "@jarvis/core";
import type { ConversationMetadata, ConversationRecord, ConversationStore } from "@jarvis/store";
import {
  requirementRunStatusIsTerminal,
  type Activity,
  type Project,
  type Requirement,
  type RequirementRun,
  type RequirementStore,
} from "@jarvis/project";
import { streamSse } from "./sse.ts";
import { isInternalId, type AppState } from "./state.ts";

const DEFAULT_LIMIT = 50;
const TITLE_MAX_CHARS = 60;
const LIFECYCLES = ["active", "archived", "abandoned"] as const;
type Lifecycle = (typeof LIFECYCLES)[number];

/** Return the store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): ConversationStore | undefined {
  if (!state.store) {
    reply.code(503).send({ error: "conversation persistence not configured" });
    return undefined;
  }
  return state.store;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, 500);
}

function finalMessage(conv: Conversation): Message {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m && m.role === "assistant") return m;
  }
  return assistantText("");
}

// ---- enrichment helpers (mirror conversations.rs) -------------------------

const AUTO_SEED_PREFIX = "Please complete this requirement and reply with a one-line summary";

/** First non-empty line of a user message, skipping the auto-mode seed prompt. */
function titleLine(content: string): string {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = lines[0] ?? "";
  if (first.startsWith(AUTO_SEED_PREFIX)) return lines[1] ?? first;
  return first;
}

/**
 * Best-effort title: the first user message's first line, capped at 60 chars
 * with a trailing ellipsis. `null` when there's no user message yet. Mirrors
 * `first_user_title`.
 */
function firstUserTitle(conv: Conversation): string | null {
  for (const m of conv.messages) {
    if (m.role !== "user") continue;
    const line = titleLine(m.content);
    if (line.length === 0) continue;
    const chars = Array.from(line);
    if (chars.length > TITLE_MAX_CHARS) return `${chars.slice(0, TITLE_MAX_CHARS).join("")}…`;
    return line;
  }
  return null;
}

/** Resolve a project by UUID id first, then by slug. Mirrors `lookup_project`. */
async function lookupProject(projects: AppState["projects"], needle: string): Promise<Project | null> {
  if (!projects) return null;
  const byId = await projects.load(needle).catch(() => undefined);
  if (byId) return byId;
  return (await projects.findBySlug(needle).catch(() => undefined)) ?? null;
}

/**
 * Join each conversation row to its most-recently-updated Requirement (the one
 * whose `conversation_ids` lists the row). Loads each row's project's
 * requirements once. Mirrors `collect_conversation_requirements`.
 */
async function collectConversationRequirements(
  requirements: RequirementStore | undefined,
  rows: ConversationRecord[],
): Promise<Map<string, Requirement>> {
  const out = new Map<string, Requirement>();
  if (!requirements) return out;
  const rowIds = new Set(rows.map((r) => r.id));
  const seenProjects = new Set<string>();
  for (const row of rows) {
    const projectId = row.project_id ?? null;
    if (!projectId || seenProjects.has(projectId)) continue;
    seenProjects.add(projectId);
    const reqs = await requirements.list(projectId).catch(() => [] as Requirement[]);
    for (const req of reqs) {
      for (const convId of req.conversation_ids) {
        if (!rowIds.has(convId)) continue;
        const prev = out.get(convId);
        if (!prev || req.updated_at > prev.updated_at) out.set(convId, req);
      }
    }
  }
  return out;
}

export function registerConversationsRoutes(app: FastifyInstance, state: AppState): void {
  // create
  app.post("/v1/conversations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { system?: string; id?: string };
    const id = typeof body.id === "string" && body.id ? body.id : randomUUID();
    if (isInternalId(id)) {
      return reply.code(400).send({ error: "ids starting with `__` are reserved for internal use" });
    }
    const conv = newConversation();
    if (typeof body.system === "string") conv.messages.push(systemMessage(body.system));
    try {
      await store.save(id, conv);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send({ id });
  });

  // list (internal ids filtered out), enriched per row.
  //
  // Contract: a BARE JSON array, newest-first — byte-aligned with the Rust
  // `harness-server` (`Json(out)` in conversations.rs) and what both clients
  // decode (web `setConvoRows(rows)`, iOS `[ConversationSummary]`). It must NOT
  // be wrapped in an `{ conversations: [...] }` envelope; the iOS contract smoke
  // test (apps/jarvis-ios/Tests) and conversations-routes.test.ts guard this.
  app.get("/v1/conversations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const q = (req.query ?? {}) as { limit?: string; project_id?: string; lifecycle?: string };
    const limit = clampLimit(q.limit);

    // Optional lifecycle facet — unknown value is a 400, not a silent pass.
    let lifecycleFilter: Lifecycle | undefined;
    if (q.lifecycle !== undefined) {
      if (!(LIFECYCLES as readonly string[]).includes(q.lifecycle)) {
        return reply.code(400).send({ error: `unknown lifecycle \`${q.lifecycle}\`` });
      }
      lifecycleFilter = q.lifecycle as Lifecycle;
    }

    try {
      let rows: ConversationRecord[];
      if (q.project_id !== undefined && q.project_id !== "") {
        const project = await lookupProject(state.projects, q.project_id);
        if (!project) return reply.code(404).send({ error: "project not found" });
        rows = await store.listByProject(project.id, limit);
      } else {
        rows = await store.list(limit);
      }
      rows = rows.filter((r) => !isInternalId(r.id));
      if (lifecycleFilter) rows = rows.filter((r) => r.lifecycle === lifecycleFilter);

      const reqMap = await collectConversationRequirements(state.requirements, rows);

      const out = await Promise.all(
        rows.map(async (r) => {
          const conv = await store.load(r.id).catch(() => undefined);
          const title = conv ? firstUserTitle(conv) : null;
          const workspacePath = (await state.workspaces?.lookup(r.id).catch(() => undefined)) ?? null;
          const req = reqMap.get(r.id);
          return {
            id: r.id,
            created_at: r.created_at,
            updated_at: r.updated_at,
            message_count: r.message_count,
            title,
            project_id: r.project_id ?? null,
            workspace_path: workspacePath,
            source: req ? "requirement" : "chat",
            requirement_id: req?.id ?? null,
            requirement_title: req?.title ?? null,
            requirement_status: req?.status ?? null,
            lifecycle: r.lifecycle,
          };
        }),
      );
      return reply.send(out);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // get one
  app.get("/v1/conversations/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const env = await store.loadEnvelope(id);
      if (!env) return reply.code(404).send({ error: "conversation not found" });
      const [conv, meta] = env;
      return reply.send({ id, messages: conv.messages, project_id: meta.project_id ?? null });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // set lifecycle (active / archived / abandoned). Abandoning cancels the
  // conversation's in-flight requirement runs (best-effort).
  app.post("/v1/conversations/:id/lifecycle", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { lifecycle?: unknown };
    if (typeof body.lifecycle !== "string" || !(LIFECYCLES as readonly string[]).includes(body.lifecycle)) {
      return reply.code(400).send({ error: "body.lifecycle must be active|archived|abandoned" });
    }
    const next = body.lifecycle as Lifecycle;
    try {
      const env = await store.loadEnvelope(id);
      if (!env) return reply.code(404).send({ error: "conversation not found" });
      const [conv, meta] = env;
      const previous = meta.lifecycle;
      meta.lifecycle = next;
      await store.saveEnvelope(id, conv, meta);
      if (next === "abandoned" && previous !== "abandoned") {
        void cancelRunsOnAbandon(state, id);
      }
      return reply.send({ id, lifecycle: next, previous_lifecycle: previous });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // work-context: the requirement + latest run + recent activities bound to
  // this conversation (for the chat-header "Work" affordance). Degrades to null
  // fields when the conversation isn't requirement-backed or stores are absent.
  app.get("/v1/conversations/:id/work-context", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const env = await store.loadEnvelope(id);
      if (!env) return reply.code(404).send({ error: "conversation not found" });
      const projectId = env[1].project_id ?? null;
      const empty = {
        conversation_id: id,
        project_id: projectId,
        requirement: null as Requirement | null,
        latest_run: null as RequirementRun | null,
        recent_activities: [] as Activity[],
      };
      if (!projectId || !state.requirements) return reply.send(empty);

      const candidates = (await state.requirements.list(projectId)).filter((r) =>
        r.conversation_ids.includes(id),
      );
      const requirement = await pickPrimaryRequirement(state, candidates, id);
      if (!requirement) return reply.send(empty);

      const runs = (await state.requirementRuns?.listForRequirement(requirement.id)) ?? [];
      // listForRequirement is newest-first by started_at.
      const latestRun = runs[0] ?? null;
      const activities = (await state.activities?.listForRequirement(requirement.id)) ?? [];
      return reply.send({
        conversation_id: id,
        project_id: projectId,
        requirement,
        latest_run: latestRun,
        recent_activities: activities.slice(0, 25),
      });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // delete one
  app.delete("/v1/conversations/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const deleted = await store.delete(id);
      return reply.code(deleted ? 200 : 404).send({ deleted });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // append a user message, run the agent, save → {id, message, iterations, history}
  app.post("/v1/conversations/:id/messages", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = req.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.code(400).send({ error: "missing `content`" });
    }
    let env: [Conversation, ConversationMetadata] | undefined;
    try {
      env = await store.loadEnvelope(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!env) return reply.code(404).send({ error: "conversation not found" });
    const [conv, meta] = env;
    conv.messages.push(userMessage(body.content));
    // Persist the appended user turn before running the agent so a failed run
    // (provider 429/5xx, network blip) doesn't silently lose the user's message.
    try {
      await store.saveEnvelope(id, conv, meta);
    } catch {
      /* tolerate save failure */
    }
    try {
      const outcome = await state.createAgent().run(conv);
      // Save failure is logged-and-tolerated in Rust; here we still return the reply.
      try {
        await store.saveEnvelope(id, conv, meta);
      } catch {
        /* tolerate save failure */
      }
      return reply.send({
        id,
        message: finalMessage(conv),
        iterations: outcome.iterations,
        history: conv.messages,
      });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // streaming variant — SSE, saves on the terminal `done`
  app.post("/v1/conversations/:id/messages/stream", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = req.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.code(400).send({ error: "missing `content`" });
    }
    const env = await store.loadEnvelope(id);
    if (!env) return reply.code(404).send({ error: "conversation not found" });
    const [conv, meta] = env;
    conv.messages.push(userMessage(body.content));
    await streamSse(reply, state.createAgent().runStream(conv), async (ev) => {
      if (ev.type === "done") {
        try {
          await store.saveEnvelope(id, ev.conversation, meta);
        } catch {
          /* tolerate save failure */
        }
      }
    });
  });
}

/**
 * Choose the primary requirement among the candidates linked to a conversation:
 * prefer one with a live (running/pending) run (latest started_at), else the
 * most-recently-updated. Mirrors `pick_primary_requirement`.
 */
async function pickPrimaryRequirement(
  state: AppState,
  candidates: Requirement[],
  _conversationId: string,
): Promise<Requirement | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  if (state.requirementRuns) {
    let bestLive: { req: Requirement; startedAt: string } | undefined;
    for (const req of candidates) {
      const runs = await state.requirementRuns.listForRequirement(req.id).catch(() => [] as RequirementRun[]);
      for (const run of runs) {
        if (requirementRunStatusIsTerminal(run.status)) continue;
        if (!bestLive || run.started_at > bestLive.startedAt) bestLive = { req, startedAt: run.started_at };
      }
    }
    if (bestLive) return bestLive.req;
  }
  // Fall back to the most-recently-updated requirement.
  return candidates.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
}

/**
 * Cancel the conversation's non-terminal requirement runs when it's abandoned.
 * Best-effort: per-run failures are swallowed (warn) so the lifecycle response
 * still succeeds. Mirrors `cancel_runs_on_abandon`.
 */
async function cancelRunsOnAbandon(state: AppState, conversationId: string): Promise<void> {
  if (!state.requirementRuns) return;
  let runs: RequirementRun[];
  try {
    runs = await state.requirementRuns.listAll(1000);
  } catch {
    return;
  }
  const now = new Date().toISOString();
  for (const run of runs) {
    if (run.conversation_id !== conversationId) continue;
    if (requirementRunStatusIsTerminal(run.status)) continue;
    run.status = "cancelled";
    run.finished_at = now;
    run.error = "conversation abandoned";
    try {
      await state.requirementRuns.upsert(run);
    } catch (e) {
      console.warn(`cancelRunsOnAbandon: failed to cancel run ${run.id}: ${errorText(e)}`);
    }
  }
}
