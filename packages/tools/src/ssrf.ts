// SSRF protection for the always-on, ungated `http.fetch` tool.
//
// Ported from crates/harness-tools/src/ssrf.rs — keep the two in sync. Without
// a guard a prompt-injected model can reach cloud metadata endpoints
// (169.254.169.254), loopback admin surfaces (localhost:7001), and RFC-1918
// internal services, turning the agent into an SSRF pivot.
//
// The classification is intentionally conservative: anything that isn't a
// routable public address is blocked. These functions are pure (no I/O); DNS
// resolution lives in http.ts so it can be injected in tests.

import net from "node:net";

/** Policy controlling SSRF protection for `http.fetch`. */
export interface SsrfPolicyConfig {
  /**
   * When `true` (default) requests to loopback / link-local / private /
   * reserved addresses are rejected. Set `false` to restore the legacy
   * unrestricted behaviour (operator opt-out).
   */
  enabled?: boolean;
  /**
   * Hostnames exempt from the private-range check (exact match,
   * case-insensitive). A matching host is fetched even if it resolves to a
   * private address.
   */
  allowHosts?: string[];
}

/** Normalized policy with defaults applied. */
export class SsrfPolicy {
  readonly enabled: boolean;
  readonly #allow: string[];

  constructor(config: SsrfPolicyConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.#allow = (config.allowHosts ?? []).map((h) => h.trim().toLowerCase());
  }

  /**
   * Build a policy from an operator allowlist. A single `"*"` entry disables
   * blocking entirely; otherwise the listed hosts bypass the private-range
   * check while everything else stays guarded.
   */
  static fromAllowHosts(hosts: string[]): SsrfPolicy {
    if (hosts.some((h) => h.trim() === "*")) {
      return new SsrfPolicy({ enabled: false });
    }
    return new SsrfPolicy({ enabled: true, allowHosts: hosts });
  }

  isAllowlisted(host: string): boolean {
    const h = host.trim().toLowerCase();
    return this.#allow.includes(h);
  }
}

/**
 * Classify an IP address (string form). Returns a human-readable reason when
 * the address must be blocked for SSRF safety, or `null` when it is an
 * acceptable public target.
 */
export function classifyBlocked(ip: string): string | null {
  const kind = net.isIP(ip);
  if (kind === 4) return classifyV4(ip);
  if (kind === 6) return classifyV6(ip);
  return "not a valid IP address";
}

function classifyV4(ip: string): string | null {
  const o = ip.split(".").map((s) => Number(s));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return "not a valid IPv4 address";
  }
  const [a, b] = o;
  if (a === 0) return "reserved address (0.0.0.0/8)";
  if (a === 127) return "loopback address (127.0.0.0/8)";
  if (a === 10) return "private RFC-1918 address";
  if (a === 172 && b >= 16 && b <= 31) return "private RFC-1918 address";
  if (a === 192 && b === 168) return "private RFC-1918 address";
  if (a === 169 && b === 254) return "link-local address (169.254.0.0/16) — cloud metadata";
  if (a === 100 && b >= 64 && b <= 127) return "shared CGNAT address (100.64.0.0/10)";
  if (a >= 224 && a <= 239) return "multicast address";
  if (a >= 240) return "reserved address (240.0.0.0/4)";
  return null;
}

function classifyV6(ip: string): string | null {
  const h = expandV6(ip);
  if (!h) return "not a valid IPv6 address";

  // IPv4-mapped (::ffff:a.b.c.d): classify the embedded v4 target.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return classifyV4(hextetsToV4(h[6], h[7]));
  }
  // :: and ::1, plus deprecated IPv4-compatible ::a.b.c.d.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    if (h[6] === 0 && h[7] === 0) return "unspecified address (::)";
    if (h[6] === 0 && h[7] === 1) return "loopback address (::1)";
    // ::a.b.c.d compat — classify embedded v4.
    return classifyV4(hextetsToV4(h[6], h[7]));
  }
  if ((h[0] & 0xff00) === 0xff00) return "multicast address";
  if ((h[0] & 0xfe00) === 0xfc00) return "unique-local address (fc00::/7)";
  if ((h[0] & 0xffc0) === 0xfe80) return "link-local address (fe80::/10)";
  return null;
}

function hextetsToV4(h6: number, h7: number): string {
  return `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`;
}

/** Expand an IPv6 string (with `::` compression / embedded IPv4) to 8 hextets. */
function expandV6(input: string): number[] | null {
  let ip = input.split("%")[0]; // drop zone id

  // Embedded IPv4 in the final segment (e.g. ::ffff:1.2.3.4).
  const lastColon = ip.lastIndexOf(":");
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes(".")) {
    const tail = ip.slice(lastColon + 1);
    const o = tail.split(".").map((s) => Number(s));
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dbl = ip.split("::");
  if (dbl.length > 2) return null;

  const head = dbl[0] ? dbl[0].split(":") : [];
  if (dbl.length === 1) {
    if (head.length !== 8) return null;
    return parseHextets(head);
  }

  const tail = dbl[1] ? dbl[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return parseHextets([...head, ...Array<string>(missing).fill("0"), ...tail]);
}

function parseHextets(parts: string[]): number[] | null {
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}
