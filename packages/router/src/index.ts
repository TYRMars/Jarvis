// @jarvis/router — smart model routing for the Jarvis harness. Public surface.
//
// A RoutingProvider is itself an LlmProvider: on each call it classifies the
// request's difficulty into a Tier via a Classifier, looks the tier up in a
// RouterConfig tier→ModelRef table, rewrites ChatRequest.model, and delegates
// to the matching downstream provider. Depends on @jarvis/core only — the
// composition root (apps/jarvis) reads env/config and constructs the provider
// map + RouterConfig, handing them to RoutingProvider.
export {
  type Tier,
  type ModelRef,
  ALL_TIERS,
  RouterConfig,
  modelRef,
  parseModelRef,
} from "./tier.ts";
export {
  type Classifier,
  type HeuristicConfig,
  HeuristicClassifier,
} from "./classify.ts";
export { RoutingProvider, stampResponseId, unstampResponseId } from "./provider.ts";
