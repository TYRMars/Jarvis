// Redaction helpers for provider error bodies.
//
// Provider/transport failures interpolate the upstream response body into
// ProviderError messages so the agent loop can surface them to the model for
// recovery. Those bodies then propagate into logs and persisted conversation
// transcripts. On most paths a body is low-sensitivity, but it can carry
// credential material — most acutely on the OAuth token-refresh path, whose
// endpoint can echo grant/token fragments. These helpers cap body size and
// scrub obvious secret-bearing fields before the text escapes into a
// model-visible / logged error.

/** Default cap (chars) applied to interpolated upstream bodies. */
const DEFAULT_MAX_BODY = 512;

/**
 * Redact obvious credential-bearing fields from a (possibly JSON) body. Matches
 * common token/secret key names in both JSON (`"access_token": "…"`) and
 * form-encoded (`access_token=…`) shapes and replaces the value with a marker.
 */
export function scrubSecrets(body: string): string {
  return body.replace(
    /("?(?:access_token|refresh_token|id_token|client_secret|client_id|api_key|authorization|password|secret)"?\s*[:=]\s*"?)([^"',&\s}]+)/gi,
    (_m, prefix: string) => `${prefix}<redacted>`,
  );
}

/**
 * Scrub secrets then truncate to `max` chars (with a marker noting how much was
 * dropped). Use for the general provider error paths where the body is useful
 * for debugging but must not leak unbounded / secret content.
 */
export function safeBody(body: string, max = DEFAULT_MAX_BODY): string {
  const scrubbed = scrubSecrets(body);
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max)}…[truncated ${scrubbed.length - max} chars]`;
}

/**
 * Fully redacted marker for the most sensitive paths (OAuth token endpoint),
 * where even a scrubbed body is not worth the risk. Surfaces only the byte
 * count so an operator can tell something came back without exposing it.
 */
export function redactedMarker(body: string): string {
  return `<redacted ${body.length} bytes>`;
}
