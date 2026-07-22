// RoutingProvider — an LlmProvider that picks the downstream model per call
// based on classified difficulty. Ported from harness-router/src/provider.rs.
//
// On each call it classifies the request's difficulty into a Tier via a
// Classifier, looks the tier up in a RouterConfig tier→ModelRef table,
// rewrites ChatRequest.model, and delegates to the matching downstream
// provider. Requests that resolve to the primary get auto-tiered; requests
// explicitly targeting a *different* provider bypass routing entirely — that
// bypass lives in the composition root (apps/jarvis), which only wraps the
// primary provider entry in a RoutingProvider, so such requests never reach
// this wrapper.
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider, Message } from "@jarvis/core";
import type { Classifier } from "./classify.ts";
import type { RouterConfig, Tier } from "./tier.ts";

/**
 * Separator that stamps a routed `response_id` with the name of the provider
 * that minted it. ASCII unit separator (U+001F) — it never appears in a real
 * provider name or a provider-issued id, so the split back into
 * `(provider, id)` is unambiguous and round-trips losslessly.
 */
const CHAIN_PROVIDER_SEP = "";

/**
 * Prefix a provider-issued `response_id` with the routed provider name so the
 * *next* turn can tell which backend's server-side state the id refers to.
 * Inverse of `unstampResponseId`.
 */
export function stampResponseId(provider: string, id: string): string {
  return `${provider}${CHAIN_PROVIDER_SEP}${id}`;
}

/**
 * Split a stamped id back into `[provider, originalId]`. Returns `undefined`
 * for an unstamped id (e.g. one minted before routing was enabled), which the
 * caller treats as "not safe to chain". Splits on the FIRST separator only.
 */
export function unstampResponseId(stamped: string): [string, string] | undefined {
  const idx = stamped.indexOf(CHAIN_PROVIDER_SEP);
  if (idx === -1) return undefined;
  return [stamped.slice(0, idx), stamped.slice(idx + 1)];
}

interface Resolved {
  provider: LlmProvider;
  /** Configured provider name (identifies the chain handle's backend). */
  name: string;
  model: string;
}

/**
 * Latest user message text, scanning from the end. During a tool loop the
 * trailing message is a tool result, so this naturally pins the classification
 * to the user's actual ask and keeps the tier stable across the loop's
 * iterations. Empty when there's no user message.
 */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return m.content;
  }
  return "";
}

/**
 * Wraps a set of already-built providers and routes each call to one of them
 * by tier. Construct it in the composition root and register it as the primary
 * provider entry.
 */
export class RoutingProvider implements LlmProvider {
  /**
   * Provider used when a tier's target names a provider absent from
   * `providers` (misconfiguration). Always the primary provider in practice.
   */
  readonly #fallback: LlmProvider;
  /** provider name → impl. The classifier picks a ModelRef whose `provider` is looked up here. */
  readonly #providers: Map<string, LlmProvider>;
  readonly #config: RouterConfig;
  readonly #classifier: Classifier;

  constructor(
    fallback: LlmProvider,
    providers: Map<string, LlmProvider>,
    config: RouterConfig,
    classifier: Classifier,
  ) {
    this.#fallback = fallback;
    this.#providers = providers;
    this.#config = config;
    this.#classifier = classifier;
  }

  /**
   * Resolve a tier to a concrete `(provider, name, model)`. A tier whose
   * target provider isn't registered falls back to `fallback` but keeps the
   * configured provider name + model string — better to run the intended model
   * on a working provider than to silently drop the request. The name
   * identifies which backend a chain handle belongs to (see `reconcileChain`).
   */
  #resolve(tier: Tier): Resolved {
    const target = this.#config.target(tier);
    const provider = this.#providers.get(target.provider) ?? this.#fallback;
    return { provider, name: target.provider, model: target.model };
  }

  async #decide(req: ChatRequest): Promise<Resolved & { tier: Tier }> {
    const tier = await this.#classifier.classify(lastUserText(req.messages));
    return { ...this.#resolve(tier), tier };
  }

  /**
   * Drop Responses-API chain handles when they were minted by a *different*
   * provider than the one this call routes to. The router re-classifies every
   * request, so two turns of one conversation can land on different backends;
   * `previous_response_id` / `chain_origin` are opaque, provider-private
   * server-state handles that are invalid when replayed against a backend that
   * never issued them. When the provider matches, strip our stamp and forward
   * the original id so chaining keeps working.
   *
   * Returns a NEW request object (never mutates the caller's) with the chain
   * fields reconciled and the model rewritten.
   */
  #rewrite(req: ChatRequest, resolved: string, model: string): ChatRequest {
    const out: ChatRequest = { ...req, model };
    const stamped = req.previous_response_id ?? undefined;
    const parsed = stamped !== undefined ? unstampResponseId(stamped) : undefined;
    if (parsed !== undefined && parsed[0] === resolved) {
      out.previous_response_id = parsed[1];
    } else {
      out.previous_response_id = null;
      out.chain_origin = null;
    }
    return out;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const { provider, name, model } = await this.#decide(req);
    const routed = this.#rewrite(req, name, model);
    const resp = await provider.complete(routed);
    // Attribute usage to the model that actually ran (unless the downstream
    // already reported one), so cost estimates aren't priced against the
    // pre-routing model.
    const withModel = resp.model != null ? resp : { ...resp, model };
    // Stamp the id we hand back so the next turn can detect a switch.
    if (withModel.response_id != null) {
      return { ...withModel, response_id: stampResponseId(name, withModel.response_id) };
    }
    return withModel;
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const { provider, name, model } = await this.#decide(req);
    const routed = this.#rewrite(req, name, model);
    const inner = await provider.completeStream(routed);
    // Mirror the blocking path: re-stamp the terminal Finish's response_id with
    // the routed provider so chaining stays correct, and tag the usage chunk
    // with the routed model so token usage is attributed to the model that ran.
    return restampStream(inner, name, model);
  }
}

/**
 * Re-stamp the terminal `finish` chunk's `response_id` with the routed
 * provider name, tag the `usage` chunk with the routed `model` (unless the
 * downstream already set one), and forward every other chunk untouched.
 */
async function* restampStream(
  inner: AsyncIterable<LlmChunk>,
  name: string,
  model: string,
): AsyncGenerator<LlmChunk> {
  for await (const chunk of inner) {
    if (chunk.type === "finish" && chunk.response_id != null) {
      yield { ...chunk, response_id: stampResponseId(name, chunk.response_id) };
    } else if (chunk.type === "usage" && chunk.model == null) {
      yield { ...chunk, model };
    } else {
      yield chunk;
    }
  }
}
