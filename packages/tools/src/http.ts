// http.fetch — fetch an HTTP(S) URL, return status + headers + (truncated) body
// as a single string. Ported from crates/harness-tools/src/http.rs.
//
// GET and POST only (per the arg schema). Response bodies larger than
// `maxBytes` are truncated *on the byte boundary* (the Rust slices the raw
// response bytes, then decodes lossily) with a trailing marker.
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";

/** Default body cap: 256 KiB, matching the Rust `http_max_bytes` default. */
export const HTTP_DEFAULT_MAX_BYTES = 262144;

/** A minimal subset of the WHATWG `fetch` signature this tool relies on. */
export type FetchImpl = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponse>;

/** The subset of `Response` we consume. */
export interface FetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpFetchConfig {
  /** Body truncation cap in bytes. Defaults to {@link HTTP_DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Inject a `fetch` implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /**
   * Block requests to loopback / private / link-local / cloud-metadata hosts
   * (SSRF guard). Defaults to `true` — secure by default. The composition root
   * flips it off via `JARVIS_HTTP_ALLOW_PRIVATE` when an operator wants the
   * agent to reach `localhost` dev servers / internal hosts. Catches literal-IP
   * targets (incl. `169.254.169.254`, IPv4-mapped IPv6 `::ffff:127.0.0.1`, and
   * trailing-dot `localhost.`) + `localhost`. String/parse-based only: a
   * hostname that *resolves* to a private IP (DNS rebinding) and redirect hops
   * are documented residuals (the FetchImpl seam hides post-redirect URLs).
   */
  blockPrivateHosts?: boolean;
}

/**
 * Reject non-http(s) schemes and (when `blockPrivate`) loopback / private /
 * link-local / cloud-metadata destinations. Throws a user-facing Error so the
 * model sees why and can adapt. String/parse-based only — no DNS lookup, so it
 * stays deterministic + offline.
 */
export function validateFetchUrl(raw: string, blockPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported URL scheme \`${parsed.protocol}\` — only http/https allowed`);
  }
  if (!blockPrivate) return;

  // Strip IPv6 brackets, lower-case, and drop a single trailing FQDN dot
  // (`localhost.` resolves to `127.0.0.1` but wouldn't match `=== "localhost"`).
  const host = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    isPrivateIp(host)
  ) {
    throw new Error(
      `refusing to fetch private/loopback host \`${host}\` (SSRF guard; set JARVIS_HTTP_ALLOW_PRIVATE=1 to allow)`,
    );
  }
}

/**
 * Decode an IPv4-mapped IPv6 host to its dotted-decimal IPv4, or return null.
 * Node's `URL` normalizes `[::ffff:127.0.0.1]` to the hex-compressed form
 * `::ffff:7f00:1` (no dots), so a dotted-decimal regex alone never catches it —
 * we accept both the dotted and the two-hex-group forms here.
 */
