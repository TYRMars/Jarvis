// Service layer for the built-in SubAgent registry.
//
// Read-only — built-in subagents (`subagent.read_doc` / `.review` /
// `.codex` / `.claude_code`) are wired by the binary's composition
// root and exposed to the main agent as tools. The Settings UI
// surfaces them as informational cards alongside user-defined agent
// profiles so operators can see what's available out of the box.
//
// Distinct from `services/agentProfiles.ts`: those are the
// user-managed CRUD entries (name + provider + model + system
// prompt) the kanban can assign. SubAgents listed here are
// composition-root primitives, not editable.

import { apiUrl } from "./api";

export interface BuiltinSubAgent {
  /// Bare name, e.g. `read_doc`. Used as the card's primary label.
  name: string;
  /// Full tool name including the `subagent.` prefix.
  tool_name: string;
  /// One-line description shown to the main agent in the tool spec.
  description: string;
  /// `true` when invoking the subagent requires operator approval —
  /// i.e. the subagent can mutate the workspace.
  requires_approval: boolean;
}

interface ListResponse {
  items: BuiltinSubAgent[];
}

/// Fetch the built-in subagent list. Always returns an array;
/// network / parse failures degrade to empty so the Settings page
/// can still render the user-defined-profile section.
export async function loadBuiltinSubAgents(): Promise<BuiltinSubAgent[]> {
  try {
    const r = await fetch(apiUrl("/v1/subagents"));
    if (!r.ok) return [];
    const body = (await r.json()) as ListResponse;
    return body.items ?? [];
  } catch (e) {
    console.warn("built-in subagents fetch failed", e);
    return [];
  }
}
