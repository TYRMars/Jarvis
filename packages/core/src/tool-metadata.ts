// Tool catalog metadata — the side-channel classification served by
// `GET /v1/tools`. Ported from harness-core/src/tool_metadata.rs.
//
// These types live alongside the {@link Tool} interface but are deliberately
// NOT part of it: the trait keeps a stable surface and the catalog layer
// derives a best-effort classification from the wire name + the trait's coarse
// {@link ToolCategory} + `requiresApproval` flag. Wire shape is camelCase
// fields with kebab-case enum values (matching the Rust serde reprs and the
// web's apps/jarvis-web/src/services/tools.ts contract).
import type { JsonValue } from "./json.ts";
import { type Tool, type ToolCategory, toolCategory, toolRequiresApproval } from "./tool.ts";

/** Where this tool came from. Drives the catalog UI's "Source" facet. */
export type ToolSource =
  | { kind: "builtin" }
  | { kind: "mcp"; server: string }
  | { kind: "plugin"; plugin: string }
  | { kind: "subagent"; subagent: string };

/**
 * Product-level grouping for the catalog UI (distinct from the trait-level
 * {@link ToolCategory}). Serialised kebab-case.
 */
export type ToolPackCategory =
  | "search"
  | "web"
  | "file-read"
  | "file-write"
  | "code-search"
  | "code-edit"
  | "shell"
  | "git"
  | "project"
  | "requirement"
  | "todo"
  | "doc"
  | "memory"
  | "skill"
  | "cloud"
  | "media"
  | "sub-agent"
  | "mcp"
  | "other";

/** Risk class (advice, not policy). Serialised kebab-case. */
export type ToolRisk =
  | "read-only"
  | "metadata-write"
  | "workspace-write"
  | "shell"
  | "network"
  | "external-side-effect"
  | "secret-access";

/** One tool's catalog entry. Returned (wire-shaped) by `GET /v1/tools`. */
export interface ToolMetadata {
  name: string;
  displayName?: string;
  description: string;
  traitCategory: ToolCategory;
  pack: ToolPackCategory;
  source: ToolSource;
  risk: ToolRisk;
  requiresApproval: boolean;
  /** Runtime enable flag (`false` = muted). Flipped by `PATCH /v1/tools/:name`. */
  enabled: boolean;
  inputSchema: JsonValue;
  cacheable: boolean;
  isTerminal: boolean;
}

/** Build a default metadata snapshot from a registered tool (source=builtin). */
export function toolMetadataFromTool(tool: Tool): ToolMetadata {
  const traitCategory = toolCategory(tool);
  const requiresApproval = toolRequiresApproval(tool);
  return {
    name: tool.name,
    description: tool.description,
    traitCategory,
    pack: derivePack(tool.name),
    source: { kind: "builtin" },
    risk: deriveRisk(tool.name, traitCategory, requiresApproval),
    requiresApproval,
    enabled: true,
    inputSchema: tool.parameters,
    cacheable: tool.cacheable ?? false,
    isTerminal: tool.isTerminal ?? false,
  };
}

/**
 * Project the in-memory metadata onto the JSON wire shape, omitting fields that
 * the Rust serde skips when default (so older/optional-typed clients match):
 * `displayName` when absent, `pack` when `other`, `source` when `builtin`,
 * `isTerminal` when false. `enabled` is always emitted.
 */
export function toolMetadataToWire(m: ToolMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: m.name,
    description: m.description,
    traitCategory: m.traitCategory,
    risk: m.risk,
    requiresApproval: m.requiresApproval,
    enabled: m.enabled,
    inputSchema: m.inputSchema,
    cacheable: m.cacheable,
  };
  if (m.displayName !== undefined) out.displayName = m.displayName;
  if (m.pack !== "other") out.pack = m.pack;
  if (m.source.kind !== "builtin") out.source = m.source;
  if (m.isTerminal) out.isTerminal = m.isTerminal;
  return out;
}

/**
 * Heuristic mapping from wire name to product pack. Keeps catalog grouping
 * zero-config. Mirrors `derive_pack`.
 */
export function derivePack(name: string): ToolPackCategory {
  const dot = name.indexOf(".");
  if (dot < 0) return "other";
  const prefix = name.slice(0, dot);
  switch (prefix) {
    case "fs":
      return name === "fs.read" || name === "fs.list" || name === "fs.search"
        ? "file-read"
        : "file-write";
    case "code":
      return "code-search";
    case "shell":
      return "shell";
    case "git":
      return "git";
    case "http":
    case "web":
    case "browser":
      return "web";
    case "project":
      return "project";
    case "requirement":
    case "roadmap":
    case "triage_scan":
    case "triage":
      return "requirement";
    case "todo":
      return "todo";
    case "doc":
      return "doc";
    case "memory":
      return "memory";
    case "skill":
      return "skill";
    case "cloud":
      return "cloud";
    case "media":
    case "image":
    case "video":
    case "audio":
      return "media";
    case "subagent":
    case "codex":
    case "claude_code":
    case "reviewer":
    case "doc_reader":
      return "sub-agent";
    case "mcp":
      return "mcp";
    default:
      return "other";
  }
}

/**
 * Heuristic risk classification. Conservative: when in doubt, the higher tier.
 * Mirrors `derive_risk`.
 */
export function deriveRisk(
  name: string,
  traitCategory: ToolCategory,
  requiresApproval: boolean,
): ToolRisk {
  // 1. Specific name overrides win first.
  switch (name) {
    case "shell.exec":
    case "shell.background":
    case "shell.kill":
    case "shell.logs":
      return "shell";
    case "fs.write":
    case "fs.edit":
    case "fs.patch":
      return "workspace-write";
    case "http.fetch":
    case "web.search":
    case "web.extract":
      return "network";
  }
  // 2. Prefix-based heuristics.
  const prefix = name.split(".")[0];
  switch (prefix) {
    case "git":
      return requiresApproval ? "workspace-write" : "read-only";
    case "shell":
      return "shell";
    case "subagent":
    case "codex":
    case "claude_code":
    case "reviewer":
    case "doc_reader":
      return "external-side-effect";
    case "todo":
    case "project":
    case "requirement":
    case "doc":
    case "roadmap":
    case "triage":
      return requiresApproval ? "metadata-write" : "read-only";
  }
  // 3. Fall back to the trait-level category.
  switch (traitCategory) {
    case "read":
      return "read-only";
    case "write":
      return requiresApproval ? "workspace-write" : "metadata-write";
    case "exec":
      return "shell";
    case "network":
      return "network";
  }
}
