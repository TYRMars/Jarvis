// Public + LAN IP discovery. No deps: LAN addrs from os.networkInterfaces;
// public IP raced across a few well-known echo endpoints (any one answering
// wins). Both are best-effort — callers degrade gracefully on `undefined`.
import { networkInterfaces } from "node:os";
import { httpText } from "./http.ts";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s.trim());
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** This machine's non-internal IPv4 addresses (LAN interfaces). */
export function getLocalIpv4s(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      // node ≥ 18 reports `family` as the string "IPv4".
      if (ni.family === "IPv4" && !ni.internal && ni.address) out.push(ni.address);
    }
  }
  return out;
}

/** The first LAN IPv4, preferring common private ranges (the UPnP internal client). */
export function primaryLanIpv4(): string | undefined {
  const all = getLocalIpv4s();
  const priv = all.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return priv ?? all[0];
}

const PUBLIC_IP_ENDPOINTS = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
  "https://ipinfo.io/ip",
];

/**
 * Detect the current public IPv4 by trying the echo endpoints in order.
 * Returns `undefined` if none answered with a valid IPv4 in time.
 */
export async function getPublicIp(timeoutMs = 8_000): Promise<string | undefined> {
  for (const url of PUBLIC_IP_ENDPOINTS) {
    try {
      const { ok, text } = await httpText(url, { headers: { "User-Agent": "jarvis-ddns/0.1" } }, timeoutMs);
      const ip = text.trim();
      if (ok && isIpv4(ip)) return ip;
    } catch {
      // Try the next endpoint.
    }
  }
  return undefined;
}
