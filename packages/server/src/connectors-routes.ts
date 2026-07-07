// Project-connector REST surface — the import/sync/push orchestration plus
// account/binding CRUD. Ported from crates/harness-server/src/connectors_routes.rs
// (proposal: project-connectors.zh-CN.md, Phase 1 with GitHub Issues first).
//
//   GET    /v1/connectors                                  → registered connector kinds
//   GET    /v1/connectors/accounts                         → account rows
//   POST   /v1/connectors/:connector/accounts              → create account {display_name, auth_ref}
//   DELETE /v1/connectors/accounts/:id
//   GET    /v1/connectors/:connector/projects?account_id=… → list remote projects
//   POST   /v1/connectors/:connector/import                → bind + initial pull
//   GET    /v1/project-bindings?project_id=…
//   POST   /v1/project-bindings/:id/sync                   → re-pull (idempotent upsert)
//   POST   /v1/requirement-bindings/:id/push               → write-back {action?, comment?, force?}
//
// 503 when the stores / secret resolver are unconfigured (the workspace-wide
// convention). The local store stays the source of truth: pulls only
// create/refresh rows, never delete; pushes are explicit caller actions, never
// derived from local status changes.
//
// `connectorError` maps the @jarvis/connectors `ConnectorError.kind` to an
// HTTP status, mirroring the Rust `connector_error`: auth → 502 (bad gateway),
// not_found → 404, conflict → 409, other → 502.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import type { JsonValue } from "@jarvis/core";
import type {
  ConnectorAccount,
  ConnectorAccountStore,
  ConnectorAuth,
  ConnectorError,
  ProjectBinding,
  ProjectBindingStore,
  ProjectConnector,
  RemoteIssue,
  RequirementBinding,
  RequirementBindingStore,
  RequirementPush,
} from "@jarvis/connectors";
import {
  newConnectorAccount,
  newProjectBinding,
  newRequirementBinding,
  touchProjectBinding,
  touchRequirementBinding,
} from "@jarvis/connectors";
import type { Activity, ActivityStore, Requirement, RequirementStore } from "@jarvis/project";
import {
  deriveSlug,
  newActivity,
  newProject,
  newRequirement,
  touchRequirement,
} from "@jarvis/project";
import type { AppState } from "./state.ts";

// ---------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------

/** The three connector stores + the resolved connector, threaded through handlers. */
interface ConnectorCtx {
  connector: ProjectConnector;
  accounts: ConnectorAccountStore;
  projectBindings: ProjectBindingStore;
  requirementBindings: RequirementBindingStore;
}

/** Send a 503 with `msg` and return undefined. Mirrors Rust `unavailable`. */
function unavailable(reply: FastifyReply, msg: string): undefined {
  reply.code(503).send({ error: msg });
  return undefined;
}

/** Send a 500 carrying `errorText(e)`. Mirrors Rust `internal_error`. */
function internalError(reply: FastifyReply, e: unknown): FastifyReply {
  return reply.code(500).send({ error: errorText(e) });
}

/**
 * Build a {@link ConnectorCtx} for `connectorId`, or send the appropriate
 * response and return undefined. 503 when the three connector stores are
 * unconfigured; 404 when the connector id is unknown. Mirrors Rust `ctx`.
 */
function ctx(state: AppState, reply: FastifyReply, connectorId: string): ConnectorCtx | undefined {
  const accounts = state.connectorAccounts;
  const projectBindings = state.connectorProjectBindings;
  const requirementBindings = state.connectorRequirementBindings;
  if (!accounts || !projectBindings || !requirementBindings) {
    return unavailable(reply, "connector stores not configured");
  }
  const connector = (state.connectors ?? []).find((c) => c.id === connectorId);
  if (!connector) {
    reply.code(404).send({ error: `unknown connector: ${connectorId}` });
    return undefined;
  }
  return { connector, accounts, projectBindings, requirementBindings };
}

/**
 * Resolve an account's secret ref to a {@link ConnectorAuth}, or send the
 * appropriate response and return undefined. 503 when no resolver is wired;
 * 400 when the ref does not resolve to a non-empty token. Mirrors Rust
 * `resolve_auth`.
 */
