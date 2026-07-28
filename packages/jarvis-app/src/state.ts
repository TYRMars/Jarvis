// state.ts — assemble the server `AppState` from a JarvisConfig + stores.
//
// Mirrors the Rust composition root's `AppState` assembly (apps/jarvis/src/
// serve.rs): the conversation store + every domain store + the peripheral
// stores, plus a `createAgent` factory that builds a fresh @jarvis/core Agent
// per request from the provider + tools + memory + system prompt.
//
// The @jarvis/server `AppState` is a PLAIN INTERFACE (not a Rust-style builder):
// `createAgent(approver?)` is a function this module supplies, and every store
// is an optional field that routes 503 when absent. We build everything once
// and close over it in the factory.
//
// System-prompt switch (mirrors serve.rs): the coding prompt when any write/
// exec tool is enabled (and `codingPromptAuto`), else the general prompt; then
// the workspace project context (AGENTS.md / CLAUDE.md / AGENT.md, priority
// order, 8 KiB cap) is appended unless disabled.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Agent, ToolRegistry, type AgentConfig, type Approver, type HumanLayer, type LlmProvider, type Memory, type Tool } from "@jarvis/core";
import { registerBuiltins, type BuiltinsConfig } from "@jarvis/tools";
import { SlidingWindowMemory, SummarizingMemory, type SummaryStore } from "@jarvis/memory";
import { lookupCapability, canonicalKind } from "@jarvis/llm";
import type { StoreBundle } from "@jarvis/store";
import {
  ChatRunRegistry,
  MemoryPermissionStore,
  RoutePolicyStore,
  isRouteSlot,
  parseModelTarget,
} from "@jarvis/server";
import type { AppState, ProviderCatalog, ServerInfo } from "@jarvis/server";
import type {
  ActivityStore,
  DocStore,
  ProjectStore,
  RequirementStore,
} from "@jarvis/project";
import type { MemoryStore as LearningMemoryStore } from "@jarvis/learning";

import type { JarvisConfig } from "./config.ts";
import { buildToolRegistry, codingMode } from "./tools.ts";
import { capabilityCatalog } from "./provider.ts";
import type { McpClient } from "@jarvis/mcp";
import type { SubAgentRegistry } from "@jarvis/subagents";
import { ConversationSummaryStore } from "./summary-store.ts";

// ---------------------------------------------------------------------------
// system prompts (mirror serve.rs's two consts)
// ---------------------------------------------------------------------------

/** Coding-mode system prompt — byte-aligned with the CLI's `CODING_SYSTEM_PROMPT`. */
export const CODING_SYSTEM_PROMPT =
  "You are Jarvis, a coding agent working in the user's repository. " +
  "Before editing, call workspace.context to orient yourself, then inspect git status. " +
  "Do not overwrite user changes you did not make. " +
  "Prefer code.grep, fs.read, fs.list, git.status, and git.diff before reaching for shell.exec. " +
  "Use fs.edit (uniqueness-checked single replace) or fs.patch (unified-diff multi-hunk) for small " +
  "reviewable edits; reach for fs.write only to create new files. " +
  "When you run checks (tests, lints, builds), keep them focused on the change rather than the " +
  "whole repo. " +
  "End every coding turn with a short report: which files changed, which checks ran, which checks " +
  "were skipped and why, and any residual risk you couldn't verify.";

/** General-purpose system prompt — used when no write/exec tool is enabled. */
export const GENERAL_SYSTEM_PROMPT =
  "You are Jarvis, a helpful assistant with access to a set of tools. " +
  "Call workspace.context first to orient yourself when working in a repository. " +
  "Prefer the read-only tools (fs.read, fs.list, code.grep, git.status, http.fetch) and explain " +
  "your reasoning concisely.";

/**
 * Instruction files auto-loaded as project context, highest priority first.
 * Mirrors the Rust `load_instructions` set (README.md / CONTRIBUTING.md are
 * deliberately excluded).
 */
const PROJECT_CONTEXT_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", "AGENT.md"];

// ---------------------------------------------------------------------------
// store seams
// ---------------------------------------------------------------------------

/**
 * The subset of stores that gate the store-backed tool families. Built from a
 * full {@link StoreBundle} (production) or hand-picked (tests). Distinct from
 * the AppState store set because the tool families only need these handles.
 */
export interface ToolStores {
  requirements?: RequirementStore;
  activities?: ActivityStore;
  projects?: ProjectStore;
  docs?: DocStore;
  learningMemory?: LearningMemoryStore;
}

