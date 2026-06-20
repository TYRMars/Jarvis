// Outbound message + format + send outcome.
//
// Ported from crates/harness-channel/src/message.rs. Used by the
// `channel.send` agent tool and every kind's adapter `send` method (the
// adapters themselves land in a later server phase). This module owns the
// normalised outbound shape ({@link OutboundMessage}) and the normalised
// result ({@link SendOutcome}) so retries are explicit.

// `ChannelMessageFormat` is the single-source-of-truth wire type from
// @jarvis/shared-types; re-exported here next to its runtime validator.
import type { ChannelMessageFormat } from "@jarvis/shared-types";

export type { ChannelMessageFormat };

const CHANNEL_MESSAGE_FORMATS: readonly ChannelMessageFormat[] = ["text", "markdown"];

/** Parse a wire string. `undefined` for unrecognised values. */
export function channelMessageFormatFromWire(s: string): ChannelMessageFormat | undefined {
  return (CHANNEL_MESSAGE_FORMATS as readonly string[]).includes(s)
    ? (s as ChannelMessageFormat)
    : undefined;
}

/**
 * One outbound message, normalised across kinds. Adapters consume this and
 * produce platform-specific wire payloads.
 */
export interface OutboundMessage {
  /**
   * Body text. Adapters cap at the platform's max length and surface
   * truncation via `SendOutcome` (`truncated: true`).
   */
  text: string;
  format: ChannelMessageFormat;
  /**
   * Platform-side user ids to @-mention. Empty array means "no mentions";
   * the semantics of `"@all"` are platform-defined.
   */
  mentions: string[];
}

/**
 * Build a plain-text outbound message with no mentions — the most common
 * case (mirrors Rust's `OutboundMessage::text`).
 */
export function outboundText(body: string): OutboundMessage {
  return { text: body, format: "text", mentions: [] };
}

/**
 * Outcome of an outbound send. Serde shape:
 * `#[serde(tag = "outcome", rename_all = "snake_case")]` → a discriminated
 * union keyed by `outcome`.
 *
 * The `retryable` distinction is the hard-won bit: read/write timeouts on a
 * non-idempotent send may already have delivered, so blindly retrying
 * duplicates messages.
 *
 * Default-valued booleans on the `sent` arm (`truncated` / `downgraded_format`)
 * and the optional `code` on the `failed` arm are `skip_serializing_if`'d in
 * Rust, so they are absent on the wire when at their default. The factory
 * helpers below omit them accordingly; readers should treat a missing
 * `truncated` / `downgraded_format` as `false`.
 */
export type SendOutcome =
  | {
      outcome: "sent";
      /**
       * Platform-side message id when available. Some platforms (group
       * robots) don't return one — absent is fine.
       */
      message_id?: string;
      /**
       * True when the body was truncated to fit a platform max-length cap.
       * Absent on the wire when false.
       */
      truncated?: boolean;
      /**
       * True when the adapter had to downgrade (e.g. markdown → text because
       * the sub-kind doesn't support markdown). Absent on the wire when false.
       */
      downgraded_format?: boolean;
    }
  | {
      outcome: "failed";
      /** Single-line human-readable error suitable for operators / agents. */
      message: string;
      /**
       * Adapter-namespaced error code, e.g. `"wecom_webhook:errcode_45009"`
       * (lowercase + colons). Absent on the wire when unset.
       */
      code?: string;
      /**
       * Whether the same payload can be retried without risking duplicate
       * delivery. Conservative: connect-timeout = retryable (no bytes sent);
       * read-timeout on the response = NOT retryable (may already have been
       * processed by the platform).
       */
      retryable: boolean;
    };

/** Convenience constructor for the trivial happy path (mirrors `SendOutcome::sent`). */
export function sendOutcomeSent(): SendOutcome {
  return { outcome: "sent" };
}

/**
 * Non-retryable failure (config errors, 4xx from platform, …) — mirrors
 * `SendOutcome::fail`. Most adapters surface these.
 */
export function sendOutcomeFail(message: string): SendOutcome {
  return { outcome: "failed", message, retryable: false };
}

/**
 * Transient failure the caller can retry without risking duplicate delivery
 * (mirrors `SendOutcome::fail_retryable`).
 */
export function sendOutcomeFailRetryable(message: string): SendOutcome {
  return { outcome: "failed", message, retryable: true };
}

/** True when `outcome` accepted the payload (mirrors `SendOutcome::is_sent`). */
export function isSent(outcome: SendOutcome): boolean {
  return outcome.outcome === "sent";
}