async function resolveAuth(
  state: AppState,
  reply: FastifyReply,
  account: ConnectorAccount,
): Promise<ConnectorAuth | undefined> {
  const resolver = state.connectorSecrets;
  if (!resolver) {
    return unavailable(reply, "connector secret resolver not configured");
  }
  const token = await resolver(account.auth_ref);
  if (token !== undefined && token.trim() !== "") {
    return { token };
  }
  reply.code(400).send({
    error: `secret \`${account.auth_ref}\` not resolvable; set the environment variable and restart`,
  });
  return undefined;
}

/** Is `e` a {@link ConnectorError}? Duck-typed (instanceof can cross realms). */
function isConnectorError(e: unknown): e is ConnectorError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ConnectorError" &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

/**
 * Map a {@link ConnectorError} to an HTTP response. Mirrors Rust
 * `connector_error`: auth → 502, not_found → 404, conflict → 409, other → 502.
 */
function connectorError(reply: FastifyReply, e: ConnectorError): FastifyReply {
  let status: number;
  switch (e.kind) {
    case "not_found":
      status = 404;
      break;
    case "conflict":
      status = 409;
      break;
    case "auth":
    case "other":
    default:
      status = 502;
      break;
  }
  return reply.code(status).send({ error: e.message });
}

/**
 * Append a `connector_sync` Activity row (System actor) if the activity store
 * is configured. Tolerates a missing store and a failed append (Rust logs a
 * WARN). Mirrors Rust `record_connector_activity`.
 */
async function recordConnectorActivity(
  state: AppState,
  requirementId: string,
  body: JsonValue,
): Promise<void> {
  const store: ActivityStore | undefined = state.activities;
  if (!store) return;
  const activity: Activity = newActivity(requirementId, "connector_sync", { type: "system" }, body);
  try {
    await store.append(activity);
  } catch {
    // Mirrors Rust's `warn!` + continue — the audit row is best-effort.
  }
}

// ---------------------------------------------------------------------
// Pull / refresh (shared by import + sync)
// ---------------------------------------------------------------------

interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * Refresh title/description of an already-imported requirement. Returns
 * whether anything changed, or `undefined` after the response has been sent on
 * a store error. A vanished local row is not an error (returns false). Mirrors
 * Rust `refresh_existing`.
 */
async function refreshExisting(
  reply: FastifyReply,
  requirements: RequirementStore,
  requirementId: string,
  issue: RemoteIssue,
): Promise<boolean | undefined> {
  let req: Requirement | undefined;
  try {
    req = await requirements.get(requirementId);
  } catch (e) {
    internalError(reply, e);
    return undefined;
  }
  if (!req) return false;
  let changed = false;
  if (req.title !== issue.title && issue.title.trim() !== "") {
    req.title = issue.title;
    changed = true;
  }
  if ((req.description ?? undefined) !== (issue.body ?? undefined)) {
    req.description = issue.body;
    changed = true;
  }
  if (changed) {
    touchRequirement(req);
    try {
      await requirements.upsert(req);
    } catch (e) {
      internalError(reply, e);
      return undefined;
    }
  }
  return changed;
}

/**
 * Pull the remote project's issues and upsert them as requirements. Returns a
 * {@link SyncSummary}, or `undefined` after the response has been sent on an
 * error. Mutates `binding.sync_cursor` (when the pull yields one) and touches
 * it. Mirrors Rust `pull_into`.
 *
 * Idempotency key: `(project_binding_id, remote_task_id)` via the
 * requirement-binding store. New issues become `backlog` (open) / `done`
 * (closed); existing rows only refresh title/description — local status, todos,
 * verification plans, triage and dependency edges are Jarvis-owned and never
 * overwritten by a pull.
 */