function embeddedMappedIpv4(host: string): string | null {
  const rest = /^::ffff:(.+)$/.exec(host)?.[1];
  if (rest === undefined) return null;
  // Dotted-decimal embedded form (`::ffff:127.0.0.1`).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  // Two hex groups encoding the 32-bit IPv4 (Node's normalized form).
  const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (hx) {
    const hi = parseInt(hx[1] ?? "0", 16);
    const lo = parseInt(hx[2] ?? "0", 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Canonicalize the non-dotted-quad IPv4 notations the platform resolver still
 * honours to dotted-decimal, or return null when `host` isn't one of them:
 *   - bare 32-bit decimal  — `2130706433`        → `127.0.0.1`
 *   - octal octets         — `0177.0.0.1`        → `127.0.0.1`
 *   - hex octets / whole   — `0x7f.0.0.1` / `0x7f000001`
 *   - 1–3 part shorthand   — `127.1`             → `127.0.0.1`
 *
 * Mirrors the C `inet_aton` rules: 1–4 dot-separated parts, each part decimal /
 * octal (leading `0`) / hex (`0x`), the final part absorbing the remaining
 * low-order bytes.
 *
 * Node's WHATWG `URL` already folds these to dotted-quad before
 * `validateFetchUrl` sees the host, so within `http.fetch` this is
 * defense-in-depth — it keeps `isPrivateIp` sound as a standalone primitive for
 * any caller that hands it a raw, non-URL-normalized host string (#207).
 */
function numericIpv4ToDotted(host: string): string | null {
  const h = host.toLowerCase();
  // Fast reject: only digits / hex / `x` / dots can form a numeric IPv4.
  if (!/^[0-9a-fx.]+$/.test(h)) return null;
  const parts = h.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/.test(part)) {
      n = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      n = parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null; // empty / malformed part (`127..1`, `0x`, `0xfg`, `cafe`)
    }
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }

  // inet_aton: each leading part is exactly one byte; the final part fills the
  // remaining low-order bytes (so `a.b` is a, then b across the low 3 bytes).
  const last = nums[nums.length - 1] ?? 0;
  const leading = nums.slice(0, -1);
  if (leading.some((b) => b > 0xff)) return null;
  const remainingBytes = 4 - leading.length;
  const maxLast = Math.pow(256, remainingBytes) - 1;
  if (last > maxLast) return null;

  let value = 0;
  for (const b of leading) value = value * 256 + b;
  value = value * Math.pow(256, remainingBytes) + last;
  if (value > 0xffffffff) return null;

  return [
    Math.floor(value / 0x1000000) & 0xff,
    Math.floor(value / 0x10000) & 0xff,
    Math.floor(value / 0x100) & 0xff,
    value & 0xff,
  ].join(".");
}

/** True if `host` is a literal IP in a loopback/private/link-local/reserved
 * range (the SSRF-relevant set). Non-IP hostnames return false. Handles
 * IPv4-mapped IPv6 by decoding the embedded IPv4 and re-checking it, and
 * non-dotted-quad numeric IPv4 notation by canonicalizing it first. */
export function isPrivateIp(host: string): boolean {
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) → decode and re-check the embedded IPv4.
  const mapped = embeddedMappedIpv4(host);
  if (mapped) return isPrivateIp(mapped);

  // Non-dotted-quad numeric IPv4 (bare decimal / octal / hex / shorthand) →
  // canonicalize and re-check. The `!== host` guard avoids re-entering on an
  // already-dotted-quad host (which round-trips to itself). (#207)
  const numeric = numericIpv4ToDotted(host);
  if (numeric !== null && numeric !== host) return isPrivateIp(numeric);

  // Dotted-decimal IPv4.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = v4.slice(1, 5).map((n) => Number(n));
    if (o.some((n) => n > 255)) return false;
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6 literals (brackets stripped, lower-cased). Cover the broader reserved
  // set, not just `::1`: unspecified, unique-local (fc00::/7), and the full
  // link-local block (fe80::/10 → first hextet fe80–febf).
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  return false;
}

/**
 * Render a status line the way reqwest's `StatusCode` Display does, e.g.
 * `200 OK` / `404 Not Found`. When the runtime gives no reason phrase we fall
 * back to just the numeric code (reqwest emits `<unknown status code>` for
 * unregistered codes, but the common path is code + phrase).
 */
function statusLine(status: number, statusText: string): string {
  const phrase = statusText.trim();
  return phrase.length > 0 ? `${status} ${phrase}` : String(status);
}

export class HttpFetchTool implements Tool {
  readonly name = "http.fetch";
  readonly description =
    "Fetch an HTTP(S) URL. Returns status, response headers, and body. " +
    "Supports GET and POST. Body is truncated if very large.";
  readonly category: ToolCategory = "network";
  readonly cacheable = true;

  readonly #maxBytes: number;
  readonly #fetch: FetchImpl;
  readonly #blockPrivateHosts: boolean;

  constructor(config: HttpFetchConfig = {}) {
    this.#maxBytes = config.maxBytes ?? HTTP_DEFAULT_MAX_BYTES;
    this.#blockPrivateHosts = config.blockPrivateHosts ?? true;
    const impl = config.fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
    if (!impl) {
      throw new Error("http.fetch: no fetch implementation available (pass fetchImpl)");
    }
    this.#fetch = impl;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          description: "HTTP method. Defaults to GET.",
        },
        headers: {
          type: "object",
          description: "Optional request headers.",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "string",
          description: "Optional request body (POST only).",
        },
      },
      required: ["url"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = isObject(args) ? args : {};

    const url = obj["url"];
    if (typeof url !== "string") {
      throw new Error("missing `url` argument");
    }
    // SSRF guard + scheme allowlist before any network is touched.
    validateFetchUrl(url, this.#blockPrivateHosts);

    const rawMethod = obj["method"];
    const method = (typeof rawMethod === "string" ? rawMethod : "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw new Error(`invalid method: ${method}`);
    }

    const init: { method: string; headers?: Record<string, string>; body?: string } = {
      method,
    };

    const rawHeaders = obj["headers"];
    if (isObject(rawHeaders)) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v !== "string") {
          throw new Error(`header \`${k}\` must be a string`);
        }
        map[k] = v;
      }
      init.headers = map;
    }

    if (method === "POST") {
      const body = obj["body"];
      if (typeof body === "string") {
        init.body = body;
      }
    }

    const resp = await this.#fetch(url, init);

    let headers = "";
    resp.headers.forEach((value, key) => {
      headers += `${key}: ${value}\n`;
    });

    const buf = new Uint8Array(await resp.arrayBuffer());
    const truncated = buf.length > this.#maxBytes;
    const slice = truncated ? buf.subarray(0, this.#maxBytes) : buf;
    // Lossy UTF-8 decode (replacement chars for invalid sequences), matching
    // Rust's `String::from_utf8_lossy`.
    const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);

    let out = `HTTP ${statusLine(resp.status, resp.statusText)}\n${headers}\n${body}`;
    if (truncated) {
      out += `\n\n[... truncated at ${this.#maxBytes} bytes ...]`;
    }
    return out;
  }
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
