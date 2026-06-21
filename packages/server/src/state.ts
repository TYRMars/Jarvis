// Server-shared application state. Ported (minimal P2 subset) from
// harness-server/src/state.rs. The composition root (apps/jarvis) builds this
// and hands it to `buildServer`; the server itself reads no env / config.
import type { Agent, Approver, LlmProvider, ToolRegistry } from "@jarvis/core";
import type { ChatRunRegistry } from "./chat-runs.ts";
import type { McpManager } from "./mcp-manager.ts";
import type { RoutePolicyStore } from "./route-policy.ts";
import type { ConversationStore, WorkspaceStore } from "@jarvis/store";
import type {
  ActivityStore,
  CommentStore,
  DocStore,
  LabelStore,
  ProjectMemoryStore,
  ProjectStore,
  RequirementRunStore,
  RequirementStore,
} from "@jarvis/project";
import type { WorkflowStore } from "@jarvis/workflow";
import type { WorkflowRunGate } from "./workflow-concurrency.ts";
import type { AutoModeConfig, AutoModeRuntime } from "./auto-mode.ts";
import type { ChannelBindingStore, ChannelDispatcher, ChannelInstanceStore } from "@jarvis/channel";
import type { PluginManager } from "@jarvis/plugin";
import type { AgentProfileStore } from "@jarvis/agent-profile";
import type { TodoStore } from "@jarvis/todo";
import type { SkillCatalog, SkillStore } from "@jarvis/skill";
import type {
  MemoryStore as LearningMemoryStore,
  SkillLifecycleStore,
  SkillUsageStore,
} from "@jarvis/learning";
import type { AutomationStore } from "@jarvis/automation";
import type { EvalStore, ObservabilityStore } from "@jarvis/observability";
import type { MemorySyncBackend } from "@jarvis/tools";
import type { SubAgentRegistry, SubAgentRunStore } from "@jarvis/subagents";
import type {
  ConnectorAccountStore,
  ProjectBindingStore,
  ProjectConnector,
  RequirementBindingStore,
} from "@jarvis/connectors";

/**
 * Resolves a connector account's secret reference (e.g. an env-var name or
 * keychain id) to the actual token. Supplied by the composition root so the
 * server/library never reads process.env. Returns undefined when unresolved.
 */
export type ConnectorSecretResolver = (ref: string) => Promise<string | undefined>;

/**
 * Memory tree roots + chosen sync transport. The composition root builds this
 * from `JARVIS_ENABLE_MEMORY` / `JARVIS_MEMORY_USER_ROOT` /
 * `JARVIS_MEMORY_SYNC_BACKEND` and hands it to {@link AppState.memoryRuntime}.
 * Mirrors `harness_server::state::MemoryRuntime`.
 */
export interface MemoryRuntime {
  /** Pinned workspace root — parent of `<root>/.jarvis/memory/` for workspace scope. */
  workspaceRoot: string;
  /** Parent of the user-scope memory tree; absent disables user scope. */
  userRoot?: string;
  /** Which sync transport is wired (`none` → sync ops 503). */
  backend: MemorySyncBackend;
}

/**
 * One entry in the read-only `GET /v1/providers` catalog that drives the client
 * model picker. Mirrors `harness_server::ProviderInfo` (snake_case wire keys);
 * both the web (`data.providers`) and iOS (`ProvidersResponse`) clients decode it.
 */
export interface ProviderListEntry {
  name: string;
  default_model: string;
  models: string[];
  is_default: boolean;
  /** Canonical provider kind; omitted when unknown. */
  kind?: string;
}

/** Read-only provider/model catalog returned by `GET /v1/providers`. */
export interface ProviderCatalog {
  /** The default provider name (top-level `default` field). */
  default: string | null;
  providers: ProviderListEntry[];
}

