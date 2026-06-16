// High-level dispatcher trait — the seam between the `channel.send` agent tool
// and the server's per-kind adapter registry.
//
// Ported from crates/harness-channel/src/dispatcher.rs. The implementation
// (instance lookup, adapter resolution, `${env:…}` template resolution, the
// actual HTTP send) lives in the server in a later phase; this is the
// interface the tool depends on.
import type { OutboundMessage, SendOutcome } from "./message.ts";

/**
 * High-level dispatcher used by the `channel.send` agent tool. Hides:
 * - looking up a `ChannelInstance` by its UUID,
 * - finding the kind-specific adapter,
 * - resolving `${env:…}` templates in the config,
 * - calling the adapter's `send` and surfacing the outcome.
 */
export interface ChannelDispatcher {
  /**
   * Send `msg` via the channel instance with id `instanceId`. Resolves to a
   * `failed` {@link SendOutcome} if the instance doesn't exist, is disabled, or
   * has unconfigured / broken config — the tool surfaces all of these as a
   * single "failed: <reason>" line. Mirrors `send_by_id`.
   */
  sendById(instanceId: string, msg: OutboundMessage): Promise<SendOutcome>;
}
