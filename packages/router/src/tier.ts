// Difficulty tiers + the tier→model routing table.
// Ported from harness-router/src/tier.rs.
//
// The Rust `Tier` enum is rendered as a lowercase string union here — its
// stable wire/log names (`as_str`) ARE the variants, so no separate mapping
// helper is needed. `RouterConfig` keeps the mandatory `default` fallback so a
// partially-configured router is always well-defined.

/**
 * Difficulty tier a single turn is classified into. Mirrors the four-level
 * scheme used by comparable routers: trivial confirmations at "simple", deep
 * multi-file analysis at "reasoning".
 *
 * The HeuristicClassifier only emits "simple" / "medium" / "complex";
 * "reasoning" is reserved for the future LLM judge but is a valid routing
 * target today (operators may map it even if nothing emits it yet).
 */
export type Tier = "simple" | "medium" | "complex" | "reasoning";

/** All tiers, in difficulty order. Stable lowercase wire/log names. */
export const ALL_TIERS: readonly Tier[] = ["simple", "medium", "complex", "reasoning"];

/**
 * One `(provider, model)` routing target. `provider` is a key into the
 * RoutingProvider's provider map; `model` is the string written onto the
 * outgoing request.
 *
 * The `provider/model` slash form matches the rest of the harness, so
 * operators reuse the same syntax in `JARVIS_ROUTER_TIER_*` env vars.
 */
export interface ModelRef {
  provider: string;
  model: string;
}

export function modelRef(provider: string, model: string): ModelRef {
  return { provider, model };
}

/**
 * Parse the `<provider>/<model>` wire form. Returns `undefined` when either
 * side is empty so a typo'd env var falls through to the default target rather
 * than routing to a half-specified model. Splits on the FIRST `/` so model
 * names containing slashes are preserved (mirrors Rust `split_once`).
 */
export function parseModelRef(s: string): ModelRef | undefined {
  const idx = s.indexOf("/");
  if (idx === -1) return undefined;
  const provider = s.slice(0, idx);
  const model = s.slice(idx + 1);
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

/**
 * Tier→model table with a mandatory `default` fallback. Any tier with no
 * explicit entry resolves to `default`, so a partially-configured router (e.g.
 * only "simple" mapped) is always well-defined.
 *
 * Ported from the Rust `RouterConfig` struct + builder. `withTier` returns a
 * new config (immutable builder) so the same base can be reused.
 */
export class RouterConfig {
  readonly default: ModelRef;
  readonly tiers: Map<Tier, ModelRef>;

  constructor(defaultTarget: ModelRef, tiers?: Map<Tier, ModelRef>) {
    this.default = defaultTarget;
    this.tiers = tiers ?? new Map();
  }

  /**
   * Map `tier` to `target`. Later calls overwrite earlier ones for the same
   * tier. Returns a new RouterConfig (builder style) leaving the receiver
   * untouched.
   */
  withTier(tier: Tier, target: ModelRef): RouterConfig {
    const next = new Map(this.tiers);
    next.set(tier, target);
    return new RouterConfig(this.default, next);
  }

  /** Resolve a tier to its target, falling back to `default`. */
  target(tier: Tier): ModelRef {
    return this.tiers.get(tier) ?? this.default;
  }
}
