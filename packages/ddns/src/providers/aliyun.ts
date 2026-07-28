// Alibaba Cloud DNS (AliDNS) via the RPC-style API with HMAC-SHA1 request
// signing (Signature Version 1.0). Needs an AccessKey pair scoped to AliDNS.
// Flow: DescribeSubDomainRecords → Update (changed) / Add (missing).
import { createHmac, randomUUID } from "node:crypto";
import { httpText, parseJson, rfc3986 } from "../http.ts";
import { requireCreds, splitHost, type DdnsProvider, type DdnsUpdateInput, type DdnsUpdateResult } from "../provider.ts";

const ENDPOINT = "https://alidns.aliyuncs.com/";
const VERSION = "2015-01-09";

interface AliRecord {
  RecordId: string;
  Value: string;
  RR: string;
  Type: string;
}
interface DescribeResp {
  Code?: string;
  Message?: string;
  TotalCount?: number;
  DomainRecords?: { Record?: AliRecord[] };
}
interface MutateResp {
  Code?: string;
  Message?: string;
  RecordId?: string;
}

/** Sign + GET an AliDNS RPC action. Throws on a non-2xx or an error `Code`. */
async function aliRequest<T extends { Code?: string; Message?: string }>(
  action: Record<string, string>,
  accessKeyId: string,
  accessKeySecret: string,
): Promise<T> {
  const params: Record<string, string> = {
    Format: "JSON",
    Version: VERSION,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...action,
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
    .join("&");
  const stringToSign = `GET&${rfc3986("/")}&${rfc3986(canonical)}`;
  const signature = createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  const url = `${ENDPOINT}?${canonical}&Signature=${rfc3986(signature)}`;
  const res = await httpText(url);
  const parsed = parseJson<T>(res.text);
  if (parsed.Code) throw new Error(`aliyun ${action["Action"]}: ${parsed.Code} ${parsed.Message ?? ""}`.trim());
  if (!res.ok) throw new Error(`aliyun ${action["Action"]}: HTTP ${res.status}`);
  return parsed;
}

export class AliyunProvider implements DdnsProvider {
  readonly kind = "aliyun" as const;

  async update(input: DdnsUpdateInput): Promise<DdnsUpdateResult> {
    const creds = requireCreds(input.credentials, ["access_key_id", "access_key_secret"]);
    const id = creds["access_key_id"]!;
    const secret = creds["access_key_secret"]!;
    const { rr, apex } = splitHost(input.hostname, creds["domain"]);

    const describe = await aliRequest<DescribeResp>(
      { Action: "DescribeSubDomainRecords", SubDomain: input.hostname, Type: input.recordType },
      id,
      secret,
    );
    const existing = describe.DomainRecords?.Record?.[0];

    if (existing) {
      if (existing.Value === input.ip) {
        return { ok: true, unchanged: true, message: `aliyun: ${input.hostname} already → ${input.ip}` };
      }
      await aliRequest<MutateResp>(
        { Action: "UpdateDomainRecord", RecordId: existing.RecordId, RR: rr, Type: input.recordType, Value: input.ip },
        id,
        secret,
      );
      return { ok: true, message: `aliyun: updated ${input.hostname} → ${input.ip}` };
    }

    await aliRequest<MutateResp>(
      { Action: "AddDomainRecord", DomainName: apex, RR: rr, Type: input.recordType, Value: input.ip },
      id,
      secret,
    );
    return { ok: true, message: `aliyun: created ${input.hostname} → ${input.ip}` };
  }
}
