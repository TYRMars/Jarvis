// http.fetch — fetch an HTTP(S) URL, return status + headers + (truncated) body
// as a single string. Ported from crates/harness-tools/src/http.rs.
//
// GET and POST only (per the arg schema). Response bodies larger than
// `maxBytes` are truncated *on the byte boundary* (the Rust slices the raw
// response bytes, then decodes lossily) with a trailing marker.
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { htmlToMarkdown, looksLikeHtml } from "./html-markdown.ts";

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
   * (SSRF guard, P8.6). Defaults to `true` — secure by default. The composition
   * root flips it off via `JARVIS_HTTP_ALLOW_PRIVATE` when an operator wants the
   * agent to reach `localhost` dev servers. Catches literal-IP targets (incl.
   * `169.254.169.254`) + `localhost`; DNS-rebinding / redirect-to-internal are
   * documented residuals (the FetchImpl seam hides post-redirect URLs).
   */
  blockPrivateHosts?: boolean;
}

/** Response headers never echoed back to the model — they can carry session /
 * auth secrets from the upstream (P8.6). Lower-cased for comparison. */
const SENSITIVE_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "www-authenticate",
  "proxy-authenticate",
  "authorization",
]);

/**
 * Reject non-http(s) schemes and (when `blockPrivate`) loopback / private /
 * link-local / cloud-metadata destinations. Throws a user-facing Error so the
 * model sees why and can adapt. String/parse-based only — no DNS lookup, so it
 * stays deterministic + offline (a hostname that *resolves* to a private IP is
 * a documented residual).
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

  // Strip IPv6 brackets; lower-case the host for comparison.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
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

/** True if `host` is a literal IP in a loopback/private/link-local/reserved
 * range (the SSRF-relevant set). Non-IP hostnames return false. */
function isPrivateIp(host: string): boolean {
  // IPv4 (incl. IPv4-mapped IPv6 `::ffff:a.b.c.d`).
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = v4.slice(1, 5).map((n) => Number(n));
    if (o.some((n) => n > 255)) return false;
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 ULA
  if (host.startsWith("fe80")) return true; // link-local
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
    "Supports GET and POST. Body is truncated if very large. " +
    "To read an article or documentation page, pass `format: \"markdown\"` — " +
    "HTML responses are converted to clean Markdown (JSON / plain-text bodies " +
    "pass through unchanged), which is far more token-efficient than raw HTML.";
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
        format: {
          type: "string",
          enum: ["raw", "markdown"],
          description:
            "Output format for the body. `raw` (default) returns it verbatim; " +
            "`markdown` converts an HTML response to Markdown (non-HTML bodies " +
            "are returned as-is).",
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
    // SSRF guard + scheme allowlist (P8.6) before any network is touched.
    validateFetchUrl(url, this.#blockPrivateHosts);

    const rawMethod = obj["method"];
    const method = (typeof rawMethod === "string" ? rawMethod : "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw new Error(`invalid method: ${method}`);
    }

    // `markdown` requests HTML→Markdown extraction; anything else is verbatim.
    const format = obj["format"] === "markdown" ? "markdown" : "raw";

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
    let contentType: string | undefined;
    resp.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-type") contentType = value;
      // Drop auth/session headers so an upstream's secrets aren't echoed to the
      // model (P8.6).
      if (SENSITIVE_RESPONSE_HEADERS.has(lower)) return;
      headers += `${key}: ${value}\n`;
    });

    const buf = new Uint8Array(await resp.arrayBuffer());
    // Cap the raw response on the byte boundary before decoding (matches Rust's
    // `String::from_utf8_lossy` over the slice).
    const sourceTruncated = buf.length > this.#maxBytes;
    const slice = sourceTruncated ? buf.subarray(0, this.#maxBytes) : buf;
    // Lossy UTF-8 decode (replacement chars for invalid sequences).
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);

    // Markdown extraction runs on the (possibly truncated) HTML slice. Non-HTML
    // bodies pass through unchanged.
    const converted = format === "markdown" && looksLikeHtml(contentType, decoded);
    let body = converted ? await htmlToMarkdown(decoded) : decoded;

    // `node-html-markdown` can *expand* its HTML source — tables gain `| … |`
    // separator rows, links duplicate their href as `[text](url)`, entities are
    // unescaped — so the converted Markdown may exceed `maxBytes` even when the
    // HTML slice fit. Re-measure the emitted bytes and cap them so the body the
    // LLM sees never blows past the budget the caller relies on. (#286)
    let bodyTruncated = false;
    if (converted) {
      const bodyBytes = new TextEncoder().encode(body);
      if (bodyBytes.length > this.#maxBytes) {
        body = new TextDecoder("utf-8", { fatal: false }).decode(
          bodyBytes.subarray(0, this.#maxBytes),
        );
        bodyTruncated = true;
      }
    }

    let out = `HTTP ${statusLine(resp.status, resp.statusText)}\n${headers}\n${body}`;
    // Report what was actually cut. When the emitted body was capped (raw over
    // budget, or over-long Markdown) the classic marker is accurate. When only
    // the upstream HTML was cut *before* a within-budget conversion, say so —
    // otherwise the marker misreports the boundary of a body it didn't trim.
    if (bodyTruncated || (sourceTruncated && !converted)) {
      out += `\n\n[... truncated at ${this.#maxBytes} bytes ...]`;
    } else if (sourceTruncated) {
      out += `\n\n[... source HTML truncated at ${this.#maxBytes} bytes before markdown conversion ...]`;
    }
    return out;
  }
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
