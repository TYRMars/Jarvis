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

  constructor(config: HttpFetchConfig = {}) {
    this.#maxBytes = config.maxBytes ?? HTTP_DEFAULT_MAX_BYTES;
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

    // Bound the header block by the same byte budget as the body — an upstream
    // returning very large or very many headers must not blow past `maxBytes`
    // (and leave the model with no truncation signal).
    let headers = "";
    let headersTruncated = false;
    resp.headers.forEach((value, key) => {
      if (headersTruncated) return;
      const line = `${key}: ${value}\n`;
      if (headers.length + line.length > this.#maxBytes) {
        headersTruncated = true;
        return;
      }
      headers += line;
    });

    const buf = new Uint8Array(await resp.arrayBuffer());
    const bodyTruncated = buf.length > this.#maxBytes;
    const slice = bodyTruncated ? buf.subarray(0, this.#maxBytes) : buf;
    // Lossy UTF-8 decode (replacement chars for invalid sequences), matching
    // Rust's `String::from_utf8_lossy`.
    const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);

    let out = `HTTP ${statusLine(resp.status, resp.statusText)}\n${headers}\n${body}`;
    if (headersTruncated) {
      out += `\n\n[... response headers truncated at ${this.#maxBytes} bytes ...]`;
    }
    if (bodyTruncated) {
      out += `\n\n[... truncated at ${this.#maxBytes} bytes ...]`;
    }
    return out;
  }
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
