// Server-shared application state. Ported (minimal P2 subset) from
// harness-server/src/state.rs. The composition root (apps/jarvis) builds this
// and hands it to `buildServer`; the server itself reads no env / config.
import type { Agent, Approver } from "@jarvis/core";
import type { ConversationStore } from "@jarvis/store";
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
import type { SubAgentRegistry, SubAgentRunStore } from "@jarvis/subagents";

export interface AppState {
  /**
   * Build an Agent for one request. The optional `approver` is the per-socket
   * gate the WebSocket transport supplies (mirrors Rust `state.build_agent`).
   * The blocking / SSE chat routes call this with no approver.
   */
  createAgent(approver?: Approver): Agent;
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

  /** Pinned workspace root (for roadmap import + workspace probes). */
  workspaceRoot?: string;

  /**
   * Absolute path to the built web SPA directory (containing `index.html`).
   * When set, `buildServer` serves it at `/` with a React-Router-aware SPA
   * fallback (see ui.ts), registered LAST so it only catches unmatched paths.
   * Absent → no static UI is served (the Rust binary always bakes `dist/` in;
   * here the composition root supplies the path, or omits it for API-only).
   */
  webDistDir?: string;
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
