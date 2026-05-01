// Skill catalogue API client.
//
// `/v1/skills` list / detail / reload — load-only by design today.
// Per-session activation flows over the WebSocket via the
// `activate_skill` / `deactivate_skill` frames; this REST surface
// only mirrors the on-disk catalogue.

import { apiUrl } from "./api";

export type SkillSource = "bundled" | "user" | "workspace" | "plugin";
export type SkillActivation = "manual" | "auto" | "both";

export interface SkillSummary {
  name: string;
  description: string;
  license?: string | null;
  allowed_tools: string[];
  activation: SkillActivation;
  keywords: string[];
  version?: string | null;
  source: SkillSource;
  path: string;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

async function request<T>(method: string, path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { method });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(`skills ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export async function listSkills(): Promise<SkillSummary[]> {
  const data = await request<{ skills: SkillSummary[] }>("GET", "/v1/skills");
  return data.skills ?? [];
}

export async function fetchSkill(name: string): Promise<SkillDetail> {
  return request<SkillDetail>("GET", `/v1/skills/${encodeURIComponent(name)}`);
}

export async function reloadSkills(): Promise<{ count: number }> {
  return request<{ count: number }>("POST", "/v1/skills/reload");
}
