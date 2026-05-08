// Read-side client for `GET /v1/tools`. Phase 1 of the
// model-tool-compatibility rollout — the per-tool catalog lands
// before the per-tool enable/disable mutator (which is Phase 1.5
// in spec terms).

import { apiUrl } from "./api";

export type ToolSourceKind = "builtin" | "mcp" | "plugin" | "subagent";

export type ToolSource =
  | { kind: "builtin" }
  | { kind: "mcp"; server: string }
  | { kind: "plugin"; plugin: string }
  | { kind: "subagent"; subagent: string };

export type ToolPack =
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

export type ToolRisk =
  | "read-only"
  | "metadata-write"
  | "workspace-write"
  | "shell"
  | "network"
  | "external-side-effect"
  | "secret-access";

export type TraitToolCategory = "read" | "write" | "exec" | "network";

export interface ToolMetadata {
  name: string;
  displayName?: string;
  description: string;
  traitCategory: TraitToolCategory;
  pack?: ToolPack;
  source?: ToolSource;
  risk: ToolRisk;
  requiresApproval: boolean;
  /// Runtime enable flag. `false` means the tool is muted —
  /// hidden from the LLM but kept in the catalog so the operator
  /// can flip it back. Older servers omit the field; the type
  /// keeps it optional for back-compat.
  enabled?: boolean;
  inputSchema: unknown;
  cacheable: boolean;
  isTerminal?: boolean;
}

export interface ToolsResponse {
  total: number;
  tools: ToolMetadata[];
}

export interface ToolsFilter {
  source?: ToolSourceKind;
  pack?: ToolPack;
  risk?: ToolRisk;
}

export async function loadTools(filter?: ToolsFilter): Promise<ToolsResponse> {
  const params = new URLSearchParams();
  if (filter?.source) params.set("source", filter.source);
  if (filter?.pack) params.set("pack", filter.pack);
  if (filter?.risk) params.set("risk", filter.risk);
  const qs = params.toString();
  const path = qs ? `/v1/tools?${qs}` : "/v1/tools";
  const r = await fetch(apiUrl(path));
  if (!r.ok) {
    throw new Error(`tools fetch ${r.status} ${r.statusText}`);
  }
  return (await r.json()) as ToolsResponse;
}

export interface SetToolEnabledResult {
  name: string;
  enabled: boolean;
  muted_count: number;
}

/// Toggle a tool's runtime enable flag. Server-side this hits
/// `PATCH /v1/tools/:name`; the registry's mute set persists only
/// in-process so a restart returns to "everything enabled".
export async function setToolEnabled(
  name: string,
  enabled: boolean,
): Promise<SetToolEnabledResult> {
  const r = await fetch(apiUrl(`/v1/tools/${encodeURIComponent(name)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(`tool patch failed: ${msg}`);
  }
  return JSON.parse(text) as SetToolEnabledResult;
}
