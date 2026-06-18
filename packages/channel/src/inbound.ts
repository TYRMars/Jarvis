// Inbound primitives (M3 — first inbound kind: WeCom 自建应用).
//
// Ported from crates/harness-channel/src/inbound.rs. The normalised inbound
// message shape, keyed by Jarvis's `ChannelInstance.id` so the dispatcher can
// look up bindings + send replies via the same row. Per-kind signature
// verification + decoding live in the server (a later phase); this is the
// shared value vocabulary only.
import type { JsonValue } from "@jarvis/core";

/**
 * Coarse-grained inbound message kind, normalised across platforms. Adapters
 * that receive richer wire shapes (forms, location, cards…) fold them into an
 * `event` carrying the platform's event-type name, lowercased.
 *
 * Serde shape: `#[serde(tag = "kind", content = "name", rename_all =
 * "snake_case")]`. Fieldless variants are `{ kind }`; the data-carrying
 * `Event(String)` variant is `{ kind: "event", name: "<event-type>" }`.
 */
export type ChannelInboundKind =
  | { kind: "text" }
  | { kind: "image" }
  | { kind: "voice" }
  | { kind: "event"; name: string };

/** One-line tag suitable for log lines + activity rows (mirrors `ChannelInboundKind::tag`). */
export function channelInboundKindTag(k: ChannelInboundKind): string {
  return k.kind === "event" ? `event:${k.name}` : k.kind;
}

/**
 * Inbound message arriving from a configured channel. Keyed by Jarvis's
 * `ChannelInstance.id` so the dispatcher can look up bindings + send replies
 * via the same row.
 *
 * `thread_id` is reserved for platforms that have threads (Slack, Feishu
 * topics, Discord); WeCom 自建应用 doesn't, so it stays absent in M3.
 * `external_user_id` / `display_name` / `thread_id` are
 * `skip_serializing_if = "Option::is_none"` → optional + absent when unset.
 * `raw` is `skip_serializing_if = "Value::is_null"` → absent when null.
 */
export interface ChannelInboundEvent {
  /** Adapter discriminator, matches the adapter's `kind()`. */
  channel: string;
  /** `ChannelInstance.id` this event arrived on; the dispatcher routes replies back through it. */
  instance_id: string;
  /** Platform-side chat / group / DM identifier. Forms the `(channel, channel_chat_id)` binding key. */
  external_chat_id: string;
  /** Platform-side sender id, when known. Absent for events (subscribe / unsubscribe) that don't carry one. */
  external_user_id?: string;
  /** Best-effort display name captured at receipt. May be stale. Absent when unknown. */
  display_name?: string;
  /** Thread / topic id, when the platform has them. Absent otherwise (reserved early). */
  thread_id?: string;
  text: string;
  kind: ChannelInboundKind;
  /**
   * Platform-decoded payload. JSON for most kinds; XML-flavoured kinds (WeCom
   * AES callback) decode to an object first. Absent on the wire when null.
   */
  raw?: JsonValue;
  /**
   * RFC-3339 timestamp set when the inbound handler accepted the payload.
   * Adapters may shadow it with a platform-supplied timestamp.
   */
  received_at: string;
}

/**
 * HTTP request envelope passed to inbound handlers. Decouples the handler from
 * the transport's extractor types so the request shape stays platform-agnostic.
 * Rust's `Vec<u8>` body becomes a {@link Uint8Array} here; `Default` (empty
 * maps + empty body) is the {@link newInboundRequest} helper.
 */
export interface InboundRequest {
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Build an empty {@link InboundRequest} (mirrors Rust's `#[derive(Default)]`). */
export function newInboundRequest(): InboundRequest {
  return { query: {}, headers: {}, body: new Uint8Array() };
}

/**
 * What to write back to the platform after an inbound handler runs. Platforms
 * have wildly different ack conventions — WeCom expects HTTP 200 with empty
 * body, WeChat MP wants a synchronous XML reply, the verification GET wants the
 * verbatim echostr — so this is an opaque payload classifier the route handler
 * maps to its HTTP response.
 *
 * Rust models it as a plain (non-serde) enum; here it's a discriminated union
 * keyed by `type`. `Plain(Vec<u8>)` → `bytes: Uint8Array`; `Xml(String)` →
 * `body: string`.
 */
export type AckPayload =
  | { type: "empty" }
  | { type: "plain"; bytes: Uint8Array }
  | { type: "xml"; body: string };

/** Empty body, 200 OK — fire-and-forget ack (mirrors `AckPayload::Empty`). */
export function ackEmpty(): AckPayload {
  return { type: "empty" };
}

/** Plain bytes, `text/plain` (e.g. WeCom GET verification echostr). Mirrors `AckPayload::Plain`. */
export function ackPlain(bytes: Uint8Array): AckPayload {
  return { type: "plain", bytes };
}

/** XML body, `application/xml` — passive-reply platforms. Mirrors `AckPayload::Xml`. */
export function ackXml(body: string): AckPayload {
  return { type: "xml", body };
}

/**
 * Result of a successful inbound POST: the normalised event + the
 * platform-specific ack payload. Mirrors `DecodedInbound`.
 */
export interface DecodedInbound {
  event: ChannelInboundEvent;
  ack: AckPayload;
}
