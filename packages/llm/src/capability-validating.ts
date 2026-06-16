// Capability-validating provider wrapper. Ported from
// harness-llm/src/capability_validating.rs.
//
// Wraps any `LlmProvider` together with a snapshot of `ModelCapability`
// entries. Every request is validated against the matching model's flags
// before forwarding:
//
//   * Tool calls vs `supportsToolCalls === false` — when the request carries
//     `tools` and the model is known to lack tool support, short-circuit with a
//     clear `ProviderError` so the caller sees "model X doesn't do tools"
//     instead of an obscure 400 from the upstream API.
//   * Parallel tool calls vs `supportsParallelToolCalls === false` — when
//     the request opts in but the catalog says no, silently downgrade
//     `parallel_tool_calls` to undefined. The agent loop's parallel dispatch is
//     harmless on a model that emits one call at a time, so this isn't bubbled
//     back to the caller.
//
// Models *not* in the catalog pass through unchanged — capability data is
// best-effort, not a gate. Likewise, a known model with an *unknown* flag
// (absent) is never gated; only an explicit `false` gates.
import { ProviderError } from "@jarvis/core";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";
// Reuse the catalog's `ModelCapability` (the same struct the Rust wrapper reads
// from `crate::profile`) rather than forking a parallel shape. Every capability
// flag is tri-state: `true` (yes) / `false` (definitively no) / `undefined`
// ("we don't know" → never gate). Matches the Rust `Option<bool>` semantics
// where only `Some(false)` blocks.
import type { ModelCapability } from "./profile.ts";

/**
 * Wraps a primary provider with capability validation. Identical surface to
 * `LlmProvider` so callers have nothing to migrate.
 */
export class CapabilityValidatingProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  /** Snapshot of capability rows for this provider's catalog. */
  readonly #capabilities: ReadonlyArray<ModelCapability>;

  constructor(inner: LlmProvider, capabilities: ModelCapability[]) {
    this.#inner = inner;
    this.#capabilities = capabilities;
  }

  /**
   * Look up the row for `model`, if any. Match by exact `model` string only —
   * the catalog stores wire model ids and the caller's `ChatRequest.model` is
   * what we send upstream, so these strings line up by construction.
   */
  #lookup(model: string): ModelCapability | undefined {
    return this.#capabilities.find((c) => c.model === model);
  }

  /**
   * Apply the gating rules. Returns the (possibly-mutated) request or throws a
   * hard `ProviderError` when the request is incompatible with the model.
   * Mutations: clear `parallel_tool_calls` when the model is known to not
   * support it (silent downgrade).
   */
  #validateAndAdjust(req: ChatRequest): ChatRequest {
    const cap = this.#lookup(req.model);
    // Unknown model → passthrough. Don't gate what we don't know.
    if (cap === undefined) return req;

    const hasTools = (req.tools?.length ?? 0) > 0;
    if (hasTools && cap.supportsToolCalls === false) {
      throw new ProviderError(
        `model \`${req.model}\` does not support tool calls; ` +
          `pick another model or remove tools from the request`,
      );
    }

    if (req.parallel_tool_calls === true && cap.supportsParallelToolCalls === false) {
      // Silent downgrade: drop the opt-in so the inner provider doesn't reject
      // it. (Rust emits a tracing::warn! here; no logging surface in core.)
      const { parallel_tool_calls: _drop, ...rest } = req;
      return rest;
    }

    return req;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const adjusted = this.#validateAndAdjust(req);
    return this.#inner.complete(adjusted);
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const adjusted = this.#validateAndAdjust(req);
    return this.#inner.completeStream(adjusted);
  }
}
