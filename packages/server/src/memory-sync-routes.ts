// Memory sync + includes REST surface — backs the Settings → Memory Sync panel
// (MemorySyncSection + MemoryIncludesPanel).
//
// Ported from crates/harness-server/src/memory_sync_routes.rs. These endpoints
// expose the same operations as the agent-side `memory.{sync,sync_setup,
// sync_setup_icloud,sync_status}` + `memory.include_*` tools so an operator can
// configure sync from the UI without going through chat. They reuse the same
// tool impls under the hood (no duplicate logic) — constructed per request from
// `state.memoryRuntime` (the tools are stateless past their roots).
//
// 503 is returned when `state.memoryRuntime` is absent (memory tools not
// enabled). The git/iCloud write endpoints additionally 503 when the configured
// backend doesn't match the operation. These write endpoints are intentionally
// NOT approval-gated at the REST layer — the operator clicking the button IS the
// approval, and we're not inside an agent run, so the underlying tool's
// `requiresApproval` flag doesn't apply here.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, type Tool } from "@jarvis/core";
import {
  MemoryIncludeAddTool,
  MemoryIncludeListTool,
  MemoryIncludeRefreshTool,
  MemoryIncludeRemoveTool,
  MemoryICloudSetupTool,
  MemorySyncSetupTool,
  MemorySyncStatusTool,
  MemorySyncTool,
  type MemorySyncBackend,
  type MemoryToolsConfig,
} from "@jarvis/tools";
import type { AppState, MemoryRuntime } from "./state.ts";

/** Build the per-request `MemoryToolsConfig` from the runtime, or send 503. */
function rootsFromState(state: AppState, reply: FastifyReply): MemoryToolsConfig | undefined {
  const rt: MemoryRuntime | undefined = state.memoryRuntime;
  if (rt === undefined) {
    reply.code(503).send({
      error: "memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart",
    });
    return undefined;
  }
  return rt.userRoot !== undefined
    ? { workspaceRoot: rt.workspaceRoot, userRoot: rt.userRoot }
    : { workspaceRoot: rt.workspaceRoot };
}

function backendOf(state: AppState): MemorySyncBackend {
  return state.memoryRuntime?.backend ?? "none";
}

/** Invoke a memory tool and shape its string result into a JSON response:
 * parsed JSON on success, `{ raw }` if the tool returned non-JSON text, or 400
 * `{ error }` if the tool threw. Mirrors Rust's `invoke_tool_to_response`. */
async function invokeToolToResponse(
  tool: Tool,
  args: Record<string, unknown>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = await tool.invoke(args as never);
    try {
      reply.send(JSON.parse(body));
    } catch {
      reply.send({ raw: body });
    }
  } catch (e) {
    reply.code(400).send({ error: errorText(e) });
  }
}

interface SyncBody {
  scope?: string;
  remote?: string;
  branch?: string;
  timeout_ms?: number;
}
interface GitSetupBody {
  remote_url?: string;
  scope?: string;
  branch?: string;
  push?: boolean;
  force?: boolean;
}
interface IncludeBody {
  target?: string;
  scope?: string;
}

