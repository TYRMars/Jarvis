// Project CRUD. Ported from crates/harness-server/src/projects.rs (the CRUD
// subset: create / list / get-one / update / delete / restore). The larger
// project surface in the Rust file — project memory, run history, and the
// workspaces/status|branches|switch git probes — lands in later steps; this
// module owns the kanban-board container's lifecycle.
//
// Every route 503s when `state.projects` is absent, so callers can tell "not
// configured" from "really broken" — same convention as conversations-routes.
//
// Slug resolution: a `:id_or_slug` path segment is resolved by id first
// (`store.load`), then by slug (`store.findBySlug`). Slugs are derived from
// the name when not supplied, disambiguated with a `-2`, `-3`, … suffix; a
// caller-supplied slug that collides is a hard 409.
import { realpath, stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { ConversationStore } from "@jarvis/store";
import {
  archiveProject,
  deriveSlug,
  newProject,
  projectToWire,
  setProjectAutomation,
  setProjectDescription,
  setProjectInstructions,
  setProjectName,
  setProjectSlug,
  setProjectTags,
  setProjectWorkspaces,
  touchProject,
  unarchiveProject,
  validateColumnId,
  validateSlug,
  type KanbanColumn,
  type Project,
  type ProjectAutomation,
  type ProjectStore,
  type ProjectWorkspace,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

const DEFAULT_LIMIT = 50;

/** Return the project store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): ProjectStore | undefined {
  if (!state.projects) {
    reply.code(503).send({ error: "project store not configured; set JARVIS_DB_URL" });
    return undefined;
  }
  return state.projects;
}

/** Resolve `?limit=` to a positive count capped at 500. */
function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), 500);
}

/** Coerce a query value (Fastify gives strings) into a boolean. */
function asBool(raw: unknown): boolean {
  return raw === true || raw === "true" || raw === "1";
}

/** id-or-slug lookup: try the primary id, then fall back to the slug. */
async function loadByIdOrSlug(store: ProjectStore, needle: string): Promise<Project | undefined> {
  const byId = await store.load(needle);
  if (byId) return byId;
  return store.findBySlug(needle);
}

/**
 * Resolve `?` / `~`-free canonical paths and confirm each entry is a
 * directory. The whole batch is rejected (returns an error string) on the
 * first failure so callers always see a consistent saved state. Trims display
 * `name` (folding empties to undefined) and drops duplicate paths, preserving
 * order. Returns either the canonical workspaces or an error message.
 */
async function canonicaliseWorkspaces(
  raw: ProjectWorkspaceInput[],
): Promise<{ ok: true; workspaces: ProjectWorkspace[] } | { ok: false; error: string }> {
  const out: ProjectWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const trimmedPath = (entry.path ?? "").trim();
    if (trimmedPath === "") {
      return { ok: false, error: "workspace path must not be empty" };
    }
    let canonical: string;
    try {
      canonical = await realpath(trimmedPath);
    } catch (e) {
      return { ok: false, error: `workspace \`${trimmedPath}\` is not reachable: ${errorText(e)}` };
    }
    let isDir = false;
    try {
      isDir = (await stat(canonical)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { ok: false, error: `workspace \`${canonical}\` is not a directory` };
    }
    if (seen.has(canonical)) continue; // duplicate — silently drop
    seen.add(canonical);
    const name = entry.name?.trim();
    out.push(name ? { path: canonical, name } : { path: canonical });
  }
  return { ok: true, workspaces: out };
}

/**
 * Disambiguate a slug seed against existing rows. A caller-supplied seed that
 * collides is a hard error (the route maps it to 409); a derived seed quietly
 * appends `-2`, `-3`, … until something fits. Returns the resolved slug or a
 * `{ conflict }` marker.
 */
async function resolveUniqueSlug(
  store: ProjectStore,
  seed: string,
  callerSupplied: boolean,
): Promise<{ ok: true; slug: string } | { ok: false; conflict: string }> {
  if ((await store.findBySlug(seed)) === undefined) {
    return { ok: true, slug: seed };
  }
  if (callerSupplied) {
    return { ok: false, conflict: `slug '${seed}' already in use` };
  }
  for (let n = 2; n <= 99; n++) {
    const candidate = `${seed}-${n}`;
    if (validateSlug(candidate) !== null) break; // overflow — give up rather than truncate
    if ((await store.findBySlug(candidate)) === undefined) {
      return { ok: true, slug: candidate };
    }
  }
  return { ok: false, conflict: `could not derive a unique slug from '${seed}'` };
}

