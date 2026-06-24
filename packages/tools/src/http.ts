// http.fetch — fetch an HTTP(S) URL, return status + headers + (truncated) body
// as a single string. Ported from crates/harness-tools/src/http.rs.
//
// GET and POST only (per the arg schema). Response bodies larger than
// `maxBytes` are truncated *on the byte boundary* (the Rust slices the raw
// response bytes, then decodes lossily) with a trailing marker.
//
// SSRF guard (secure by default): the tool is always-on and ungated, so a
// prompt-injected model can drive it freely. Before every connection we parse
// the target, require an http(s) scheme, and — unless `blockPrivateHosts` is
// turned off — reject hosts that resolve to loopback / link-local (cloud
// metadata) / RFC-1918 ranges. Redirects are followed *manually* so the guard
// re-validates every hop's `Location` (a public host can otherwise 30x straight
// to `169.254.169.254`). The host classifier normalizes the many literal forms
// that collapse to an internal address: dotted-quad and numeric (decimal /
// octal / hex) IPv4, IPv4-mapped/compatible IPv6, IPv6 loopback/ULA/link-local,
// and trailing-dot `localhost.`. DNS-rebinding (a public name that *resolves*
// to a private IP) is out of scope — we classify the literal host, not the
// resolved address.
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";

/** Default body cap: 256 KiB, matching the Rust `http_max_bytes` default. */
export const HTTP_DEFAULT_MAX_BYTES = 262144;

/** Max redirect hops we follow before giving up (undici's default is 20). */
const MAX_REDIRECTS = 10;

/** A minimal subset of the WHATWG `fetch` signature this tool relies on. */
export type FetchImpl = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** We always pass `"manual"` so the SSRF guard re-checks each hop. */
    redirect?: "follow" | "manual" | "error";
  },
) => Promise<FetchResponse>;

/** The subset of `Response` we consume. */
export interface FetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: {
    forEach(cb: (value: string, key: string) => void): void;
    /** Present on the global `fetch` Headers; used to read `Location` directly. */
    get?(name: string): string | null;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpFetchConfig {
  /** Body truncation cap in bytes. Defaults to {@link HTTP_DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Inject a `fetch` implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /**
   * Reject connections to private / internal hosts (loopback, link-local,
   * RFC-1918, …) on the initial URL **and every redirect hop**. Defaults to
   * `true` (secure by default). The composition root flips this off when
   * `JARVIS_HTTP_ALLOW_PRIVATE` is set.
   */
  blockPrivateHosts?: boolean;
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

    const rawMethod = obj["method"];
    const method = (typeof rawMethod === "string" ? rawMethod : "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw new Error(`invalid method: ${method}`);
    }

    let headers: Record<string, string> | undefined;
    const rawHeaders = obj["headers"];
    if (isObject(rawHeaders)) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v !== "string") {
          throw new Error(`header \`${k}\` must be a string`);
        }
        map[k] = v;
      }
      headers = map;
    }

    let body: string | undefined;
    if (method === "POST") {
      const rawBody = obj["body"];
      if (typeof rawBody === "string") {
        body = rawBody;
      }
    }

    // Validate the initial target, then follow redirects manually so the guard
    // re-checks every hop (`fetch`'s default `redirect: "follow"` would silently
    // chase a 30x into an internal host, bypassing the guard entirely).
    this.#guard(url);

    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let resp: FetchResponse | undefined;

    for (let hop = 0; ; hop++) {
      const init: Parameters<FetchImpl>[1] = { method: currentMethod, redirect: "manual" };
      if (headers !== undefined) init.headers = headers;
      if (currentBody !== undefined) init.body = currentBody;

      resp = await this.#fetch(currentUrl, init);

      if (!isRedirectStatus(resp.status)) break;
      const location = readHeader(resp.headers, "location");
      if (location === null || location === "") break; // 30x without a target — return as-is.

      if (hop >= MAX_REDIRECTS) {
        throw new Error(`http.fetch: too many redirects (>${MAX_REDIRECTS})`);
      }

      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        throw new Error(`http.fetch: invalid redirect Location: ${location}`);
      }
      this.#guard(next);

      const downgraded = redirectMethodAndBody(resp.status, currentMethod, currentBody);
      currentMethod = downgraded.method;
      currentBody = downgraded.body;
      currentUrl = next;
    }

    let headerBlock = "";
    resp.headers.forEach((value, key) => {
      headerBlock += `${key}: ${value}\n`;
    });

    const buf = new Uint8Array(await resp.arrayBuffer());
    const truncated = buf.length > this.#maxBytes;
    const slice = truncated ? buf.subarray(0, this.#maxBytes) : buf;
    // Lossy UTF-8 decode (replacement chars for invalid sequences), matching
    // Rust's `String::from_utf8_lossy`.
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);

    let out = `HTTP ${statusLine(resp.status, resp.statusText)}\n${headerBlock}\n${decoded}`;
    if (truncated) {
      out += `\n\n[... truncated at ${this.#maxBytes} bytes ...]`;
    }
    return out;
  }

  /** Parse + scheme-check a URL, and (when enabled) reject private hosts. */
  #guard(raw: string): void {
    const parsed = parseHttpUrl(raw);
    if (this.#blockPrivateHosts && isBlockedHost(parsed.hostname)) {
      throw new Error(
        `http.fetch: refusing to connect to private/internal host ` +
          `'${parsed.hostname}' (set JARVIS_HTTP_ALLOW_PRIVATE=1 to override)`,
      );
    }
  }
}

