// REST client for the route-policy admin
// (`GET/PUT /v1/routing` + `PATCH/DELETE /v1/routing/:slot`).
// Read-side seeds the in-process snapshot at app boot; mutations
// take immediate effect for the SummarizingMemory resolver and
// future per-request resolvers, but **not** for already-built
// SubAgent instances (those capture the policy at startup; a
// server restart picks up changes). The Web UI surfaces this
// caveat in the section description.

import { apiUrl } from "./api";

/// One `(provider, model)` target in the policy. Mirrors the Rust
/// `ModelTarget` shape from `crates/harness-server/src/route_policy.rs`.
export interface ModelTarget {
  provider: string;
  model: string;
}

export type RouteSlot =
  | "default"
  | "coding"
  | "review"
  | "summarization"
  | "doc_reader"
  | "vision"
  | "local_private";

export const ALL_ROUTE_SLOTS: RouteSlot[] = [
  "default",
  "coding",
  "review",
  "summarization",
  "doc_reader",
  "vision",
  "local_private",
];

/// Wire shape returned by `GET /v1/routing`. Empty fields are
/// elided server-side (`skip_serializing_if = "Option::is_none"` /
/// `Vec::is_empty`), so the client must default-fill.
export interface RoutePolicy {
  default?: ModelTarget;
  coding?: ModelTarget;
  review?: ModelTarget;
  summarization?: ModelTarget;
  doc_reader?: ModelTarget;
  vision?: ModelTarget;
  local_private?: ModelTarget;
  fallbacks?: ModelTarget[];
}

export async function fetchRoutePolicy(): Promise<RoutePolicy> {
  const res = await fetch(apiUrl("/v1/routing"));
  if (!res.ok) {
    throw new Error(`GET /v1/routing failed: ${res.status}`);
  }
  return res.json();
}

export async function replaceRoutePolicy(policy: RoutePolicy): Promise<RoutePolicy> {
  const res = await fetch(apiUrl("/v1/routing"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT /v1/routing failed: ${res.status} ${text}`);
  }
  return res.json();
}

/// Update a single slot. Pass `null` to clear the slot. Returns the
/// updated whole-policy snapshot.
export async function patchRouteSlot(
  slot: RouteSlot,
  target: ModelTarget | null,
): Promise<RoutePolicy> {
  const body = {
    target: target ? `${target.provider}/${target.model}` : null,
  };
  const res = await fetch(apiUrl(`/v1/routing/${slot}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PATCH /v1/routing/${slot} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function deleteRouteSlot(slot: RouteSlot): Promise<RoutePolicy> {
  const res = await fetch(apiUrl(`/v1/routing/${slot}`), {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE /v1/routing/${slot} failed: ${res.status} ${text}`);
  }
  return res.json();
}
