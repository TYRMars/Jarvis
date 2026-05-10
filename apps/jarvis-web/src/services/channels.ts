// Service layer for the Settings → Channels page.
//
// Wraps `/v1/channels*`. Mirrors the conventions used by
// `services/conversations.ts` etc. — fetch, surface 503 as null,
// throw on other non-2xx so the UI surfaces actionable errors.

import { apiUrl } from "./api";

export type ChannelStatus = "enabled" | "disabled" | "unconfigured";

export interface ChannelInstance {
  id: string;
  kind: string;
  display_name: string;
  status: ChannelStatus;
  /** Kind-specific config blob. May contain `${env:NAME}` templates. */
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Catalogue entry returned by `GET /v1/channels/kinds`. Drives the
 *  "Add channel" picker and the per-kind config form. */
export interface ChannelKind {
  kind: string;
  label: string;
  label_en: string;
  direction: "outbound" | "inbound" | "bidirectional";
  description: string;
  /** JSON Schema-shaped object describing the `config` payload. */
  schema: {
    type: "object";
    required?: string[];
    properties: Record<
      string,
      {
        type: "string" | "array" | "object" | "boolean" | "number";
        title?: string;
        description?: string;
        items?: { type: string };
        example?: string;
      }
    >;
  };
  test_supported: boolean;
}

/// `null` ⇒ store not configured (503). Throws on other errors.
export async function listChannels(): Promise<ChannelInstance[] | null> {
  const r = await fetch(apiUrl("/v1/channels"));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`channels list ${r.status}`);
  const body = (await r.json()) as { items: ChannelInstance[] };
  return body.items;
}

export async function listChannelKinds(): Promise<ChannelKind[] | null> {
  const r = await fetch(apiUrl("/v1/channels/kinds"));
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`channel kinds ${r.status}`);
  const body = (await r.json()) as { kinds: ChannelKind[] };
  return body.kinds;
}

export async function createChannel(input: {
  kind: string;
  display_name: string;
  config?: Record<string, unknown>;
}): Promise<ChannelInstance> {
  const r = await fetch(apiUrl("/v1/channels"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, config: input.config ?? {} }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`channels create ${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as ChannelInstance;
}

export async function patchChannel(
  id: string,
  patch: {
    display_name?: string;
    status?: ChannelStatus;
    config?: Record<string, unknown>;
  },
): Promise<ChannelInstance> {
  const r = await fetch(apiUrl(`/v1/channels/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`channels patch ${r.status}: ${text || r.statusText}`);
  }
  return (await r.json()) as ChannelInstance;
}

export async function deleteChannel(id: string): Promise<boolean> {
  const r = await fetch(apiUrl(`/v1/channels/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`channels delete ${r.status}`);
  const body = (await r.json()) as { deleted: boolean };
  return body.deleted;
}

export interface ChannelTestResult {
  ok: boolean;
  message_preview?: string;
  error?: string;
}

/** Sends a one-shot test message via the kind's sender. The server
 *  resolves `${env:…}` templates at this moment, so an in-flight env
 *  rotation takes effect on the next click. */
export async function testChannel(
  id: string,
  text?: string,
): Promise<ChannelTestResult> {
  const r = await fetch(
    apiUrl(`/v1/channels/${encodeURIComponent(id)}/test`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(text ? { text } : {}),
    },
  );
  // Distinguish "channel hit a 4xx/5xx" (returned as JSON) from a
  // hard transport failure. The server uses 502 for upstream send
  // failures + 200 for success, both with a JSON body — fold both
  // shapes into a single `ChannelTestResult`.
  const body = (await r.json().catch(() => ({}))) as ChannelTestResult;
  if (!r.ok && body.error === undefined) {
    return { ok: false, error: `HTTP ${r.status}` };
  }
  return body;
}
