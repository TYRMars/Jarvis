// Operator-static model route policy. Ported from harness-server's
// ModelRoutePolicy + route_policy.rs. Per-task-slot `(provider, model)`
// overrides operators set so subagents / the summariser route to cheaper or
// specialised models. Held mutable in-process (the `/v1/routing` CRUD mutates
// it); seeded from JARVIS_ROUTE_* at boot by the composition root.
//
// Consumption today (matching Rust): the `summarization` slot is read by the
// SummarizingMemory resolver. The other slots are surfaced for the UI + future
// per-request resolvers; they take effect when a consumer is wired.

/** One `(provider, model)` routing target. Wire shape matches the web. */
export interface ModelTarget {
  provider: string;
  model: string;
}

export type RouteSlot =
  | "default"
  | "coding"
  | "review"
  | "summarization"
  | "doc_reader"
  | "vision"
  | "local_private";

export const ROUTE_SLOTS: readonly RouteSlot[] = [
  "default",
  "coding",
  "review",
  "summarization",
  "doc_reader",
  "vision",
  "local_private",
];

/** The whole policy. Empty slots are omitted on the wire. */
export interface RoutePolicy {
  default?: ModelTarget;
  coding?: ModelTarget;
  review?: ModelTarget;
  summarization?: ModelTarget;
  doc_reader?: ModelTarget;
  vision?: ModelTarget;
  local_private?: ModelTarget;
  fallbacks?: ModelTarget[];
}

export function isRouteSlot(s: string): s is RouteSlot {
  return (ROUTE_SLOTS as readonly string[]).includes(s);
}

/**
 * Parse a `"<provider>/<model>"` target. Both segments must be non-empty;
 * `undefined` for malformed input (the route turns that into a 400). Mirrors
 * `ModelTarget::parse`.
 */
export function parseModelTarget(s: string): ModelTarget | undefined {
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return undefined;
  const provider = s.slice(0, slash).trim();
  const model = s.slice(slash + 1).trim();
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

/**
 * Mutable in-process holder. The `/v1/routing` routes mutate it; the
 * SummarizingMemory resolver reads `summarizationModel()`. Shared by reference
 * so a mutation is visible to the resolver without rebuilding anything.
 */
export class RoutePolicyStore {
  #policy: RoutePolicy;

  constructor(initial: RoutePolicy = {}) {
    this.#policy = initial;
  }

  /** A snapshot for the wire (omits empty slots / empty fallbacks). */
  snapshot(): RoutePolicy {
    const p = this.#policy;
    const out: RoutePolicy = {};
    for (const slot of ROUTE_SLOTS) {
      const t = p[slot];
      if (t) out[slot] = { ...t };
    }
    if (p.fallbacks && p.fallbacks.length > 0) out.fallbacks = p.fallbacks.map((t) => ({ ...t }));
    return out;
  }

  /** Replace the whole policy (PUT /v1/routing). */
  replace(p: RoutePolicy): void {
    this.#policy = p;
  }

  /** Set or clear one slot (PATCH/DELETE /v1/routing/:slot). */
  setSlot(slot: RouteSlot, target: ModelTarget | undefined): void {
    if (target) this.#policy[slot] = target;
    else delete this.#policy[slot];
  }

  /** The summarization slot's model, if set — read by SummarizingMemory. */
  summarizationModel(): string | undefined {
    return this.#policy.summarization?.model;
  }
}