/** Parse `raw`, requiring an absolute http(s) URL. */
function parseHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`http.fetch: invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`http.fetch: unsupported URL scheme '${u.protocol}' (only http/https)`);
  }
  return u;
}

/** Statuses that carry a `Location` we follow. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Mirror `fetch`'s method/body handling across a redirect: 303 (and POST on
 * 301/302) downgrades to a bodyless GET; 307/308 preserve the method and body.
 */
function redirectMethodAndBody(
  status: number,
  method: string,
  body: string | undefined,
): { method: string; body: string | undefined } {
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    return { method: "GET", body: undefined };
  }
  return { method, body };
}

/** Read a single header case-insensitively, preferring the native `.get()`. */
function readHeader(headers: FetchResponse["headers"], name: string): string | null {
  if (typeof headers.get === "function") return headers.get(name);
  const wanted = name.toLowerCase();
  let found: string | null = null;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === wanted) found = value;
  });
  return found;
}

/**
 * True when `hostname` (a `URL.hostname`) designates a loopback / link-local /
 * private / unspecified target. Handles IPv6 brackets, FQDN trailing dots, the
 * `localhost` family, numeric IPv4 encodings, and IPv4-mapped IPv6.
 */
export function isBlockedHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  const bracketed = host.startsWith("[") && host.endsWith("]");
  if (bracketed) {
    host = host.slice(1, -1);
  } else {
    host = host.replace(/\.$/, ""); // strip a single FQDN trailing dot
  }
  if (host === "") return false;

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (host.includes(":")) {
    const bytes = expandIpv6(host);
    return bytes !== null && isBlockedIpv6(bytes);
  }

  const v4 = parseIpv4(host);
  return v4 !== null && isBlockedIpv4(v4);
}

/**
 * Parse `host` as an IPv4 literal in any `inet_aton`-style encoding the OS
 * resolver accepts: dotted-quad, plus 1–4 parts each in decimal / octal
 * (leading `0`) / hex (`0x`). Returns the four octets or `null` when `host`
 * isn't an IPv4 literal (e.g. a real hostname).
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    const n = parseUintRadix(p);
    if (n === null) return null;
    nums.push(n);
  }

  // inet_aton: the last part fills the remaining low bytes; earlier parts are
  // one octet each. Validate widths, then assemble the 32-bit value.
  const lastMax = [0xffffffff, 0xffffff, 0xffff, 0xff][nums.length - 1];
  if (nums[nums.length - 1] > lastMax) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 0xff) return null;
  }

  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    value += nums[i] * 2 ** (24 - 8 * i);
  }
  value += nums[nums.length - 1];
  value = value >>> 0;

  return [
    Math.floor(value / 2 ** 24) & 0xff,
    Math.floor(value / 2 ** 16) & 0xff,
    Math.floor(value / 2 ** 8) & 0xff,
    value & 0xff,
  ];
}

/** Parse one unsigned integer in decimal / octal (`0…`) / hex (`0x…`). */
function parseUintRadix(p: string): number | null {
  if (p === "") return null;
  if (/^0x[0-9a-f]+$/.test(p)) return Number.parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return Number.parseInt(p.slice(1), 8);
  if (/^0$/.test(p)) return 0;
  if (/^[1-9][0-9]*$/.test(p)) return Number.parseInt(p, 10);
  return null;
}

function isBlockedIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC-1918
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

/** Expand an IPv6 literal (with `::` compression / embedded IPv4) to 16 bytes. */
function expandIpv6(input: string): Uint8Array | null {
  let s = input;
  const pct = s.indexOf("%"); // strip a zone id (fe80::1%eth0)
  if (pct >= 0) s = s.slice(0, pct);

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        // Embedded IPv4 — only valid as the final token (standard textual form).
        if (i !== tokens.length - 1) return null;
        const v4 = parseDottedQuad(tok);
        if (v4 === null) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        groups.push(Number.parseInt(tok, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    const all = parseGroups(s);
    if (all === null || all.length !== 8) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** Strict dotted-quad parse (decimal octets only) for IPv6-embedded IPv4. */
function parseDottedQuad(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  const allZeroThrough = (end: number): boolean => {
    for (let i = 0; i < end; i++) if (bytes[i] !== 0) return false;
    return true;
  };

  // ::1 loopback / :: unspecified
  if (allZeroThrough(15) && (bytes[15] === 0 || bytes[15] === 1)) return true;
  // fc00::/7 unique-local
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (allZeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  // IPv4-compatible ::a.b.c.d (deprecated) and 64:ff9b::/96 NAT64
  if (allZeroThrough(12) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0)) {
    return isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }
  return false;
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
