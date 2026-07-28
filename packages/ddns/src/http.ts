// Tiny fetch helpers shared by the DDNS providers + IP lookup. Uses the global
// `fetch` (Node ≥ 18 undici) — no transport dependency, matching the
// `http.fetch` tool's choice. Every call is timeout-bounded via AbortController
// so a hung provider endpoint can never wedge the periodic updater.

export interface HttpTextResult {
  status: number;
  ok: boolean;
  text: string;
}

/** GET/POST and return the body as text, with a hard timeout. Network errors
 * reject; HTTP error statuses resolve (the caller inspects `status`). */
export async function httpText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<HttpTextResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON body, or throw with the raw text so callers can surface it. */
export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
  }
}

/** RFC-3986 percent-encoding (stricter than encodeURIComponent — also escapes
 * `!*'()`). Required by the Aliyun RPC signature. */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
