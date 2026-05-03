//! Conversation → turn grouping shared by every memory implementation.
//!
//! A "turn" starts at a `User` message and runs through every Assistant
//! reply and `Tool` answer that follows, up to (but not including) the
//! next `User`. Grouping on this boundary keeps tool exchanges atomic so
//! a compactor never splits an `Assistant.tool_calls` from its `Tool`
//! replies — OpenAI rejects orphaned tool messages, so this matters for
//! correctness, not just hygiene.
//!
//! `System` messages at the very front of the slice are returned as a
//! separate "leading system" group; downstream compactors typically keep
//! them unconditionally. A `System` message that appears later is folded
//! into the surrounding turn so it travels with its peers.

use harness_core::Message;

/// Indices of leading system messages. Walking the original slice with
/// these indices yields the system prompts in order.
pub(crate) type SystemIndices = Vec<usize>;

/// One turn, expressed as the indices into the original message slice.
pub(crate) type TurnIndices = Vec<usize>;

pub(crate) fn split_into_turns(messages: &[Message]) -> (SystemIndices, Vec<TurnIndices>) {
    let mut leading_system: SystemIndices = Vec::new();
    let mut turns: Vec<TurnIndices> = Vec::new();
    let mut current: TurnIndices = Vec::new();
    let mut seen_non_system = false;

    for (i, msg) in messages.iter().enumerate() {
        match msg {
            Message::System { .. } if !seen_non_system => {
                leading_system.push(i);
            }
            Message::User { .. } => {
                seen_non_system = true;
                if !current.is_empty() {
                    turns.push(std::mem::take(&mut current));
                }
                current.push(i);
            }
            _ => {
                seen_non_system = true;
                current.push(i);
            }
        }
    }
    if !current.is_empty() {
        turns.push(current);
    }
    (leading_system, turns)
}

/// Walk turns newest-first and keep them while the running token cost
/// fits `budget`. The most recent turn is **always** kept, even if it
/// alone exceeds the budget — sending no recent context is strictly
/// worse than slightly overrunning. Returns the kept turns in original
/// (chronological) order.
pub(crate) fn select_recent_turns<F>(
    turns: &[TurnIndices],
    mut budget: usize,
    cost: F,
) -> Vec<&TurnIndices>
where
    F: Fn(&TurnIndices) -> usize,
{
    let mut kept: Vec<&TurnIndices> = Vec::new();
    for turn in turns.iter().rev() {
        let c = cost(turn);
        if kept.is_empty() {
            kept.push(turn);
            budget = budget.saturating_sub(c);
        } else if c <= budget {
            kept.push(turn);
            budget -= c;
        } else {
            break;
        }
    }
    kept.reverse();
    kept
}

/// Cache-aware variant of [`select_recent_turns`]. `breakpoint` is the
/// highest-indexed message that carries an explicit `CacheHint` — the
/// cached prefix runs through (and includes) that index. We try to keep
/// every turn whose messages all fall at-or-before the breakpoint plus
/// the most recent turn (recency invariant), then top up newest-first
/// with the remaining budget.
///
/// If preserving the cached prefix would push us over budget, falls
/// back to plain [`select_recent_turns`] so we never regress recency.
pub(crate) fn select_recent_turns_with_breakpoint<F>(
    turns: &[TurnIndices],
    breakpoint: usize,
    budget: usize,
    cost: F,
) -> Vec<&TurnIndices>
where
    F: Fn(&TurnIndices) -> usize,
{
    if turns.is_empty() {
        return Vec::new();
    }

    // A turn is "cached" iff every one of its message indices is
    // at-or-before the breakpoint. A turn that straddles the breakpoint
    // is treated as post-breakpoint — splitting it would break the
    // tool-call atomicity invariant.
    let cached_count = turns
        .iter()
        .take_while(|t| t.iter().max().map_or(true, |&i| i <= breakpoint))
        .count();
    let (cached, rest) = turns.split_at(cached_count);

    let cached_cost: usize = cached.iter().map(&cost).sum();
    if cached_cost > budget {
        // Cached prefix alone overflows — fall back to the plain
        // newest-first heuristic. Recency still beats caching when we
        // can't have both.
        return select_recent_turns(turns, budget, cost);
    }

    // Keep the cached prefix unconditionally, then accumulate the
    // post-breakpoint slice newest-first under the remaining budget.
    let remaining = budget - cached_cost;
    let mut kept: Vec<&TurnIndices> = Vec::with_capacity(turns.len());
    let mut tail_kept: Vec<&TurnIndices> = Vec::new();
    let mut tail_budget = remaining;
    for turn in rest.iter().rev() {
        let c = cost(turn);
        if tail_kept.is_empty() {
            // Recency invariant: keep the very latest turn even if it
            // alone exceeds `remaining`.
            tail_kept.push(turn);
            tail_budget = tail_budget.saturating_sub(c);
        } else if c <= tail_budget {
            tail_kept.push(turn);
            tail_budget -= c;
        } else {
            break;
        }
    }
    tail_kept.reverse();
    for t in cached {
        kept.push(t);
    }
    kept.extend(tail_kept);
    kept
}