/** Everything the AppState assembly needs that isn't on the JarvisConfig. */
export interface BuildAppStateDeps {
  /** The (already-wrapped) primary LlmProvider. Injected so tests pass a stub. */
  provider: LlmProvider;
  /** The full persistence bundle (conversations + domain stores). */
  stores: StoreBundle;
  /** Long-term (user) memory rows — the @jarvis/learning MemoryStore. */
  learningMemory?: LearningMemoryStore;
  /**
   * Pre-resolved system prompt. When omitted, {@link resolveSystemPrompt} runs
   * (coding/general switch + project context). Tests pass a fixed string to
   * skip the filesystem read.
   */
  systemPrompt?: string;
}

/** Result of {@link buildAppState}: the state + the live MCP clients to keep open. */
export interface AppStateBundle {
  state: AppState;
  mcpClients: McpClient[];
  subagents: SubAgentRegistry;
  /** The resolved system prompt (surfaced for `status` / logging). */
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * Resolve the final system prompt: coding vs general template + (unless opted
 * out) the workspace project context, capped at `projectContextMaxBytes`.
 */
export async function resolveSystemPrompt(config: JarvisConfig): Promise<string> {
  const base = codingMode(config) && config.codingPromptAuto ? CODING_SYSTEM_PROMPT : GENERAL_SYSTEM_PROMPT;
  if (!config.includeProjectContext) return base;
  const extra = await loadProjectContext(config.fsRoot, config.projectContextMaxBytes);
  return extra !== undefined ? `${base}\n\n${extra}` : base;
}

/**
 * Load the workspace's project-context files (AGENTS.md / CLAUDE.md / AGENT.md)
 * and concatenate them, each wrapped in `=== project context: <name> ===`,
 * capped at `maxBytes`. Returns undefined when none exist.
 */
export async function loadProjectContext(fsRoot: string, maxBytes: number): Promise<string | undefined> {
  const blocks: string[] = [];
  let total = 0;
  for (const name of PROJECT_CONTEXT_FILES) {
    let body: string;
    try {
      body = await readFile(path.join(fsRoot, name), "utf8");
    } catch {
      continue; // not present — skip
    }
    if (body.trim() === "") continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) break;
    const truncated = body.length > remaining ? `${body.slice(0, remaining)}\n[...truncated]` : body;
    blocks.push(`=== project context: ${name} ===\n${truncated}`);
    total += truncated.length;
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * The builtin-tool config for an INNER subagent registry: the same fs/shell
 * gating + store-backed families as the outer agent, but without MCP or the
 * `subagent.*` adapters (those are added by `buildToolRegistry`, not here).
 */
function innerBuiltinsConfig(config: JarvisConfig, stores: ToolStores): BuiltinsConfig {
  const c: BuiltinsConfig = {
    fsRoot: config.fsRoot,
    httpMaxBytes: config.gating.httpMaxBytes,
    enableFsWrite: config.gating.enableFsWrite,
    enableFsEdit: config.gating.enableFsEdit,
    enableFsPatch: config.gating.enableFsPatch,
    enableShellExec: config.gating.enableShellExec,
    shellDefaultTimeoutMs: config.gating.shellTimeoutMs,
    enableGitRead: config.gating.enableGitRead,
  };
  if (stores.requirements !== undefined) c.requirements = stores.requirements;
  if (stores.activities !== undefined) c.activities = stores.activities;
  if (stores.projects !== undefined) c.projects = stores.projects;
  if (stores.docs !== undefined) c.docs = stores.docs;
  if (stores.learningMemory !== undefined) c.learningMemory = stores.learningMemory;
  return c;
}

/**
 * Build short-term memory per `JARVIS_MEMORY_MODE`. Returns undefined when no
 * token budget is set (the default unbounded-history behaviour).
 *
 * In `summary` mode, when a `summaryStore` is supplied the cross-process
 * persistence tier is attached (`withPersistence`) so summaries survive
 * restarts and are shared across workers — mirroring the Rust composition
 * root, which wires `with_persistence(store)` whenever a store is present.
 * `window` mode never calls the LLM, so it has no persistence tier.
 */
export function buildMemory(
  config: JarvisConfig,
  llm: LlmProvider,
  summaryStore?: SummaryStore,
  routePolicy?: RoutePolicyStore,
): Memory | undefined {
  const budget = resolveMemoryBudget(config);
  if (budget === undefined) return undefined;
  if (config.memoryMode === "summary") {
    let sm = new SummarizingMemory(llm, config.memoryModel ?? config.model, budget);
    // Honour the operator route policy's `summarization` slot (non-hollow
    // consumer of /v1/routing), mirroring the Rust LlmRouteResolver.
    if (routePolicy) sm = sm.withModelResolver(() => routePolicy.summarizationModel());
    return summaryStore !== undefined ? sm.withPersistence(summaryStore) : sm;
  }
  return new SlidingWindowMemory(budget);
}

/** Reserve carved out of a model's context window for output + system/tools
 * headroom when deriving a default memory budget (mirrors opencode's
 * COMPACTION_BUFFER cap). 20% of context, clamped to [4k, 20k] tokens. */
function reservedTokens(contextWindow: number): number {
  return Math.min(20_000, Math.max(4_000, Math.floor(contextWindow * 0.2)));
}

/**
 * The effective memory token budget. Explicit `JARVIS_MEMORY_TOKENS` wins;
 * otherwise derive `contextWindow - reserved` from the model's capability
 * catalog so compaction adapts to the model's window instead of being off
 * entirely. Returns `undefined` when neither is available (unknown model with
 * no explicit budget) — the historical "no memory installed" behaviour.
 */
export function resolveMemoryBudget(config: JarvisConfig): number | undefined {
  if (config.memoryTokens !== undefined) return config.memoryTokens;
  const ctx = lookupCapability(canonicalKind(config.provider), config.model)?.contextWindow;
  if (ctx === undefined || ctx <= 0) return undefined;
  const budget = ctx - reservedTokens(ctx);
  return budget > 0 ? budget : undefined;
}

/**
 * Build the read-only provider/model catalog for `GET /v1/providers` (the client
 * model picker). In the env-driven setup exactly one provider is configured, so
 * the catalog is a single `is_default` entry: the configured provider, its
 * default model, and the model list from its capability catalog (the configured
 * model is always included even if the catalog doesn't list it). Mirrors the
 * shape of Rust's `list_providers` (`{ default, providers }`).
 */
export function buildProviderCatalog(config: JarvisConfig): ProviderCatalog {
  const catalogModels = capabilityCatalog(config.provider).map((c) => c.model);
  const models = catalogModels.includes(config.model)
    ? catalogModels
    : [config.model, ...catalogModels];
  return {
    default: config.provider,
    providers: [
      {
        name: config.provider,
        default_model: config.model,
        models,
        is_default: true,
        kind: config.provider,
      },
    ],
  };
}

/**
 * Assemble the {@link AppState}. The `createAgent` factory rebuilds a fresh
 * Agent per request from a SNAPSHOT of the canonical tool registry (so a
 * per-socket approver can be supplied without mutating shared state), with the
 * resolved system prompt + short-term memory attached.
 */
export async function buildAppState(
  config: JarvisConfig,
  deps: BuildAppStateDeps,
): Promise<AppStateBundle> {
  const { provider, stores } = deps;
  const systemPrompt = deps.systemPrompt ?? (await resolveSystemPrompt(config));

  const toolStores: ToolStores = {
    requirements: stores.requirements,
    activities: stores.activities,
    projects: stores.projects,
    docs: stores.docs,
    ...(deps.learningMemory !== undefined ? { learningMemory: deps.learningMemory } : {}),
  };

  // Build a subagent-FREE registry first — the builtin set only, NO `subagent.*`
  // adapters (no batch-of-batches) and NO external MCP servers (inner loops must
  // not re-spawn child processes). Built once and reused across inner runs.
  const innerToolSnapshot = new ToolRegistry();
  registerBuiltins(innerToolSnapshot, innerBuiltinsConfig(config, toolStores));

  // The internal subagents spin up an inner agent loop sharing the SAME
  // provider + the subagent-free registry, with a session-scoped system prompt.
  const makeInnerAgent = (opts: { model: string; maxIterations: number; sessionWorkspace: string }) => {
    void opts.sessionWorkspace; // session-workspace sandbox re-root is deferred
    const innerCfg: AgentConfig = {
      model: opts.model,
      systemPrompt,
      tools: innerToolSnapshot,
      maxIterations: opts.maxIterations,
      refreshSystemPromptOnResume: true,
    };
    return new Agent(provider, innerCfg);
  };

  // Build the canonical tool registry (with the subagent adapters wired via the
  // inner factory) + connect the external MCP servers.
  const toolBundle = await buildToolRegistry(config, toolStores, { createAgent: makeInnerAgent });

  // Cross-process summary cache tier: the persistent conversation store doubles
  // as the SummaryStore (rows under `__memory__.summary:<hash>`, filtered out of
  // public lists). Only consumed by `buildMemory` in `summary` mode; harmless to
  // construct otherwise. Mirrors the Rust "attach when a store is present" rule.
  const summaryStore = new ConversationSummaryStore(stores.conversations);

  // Operator route policy: seed from JARVIS_ROUTE_* then share the mutable store
  // between the /v1/routing CRUD and the SummarizingMemory resolver.
  const routePolicy = new RoutePolicyStore();
  for (const [slot, raw] of Object.entries(config.routeSlots)) {
    if (!isRouteSlot(slot)) continue;
    const target = parseModelTarget(raw);
    if (target) routePolicy.setSlot(slot, target);
  }
  const memory = buildMemory(config, provider, summaryStore, routePolicy);

  const createAgent = (
    approver?: Approver,
    human?: HumanLayer,
    toolFilter?: (tool: Tool) => boolean,
  ): Agent => {
    const agentConfig: AgentConfig = {
      model: config.model,
      systemPrompt,
      // The registry is shared (read-only at request time); the per-socket
      // approver / human responder / tool filter live on AgentConfig, not the
      // registry, so this is safe.
      tools: toolBundle.registry,
      maxIterations: 80,
      refreshSystemPromptOnResume: true,
    };
    if (approver !== undefined) agentConfig.approver = approver;
    if (human !== undefined) agentConfig.human = human;
    if (toolFilter !== undefined) agentConfig.toolFilter = toolFilter;
    if (memory !== undefined) agentConfig.memory = memory;
    return new Agent(provider, agentConfig);
  };

  // The permission rule engine. Seeded with the resolved JARVIS_PERMISSION_MODE
  // so the env var actually gates tool calls (each chat socket adopts this as
  // its starting mode); `/v1/permissions*` edits the same table.
  const permissionStore = new MemoryPermissionStore(config.permissionMode);

  // Static config snapshot for GET /v1/server/info + /v1/version (no secrets).
  const serverInfo: ServerInfo = {
    // The "jarvis" app version users saw under the Rust binary (crate 0.2.0);
    // continuity for the About section until a single Node version is minted.
    version: "0.2.0",
    listen_addr: config.addr,
    config_path: null,
    persistence: config.dbUrl ?? "json",
    project_store: stores.projects !== undefined,
    memory: { mode: config.memoryMode, budget_tokens: resolveMemoryBudget(config) ?? null },
    approval_mode: config.permissionMode,
    coding_mode: codingMode(config),
    project_context: { loaded: config.includeProjectContext, max_bytes: config.projectContextMaxBytes },
    system_prompt: { length: systemPrompt.length, preview: systemPrompt.slice(0, 280) },
    max_iterations: 80,
    workspace_root: config.fsRoot,
  };

  const state: AppState = {
    createAgent,
    // The configured provider, for GET /v1/server/info's provider list + the
    // POST /v1/providers/:name/probe connectivity ping.
    provider,
    serverInfo,
    // The SAME registry `createAgent` builds agents from — so `GET /v1/tools`
    // lists the live catalog and `PATCH /v1/tools/:name` mutes take effect for
    // the next turn.
    tools: toolBundle.registry,
    // Permission rule table + default mode: gates gated-tool dispatch on every
    // chat socket and backs /v1/permissions*.
    permissionStore,
    // In-process chat-run registry for the turn-status badge / Stop button.
    chatRuns: new ChatRunRegistry(),
    // MCP server manager backing /v1/mcp/servers* (shares the tool registry).
    mcpManager: toolBundle.mcpManager,
    // Operator route policy backing /v1/routing (shared with the summariser).
    routePolicy,
    store: stores.conversations,
    projects: stores.projects,
    requirements: stores.requirements,
    requirementRuns: stores.requirementRuns,
    activities: stores.activities,
    comments: stores.comments,
    labels: stores.labels,
    docs: stores.docs,
    projectMemory: stores.projectMemory,
    workflows: stores.workflows,
    workspaces: stores.workspaces,
    subagents: toolBundle.subagents,
    workspaceRoot: config.fsRoot,
    providerCatalog: buildProviderCatalog(config),
    ...(config.webDistDir !== undefined ? { webDistDir: config.webDistDir } : {}),
    ...(deps.learningMemory !== undefined ? { learningMemory: deps.learningMemory } : {}),
    // Memory tree roots + sync backend backing /v1/memory/sync* + /includes*.
    // Only populated when JARVIS_ENABLE_MEMORY is set, so the routes otherwise
    // 503 ("memory tools not enabled").
    ...(config.enableMemory
      ? {
          memoryRuntime: {
            workspaceRoot: config.fsRoot,
            ...(config.memoryUserRoot !== undefined ? { userRoot: config.memoryUserRoot } : {}),
            backend: config.memorySyncBackend,
          },
        }
      : {}),
  };

  return {
    state,
    mcpClients: toolBundle.mcpClients,
    subagents: toolBundle.subagents,
    systemPrompt,
  };
}
