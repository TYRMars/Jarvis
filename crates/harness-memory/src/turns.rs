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