/**
 * Validate a client-submitted column list. Returns an error message suitable
 * for surfacing verbatim, or `null` when ok. Rules: ≤ 32 columns; each id
 * passes {@link validateColumnId}; ids unique (case-sensitive); labels
 * non-blank after trim; `kind`, when set, is one of the four built-in glyphs.
 */
function validateColumns(cols: KanbanColumn[]): string | null {
  if (cols.length > 32) {
    return "at most 32 columns are allowed";
  }
  const seen = new Set<string>();
  for (const col of cols) {
    const reason = validateColumnId(col.id);
    if (reason !== null) return `column \`${col.id}\`: ${reason}`;
    if (seen.has(col.id)) return `duplicate column id \`${col.id}\``;
    seen.add(col.id);
    if (col.label.trim() === "") return `column \`${col.id}\`: label must not be blank`;
    if (col.kind !== undefined && !["backlog", "in_progress", "review", "done"].includes(col.kind)) {
      return `column \`${col.id}\`: kind \`${col.kind}\` is not one of backlog / in_progress / review / done`;
    }
  }
  return null;
}

/**
 * Best-effort conversation count per project, capped at 200. Skipped silently
 * (returns undefined) when the conversation store errors. Mirrors the badge
 * the sidebar picker renders.
 */
async function countBoundConversations(store: ConversationStore, projectId: string): Promise<number | undefined> {
  try {
    const rows = await store.listByProject(projectId, 200);
    return rows.length;
  } catch {
    return undefined;
  }
}

// ---- request body shapes ----

interface ProjectWorkspaceInput {
  path: string;
  name?: string;
}

interface CreateRequest {
  name?: string;
  instructions?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  workspaces?: ProjectWorkspaceInput[];
  automation?: ProjectAutomation;
}

interface UpdateRequest {
  name?: string;
  slug?: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  workspaces?: ProjectWorkspaceInput[];
  archived?: boolean;
  columns?: KanbanColumn[];
  automation?: ProjectAutomation;
}

