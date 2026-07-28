// DNSPod (dnspod.cn) via the legacy token API. `login_token = "<id>,<token>"`
// (create an API token in the DNSPod console). Flow: Record.List → Record.Ddns
// (the dynamic-DNS endpoint, which upserts the record's value).
import { httpText, parseJson } from "../http.ts";
import { requireCreds, splitHost, type DdnsProvider, type DdnsUpdateInput, type DdnsUpdateResult } from "../provider.ts";

const API = "https://dnsapi.cn";

interface DnspodStatus {
  code: string;
  message: string;
}
interface RecordListResp {
  status: DnspodStatus;
  records?: { id: string; name: string; value: string; type: string }[];
}
interface DdnsResp {
  status: DnspodStatus;
  record?: { id: string; value: string };
}

async function dnspodPost<T extends { status: DnspodStatus }>(
  path: string,
  fields: Record<string, string>,
): Promise<T> {
  const body = new URLSearchParams(fields).toString();
  const res = await httpText(`${API}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // DNSPod requires a descriptive UA with contact info.
      "User-Agent": "jarvis-ddns/0.1 (jarvis@localhost)",
    },
    body,
  });
  return parseJson<T>(res.text);
}

export class DnspodProvider implements DdnsProvider {
  readonly kind = "dnspod" as const;

  async update(input: DdnsUpdateInput): Promise<DdnsUpdateResult> {
    const creds = requireCreds(input.credentials, ["id", "token"]);
    const loginToken = `${creds["id"]},${creds["token"]}`;
    const { rr, apex } = splitHost(input.hostname, creds["domain"]);
    const subDomain = rr === "@" ? "@" : rr;

    const base = { login_token: loginToken, format: "json", domain: apex };

    const list = await dnspodPost<RecordListResp>("Record.List", {
      ...base,
      sub_domain: subDomain,
      record_type: input.recordType,
    });
    // code "1" = ok, "10" = no records matched.
    if (list.status.code !== "1" && list.status.code !== "10") {
      throw new Error(`dnspod Record.List: ${list.status.code} ${list.status.message}`);
    }
    const existing = list.records?.[0];
    if (existing && existing.value === input.ip) {
      return { ok: true, unchanged: true, message: `dnspod: ${input.hostname} already → ${input.ip}` };
    }

    if (existing) {
      const upd = await dnspodPost<DdnsResp>("Record.Ddns", {
        ...base,
        record_id: existing.id,
        sub_domain: subDomain,
        record_line: "默认",
        value: input.ip,
      });
      if (upd.status.code !== "1") throw new Error(`dnspod Record.Ddns: ${upd.status.code} ${upd.status.message}`);
      return { ok: true, message: `dnspod: updated ${input.hostname} → ${input.ip}` };
    }

    const created = await dnspodPost<DdnsResp>("Record.Create", {
      ...base,
      sub_domain: subDomain,
      record_type: input.recordType,
      record_line: "默认",
      value: input.ip,
    });
    if (created.status.code !== "1") throw new Error(`dnspod Record.Create: ${created.status.code} ${created.status.message}`);
    return { ok: true, message: `dnspod: created ${input.hostname} → ${input.ip}` };
  }
}
