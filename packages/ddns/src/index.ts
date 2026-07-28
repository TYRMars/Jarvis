// @jarvis/ddns — dynamic-DNS + remote-access foundation.
//
// Public surface: the pluggable provider seam + impls, public/LAN IP discovery,
// best-effort UPnP port-mapping, and the DdnsRuntime that orchestrates them.
// Consumed by @jarvis/tools (the `ddns.*` tools) and @jarvis/server (the
// `/v1/ddns/*` + `/v1/remote/info` routes). Runtime-independent — reads no env.
export type {
  DdnsProvider,
  DdnsProviderKind,
  DdnsUpdateInput,
  DdnsUpdateResult,
} from "./provider.ts";
export { requireCreds, splitHost } from "./provider.ts";

export {
  DDNS_PROVIDER_KINDS,
  makeProvider,
  CloudflareProvider,
  DuckDnsProvider,
  DynDns2Provider,
  AliyunProvider,
  DnspodProvider,
} from "./providers/index.ts";

export { getLocalIpv4s, getPublicIp, isIpv4, primaryLanIpv4 } from "./ip.ts";
export { mapPort, unmapPort, discoverGateway, type PortMapResult, type MapPortOptions } from "./upnp.ts";
export { DdnsRuntime, type DdnsRuntimeOptions } from "./runtime.ts";
export { MdnsAdvertiser, type MdnsOptions } from "./mdns.ts";

// Re-export the wire shapes so consumers can import them from one place.
export type {
  DdnsConfigInput,
  DdnsConfigView,
  DdnsStatus,
  DdnsUpnpStatus,
  RemoteInfo,
} from "@jarvis/shared-types";
