// Token-budgeted sliding window over a conversation. Ported from
// harness-memory/src/sliding.rs (the load-bearing compaction subset).
//
// The conversation splits into leading system messages (kept
// unconditionally) and turns (kept newest-first until the budget fills, then
// emitted chronologically). The most recent turn is always preserved. Tool
// exchanges stay atomic via turn grouping.
//
// Deferred (later phases): the trailing working-context snapshot
// (task-local), telemetry counters / compaction events (observability), and
// SummarizingMemory (P6).
import type { Memory, Message } from "@jarvis/core";
import { systemMessage } from "@jarvis/core";
import { cacheBreakpointIndices, defaultEstimator, type TokenEstimator } from "./tokens.ts";
import {
  selectRecentTurns,
  selectRecentTurnsWithBreakpoint,
  splitIntoTurns,
  type TurnIndices,
} from "./turns.ts";

// Constant on purpose: embedding a count would change the bytes every time a
// turn drops off the tail, busting the LLM prompt cache for everything after
// this point.
const OMITTED_MARKER = "[earlier turns omitted to fit context]";

/**
 * Pure compaction. Returns the messages to send plus how many turns were
 * dropped. Mirrors `harness-memory`'s free `compact` fn.
 */
export function compact(
  messages: Message[],
  maxTokens: number,
  insertMarker: boolean,
  estimator: TokenEstimator,
): { out: Message[]; dropped: number } {
  const { systemIdxs, turns } = splitIntoTurns(messages);

  const systemTokens = systemIdxs.reduce((acc, i) => acc + estimator.estimateMessage(messages[i]!), 0);
  const budget = Math.max(0, maxTokens - systemTokens);
  const turnCost = (turn: TurnIndices): number =>
    turn.reduce((acc, i) => acc + estimator.estimateMessage(messages[i]!), 0);

  // Cache-aware path: keep the cached prefix intact when any message carries
  // an explicit breakpoint, else plain newest-first.
  const breakpoints = cacheBreakpointIndices(messages);
  const kept =
    breakpoints.length > 0
      ? selectRecentTurnsWithBreakpoint(turns, Math.max(...breakpoints), budget, turnCost)
      : selectRecentTurns(turns, budget, turnCost);

  const dropped = turns.length - kept.length;

  const out: Message[] = [];
  for (const i of systemIdxs) out.push(messages[i]!);
  if (insertMarker && dropped > 0) out.push(systemMessage(OMITTED_MARKER));
  for (const turn of kept) for (const i of turn) out.push(messages[i]!);

  return { out, dropped };
}

/** Drop oldest turns until the estimated token count fits `maxTokens`. */
export class SlidingWindowMemory implements Memory {
  readonly #maxTokens: number;
  #insertMarker = true;
  #estimator: TokenEstimator = defaultEstimator();

  constructor(maxTokens: number) {
    this.#maxTokens = maxTokens;
  }

  /** Disable the synthetic `[earlier turns omitted to fit context]` note. */
  withoutMarker(): this {
    this.#insertMarker = false;
    return this;
  }

  /** Use a provider-supplied estimator instead of the char-ratio fallback. */
  withEstimator(estimator: TokenEstimator): this {
    this.#estimator = estimator;
    return this;
  }

  compact(messages: Message[]): Promise<Message[]> {
    return Promise.resolve(compact(messages, this.#maxTokens, this.#insertMarker, this.#estimator).out);
  }
}