/**
 * Static, config-derived runtime snapshot surfaced by `GET /v1/server/info`
 * (the Settings·ServerSection + ContextWindowBadge). Built once by the
 * composition root; the route adds the live `tools` / `mcp_servers` /
 * `providers` lists. Mirrors `harness_server::ServerInfo`; every field is
 * optional so older/partial deployments degrade gracefully. NEVER carries
 * secrets (api keys / tokens).
 */
export interface ServerInfo {
  version?: string | null;
  listen_addr?: string | null;
  config_path?: string | null;
  persistence?: string | null;
  project_store?: boolean;
  memory?: { mode: string; budget_tokens?: number | null } | null;
  approval_mode?: string | null;
  coding_mode?: boolean;
  project_context?: { loaded: boolean; max_bytes?: number | null } | null;
  system_prompt?: { length: number; preview: string } | null;
  max_iterations?: number | null;
  workspace_root?: string | null;
}

export interface AppState {
  /**
   * Build an Agent for one request. The optional `approver` is the per-socket
   * gate the WebSocket transport supplies (mirrors Rust `state.build_agent`).
   * The blocking / SSE chat routes call this with no approver.
   */
  createAgent(approver?: Approver): Agent;
  /**
   * The shared tool registry that `createAgent` builds agents from. Surfaced
   * here so `GET /v1/tools` can list the catalog (including muted tools) and
   * `PATCH /v1/tools/:name` can flip the in-process mute set — which takes
   * effect for the next turn because agents share this instance. Routes 503
   * when absent.
   */
  tools?: ToolRegistry;
  /**
   * In-process chat-run registry: tracks the live turn per persisted
   * conversation (status / event buffer / interrupt). Powers the
   * `/v1/chat/runs*` routes (turn-status badge, reconnect event replay, Stop
   * button) and is populated by the WS turn loop. Routes 503 when absent.
   */
  chatRuns?: ChatRunRegistry;
  /**
   * Dynamic MCP server manager backing `/v1/mcp/servers*` (list/add/remove/
   * health/reload). Wraps the shared ToolRegistry so a server added at runtime
   * registers its tools for the next agent turn. Routes 503 when absent.
   */
  mcpManager?: McpManager;
  /**
   * Static config snapshot for `GET /v1/server/info` + `GET /v1/version`
   * (no secrets). Absent → those routes report only the live lists.
   */
  serverInfo?: ServerInfo;
  /**
   * The configured LLM provider, for `POST /v1/providers/:name/probe` (a
   * minimal ping completion to check auth/capabilities). Absent → probe 503s.
   */
  provider?: LlmProvider;
  /**
   * Operator model route policy (`/v1/routing` CRUD). Mutable in-process; the
   * `summarization` slot is read by the SummarizingMemory resolver. Routes 503
   * when absent.
   */
  routePolicy?: RoutePolicyStore;
  /** Optional conversation persistence. Routes 503 when absent. */
  store?: ConversationStore;

  // ---- Work / Project domain stores (each route 503s when its store is absent) ----
  projects?: ProjectStore;
  requirements?: RequirementStore;
  requirementRuns?: RequirementRunStore;
  activities?: ActivityStore;
  comments?: CommentStore;
  labels?: LabelStore;
  docs?: DocStore;
  projectMemory?: ProjectMemoryStore;
  workflows?: WorkflowStore;

  /**
   * Process-wide governor for manually-dispatched workflow runs (concurrency
   * cap + cancel ledger + liveness set). The composition root builds one and
   * shares it; the manual `/run` route reserves a slot before spawning, the
   * runtime marks each run inflight for its duration, and the stale-run reaper
   * consults its liveness set so it never reclaims a run still alive here.
   * Absent → no concurrency cap / cancel / liveness governance (the runtime
   * degrades to "always admit", matching the pre-gate behaviour).
   */
  workflowRunGate?: WorkflowRunGate;

