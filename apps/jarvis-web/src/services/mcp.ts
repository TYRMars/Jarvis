// MCP server management API client.
//
// Wraps `/v1/mcp/servers*` so React components don't have to know
// the wire shape. All errors come back as thrown `Error`s with a
// concise message; status-code translation lives here so callers can
// `try/catch` without checking response objects.

import { apiUrl } from "./api";

export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> };

export type McpServerStatus = "running" | "stopped" | "unhealthy";

export interface McpClientConfig {
  prefix: string;
  transport: McpTransport;
  allow_tools?: string[] | null;
  deny_tools?: string[];
  alias?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerInfo {
  prefix: string;
  config: McpClientConfig;
  status: McpServerStatus;
  tools: string[];
}

export interface McpHealth {
  ok: boolean;
  tools?: number;
  latency_ms: number;
  error?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(apiUrl(path), init);
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(`mcp ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export async function listMcpServers(): Promise<McpServerInfo[]> {
  const data = await request<{ servers: McpServerInfo[] }>("GET", "/v1/mcp/servers");
  return data.servers ?? [];
}

export async function addMcpServer(cfg: McpClientConfig): Promise<{ prefix: string; tools: string[] }> {
  return request("POST", "/v1/mcp/servers", cfg);
}

export async function removeMcpServer(prefix: string): Promise<void> {
  await request<{ deleted: boolean }>("DELETE", `/v1/mcp/servers/${encodeURIComponent(prefix)}`);
}

export async function checkMcpHealth(prefix: string): Promise<McpHealth> {
  return request("POST", `/v1/mcp/servers/${encodeURIComponent(prefix)}/health`);
}

/** Build a stdio config from a single command line like `uvx mcp-server-x --foo`. */
export function configFromCommandLine(prefix: string, cmdline: string): McpClientConfig {
  const parts = cmdline.trim().split(/\s+/);
  const command = parts[0] ?? "";
  const args = parts.slice(1);
  return {
    prefix,
    transport: { type: "stdio", command, args },
    enabled: true,
  };
}