export function registerMemorySyncRoutes(app: FastifyInstance, state: AppState): void {
  // ---- git / iCloud sync -------------------------------------------------

  // GET /v1/memory/sync_status — backend-agnostic envelope; for git/iCloud it
  // digs into the sync_status tool for live per-scope details.
  app.get("/v1/memory/sync_status", async (_req, reply) => {
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const backend = backendOf(state);
    const rt = state.memoryRuntime!;

    const envelope: Record<string, unknown> = {
      backend,
      user_root: rt.userRoot ?? null,
      workspace_root: rt.workspaceRoot,
    };

    if (backend === "git" || backend === "icloud") {
      try {
        const body = await new MemorySyncStatusTool(roots).invoke({ scope: "user" } as never);
        try {
          envelope["user_scope"] = JSON.parse(body);
        } catch {
          envelope["user_scope"] = { raw: body };
        }
      } catch (e) {
        envelope["user_scope"] = { error: errorText(e) };
      }
    }
    return reply.send(envelope);
  });

  // POST /v1/memory/sync — git pull --rebase + push (git backend only).
  app.post("/v1/memory/sync", async (req, reply) => {
    if (backendOf(state) !== "git") {
      return reply.code(503).send({
        error: "memory.sync only applies to the `git` backend — current backend is not git",
        backend: backendOf(state),
      });
    }
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const b = (req.body ?? {}) as SyncBody;
    const args: Record<string, unknown> = {};
    if (b.scope !== undefined) args["scope"] = b.scope;
    if (b.remote !== undefined) args["remote"] = b.remote;
    if (b.branch !== undefined) args["branch"] = b.branch;
    if (b.timeout_ms !== undefined) args["timeout_ms"] = b.timeout_ms;
    await invokeToolToResponse(new MemorySyncTool(roots), args, reply);
    return reply;
  });

  // POST /v1/memory/sync_setup — git init + remote + seed + push (git only).
  app.post("/v1/memory/sync_setup", async (req, reply) => {
    if (backendOf(state) !== "git") {
      return reply.code(503).send({
        error: "git sync setup only applies to the `git` backend",
        backend: backendOf(state),
      });
    }
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const b = (req.body ?? {}) as GitSetupBody;
    if (b.remote_url === undefined) {
      return reply.code(400).send({ error: "missing `remote_url`" });
    }
    const args: Record<string, unknown> = { remote_url: b.remote_url };
    if (b.scope !== undefined) args["scope"] = b.scope;
    if (b.branch !== undefined) args["branch"] = b.branch;
    if (b.push !== undefined) args["push"] = b.push;
    if (b.force !== undefined) args["force"] = b.force;
    await invokeToolToResponse(new MemorySyncSetupTool(roots), args, reply);
    return reply;
  });

  // POST /v1/memory/sync_setup_icloud — create the iCloud Drive folder (icloud).
  app.post("/v1/memory/sync_setup_icloud", async (_req, reply) => {
    if (backendOf(state) !== "icloud") {
      return reply.code(503).send({
        error: "iCloud sync setup only applies to the `icloud` backend",
        backend: backendOf(state),
      });
    }
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    await invokeToolToResponse(new MemoryICloudSetupTool(roots), {}, reply);
    return reply;
  });

  // ---- include directives ------------------------------------------------

  app.get("/v1/memory/includes", async (req, reply) => {
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const scope = (req.query as { scope?: string } | undefined)?.scope;
    const args: Record<string, unknown> = {};
    if (scope !== undefined) args["scope"] = scope;
    await invokeToolToResponse(new MemoryIncludeListTool(roots), args, reply);
    return reply;
  });

  app.post("/v1/memory/includes", async (req, reply) => {
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const b = (req.body ?? {}) as IncludeBody;
    if (b.target === undefined) {
      return reply.code(400).send({ error: "missing `target`" });
    }
    const args: Record<string, unknown> = { target: b.target };
    if (b.scope !== undefined) args["scope"] = b.scope;
    await invokeToolToResponse(new MemoryIncludeAddTool(roots), args, reply);
    return reply;
  });

  app.delete("/v1/memory/includes", async (req, reply) => {
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const b = (req.body ?? {}) as IncludeBody;
    if (b.target === undefined) {
      return reply.code(400).send({ error: "missing `target`" });
    }
    const args: Record<string, unknown> = { target: b.target };
    if (b.scope !== undefined) args["scope"] = b.scope;
    await invokeToolToResponse(new MemoryIncludeRemoveTool(roots), args, reply);
    return reply;
  });

  app.post("/v1/memory/includes/refresh", async (req, reply) => {
    const roots = rootsFromState(state, reply);
    if (roots === undefined) return reply;
    const b = (req.body ?? {}) as IncludeBody;
    if (b.target === undefined) {
      return reply.code(400).send({ error: "missing `target`" });
    }
    await invokeToolToResponse(new MemoryIncludeRefreshTool(roots), { target: b.target }, reply);
    return reply;
  });
}
