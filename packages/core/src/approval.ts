// Approval gate. Ported from harness-core/src/approval.rs.
//
// The agent loop consults an Approver before invoking any tool whose
// `requiresApproval` is true. No approver configured → gated tools run
// unconditionally (historical default). A Deny short-circuits the call: the
// tool is NOT invoked and `tool denied: <reason>` is surfaced to the model.
import type { JsonValue } from "./json.ts";
import type { ToolCategory } from "./tool.ts";

export type ApprovalDecision =
  | { decision: "approve" }
  | { decision: "deny"; reason?: string };

export function approveDecision(): ApprovalDecision {
  return { decision: "approve" };
}

export function denyDecision(reason?: string): ApprovalDecision {
  return reason !== undefined ? { decision: "deny", reason } : { decision: "deny" };
}

/** What the agent shows the approver. Mirrors the `approval_request` wire shape. */
export interface ApprovalRequest {
  tool_call_id: string;
  tool_name: string;
  arguments: JsonValue;
  category: ToolCategory;
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class AlwaysApprove implements Approver {
  approve(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return Promise.resolve({ decision: "approve" });
  }
}

export class AlwaysDeny implements Approver {
  approve(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return Promise.resolve({ decision: "deny", reason: "default deny policy" });
  }
}

/**
 * One pending approval handed to a transport. The transport calls `respond`
 * exactly once with the decision; the matching `approve()` promise resolves.
 */
export interface PendingApproval {
  request: ApprovalRequest;
  respond(decision: ApprovalDecision): void;
}

/**
 * Approver that fans each request out to a consumer callback and waits for
 * the reply — the WebSocket / CLI building block. Mirrors Rust's
 * `ChannelApprover` (mpsc + oneshot). If the callback throws, `approve`
 * rejects; the agent loop converts that into a synthetic Deny.
 */
export class ChannelApprover implements Approver {
  #send: (pending: PendingApproval) => void;

  constructor(send: (pending: PendingApproval) => void) {
    this.#send = send;
  }

  approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;
      const respond = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        resolve(decision);
      };
      try {
        this.#send({ request, respond });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}
