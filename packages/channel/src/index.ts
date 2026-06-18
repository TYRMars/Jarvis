// @jarvis/channel — channel value types + dispatcher / store traits + backends.
//
// Ported from crates/harness-channel + the channel-store impls in
// crates/harness-store. The shared messaging-channel vocabulary: outbound /
// inbound value types, the config-row (`ChannelInstance`) + binding-row
// (`ChannelBinding`) shapes, the `ChannelDispatcher` seam, the two persistence
// traits, and JsonFile + Memory backends for both stores. Per-kind adapters,
// inbound signature verification, and OAuth live in the server (a later phase).

// ---------- outbound message value types ----------
export {
  type ChannelMessageFormat,
  type OutboundMessage,
  type SendOutcome,
  channelMessageFormatFromWire,
  outboundText,
  sendOutcomeSent,
  sendOutcomeFail,
  sendOutcomeFailRetryable,
  isSent,
} from "./message.ts";

// ---------- channel-instance config row ----------
export {
  type ChannelInstance,
  type ChannelInstanceStatus,
  type EnvLookup,
  channelInstanceStatusFromWire,
  newChannelInstance,
  touchChannelInstance,
  resolveEnvTemplates,
} from "./instance.ts";

// ---------- channel-binding row ----------
export {
  type ChannelBinding,
  newChannelBinding,
  touchChannelBinding,
} from "./binding.ts";

// ---------- inbound value types ----------
export {
  type AckPayload,
  type ChannelInboundEvent,
  type ChannelInboundKind,
  type DecodedInbound,
  type InboundRequest,
  channelInboundKindTag,
  newInboundRequest,
  ackEmpty,
  ackPlain,
  ackXml,
} from "./inbound.ts";

// ---------- dispatcher + store traits ----------
export { type ChannelDispatcher } from "./dispatcher.ts";
export {
  type ChannelBindingStore,
  type ChannelInstanceStore,
} from "./store.ts";

// ---------- store backends ----------
export {
  JsonFileChannelBindingStore,
  MemoryChannelBindingStore,
} from "./binding-store.ts";
export {
  JsonFileChannelInstanceStore,
  MemoryChannelInstanceStore,
} from "./instance-store.ts";
