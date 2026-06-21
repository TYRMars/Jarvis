// http.fetch's HTML→Markdown extraction. Converts an HTML response body into
// clean Markdown so the model reads content, not markup — the doc-reading path
// opencode's webfetch markdownifies (`tool/webfetch.ts`). Powered by
// `node-html-markdown` (Node-native, no jsdom). Lazy-imported so the parser is
// only loaded when a caller actually requests `format: "markdown"`, keeping
// server startup lean.

let translate: ((html: string) => string) | undefined;

/**
 * Convert an HTML string to Markdown. Best-effort: on any converter error the
 * original HTML is returned, so a malformed page never fails the fetch.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  if (!translate) {
    const { NodeHtmlMarkdown } = await import("node-html-markdown");
    translate = (h) => NodeHtmlMarkdown.translate(h);
  }
  try {
    return translate(html).trim();
  } catch {
    return html;
  }
}

/**
 * Heuristic: is this response worth markdownifying? `content-type` decides when
 * present (HTML → yes; JSON / XML / plain-text → no, leave the structured body
 * intact); otherwise sniff the first KB of the body for HTML markers. Keeps
 * `format: "markdown"` safe to pass unconditionally — API/JSON responses pass
 * through untouched.
 */
export function looksLikeHtml(contentType: string | undefined, body: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("html")) return true;
    if (ct.includes("json") || ct.includes("xml") || ct.includes("text/plain") || ct.includes("csv")) {
      return false;
    }
  }
  const head = body.slice(0, 1024).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.includes("<body");
}
