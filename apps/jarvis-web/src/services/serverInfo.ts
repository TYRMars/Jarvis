// Server runtime info. Wraps `GET /v1/server/info` which carries a
// scrubbed snapshot of how the running jarvis serve was configured —
// listen addr, persistence scheme, memory mode, approval policy,
// tool list, MCP server prefixes, system-prompt preview. **Never**
// includes the persistence URL with credentials, API keys, or OAuth
// tokens.
//
// Polled lazily by the Server settings section on mount and on
// demand (the section's "Refresh" button calls `fetchServerInfo` again).

import { apiUrl } from "./api";

/// Mirrors the JSON shape returned by `GET /v1/server/info`. Every
/// field except `tools` is `null`-safe so older servers (before this
/// endpoint shipped) degrade to "unknown" rather than crashing the
/// section.
export interface ServerInfoPayload {
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
  tools?: string[];
  tool_count?: number;
  mcp_servers?: string[];
  providers?: Array<{
    name: string;
    default_model: string;
    models: string[];
    is_default: boolean;
  }>;
  workspace_root?: string | null;
}

export type ServerInfoState =
  | { kind: "loading" }
  | { kind: "ready"; info: ServerInfoPayload }
  | { kind: "error"; message: string };

export async function fetchServerInfo(): Promise<ServerInfoState> {
  try {
    const res = await fetch(apiUrl("/v1/server/info"));
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const info = (await res.json()) as ServerInfoPayload;
    return { kind: "ready", info };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
