// Cloudflare DNS via the v4 API + an API token. Resolves the zone (explicit
// `zone_id`/`zone`, else a naive apex guess), finds the existing A/AAAA record
// for `hostname`, and PATCHes it (or POSTs a new one). Token scope needed:
// Zone:DNS:Edit on the target zone.
import { httpText, parseJson } from "../http.ts";
import { requireCreds, splitHost, type DdnsProvider, type DdnsUpdateInput, type DdnsUpdateResult } from "../provider.ts";

const API = "https://api.cloudflare.com/client/v4";

interface CfList<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}
interface CfZone {
  id: string;
  name: string;
}
interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function cfError(errors: { message: string }[] | undefined, fallback: string): string {
  return errors && errors.length > 0 ? errors.map((e) => e.message).join("; ") : fallback;
}

export class CloudflareProvider implements DdnsProvider {
  readonly kind = "cloudflare" as const;

  async update(input: DdnsUpdateInput): Promise<DdnsUpdateResult> {
    const creds = requireCreds(input.credentials, ["api_token"]);
    const token = creds["api_token"]!;
    const headers = authHeaders(token);

    const zoneId = await this.#resolveZoneId(creds, input.hostname, headers);

    // Find an existing record of this type+name.
    const listUrl = `${API}/zones/${zoneId}/dns_records?type=${input.recordType}&name=${encodeURIComponent(input.hostname)}`;
    const listRes = await httpText(listUrl, { headers });
    const list = parseJson<CfList<CfRecord[]>>(listRes.text);
    if (!list.success) throw new Error(`cloudflare list records: ${cfError(list.errors, listRes.text)}`);

    const body = JSON.stringify({
      type: input.recordType,
      name: input.hostname,
      content: input.ip,
      ttl: 60,
      proxied: false,
    });
    const existing = list.result[0];
    if (existing) {
      if (existing.content === input.ip) {
        return { ok: true, unchanged: true, message: `cloudflare: ${input.hostname} already → ${input.ip}` };
      }
      const upd = await httpText(`${API}/zones/${zoneId}/dns_records/${existing.id}`, {
        method: "PUT",
        headers,
        body,
      });
      const parsed = parseJson<CfList<CfRecord>>(upd.text);
      if (!parsed.success) throw new Error(`cloudflare update: ${cfError(parsed.errors, upd.text)}`);
      return { ok: true, message: `cloudflare: updated ${input.hostname} → ${input.ip}` };
    }

    const created = await httpText(`${API}/zones/${zoneId}/dns_records`, { method: "POST", headers, body });
    const parsed = parseJson<CfList<CfRecord>>(created.text);
    if (!parsed.success) throw new Error(`cloudflare create: ${cfError(parsed.errors, created.text)}`);
    return { ok: true, message: `cloudflare: created ${input.hostname} → ${input.ip}` };
  }

  async #resolveZoneId(
    creds: Record<string, string>,
    hostname: string,
    headers: Record<string, string>,
  ): Promise<string> {
    if (creds["zone_id"]) return creds["zone_id"];
    const zoneName = creds["zone"] ?? splitHost(hostname, creds["domain"]).apex;
    const res = await httpText(`${API}/zones?name=${encodeURIComponent(zoneName)}`, { headers });
    const parsed = parseJson<CfList<CfZone[]>>(res.text);
    if (!parsed.success) throw new Error(`cloudflare zones: ${cfError(parsed.errors, res.text)}`);
    const zone = parsed.result[0];
    if (!zone) throw new Error(`cloudflare: no zone matched "${zoneName}" — pass an explicit zone_id`);
    return zone.id;
  }
}
