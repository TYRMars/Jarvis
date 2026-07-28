// DuckDNS — the simplest backend. One GET to the update endpoint with the
// account token; the subdomain is derived from `<sub>.duckdns.org`. Responds
// with the literal text "OK" / "KO".
import { httpText } from "../http.ts";
import { requireCreds, type DdnsProvider, type DdnsUpdateInput, type DdnsUpdateResult } from "../provider.ts";

export class DuckDnsProvider implements DdnsProvider {
  readonly kind = "duckdns" as const;

  async update(input: DdnsUpdateInput): Promise<DdnsUpdateResult> {
    const creds = requireCreds(input.credentials, ["token"]);
    const token = creds["token"]!;
    // Accept an explicit `domains` (comma-separated subdomains) or derive from
    // the hostname (`foo.duckdns.org` → `foo`).
    const domains = creds["domains"] ?? input.hostname.replace(/\.duckdns\.org\.?$/i, "");
    const ipParam = input.recordType === "AAAA" ? "ipv6" : "ip";
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domains)}&token=${encodeURIComponent(token)}&${ipParam}=${encodeURIComponent(input.ip)}`;
    const res = await httpText(url, { headers: { "User-Agent": "jarvis-ddns/0.1" } });
    const body = res.text.trim();
    if (body.startsWith("OK")) {
      return { ok: true, message: `duckdns: ${domains} → ${input.ip}` };
    }
    return { ok: false, message: `duckdns rejected the update (response: "${body || res.status}") — check the token/subdomain` };
  }
}
