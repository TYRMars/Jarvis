// Human-in-the-loop (HITL) channel. The agent loop's request/response sibling
// of the one-way plan/progress channels, and the tool-initiated mirror of the
// approval gate.
//
// A tool (in practice `ask.text`) calls `requestHuman(req)` to surface a
// question to the operator and AWAIT their answer. The agent loop installs a
// per-invocation sink via `withHitl` that (a) emits a `hitl_request` AgentEvent
// so a transport renders a card, (b) awaits the transport-supplied HumanLayer
// for the operator's HitlResponse, then (c) emits a `hitl_response` echo so the
// card resolves. Outside a `withHitl` scope (a blocking `run`, or an SSE stream
// with no transport) the sink is absent and `requestHuman` resolves immediately
// with an `expired` response, so the tool still produces a textual result.
//
// The split mirrors the approval gate: HumanLayer / ChannelHuman are the
// transport-facing half (like Approver / ChannelApprover); the
// AsyncLocalStorage channel below is the tool-facing half (like plan/progress).
//
// Wire shapes (HitlRequest / HitlResponse) are kept identical to the web
// client's `apps/jarvis-web/src/types/frames.ts` so the existing HITL UI works
// without change.
import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "./json.ts";

export type HitlKind = "confirm" | "input" | "choice" | "review";

export interface HitlOption {
  value: string;
  label: string;
}

/** A question surfaced to the operator. Wire-compatible with the web `HitlRequest`. */
export interface HitlRequest {
  id: string;
  transport: "text" | "voice" | "video";
  kind: HitlKind;
  title: string;
  body?: string;
  options?: HitlOption[];
  default_value?: JsonValue;
  response_schema?: JsonValue;
  metadata?: JsonValue;
}

export type HitlStatus = "approved" | "denied" | "submitted" | "cancelled" | "expired";

/** The operator's answer. Wire-compatible with the web `HitlResponse`. */
export interface HitlResponse {
  request_id: string;
  status: HitlStatus;
  payload?: JsonValue;
  reason?: string | null;
}

/** Synthetic answer returned when no transport is installed. */
export function expiredResponse(id: string, reason = "no HITL transport available"): HitlResponse {
  return { request_id: id, status: "expired", reason };
}

/** Transport-facing responder. Mirrors `Approver`. */
export interface HumanLayer {
  request(req: HitlRequest): Promise<HitlResponse>;
}

/**
 * One pending question handed to a transport. The transport calls `respond`
 * exactly once; the matching `request()` promise resolves. Mirrors
 * `PendingApproval`.
 */
export interface PendingHitl {
  request: HitlRequest;
  respond(response: HitlResponse): void;
}

/**
 * HumanLayer that fans each request out to a consumer callback and awaits the
 * reply — the WebSocket / CLI building block. Mirrors `ChannelApprover`. If the
 * callback throws, `request` rejects and the loop surfaces an expired response.
 */
export class ChannelHuman implements HumanLayer {
  #send: (pending: PendingHitl) => void;

  constructor(send: (pending: PendingHitl) => void) {
    this.#send = send;
  }

  request(request: HitlRequest): Promise<HitlResponse> {
    return new Promise<HitlResponse>((resolve, reject) => {
      let settled = false;
      const respond = (response: HitlResponse): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      try {
        this.#send({ request, respond });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

// ---- tool-facing task-local channel ----

const store = new AsyncLocalStorage<(req: HitlRequest) => Promise<HitlResponse>>();

/** Surface `req` to the operator and await their answer. No sink → `expired`. */
export function requestHuman(req: HitlRequest): Promise<HitlResponse> {
  const sink = store.getStore();
  if (!sink) return Promise.resolve(expiredResponse(req.id));
  return sink(req);
}

/** Whether a HITL sink is installed for the current async context. */
export function hitlActive(): boolean {
  return store.getStore() !== undefined;
}

/** Run `fn` with `sink` installed as the active HITL sink. */
export function withHitl<T>(
  sink: (req: HitlRequest) => Promise<HitlResponse>,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(sink, fn);
}
