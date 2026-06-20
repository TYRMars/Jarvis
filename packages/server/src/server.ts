// Fastify app assembly + listen helper. Mirrors harness-server's
// `router(AppState)` / `serve(addr, state)`: one place wires routes onto the
// app; transports never reimplement the agent loop (see sse.ts / chat-routes).
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { registerChatRoutes } from "./chat-routes.ts";
import { registerConversationsRoutes } from "./conversations-routes.ts";
import { registerProjectsRoutes } from "./projects-routes.ts";
import { registerRequirementsRoutes } from "./requirements-routes.ts";
import { registerCommentsRoutes } from "./comments-routes.ts";
import { registerLabelsRoutes } from "./labels-routes.ts";
import { registerWorkRoutes } from "./work-routes.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { registerAutoModeRoutes } from "./auto-mode.ts";
import { registerSkillRoutes } from "./skill-routes.ts";
import { registerAutomationRoutes } from "./automation-routes.ts";
import { registerObservabilityRoutes } from "./observability-routes.ts";
import { registerDiagnosticsRoutes } from "./diagnostics-routes.ts";
import { registerProviderAdminRoutes } from "./provider-admin-routes.ts";
import { registerLearningRoutes } from "./learning-routes.ts";
import { registerSubagentsRoutes } from "./subagents-routes.ts";
import { registerChannelsRoutes } from "./channels-routes.ts";
import { registerDocRoutes } from "./doc-routes.ts";
import { registerMemoriesRoutes } from "./memories-routes.ts";
import { registerPermissionsRoutes } from "./permissions-routes.ts";
import { registerPluginsRoutes } from "./plugins-routes.ts";
import { registerAgentProfilesRoutes } from "./agent-profiles-routes.ts";
import { registerTodosRoutes } from "./todos-routes.ts";
import { registerChannelsInboundRoutes } from "./channels-inbound-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";
import { registerWorkspaceTerminalRoutes } from "./workspace-terminal-routes.ts";
import { registerWorkspacesRoutes } from "./workspaces-routes.ts";
import { registerConnectorsRoutes } from "./connectors-routes.ts";
import { registerTasksRoutes } from "./tasks-routes.ts";
import { registerToolsRoutes } from "./tools-routes.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import { registerUiRoutes } from "./ui.ts";
import type { AppState } from "./state.ts";

/** Build the Fastify app with all P2 routes wired. Awaits the WS plugin. */
export async function buildServer(state: AppState): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  app.get("/health", async () => ({ status: "ok" }));
  registerChatRoutes(app, state);
  registerConversationsRoutes(app, state);
  registerProjectsRoutes(app, state);
  registerRequirementsRoutes(app, state);
  registerCommentsRoutes(app, state);
  registerLabelsRoutes(app, state);
  registerWorkRoutes(app, state);
  registerWorkflowRoutes(app, state);
  registerAutoModeRoutes(app, state);
  registerSkillRoutes(app, state);
  registerAutomationRoutes(app, state);
  registerObservabilityRoutes(app, state);
  registerDiagnosticsRoutes(app, state);
  registerProviderAdminRoutes(app, state);
  registerLearningRoutes(app, state);
  registerSubagentsRoutes(app, state);
  registerChannelsRoutes(app, state);
  registerDocRoutes(app, state);
  registerMemoriesRoutes(app, state);
  registerPermissionsRoutes(app, state);
  registerPluginsRoutes(app, state);
  registerAgentProfilesRoutes(app, state);
  registerTodosRoutes(app, state);
  registerChannelsInboundRoutes(app, state);
  registerWorkspaceRoutes(app, state);
  registerWorkspaceTerminalRoutes(app, state);
  registerWorkspacesRoutes(app, state);
  registerConnectorsRoutes(app, state);
  registerTasksRoutes(app, state);
  registerToolsRoutes(app, state);
  registerMcpRoutes(app, state);

  // LAST: the SPA static + fallback catch-all. Registered after every /v1 +
  // /health + WS route so its not-found handler only fires on unmatched paths
  // (mirrors the Rust `.fallback(spa_fallback)` wiring order).
  if (state.webDistDir != null) {
    registerUiRoutes(app, { distDir: state.webDistDir });
  }

  await app.ready();
  return app;
}

export interface ServeOptions {
  host: string;
  port: number;
}

/** Build + listen. Returns the running app (call `.close()` to stop). */
export async function serve(opts: ServeOptions, state: AppState): Promise<FastifyInstance> {
  const app = await buildServer(state);
  await app.listen({ host: opts.host, port: opts.port });
  return app;
}
