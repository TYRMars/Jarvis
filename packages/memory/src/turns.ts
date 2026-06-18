// Conversation → turn grouping shared by every memory implementation.
// Ported from harness-memory/src/turns.rs.
//
// A "turn" starts at a `user` message and runs through every assistant reply
// and `tool` answer that follows, up to (but not including) the next `user`.
// Grouping on this boundary keeps tool exchanges atomic so a compactor never
// splits an assistant `tool_calls` from its `tool` replies — OpenAI rejects
// orphaned tool messages, so this is correctness, not hygiene.
//
// Leading `system` messages are returned as a separate group; a `system`
// message appearing later is folded into the surrounding turn.
import type { Message } from "@jarvis/core";

/** Indices into the original slice. */
export type TurnIndices = number[];

export interface SplitTurns {
  /** Indices of leading system messages, in order. */
  systemIdxs: number[];
  /** Each turn as indices into the original slice. */
  turns: TurnIndices[];
}

export function splitIntoTurns(messages: Message[]): SplitTurns {
  const systemIdxs: number[] = [];
  const turns: TurnIndices[] = [];
  let current: TurnIndices = [];
  let seenNonSystem = false;

  messages.forEach((msg, i) => {
    if (msg.role === "system" && !seenNonSystem) {
      systemIdxs.push(i);
    } else if (msg.role === "user") {
      seenNonSystem = true;
      if (current.length > 0) {
        turns.push(current);
        current = [];
      }
      current.push(i);
    } else {
      seenNonSystem = true;
      current.push(i);
    }
  });
  if (current.length > 0) turns.push(current);
  return { systemIdxs, turns };
}

/**
 * Walk turns newest-first, keeping them while the running cost fits `budget`.
 * The most recent turn is ALWAYS kept even if it alone exceeds the budget.
 * Returns the kept turns in chronological order. Mirrors `select_recent_turns`.
 */
export function selectRecentTurns(
  turns: TurnIndices[],
  budget: number,
  cost: (turn: TurnIndices) => number,
): TurnIndices[] {
  const kept: TurnIndices[] = [];
  let remaining = budget;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const c = cost(turn);
    if (kept.length === 0) {
      kept.push(turn);
      remaining = Math.max(0, remaining - c);
    } else if (c <= remaining) {
      kept.push(turn);
      remaining -= c;
    } else {
      break;
    }
  }
  kept.reverse();
  return kept;
}

/**
 * Cache-aware variant. `breakpoint` is the highest-indexed message carrying
 * an explicit cache hint — the cached prefix runs through (and includes) it.
 * Keeps the cached prefix intact, then tops up newest-first with the
 * remaining budget. Falls back to plain recency if the cached prefix alone
 * overflows. Mirrors `select_recent_turns_with_breakpoint`.
 */
export function selectRecentTurnsWithBreakpoint(
  turns: TurnIndices[],
  breakpoint: number,
  budget: number,
  cost: (turn: TurnIndices) => number,
): TurnIndices[] {
  if (turns.length === 0) return [];

  // A turn is "cached" iff all its indices are at-or-before the breakpoint.
  // A turn straddling the breakpoint is treated as post-breakpoint (splitting
  // it would break tool-call atomicity).
  let cachedCount = 0;
  for (const t of turns) {
    const max = Math.max(...t);
    if (max <= breakpoint) cachedCount++;
    else break;
  }
  const cached = turns.slice(0, cachedCount);
  const rest = turns.slice(cachedCount);

  const cachedCost = cached.reduce((acc, t) => acc + cost(t), 0);
  if (cachedCost > budget) {
    // Cached prefix overflows — recency beats caching when we can't have both.
    return selectRecentTurns(turns, budget, cost);
  }

  let tailBudget = budget - cachedCost;
  const tailKept: TurnIndices[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const turn = rest[i]!;
    const c = cost(turn);
    if (tailKept.length === 0) {
      tailKept.push(turn);
      tailBudget = Math.max(0, tailBudget - c);
    } else if (c <= tailBudget) {
      tailKept.push(turn);
      tailBudget -= c;
    } else {
      break;
    }
  }
  tailKept.reverse();
  return [...cached, ...tailKept];
}
