// Online marketplace API client.
//
// The Rust server proxies public sources so the UI has one stable
// shape for CORS, registry quirks, and install validation.

import { apiUrl } from "./api";
import type { McpClientConfig } from "./mcp";
import type { SkillSummary } from "./skills";

export interface MarketMcpRemote {
  transportType: string;
  url: string;
}

export interface MarketMcpPackage {
  registryType: string;
  identifier: string;
  version?: string | null;
  transportType?: string | null;
  requiredEnv: string[];
}

export interface MarketMcpEntry {
  name: string;
  title?: string | null;
  description?: string | null;
  version?: string | null;
  repositoryUrl?: string | null;
  remotes: MarketMcpRemote[];
  packages: MarketMcpPackage[];
  isLatest: boolean;
}

export interface MarketSkillEntry {
  source: string;
  skillId: string;
  name: string;
  installs?: number | null;
  isOfficial: boolean;
  installHint: string;
}

export interface InstalledMarketSkill extends SkillSummary {
  downloaded_from?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
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
    throw new Error(`market ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

function queryPath(base: string, q: string, limit: number): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  params.set("limit", String(limit));
  return `${base}?${params.toString()}`;
}

export async function searchMcpMarket(q = "", limit = 20): Promise<MarketMcpEntry[]> {
  const data = await request<{ servers: MarketMcpEntry[] }>("GET", queryPath("/v1/market/mcp", q, limit));
  return data.servers ?? [];
}

export async function searchSkillMarket(q = "", limit = 30): Promise<MarketSkillEntry[]> {
  const data = await request<{ skills: MarketSkillEntry[] }>("GET", queryPath("/v1/market/skills", q, limit));
  return data.skills ?? [];
}

export async function installSkillFromMarket(source: string, skillId: string): Promise<InstalledMarketSkill> {
  const data = await request<{ skill: InstalledMarketSkill }>("POST", "/v1/market/skills/install", {
    source,
    skillId,
  });
  return data.skill;
}

export function mcpConfigFromMarketEntry(entry: MarketMcpEntry): McpClientConfig | null {
  const pkg = entry.packages.find((p) =>
    (p.registryType === "npm" || p.registryType === "pypi")
      && (p.transportType == null || p.transportType === "stdio")
      && p.requiredEnv.length === 0,
  );
  if (!pkg) return null;
  const prefix = marketMcpPrefix(entry);
  if (pkg.registryType === "npm") {
    return {
      prefix,
      transport: { type: "stdio", command: "npx", args: ["-y", pkg.identifier] },
      enabled: true,
    };
  }
  return {
    prefix,
    transport: { type: "stdio", command: "uvx", args: [pkg.identifier] },
    enabled: true,
  };
}

export function marketMcpPrefix(entry: MarketMcpEntry): string {
  const raw = entry.title || entry.name.split("/").pop() || entry.name;
  const cleaned = raw
    .toLowerCase()
    .replace(/^mcp[-_\s]+server[-_\s]+/, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "market";
}
