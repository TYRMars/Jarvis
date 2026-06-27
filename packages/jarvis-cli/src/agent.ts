// agent.ts — build an @jarvis/core Agent from a CliConfig + injected deps.
//
// This is the in-process wiring: provider (env-only construction) + a builtin
// ToolRegistry + optional short-term memory + the coding system prompt with
// the workspace's project-context appended. Mirrors apps/jarvis-cli/src/
// runner.rs::build_agent + provider.rs::build, but the Node @jarvis/core does
// NOT yet expose PermissionMode / a tool-filter (Plan Mode is deferred), so we
// don't filter the catalogue here — the approver is the only gate.
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  Agent,
  ToolRegistry,
  type AgentConfig,
  type Approver,
  type LlmProvider,
  type Memory,
} from "@jarvis/core";
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAiProvider,
  ResponsesProvider,
} from "@jarvis/llm";
import { SlidingWindowMemory, SummarizingMemory } from "@jarvis/memory";
import { registerBuiltins, type BuiltinsConfig } from "@jarvis/tools";

import type { CliConfig } from "./config.ts";

/**
 * The CLI system prompt mirrors apps/jarvis::serve::CODING_SYSTEM_PROMPT — same
 * contract, so the CLI and server agent feel like the same animal. Kept inline
 * (siblings, no shared prompt crate yet).
 */
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

/**
 * Instruction files auto-loaded into the system prompt as project context,
 * highest priority first. Mirrors the Rust `load_instructions` set
 * (README.md / CONTRIBUTING.md are deliberately excluded).
 */
const PROJECT_CONTEXT_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", "AGENT.md"];

/**
 * Build the provider for `config`. Pure construction off the resolved config —
 * no env reads here (config.ts already did that). Exposed so callers can inject
 * a stub provider in tests by skipping this entirely.
 */
export function buildProvider(config: CliConfig): LlmProvider {
  const { provider, apiKey, baseUrl } = config;
  switch (provider) {
    case "openai":
    case "ollama":
    case "kimi":
      // Ollama + Kimi reuse the OpenAI wire format via a swapped base URL.
      return new OpenAiProvider(baseUrl !== undefined ? { apiKey, baseUrl } : { apiKey });
    case "openai-responses":
      return ResponsesProvider.openaiResponses(apiKey, baseUrl !== undefined ? { baseUrl } : {});
    case "anthropic": {
      const cfg: { apiKey: string; baseUrl?: string; anthropicVersion?: string } = { apiKey };
      if (baseUrl !== undefined) cfg.baseUrl = baseUrl;
      if (config.anthropicVersion !== undefined) cfg.anthropicVersion = config.anthropicVersion;
      return new AnthropicProvider(cfg);
    }
    case "google":
      return new GoogleProvider(baseUrl !== undefined ? { apiKey, baseUrl } : { apiKey });
    default:
      return assertNever(provider);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled provider: ${String(x)}`);
}

/** Assemble the builtin ToolRegistry for the CLI's gating. */
export function buildTools(config: CliConfig): ToolRegistry {
  const builtins: BuiltinsConfig = {
    fsRoot: config.fsRoot,
    enableFsEdit: config.enableFsEdit,
    enableFsPatch: config.enableFsPatch,
    enableFsWrite: config.enableFsWrite,
    enableShellExec: config.enableShellExec,
    enableGitRead: config.enableGitRead,
    enableEnterPlanMode: config.enableEnterPlanMode,
    shellDefaultTimeoutMs: config.shellTimeoutMs,
  };
  const tools = new ToolRegistry();
  registerBuiltins(tools, builtins);
  return tools;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character. The cap the operator configures
 * (`JARVIS_PROJECT_CONTEXT_BYTES`) is a *byte* budget, so accounting must use
 * UTF-8 byte lengths — `String.length` / `.slice()` count UTF-16 code units and
 * would overshoot ~3x for CJK-heavy context files.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Back the cut point off any UTF-8 continuation byte (0b10xxxxxx) so we land
  // on a character boundary rather than mid-sequence.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

/**
 * Load the workspace's project-context files (AGENTS.md / CLAUDE.md / AGENT.md)
 * and concatenate them, each wrapped in `=== project context: <name> ===`,
 * capped at `maxBytes` UTF-8 bytes. Returns undefined when none exist or
 * context is off.
 */
export async function loadProjectContext(
  fsRoot: string,
  maxBytes: number,
): Promise<string | undefined> {
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
    const truncated =
      Buffer.byteLength(body, "utf8") > remaining
        ? `${truncateToBytes(body, remaining)}\n[...truncated]`
        : body;
    blocks.push(`=== project context: ${name} ===\n${truncated}`);
    total += Buffer.byteLength(truncated, "utf8");
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * Resolve the final system prompt: coding template + (unless opted out) the
 * workspace project context.
 */
export async function resolveSystemPrompt(config: CliConfig): Promise<string> {
  let prompt = CODING_SYSTEM_PROMPT;
  if (config.includeProjectContext) {
    const extra = await loadProjectContext(config.fsRoot, config.projectContextBytes);
    if (extra !== undefined) prompt = `${prompt}\n\n${extra}`;
  }
  return prompt;
}

/** Optionally build short-term memory from the config. */
export function buildMemory(config: CliConfig, llm: LlmProvider): Memory | undefined {
  if (config.memoryTokens === undefined) return undefined;
  if (config.memoryMode === "summary") {
    return new SummarizingMemory(llm, config.memoryModel ?? config.model, config.memoryTokens);
  }
  return new SlidingWindowMemory(config.memoryTokens);
}

/**
 * Build a fully-wired Agent. `provider` and `approver` are injected so tests
 * can supply a stub LlmProvider + an in-memory approver; production callers
 * pass the env-constructed provider via {@link buildProvider}.
 */
export async function buildAgent(args: {
  config: CliConfig;
  provider: LlmProvider;
  approver?: Approver;
  /** Override the resolved system prompt (tests / project prelude). */
  systemPrompt?: string;
}): Promise<Agent> {
  const { config, provider, approver } = args;
  const tools = buildTools(config);
  const systemPrompt = args.systemPrompt ?? (await resolveSystemPrompt(config));
  const memory = buildMemory(config, provider);

  const agentConfig: AgentConfig = {
    model: config.model,
    systemPrompt,
    tools,
    maxIterations: config.maxIterations,
    refreshSystemPromptOnResume: true,
  };
  if (approver !== undefined) agentConfig.approver = approver;
  if (memory !== undefined) agentConfig.memory = memory;

  return new Agent(provider, agentConfig);
}