export function registerProjectsRoutes(app: FastifyInstance, state: AppState): void {
  // ----------------------- create -----------------------
  app.post("/v1/projects", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as CreateRequest;
    const name = typeof body.name === "string" ? body.name : "";
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    if (name.trim() === "") return reply.code(400).send({ error: "name must not be empty" });
    if (instructions.trim() === "") return reply.code(400).send({ error: "instructions must not be empty" });

    // Resolve slug: caller-supplied wins; otherwise derive from name. Then
    // disambiguate against existing rows.
    const callerSupplied = typeof body.slug === "string";
    const slugSeed = callerSupplied ? (body.slug as string) : deriveSlug(name);
    const seedReason = validateSlug(slugSeed);
    if (seedReason !== null) return reply.code(400).send({ error: seedReason });
    const resolved = await resolveUniqueSlug(store, slugSeed, callerSupplied);
    if (!resolved.ok) return reply.code(409).send({ error: resolved.conflict });

    const p = newProject(name, instructions);
    setProjectSlug(p, resolved.slug);
    if (typeof body.description === "string") setProjectDescription(p, body.description);
    if (Array.isArray(body.tags) && body.tags.length > 0) setProjectTags(p, body.tags);
    if (Array.isArray(body.workspaces) && body.workspaces.length > 0) {
      const ws = await canonicaliseWorkspaces(body.workspaces);
      if (!ws.ok) return reply.code(400).send({ error: ws.error });
      setProjectWorkspaces(p, ws.workspaces);
    }
    if (body.automation !== undefined) setProjectAutomation(p, body.automation);

    try {
      await store.save(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(projectToWire(p));
  });

  // ----------------------- list -----------------------
  app.get("/v1/projects", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const query = req.query as { limit?: string; include_archived?: string };
    const limit = clampLimit(query.limit, DEFAULT_LIMIT);
    const includeArchived = asBool(query.include_archived);
    try {
      const rows = await store.list(includeArchived, limit);
      const convStore = state.store;
      const out: Project[] = [];
      for (const p of rows) {
        const wire = projectToWire(p);
        if (convStore) {
          const n = await countBoundConversations(convStore, p.id);
          if (n !== undefined) (wire as Project & { conversation_count?: number }).conversation_count = n;
        }
        out.push(wire);
      }
      return reply.send(out);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- get one -----------------------
  app.get("/v1/projects/:id_or_slug", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id_or_slug } = req.params as { id_or_slug: string };
    try {
      const p = await loadByIdOrSlug(store, id_or_slug);
      if (!p) return reply.code(404).send({ error: "project not found" });
      return reply.send(projectToWire(p));
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- update (PUT) -----------------------
  app.put("/v1/projects/:id_or_slug", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id_or_slug } = req.params as { id_or_slug: string };
    const body = (req.body ?? {}) as UpdateRequest;

    let p: Project | undefined;
    try {
      p = await loadByIdOrSlug(store, id_or_slug);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!p) return reply.code(404).send({ error: "project not found" });

    if (body.name !== undefined) {
      if (body.name.trim() === "") return reply.code(400).send({ error: "name must not be empty" });
      setProjectName(p, body.name);
    }
    if (body.slug !== undefined) {
      const reason = validateSlug(body.slug);
      if (reason !== null) return reply.code(400).send({ error: reason });
      if (body.slug !== p.slug) {
        let other: Project | undefined;
        try {
          other = await store.findBySlug(body.slug);
        } catch (e) {
          return reply.code(500).send({ error: errorText(e) });
        }
        if (other && other.id !== p.id) {
          return reply.code(409).send({ error: `slug '${body.slug}' already in use` });
        }
        setProjectSlug(p, body.slug);
      }
    }
    if (body.description !== undefined) {
      setProjectDescription(p, body.description === "" ? undefined : body.description);
    }
    if (body.instructions !== undefined) {
      if (body.instructions.trim() === "") return reply.code(400).send({ error: "instructions must not be empty" });
      setProjectInstructions(p, body.instructions);
    }
    if (body.tags !== undefined) setProjectTags(p, body.tags);
    if (body.workspaces !== undefined) {
      const ws = await canonicaliseWorkspaces(body.workspaces);
      if (!ws.ok) return reply.code(400).send({ error: ws.error });
      setProjectWorkspaces(p, ws.workspaces);
    }
    if (body.archived !== undefined) {
      if (body.archived) archiveProject(p);
      else unarchiveProject(p);
    }
    if (body.columns !== undefined) {
      // Empty vec → revert to built-in defaults (stored as undefined).
      if (body.columns.length === 0) {
        p.columns = undefined;
      } else {
        const reason = validateColumns(body.columns);
        if (reason !== null) return reply.code(400).send({ error: reason });
        p.columns = body.columns;
      }
      touchProject(p);
    }
    if (body.automation !== undefined) setProjectAutomation(p, body.automation);

    try {
      await store.save(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(projectToWire(p));
  });

  // ----------------------- delete -----------------------
  // Soft-delete (archive) by default; `?hard=true` hard-deletes, refusing
  // with 409 if any conversations are still bound.
  app.delete("/v1/projects/:id_or_slug", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id_or_slug } = req.params as { id_or_slug: string };
    const hard = asBool((req.query as { hard?: string }).hard);

    let p: Project | undefined;
    try {
      p = await loadByIdOrSlug(store, id_or_slug);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!p) return reply.code(404).send({ error: "project not found" });

    if (!hard) {
      try {
        const archived = await store.archive(p.id);
        if (!archived) return reply.code(404).send({ error: "project not found" });
        return reply.send({ archived: true, id: p.id });
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
    }

    // Hard delete: refuse if any conversations are still bound.
    if (state.store) {
      try {
        const rows = await state.store.listByProject(p.id, 5);
        if (rows.length > 0) {
          return reply.code(409).send({
            error: "project has bound conversations; archive instead or unbind them first",
            bound_conversations: rows.map((r) => r.id),
          });
        }
      } catch (e) {
        return reply.code(500).send({ error: errorText(e) });
      }
    }
    try {
      const deleted = await store.delete(p.id);
      if (!deleted) return reply.code(404).send({ error: "project not found" });
      return reply.send({ deleted: true, id: p.id });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // ----------------------- restore -----------------------
  app.post("/v1/projects/:id/restore", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const { id } = req.params as { id: string };

    let p: Project | undefined;
    try {
      p = await loadByIdOrSlug(store, id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!p) return reply.code(404).send({ error: "project not found" });
    if (!p.archived) return reply.send(projectToWire(p));

    unarchiveProject(p);
    try {
      await store.save(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(projectToWire(p));
  });
}
