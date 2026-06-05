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

// ---- Phase 2 lifecycle (self-improving-agent) ----------------------

export type SkillState = "active" | "stale" | "archived";
export type SkillCreator = "user" | "agent" | "bundled" | "plugin";

export interface SkillLifecycle {
  skill_name: string;
  source: SkillSource;
  created_by: SkillCreator;
  state: SkillState;
  pinned?: boolean;
  absorbed_into?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

/** Raised when the server has no skill-lifecycle store wired (503). */
export class LifecycleUnavailable extends Error {}

/**
 * Fetch the lifecycle row for one skill. The server seeds an Active
 * row on first access. Returns `null` when the lifecycle store isn't
 * configured (503) so callers can hide the lifecycle UI gracefully.
 */
export async function fetchSkillLifecycle(
  name: string,
): Promise<SkillLifecycle | null> {
  try {
    const data = await request<{ lifecycle: SkillLifecycle }>(
      "GET",
      `/v1/skills/${encodeURIComponent(name)}/lifecycle`,
    );
    return data.lifecycle;
  } catch (e) {
    if (e instanceof Error && /503|not configured/i.test(e.message)) {
      return null;
    }
    throw e;
  }
}

export async function archiveSkill(
  name: string,
  absorbedInto?: string,
): Promise<SkillLifecycle> {
  const data = await request<{ lifecycle: SkillLifecycle }>(
    "POST",
    `/v1/skills/${encodeURIComponent(name)}/archive`,
    { absorbed_into: absorbedInto ?? "" },
  );
  return data.lifecycle;
}

export async function restoreSkill(name: string): Promise<SkillLifecycle> {
  const data = await request<{ lifecycle: SkillLifecycle }>(
    "POST",
    `/v1/skills/${encodeURIComponent(name)}/restore`,
  );
  return data.lifecycle;
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
