// Plugin manager API client.
//
// Wraps `/v1/plugins*` so React doesn't have to know the wire shape.
// Same throw-on-error convention as services/mcp.ts.

import { apiUrl } from "./api";

export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  install_dir: string;
  source_kind: string;
  source_value: string;
  installed_at: string;
  skill_names: string[];
  mcp_prefixes: string[];
}

export interface PluginInstallReport {
  plugin: InstalledPlugin;
  added_skills: string[];
  added_mcp: string[];
}

export interface MarketplaceEntry {
  name: string;
  description: string;
  source: "path" | "git";
  value: string;
  tags?: string[];
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
    throw new Error(`plugins ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  const data = await request<{ plugins: InstalledPlugin[] }>("GET", "/v1/plugins");
  return data.plugins ?? [];
}

export async function installPlugin(
  source: "path",
  value: string,
): Promise<PluginInstallReport> {
  return request<PluginInstallReport>("POST", "/v1/plugins/install", { source, value });
}

export async function uninstallPlugin(name: string): Promise<void> {
  await request<{ deleted: boolean }>("DELETE", `/v1/plugins/${encodeURIComponent(name)}`);
}

export async function fetchMarketplace(): Promise<MarketplaceEntry[]> {
  const data = await request<{ plugins: MarketplaceEntry[] }>("GET", "/v1/plugins/marketplace");
  return data.plugins ?? [];
}