async function pullInto(
  state: AppState,
  reply: FastifyReply,
  cx: ConnectorCtx,
  auth: ConnectorAuth,
  binding: ProjectBinding,
  requirements: RequirementStore,
): Promise<SyncSummary | undefined> {
  let pulled;
  try {
    pulled = await cx.connector.pullRequirements(auth, binding);
  } catch (e) {
    if (isConnectorError(e)) {
      connectorError(reply, e);
      return undefined;
    }
    throw e;
  }

  const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0 };
  for (const issue of pulled.issues) {
    let existing: RequirementBinding | undefined;
    try {
      existing = await cx.requirementBindings.findByRemote(binding.id, issue.id);
    } catch (e) {
      internalError(reply, e);
      return undefined;
    }

    if (existing) {
      const changed = await refreshExisting(reply, requirements, existing.requirement_id, issue);
      if (changed === undefined) return undefined; // response already sent
      existing.remote_updated_at = issue.updated_at;
      existing.remote_url = issue.url;
      touchRequirementBinding(existing);
      try {
        await cx.requirementBindings.upsert(existing);
      } catch (e) {
        internalError(reply, e);
        return undefined;
      }
      if (changed) summary.updated += 1;
      else summary.unchanged += 1;
    } else {
      const req = newRequirement(binding.project_id, issue.title);
      req.description = issue.body;
      req.status = issue.state === "closed" ? "done" : "backlog";
      try {
        await requirements.upsert(req);
      } catch (e) {
        internalError(reply, e);
        return undefined;
      }

      const rb = newRequirementBinding(cx.connector.id, binding.id, req.id, issue.id);
      rb.remote_url = issue.url;
      rb.remote_updated_at = issue.updated_at;
      try {
        await cx.requirementBindings.upsert(rb);
      } catch (e) {
        internalError(reply, e);
        return undefined;
      }

      await recordConnectorActivity(state, req.id, {
        connector: cx.connector.id,
        action: "imported",
        remote_task_id: issue.id,
        remote_url: issue.url ?? null,
      });
      summary.created += 1;
    }
  }

  if (pulled.cursor !== null) {
    binding.sync_cursor = pulled.cursor;
  }
  touchProjectBinding(binding);
  return summary;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export function registerConnectorsRoutes(app: FastifyInstance, state: AppState): void {
  // ---- connector kinds ----
  // Always 200 — listing registered connectors needs no store. Mirrors Rust
  // `list_connectors`, which returns the (possibly empty) configured set.
  app.get("/v1/connectors", async (_req, reply) => {
    const items = (state.connectors ?? []).map((c) => ({
      id: c.id,
      display_name: c.displayName,
    }));
    return reply.send({ items });
  });

  // ---- accounts: list ----
  app.get("/v1/connectors/accounts", async (_req, reply) => {
    const store = state.connectorAccounts;
    if (!store) return unavailable(reply, "connector stores not configured");
    try {
      return reply.send({ items: await store.list() });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // ---- accounts: create ----
  app.post("/v1/connectors/:connector/accounts", async (req, reply) => {
    const connectorId = (req.params as { connector: string }).connector;
    const cx = ctx(state, reply, connectorId);
    if (!cx) return reply;
    const body = (req.body ?? {}) as { display_name?: unknown; auth_ref?: unknown };
    const displayName = typeof body.display_name === "string" ? body.display_name : "";
    const authRefRaw = typeof body.auth_ref === "string" ? body.auth_ref : "";
    const authRef = authRefRaw.trim();
    // Heuristic tripwire: env-var names are short and SCREAMING_SNAKE; anything
    // long or token-shaped is almost certainly a pasted secret.
    const looksLikeToken =
      authRef.length > 64 || [...authRef].some((c) => !/[A-Za-z0-9_]/.test(c));
    if (authRef === "" || looksLikeToken) {
      return reply.code(400).send({
        error:
          "auth_ref must be the NAME of a secret (e.g. GITHUB_TOKEN), never the token itself",
      });
    }
    const account = newConnectorAccount(cx.connector.id, displayName.trim(), authRef);
    try {
      await cx.accounts.upsert(account);
    } catch (e) {
      return internalError(reply, e);
    }
    return reply.code(201).send({ account });
  });

  // ---- accounts: delete ----
  app.delete("/v1/connectors/accounts/:id", async (req, reply) => {
    const store = state.connectorAccounts;
    if (!store) return unavailable(reply, "connector stores not configured");
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      return reply.send({ deleted });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // ---- remote projects ----
  app.get("/v1/connectors/:connector/projects", async (req, reply) => {
    const connectorId = (req.params as { connector: string }).connector;
    const cx = ctx(state, reply, connectorId);
    if (!cx) return reply;
    const accountId = (req.query as { account_id?: string }).account_id;
    if (typeof accountId !== "string" || accountId === "") {
      return reply.code(400).send({ error: "missing `account_id` query parameter" });
    }
    let account: ConnectorAccount | undefined;
    try {
      account = await cx.accounts.get(accountId);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!account) {
      return reply.code(404).send({ error: "unknown account", id: accountId });
    }
    const auth = await resolveAuth(state, reply, account);
    if (!auth) return reply;
    try {
      const items = await cx.connector.listRemoteProjects(auth);
      return reply.send({ items });
    } catch (e) {
      if (isConnectorError(e)) return connectorError(reply, e);
      throw e;
    }
  });

  // ---- import ----
  app.post("/v1/connectors/:connector/import", async (req, reply) => {
    const connectorId = (req.params as { connector: string }).connector;
    const cx = ctx(state, reply, connectorId);
    if (!cx) return reply;
    const projects = state.projects;
    const requirements = state.requirements;
    if (!projects || !requirements) {
      return unavailable(reply, "project/requirement stores not configured");
    }
    const body = (req.body ?? {}) as {
      account_id?: unknown;
      remote_project_id?: unknown;
      project_id?: unknown;
      name?: unknown;
    };
    const accountId = typeof body.account_id === "string" ? body.account_id : "";
    const remoteProjectId =
      typeof body.remote_project_id === "string" ? body.remote_project_id : "";
    const reqProjectId = typeof body.project_id === "string" ? body.project_id : undefined;
    const reqName = typeof body.name === "string" ? body.name : undefined;

    let account: ConnectorAccount | undefined;
    try {
      account = await cx.accounts.get(accountId);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!account) {
      return reply.code(404).send({ error: "unknown account", id: accountId });
    }
    const auth = await resolveAuth(state, reply, account);
    if (!auth) return reply;

    // Refuse a second binding for the same (connector, remote project): two
    // bindings would race the same remote rows into two projects.
    try {
      const existing = await cx.projectBindings.list();
      const dup = existing.find(
        (b) => b.connector === cx.connector.id && b.remote_project_id === remoteProjectId,
      );
      if (dup) {
        return reply.code(409).send({
          error: "remote project already bound",
          binding_id: dup.id,
          project_id: dup.project_id,
        });
      }
    } catch (e) {
      return internalError(reply, e);
    }

    // Resolve or create the target Jarvis project.
    let project;
    if (reqProjectId !== undefined) {
      let resolved;
      try {
        resolved = await projects.load(reqProjectId);
        if (!resolved) resolved = await projects.findBySlug(reqProjectId);
      } catch (e) {
        return internalError(reply, e);
      }
      if (!resolved) {
        return reply.code(404).send({ error: "unknown project", id: reqProjectId });
      }
      project = resolved;
    } else {
      const name = reqName ?? remoteProjectId;
      const p = newProject(
        name,
        `Imported from ${cx.connector.displayName} (${remoteProjectId})`,
      );
      p.slug = deriveSlug(name);
      try {
        await projects.save(p);
      } catch (e) {
        return internalError(reply, e);
      }
      project = p;
    }

    const binding = newProjectBinding(cx.connector.id, account.id, project.id, remoteProjectId);

    const summary = await pullInto(state, reply, cx, auth, binding, requirements);
    if (!summary) return reply; // response already sent

    try {
      await cx.projectBindings.upsert(binding);
    } catch (e) {
      return internalError(reply, e);
    }

    return reply.code(201).send({ binding, project_id: project.id, summary });
  });

  // ---- project bindings: list ----
  app.get("/v1/project-bindings", async (req, reply) => {
    const store = state.connectorProjectBindings;
    if (!store) return unavailable(reply, "connector stores not configured");
    const projectId = (req.query as { project_id?: string }).project_id;
    try {
      const items = await store.list(typeof projectId === "string" ? projectId : undefined);
      return reply.send({ items });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // ---- project bindings: sync ----
  app.post("/v1/project-bindings/:id/sync", async (req, reply) => {
    const bindingStore = state.connectorProjectBindings;
    if (!bindingStore) return unavailable(reply, "connector stores not configured");
    const id = (req.params as { id: string }).id;

    let binding: ProjectBinding | undefined;
    try {
      binding = await bindingStore.get(id);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!binding) {
      return reply.code(404).send({ error: "unknown project binding", id });
    }

    const cx = ctx(state, reply, binding.connector);
    if (!cx) return reply;
    const requirements = state.requirements;
    if (!requirements) return unavailable(reply, "requirement store not configured");

    let account: ConnectorAccount | undefined;
    try {
      account = await cx.accounts.get(binding.account_id);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!account) {
      return reply
        .code(404)
        .send({ error: "binding's account no longer exists", id: binding.account_id });
    }
    const auth = await resolveAuth(state, reply, account);
    if (!auth) return reply;

    const summary = await pullInto(state, reply, cx, auth, binding, requirements);
    if (!summary) return reply; // response already sent

    try {
      await bindingStore.upsert(binding);
    } catch (e) {
      return internalError(reply, e);
    }
    return reply.send({ binding, summary });
  });

  // ---- requirement bindings: push (write-back) ----
  app.post("/v1/requirement-bindings/:id/push", async (req, reply) => {
    const body = (req.body ?? {}) as {
      action?: unknown;
      comment?: unknown;
      force?: unknown;
    };
    const action = body.action === "close" || body.action === "reopen" ? body.action : undefined;
    const comment = typeof body.comment === "string" ? body.comment : undefined;
    const force = body.force === true;
    const change: RequirementPush = {};
    if (action !== undefined) change.action = action;
    if (comment !== undefined) change.comment = comment;

    if (change.action === undefined && (change.comment ?? "").trim() === "") {
      return reply
        .code(400)
        .send({ error: "push needs an `action` and/or a non-empty `comment`" });
    }

    const rbStore = state.connectorRequirementBindings;
    if (!rbStore) return unavailable(reply, "connector stores not configured");
    const id = (req.params as { id: string }).id;

    let rb: RequirementBinding | undefined;
    try {
      rb = await rbStore.get(id);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!rb) {
      return reply.code(404).send({ error: "unknown requirement binding", id });
    }

    const cx = ctx(state, reply, rb.connector);
    if (!cx) return reply;

    let projectBinding: ProjectBinding | undefined;
    try {
      projectBinding = await cx.projectBindings.get(rb.project_binding_id);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!projectBinding) {
      return reply.code(404).send({ error: "binding's project binding no longer exists" });
    }

    let account: ConnectorAccount | undefined;
    try {
      account = await cx.accounts.get(projectBinding.account_id);
    } catch (e) {
      return internalError(reply, e);
    }
    if (!account) {
      return reply.code(404).send({ error: "binding's account no longer exists" });
    }
    const auth = await resolveAuth(state, reply, account);
    if (!auth) return reply;

    // Conflict gate: if the remote moved since our last pull/push, surface 409
    // with both timestamps instead of overwriting blind.
    if (!force) {
      try {
        const remote = await cx.connector.fetchIssue(auth, projectBinding, rb.remote_task_id);
        const remoteNow = remote.updated_at;
        const baseline = rb.remote_updated_at;
        // Fail closed: if either timestamp is missing we cannot prove the remote
        // hasn't moved, so refuse the blind overwrite and require force/re-sync
        // rather than pushing over unknown remote state.
        if (remoteNow === undefined || baseline === undefined || remoteNow > baseline) {
          return reply.code(409).send({
            error: "remote issue changed since last sync; re-sync or pass force=true",
            remote_updated_at: remoteNow ?? null,
            last_synced_at: baseline ?? null,
          });
        }
      } catch (e) {
        if (isConnectorError(e)) return connectorError(reply, e);
        throw e;
      }
    }

    let result;
    try {
      result = await cx.connector.pushRequirement(
        auth,
        projectBinding,
        rb.remote_task_id,
        change,
      );
    } catch (e) {
      if (isConnectorError(e)) return connectorError(reply, e);
      throw e;
    }

    rb.last_pushed_at = new Date().toISOString();
    if (result.remoteUpdatedAt !== null) {
      rb.remote_updated_at = result.remoteUpdatedAt;
    }
    touchRequirementBinding(rb);
    try {
      await rbStore.upsert(rb);
    } catch (e) {
      return internalError(reply, e);
    }

    await recordConnectorActivity(state, rb.requirement_id, {
      connector: cx.connector.id,
      action: "pushed",
      remote_task_id: rb.remote_task_id,
      push_action: change.action ?? null,
      commented: change.comment !== undefined,
    });

    return reply.send({ binding: rb });
  });
}
