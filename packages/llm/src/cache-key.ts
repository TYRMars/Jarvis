// Stable cache-key derivation for OpenAI prompt caching.
// Ported from harness-llm/src/cache_key.rs.
//
// OpenAI's automatic prefix cache keys requests by a server-derived hash of
// the prefix bytes; distinct system prompts / tool catalogues collide in the
// default bucket and can evict each other. Sending an explicit
// `prompt_cache_key` segments the cache by `(model, system, tools)`.
//
// The hash input is the canonical wire form: joined system instructions +
// the already-sorted, already-sanitised tools JSON. The Rust impl uses
// BLAKE3; we use SHA-256 (node:crypto, no dependency) — the exact algorithm
// is irrelevant since the two runtimes never share a server-side cache slot,
// only stability-per-config and distinctness-across-configs matter.
import { createHash } from "node:crypto";

/**
 * Derive a stable, namespaced cache key from the request's caching inputs.
 * Output is `jarvis-<16 hex>` — short enough for logs, long enough that
 * collisions on a single account are vanishingly rare. The `\0` separators
 * keep `("ab","c")` distinct from `("a","bc")`.
 */
export function autoCacheKey(model: string, systems: string, toolsJson: string): string {
  const h = createHash("sha256");
  h.update(model, "utf8");
  h.update("\0");
  h.update(systems, "utf8");
  h.update("\0");
  h.update(toolsJson, "utf8");
  return `jarvis-${h.digest("hex").slice(0, 16)}`;
}
