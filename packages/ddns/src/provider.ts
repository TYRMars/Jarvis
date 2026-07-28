// The DDNS provider seam. Each backend implements `update()` — push the
// machine's current public IP into the provider's DNS record for `hostname`.
// Providers share nothing but this interface + the `httpText` helper; their
// wire shapes diverge too much to factor a common client (mirrors the
// `LlmProvider` philosophy in @jarvis/core).
import type { DdnsProviderKind } from "@jarvis/shared-types";

export type { DdnsProviderKind };

export interface DdnsUpdateInput {
  /** Fully-qualified record name (e.g. `home.example.com`). */
  hostname: string;
  /** The IP to set. */
  ip: string;
  recordType: "A" | "AAAA";
  /** Flat credential keys (see DdnsConfigInput doc for per-provider keys). */
  credentials: Record<string, string>;
}

export interface DdnsUpdateResult {
  ok: boolean;
  /** Human-readable detail (provider response summary). */
  message: string;
  /** Provider reported the record already matched — no change applied. */
  unchanged?: boolean;
}

export interface DdnsProvider {
  readonly kind: DdnsProviderKind;
  update(input: DdnsUpdateInput): Promise<DdnsUpdateResult>;
}

/** Missing-credential guard shared by the providers. */
export function requireCreds(
  creds: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const missing = keys.filter((k) => !creds[k]);
  if (missing.length > 0) {
    throw new Error(`missing credential(s): ${missing.join(", ")}`);
  }
  return creds;
}

/**
 * Best-effort split of a FQDN into the registered apex + the left-hand label(s).
 * Naive: assumes a two-label apex (`example.com`), so multi-label public
 * suffixes (`example.co.uk`) need an explicit `domain` credential override.
 * Returns `{ rr: "@", apex }` when the hostname IS the apex.
 */
export function splitHost(hostname: string, domainOverride?: string): { rr: string; apex: string } {
  const host = hostname.replace(/\.$/, "");
  if (domainOverride) {
    const apex = domainOverride.replace(/\.$/, "");
    if (host === apex) return { rr: "@", apex };
    if (host.endsWith("." + apex)) return { rr: host.slice(0, -(apex.length + 1)), apex };
    // Override didn't match — fall through to the naive split.
  }
  const labels = host.split(".");
  if (labels.length <= 2) return { rr: "@", apex: host };
  const apex = labels.slice(-2).join(".");
  const rr = labels.slice(0, -2).join(".");
  return { rr: rr || "@", apex };
}
