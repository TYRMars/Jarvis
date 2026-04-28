// REST + WS helpers for the permission rule engine.
//
// Wire shapes mirror `crates/harness-server/src/permissions.rs` and
// `crates/harness-core/src/permission.rs`. Endpoints return 503 when
// the server has no permission store (e.g. `serve` without an
// initialised workspace) — callers should treat that as "feature
// unavailable" and hide the affordances rather than show an error.
//
// The mode badge (`ModeBadge.tsx`) drives `set_mode` over the WS
// (per-socket, ephemeral). Persisted *default* mode + rules go through
// the REST surface here so they survive restarts and can be edited from
// the Settings page without a live socket.

import { appStore } from "../store/appStore";
import { apiUrl } from "./api";
import { sendFrame, isOpen } from "./socket";
import { showError } from "./status";

export type PermissionMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";
export type Decision = "deny" | "ask" | "allow";
export type Scope = "user" | "project" | "session";

export interface PermissionRule {
  tool: string;
  matchers?: Record<string, string>;
}

export interface ScopedRule {
  scope: Scope;
  tool: string;
  matchers?: Record<string, string>;
}

export interface PermissionTable {
  default_mode: PermissionMode;
  deny: ScopedRule[];
  ask: ScopedRule[];
  allow: ScopedRule[];
}

/// Fetch the merged permission table. Returns `null` when the server
/// reports 503 (no store configured) so the caller can render an
/// "unavailable" state.
export async function fetchPermissionTable(): Promise<PermissionTable | null> {
  try {
    const r = await fetch(apiUrl("/v1/permissions"));
    if (r.status === 503) return null;
    if (!r.ok) throw new Error(`permissions: ${r.status}`);
    return (await r.json()) as PermissionTable;
  } catch (e: any) {
    console.warn("permissions fetch failed", e);
    return null;
  }
}

export interface AppendRuleInput {
  scope: Scope;
  bucket: Decision;
  rule: PermissionRule;
}

/// Append one rule to a given (scope, bucket). Server stamps the
/// scope onto the in-memory `ScopedRule` and broadcasts a change.
export async function appendRule(input: AppendRuleInput): Promise<boolean> {
  try {
    const r = await fetch(apiUrl("/v1/permissions/rules"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (r.status === 503) {
      showError("permission store not configured");
      return false;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not save rule: ${r.status} ${body}`);
      return false;
    }
    return true;
  } catch (e: any) {
    showError(`could not save rule: ${e?.message || e}`);
    return false;
  }
}

export interface DeleteRuleInput {
  scope: Scope;
  bucket: Decision;
  index: number;
}

export async function deleteRule(input: DeleteRuleInput): Promise<boolean> {
  try {
    const url = `${apiUrl("/v1/permissions/rules")}?scope=${encodeURIComponent(
      input.scope,
    )}&bucket=${encodeURIComponent(input.bucket)}&index=${input.index}`;
    const r = await fetch(url, { method: "DELETE" });
    if (r.status === 503) {
      showError("permission store not configured");
      return false;
    }
    if (r.status === 404) {
      // The rule was already gone — likely a double-click. Treat as
      // success so the UI clears the row instead of stranding it.
      return true;
    }
    if (!r.ok) {
      showError(`could not delete rule: ${r.status}`);
      return false;
    }
    return true;
  } catch (e: any) {
    showError(`could not delete rule: ${e?.message || e}`);
    return false;
  }
}

export async function setDefaultMode(scope: Scope, mode: PermissionMode): Promise<boolean> {
  try {
    const r = await fetch(apiUrl("/v1/permissions/mode"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, mode }),
    });
    if (r.status === 503) {
      showError("permission store not configured");
      return false;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not set mode: ${r.status} ${body}`);
      return false;
    }
    // The server doesn't broadcast mode changes back over the socket
    // (that's a per-socket concern), but the *persisted default* did
    // change, so bump the rules version to nudge the Settings page to
    // refetch.
    appStore.getState().bumpPermissionRulesVersion?.();
    return true;
  } catch (e: any) {
    showError(`could not set mode: ${e?.message || e}`);
    return false;
  }
}

/// Switch the *current socket's* permission mode. Per-socket and
/// ephemeral — does not write the persisted default. The server
/// echoes a `permission_mode` frame which the frame handler stashes
/// into `appStore.permissionMode`.
///
/// Bypass *is* allowed over the wire — the operator who has the
/// browser open is the same operator who started the server and
/// can already do whatever they want; forcing a process restart
/// just to flip a UI switch is bureaucratic. The CLI flag
/// `--dangerously-skip-permissions` still exists for unattended
/// / CI use where there's no human to click confirm. The caller
/// (ModeBadge) is responsible for the confirm dialog.
export function setSocketMode(mode: PermissionMode): boolean {
  if (!isOpen()) return false;
  return sendFrame({ type: "set_mode", mode });
}

/// Accept the proposed plan and switch to `post_mode` for the rest
/// of the session. Server resumes the agent loop with the previous
/// user message + the accepted plan as context.
export function acceptPlan(post_mode: PermissionMode): boolean {
  if (!isOpen()) return false;
  const ok = sendFrame({ type: "accept_plan", post_mode });
  if (ok) appStore.getState().setProposedPlan?.("");
  return ok;
}

/// Reject the proposed plan with feedback. Stays in Plan Mode; the
/// server feeds the feedback back to the model as a synthetic user
/// message.
export function refinePlan(feedback: string): boolean {
  if (!isOpen()) return false;
  const ok = sendFrame({ type: "refine_plan", feedback });
  if (ok) appStore.getState().setProposedPlan?.("");
  return ok;
}
