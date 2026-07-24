// Generic dyndns2 protocol — the de-facto standard implemented by No-IP, Dynu,
// DtDNS, Namecheap-compat endpoints, and most consumer routers. A single
// HTTP-Basic GET to `https://<server>/nic/update?hostname=…&myip=…`; the body
// is a status code per the dyndns2 spec (`good` / `nochg` / error keywords).
import { httpText } from "../http.ts";
import { requireCreds, type DdnsProvider, type DdnsUpdateInput, type DdnsUpdateResult } from "../provider.ts";

// dyndns2 has no universal default host; No-IP's is the most common. Override
// via the `server` credential (e.g. `api.dynu.com`, `members.dyndns.org`).
const DEFAULT_SERVER = "dynupdate.no-ip.com";

const ERROR_HINTS: Record<string, string> = {
  badauth: "authentication failed (username/password)",
  nohost: "the hostname does not exist for this account",
  notfqdn: "the hostname is not a fully-qualified domain name",
  badagent: "the update client / user-agent was blocked",
  abuse: "the hostname is blocked for abuse",
  "!donator": "this feature requires a paid account",
  nofqdn: "the hostname is not a fully-qualified domain name",
};

export class DynDns2Provider implements DdnsProvider {
  readonly kind = "dyndns2" as const;

  async update(input: DdnsUpdateInput): Promise<DdnsUpdateResult> {
    const creds = requireCreds(input.credentials, ["username", "password"]);
    const server = (creds["server"] ?? DEFAULT_SERVER).replace(/^https?:\/\//, "").replace(/\/$/, "");
    const auth = Buffer.from(`${creds["username"]}:${creds["password"]}`).toString("base64");
    const url = `https://${server}/nic/update?hostname=${encodeURIComponent(input.hostname)}&myip=${encodeURIComponent(input.ip)}`;
    const res = await httpText(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        // The dyndns2 spec requires a descriptive User-Agent or servers 403.
        "User-Agent": "jarvis-ddns/0.1 jarvis@localhost",
      },
    });
    const body = res.text.trim();
    const code = body.split(/\s+/)[0] ?? "";
    if (code === "good") return { ok: true, message: `dyndns2: ${input.hostname} → ${input.ip}` };
    if (code === "nochg") {
      return { ok: true, unchanged: true, message: `dyndns2: ${input.hostname} already → ${input.ip}` };
    }
    const hint = ERROR_HINTS[code];
    return {
      ok: false,
      message: `dyndns2 error "${body || res.status}"${hint ? ` — ${hint}` : ""}`,
    };
  }
}