  /**
   * Process-wide auto-mode runtime (enable flag, per-requirement claim set,
   * concurrency semaphore, hot-reloadable maxRetries override, last-tick
   * timestamp). The composition root builds one when the background scheduler
   * is wired; the `/v1/auto-mode` routes 503 on POST when absent and report
   * `configured: false` on GET.
   */
  autoModeRuntime?: AutoModeRuntime;
  /**
   * Resolved auto-mode config snapshot, surfaced by `GET /v1/auto-mode` so the
   * dashboard can render the scheduler header strip (cadence, caps, retries,
   * run timeout) without separate calls.
   */
  autoModeConfig?: AutoModeConfig;

  // ---- Peripheral domains (each route 503s when its store/registry is absent) ----
  channelInstances?: ChannelInstanceStore;
  channelBindings?: ChannelBindingStore;
  channelDispatcher?: ChannelDispatcher;
  plugins?: PluginManager;
  agentProfiles?: AgentProfileStore;
  todos?: TodoStore;
  skills?: SkillStore;
  skillCatalog?: SkillCatalog;
  skillUsage?: SkillUsageStore;
  skillLifecycle?: SkillLifecycleStore;
  /** Agent long-term (user) memory rows — the @jarvis/learning MemoryStore. */
  learningMemory?: LearningMemoryStore;
  automations?: AutomationStore;
  observability?: ObservabilityStore;
  evals?: EvalStore;
  subagents?: SubAgentRegistry;
  subagentRuns?: SubAgentRunStore;

  // ---- Project connectors (GitHub Issues import/sync/push) ----
  connectorAccounts?: ConnectorAccountStore;
  connectorProjectBindings?: ProjectBindingStore;
  connectorRequirementBindings?: RequirementBindingStore;
  /** Configured connector instances (e.g. a GitHubConnector), keyed by id(). */
  connectors?: ProjectConnector[];
  /** Resolves a connector account's secret ref → token. */
  connectorSecrets?: ConnectorSecretResolver;

  /** Pinned workspace root (for roadmap import + workspace probes). */
  workspaceRoot?: string;

  /**
   * Memory tree roots + sync backend backing the `/v1/memory/sync*` +
   * `/v1/memory/includes*` routes. Absent → those routes 503 ("memory tools
   * not enabled"). Mirrors the Rust `AppState.memory_runtime`; the routes
   * reconstruct the stateless `memory.*` tool impls per request from it.
   */
  memoryRuntime?: MemoryRuntime;

  /**
   * Optional shell override for the workspace terminal PTY
   * (`/v1/workspace/terminal/ws`). The Rust module reads `$SHELL`; the Node
   * server never touches process.env, so the composition root may supply an
   * explicit shell here. Absent -> a hardcoded default (`/bin/bash` if present
   * else `/bin/sh` on posix, `cmd.exe` on Windows).
   */
  terminalShell?: string;

  /**
   * Persisted recent-workspaces registry (the chat-header "Recent folders"
   * dropdown). The `/v1/workspaces` routes 503 when absent. Distinct from
   * `workspaceRoot`, which is the single pinned root for fs/git probes.
   */
  workspaces?: WorkspaceStore;

  /**
   * Absolute path to the built web SPA directory (containing `index.html`).
   * When set, `buildServer` serves it at `/` with a React-Router-aware SPA
   * fallback (see ui.ts), registered LAST so it only catches unmatched paths.
   * Absent → no static UI is served (the Rust binary always bakes `dist/` in;
   * here the composition root supplies the path, or omits it for API-only).
   */
  webDistDir?: string;

  /**
   * Read-only provider/model catalog for the client model picker, served by
   * `GET /v1/providers`. The composition root builds it from the configured
   * provider + its capability catalog. Absent → an empty catalog is returned
   * (never 503; an empty list is a valid "no providers" answer).
   */
  providerCatalog?: ProviderCatalog;
}

/**
 * Ids starting with `__` are reserved for internal use (the content-addressed
 * summary cache written by SummarizingMemory). They must never surface in
 * client-facing CRUD, and the public endpoints refuse to operate on them.
 * Mirrors Rust's `is_internal_id`.
 */
export function isInternalId(id: string): boolean {
  return id.startsWith("__");
}
