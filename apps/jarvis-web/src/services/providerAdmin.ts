// REST client for runtime provider admin (`POST/PATCH/DELETE
// /v1/providers` + `PUT /v1/providers/default`). The read-only side
// is `services/providers.ts` which seeds `appStore.providers` once on
// boot; this module is purely write-side. WS frame
// `providers_changed` triggers a refetch via that read-side.

import { apiUrl } from "./api";

export type ProviderKind =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "google"
  | "codex"
  | "kimi"
  | "kimi-code"
  | "ollama";

export interface ProviderDef {
  name: string;
  kind: string;
  api_key?: string;
  base_url?: string;
  default_model: string;
  models?: string[];
  version?: string;
  reasoning_summary?: string;
  reasoning_effort?: string;
  include_encrypted_reasoning?: boolean;
  service_tier?: string;
  codex_home?: string;
  codex_path?: string;
  codex_originator?: string;
}

export interface ProviderSnapshot {
  name: string;
  kind: string;
  has_api_key: boolean;
  default_model: string;
  models: string[];
  is_default: boolean;
  base_url?: string;
  version?: string;
  reasoning_summary?: string;
  reasoning_effort?: string;
  include_encrypted_reasoning?: boolean;
  service_tier?: string;
  codex_home?: string;
  codex_path?: string;
  codex_originator?: string;
}

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(apiUrl(path), init);
  const text = await r.text();
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(`provider admin ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

interface ProviderEnvelope {
  provider: ProviderSnapshot;
}

export async function createProvider(def: ProviderDef): Promise<ProviderSnapshot> {
  const data = await rest<ProviderEnvelope>("POST", "/v1/providers", def);
  return data.provider;
}

export async function getProvider(name: string): Promise<ProviderSnapshot> {
  const data = await rest<ProviderEnvelope>(
    "GET",
    `/v1/providers/${encodeURIComponent(name)}`,
  );
  return data.provider;
}

export async function updateProvider(
  name: string,
  def: ProviderDef,
): Promise<ProviderSnapshot> {
  const data = await rest<ProviderEnvelope>(
    "PATCH",
    `/v1/providers/${encodeURIComponent(name)}`,
    def,
  );
  return data.provider;
}

export async function deleteProvider(
  name: string,
  purgeSecret = true,
): Promise<boolean> {
  const path = `/v1/providers/${encodeURIComponent(name)}?purge_secret=${purgeSecret}`;
  const data = await rest<{ deleted: boolean }>("DELETE", path);
  return data.deleted;
}

export async function setDefaultProvider(name: string): Promise<void> {
  await rest("PUT", "/v1/providers/default", { name });
}
