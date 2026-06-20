// http.fetch — fetch an HTTP(S) URL, return status + headers + (truncated) body
// as a single string. Ported from crates/harness-tools/src/http.rs.
//
// GET and POST only (per the arg schema). Response bodies larger than
// `maxBytes` are truncated *on the byte boundary* (the Rust slices the raw
// response bytes, then decodes lossily) with a trailing marker.
import { lookup } from "node:dns/promises";
import net from "node:net";

import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";

import { classifyBlocked, SsrfPolicy, type SsrfPolicyConfig } from "./ssrf.ts";

/** Default body cap: 256 KiB, matching the Rust `http_max_bytes` default. */
export const HTTP_DEFAULT_MAX_BYTES = 262144;

/** A minimal subset of the WHATWG `fetch` signature this tool relies on. */
export type FetchImpl = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Redirect handling. `http.fetch` pins this to `"manual"` for SSRF safety. */
    redirect?: "follow" | "manual" | "error";
  },
) => Promise<FetchResponse>;

/**
 * DNS resolution hook: maps a hostname to its IP addresses (string form).
 * Pulled out so the SSRF guard can be exercised without real DNS. The default
 * resolves through the system resolver.
 */
export type ResolveHook = (host: string) => Promise<string[]>;

async function systemResolve(host: string): Promise<string[]> {
  const addrs = await lookup(host, { all: true });
  return addrs.map((a) => a.address);
}

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
   * SSRF policy. Defaults to blocking loopback / link-local / private /
   * reserved targets. Pass `{ enabled: false }` to restore the legacy
   * unrestricted behaviour, or `allowHosts` to exempt specific hosts.
   */
  ssrf?: SsrfPolicyConfig | SsrfPolicy;
  /** Inject a DNS resolver (tests). Defaults to the system resolver. */
  resolve?: ResolveHook;
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
  readonly #ssrf: SsrfPolicy;
  readonly #resolve: ResolveHook;

  constructor(config: HttpFetchConfig = {}) {
    this.#maxBytes = config.maxBytes ?? HTTP_DEFAULT_MAX_BYTES;
    const impl = config.fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
    if (!impl) {
      throw new Error("http.fetch: no fetch implementation available (pass fetchImpl)");
    }
    this.#fetch = impl;
    this.#ssrf =
      config.ssrf instanceof SsrfPolicy ? config.ssrf : new SsrfPolicy(config.ssrf);
    this.#resolve = config.resolve ?? systemResolve;
  }

  /**
   * Validate `url` against the SSRF policy: require an http(s) scheme and
   * reject hosts that are (or resolve to) loopback / link-local / private /
   * reserved addresses. Throws with a human-readable reason on rejection.
   */
  async guardUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new Error(`invalid url: ${(e as Error).message}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `blocked: scheme \`${parsed.protocol.replace(/:$/, "")}\` is not allowed (only http/https)`,
      );
    }

    if (!this.#ssrf.enabled) return;

    // URL hostnames for IPv6 literals are bracketed (`[::1]`); strip them.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!host) throw new Error("blocked: url has no host");

    if (this.#ssrf.isAllowlisted(host)) return;

    // A literal IP in the URL needs no DNS round-trip.
    if (net.isIP(host) !== 0) {
      const reason = classifyBlocked(host);
      if (reason) throw new Error(`blocked: ${host} is a ${reason}`);
      return;
    }

    let addrs: string[];
    try {
      addrs = await this.#resolve(host);
    } catch (e) {
      throw new Error(`blocked: cannot resolve ${host}: ${(e as Error).message}`);
    }
    if (addrs.length === 0) {
      throw new Error(`blocked: ${host} did not resolve to any address`);
    }
    // Reject if *any* resolved address is non-public (DNS-rebinding style).
    for (const ip of addrs) {
      const reason = classifyBlocked(ip);
      if (reason) {
        throw new Error(`blocked: ${host} resolves to ${ip}, a ${reason}`);
      }
    }
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

    // SSRF guard: reject non-http(s) schemes and private/loopback/link-local
    // targets before any network egress happens.
    await this.guardUrl(url);

    const init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      redirect: "manual";
    } = {
      method,
      // Don't auto-follow redirects: an allowlisted/public host could 302 onto
      // a metadata IP, bypassing the pre-flight check.
      redirect: "manual",
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

    // With `redirect: "manual"` the runtime surfaces redirects as an opaque
    // response (status 0) or a bare 3xx. We deliberately do not follow them —
    // a redirect to a metadata/internal IP would bypass the pre-flight guard.
    if (resp.status === 0 || (resp.status >= 300 && resp.status < 400)) {
      const location = readHeader(resp.headers, "location");
      const where = location ? ` (Location: ${location})` : "";
      return `HTTP ${resp.status || "3xx"} redirect not followed — blocked for SSRF safety${where}`;
    }

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

/** Read a header (case-insensitive) from the `forEach`-only header view. */
function readHeader(
  headers: { forEach(cb: (value: string, key: string) => void): void },
  name: string,
): string | undefined {
  let found: string | undefined;
  const want = name.toLowerCase();
  headers.forEach((value, key) => {
    if (key.toLowerCase() === want) found = value;
  });
  return found;
}
