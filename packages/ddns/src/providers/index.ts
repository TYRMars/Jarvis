// Provider registry — map a DdnsProviderKind to its implementation.
import type { DdnsProvider, DdnsProviderKind } from "../provider.ts";
import { CloudflareProvider } from "./cloudflare.ts";
import { DuckDnsProvider } from "./duckdns.ts";
import { DynDns2Provider } from "./dyndns2.ts";
import { AliyunProvider } from "./aliyun.ts";
import { DnspodProvider } from "./dnspod.ts";

export { CloudflareProvider, DuckDnsProvider, DynDns2Provider, AliyunProvider, DnspodProvider };

/** All supported provider kinds (drives the iOS picker + validation). */
export const DDNS_PROVIDER_KINDS: readonly DdnsProviderKind[] = [
  "cloudflare",
  "duckdns",
  "dyndns2",
  "aliyun",
  "dnspod",
];

/** Construct the provider for `kind`. Throws on an unknown kind. */
export function makeProvider(kind: DdnsProviderKind): DdnsProvider {
  switch (kind) {
    case "cloudflare":
      return new CloudflareProvider();
    case "duckdns":
      return new DuckDnsProvider();
    case "dyndns2":
      return new DynDns2Provider();
    case "aliyun":
      return new AliyunProvider();
    case "dnspod":
      return new DnspodProvider();
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown DDNS provider: ${String(exhaustive)}`);
    }
  }
}
