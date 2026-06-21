// LLM-backed long-term memory. Ported from harness-memory/src/summarizing.rs
// (the load-bearing subset).
//
// Instead of hard-dropping the oldest turns when the budget is exceeded
// (SlidingWindowMemory), this asks an LlmProvider to summarise them into a
// single paragraph and injects that as a synthetic `system` message *between*
// the leading systems and the kept recent turns — at the chronological
// position of the first dropped turn.
//
// The turn-grouping invariants of SlidingWindowMemory still apply: leading
// `system` messages are kept verbatim, the most recent turn is always
// preserved, and tool-call exchanges stay atomic (never split a tool_calls
// assistant message from its `tool` replies).
//
// ## Caching
//
// Without caching, every `buildRequest` iteration would re-summarise the same
// prefix. We carry a single-slot in-memory cache keyed by a fingerprint of the
// slice we're about to summarise. As the conversation grows turn-by-turn the
// dropped slice stays identical (we only add to the *recent* end), so the
// cache hits and the LLM is invoked only when the dropped set actually
// changes. A single slot suffices because the dropped set is monotone.
//
// ## Cross-process persistence
//
// With `.withPersistence(store)`, a second tier kicks in: the same fingerprint
// keys a row in a SummaryStore, so a restart picks up where the previous
// process left off and parallel workers sharing a backend see each other's
// work. Storage is content-addressed (the key is a stable hash of the slice,
// not a conversation id), so it's shared across conversations. The composition
// root implements SummaryStore over a ConversationStore, writing under the
// reserved `__memory__.summary:<hash>` key namespace so the HTTP server can
// filter the rows out of public conversation lists.
//
// ## Deferred (vs. the Rust source)
//
// The trailing working-context snapshot (task-local; not yet ported in
// sliding.ts), the observability `CompactionCounters` + `emit_memory_compaction`
// event surface, and the per-call route resolver are intentionally left out
// for this phase. The circuit breaker, the one-shot transport-error retry, and
// the PTL ("prune to last") budget safety net are kept because they protect
// quota, recover from connection-pool flakes, and hold the hard token cap
// respectively.
import { createHash } from "node:crypto";

import type { ChatRequest, LlmProvider, Memory, Message } from "@jarvis/core";
import { errorText, systemMessage, userMessage } from "@jarvis/core";

import {
  cacheBreakpointIndices,
  defaultEstimator,
  estimateMessages,
  type TokenEstimator,
} from "./tokens.ts";
import {
  selectRecentTurns,
  selectRecentTurnsWithBreakpoint,
  splitIntoTurns,
  type TurnIndices,
} from "./turns.ts";
import type { SummaryStore } from "./summary-store.ts";

export type { SummaryStore } from "./summary-store.ts";

/**
 * Default summary prompt when the caller doesn't supply one.
 *
 * A STRUCTURED anchored template (borrowed from opencode's compaction
 * `SUMMARY_TEMPLATE`) rather than a free paragraph: fixed sections give the
 * model durable slots for goal / constraints / progress / decisions / next
 * steps / critical context / files, which markedly improves recall of the facts
 * later turns depend on. The output starts with `## Goal`, so the preamble
 * stripper leaves it untouched (no opener match).
 *
 * NOTE: an "update-merge" variant (feed the prior summary back so the model
 * revises rather than regenerates — opencode's `previousSummary` path) is
 * deferred: `SummarizingMemory` is a single shared instance with one global
 * cache slot, so there is no per-conversation prior summary that could be
 * sourced safely without cross-conversation contamination.
 */
export const DEFAULT_SUMMARY_PROMPT = `\
You are compressing the earlier portion of a conversation into a durable, \
structured summary that later turns will rely on. Output EXACTLY the Markdown \
structure shown inside <template> and keep the section order unchanged. Do not \
include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, identifiers, names, and numbers when known.
- Do not invent details and do not editorialise.
- Do not mention the summary process or that context was compacted — start directly with "## Goal".`;

/**
 * Reserved budget (estimated tokens) carved out for the synthetic summary
 * itself when deciding what to keep recent — keeps us from packing the budget
 * so tight that inserting the summary pushes us back over.
 */
const SUMMARY_RESERVE_TOKENS = 256;

/** Cap on tokens the summarisation call may emit. Sized for the multi-section
 * structured template (≈7 sections of terse bullets) rather than a paragraph. */
const DEFAULT_SUMMARY_MAX_TOKENS = 800;

/**
 * Consecutive summary-call failures that flip the circuit breaker open. While
 * open, `compact` skips the LLM entirely and falls through to the placeholder
 * note, so a wedged summariser stops burning quota.
 */
const CIRCUIT_FAILURE_THRESHOLD = 3;

/** How long the circuit stays open before the next request may try the LLM. */
const CIRCUIT_OPEN_DURATION_MS = 60_000;

interface CachedSummary {
  fingerprint: string;
  text: string;
}

/** Which (if any) PTL round fired in {@link enforceTokenBudget}. */
type PtlOutcome = "none" | "round-one" | "round-two";

/**
 * Compact a conversation by summarising the oldest turns into a synthetic
 * system message instead of dropping them.
 */
export class SummarizingMemory implements Memory {
  readonly #llm: LlmProvider;
  readonly #model: string;
  readonly #maxTokens: number;

  #summaryPrompt = DEFAULT_SUMMARY_PROMPT;
  #summaryMaxTokens = DEFAULT_SUMMARY_MAX_TOKENS;
  #estimator: TokenEstimator = defaultEstimator();
  #persistence: SummaryStore | undefined;
  // Optional per-call model override (the operator route policy's
  // `summarization` slot). Returns undefined to fall back to `#model`.
  #resolveModel: (() => string | undefined) | undefined;

  // Single-slot in-memory cache. The dropped set is monotone, so one slot
  // covers turn-by-turn growth.
  #cache: CachedSummary | undefined;

  // Circuit breaker state.
  #failureStreak = 0;
  #circuitUntil: number | undefined; // epoch ms; undefined = closed

  constructor(llm: LlmProvider, model: string, maxTokens: number) {
    this.#llm = llm;
    this.#model = model;
    this.#maxTokens = maxTokens;
  }

  /** Override the summariser system prompt. */
  withSummaryPrompt(prompt: string): this {
    this.#summaryPrompt = prompt;
    return this;
  }

  /**
   * Supply a per-call model resolver — when it returns a model id, it overrides
   * the constructor `model` for the summary completion. Wired to the operator
   * route policy's `summarization` slot by the composition root.
   */
  withModelResolver(fn: () => string | undefined): this {
    this.#resolveModel = fn;
    return this;
  }

  /** Override the per-call output cap for the summariser. */
  withSummaryMaxTokens(n: number): this {
    this.#summaryMaxTokens = n;
    return this;
  }

  /**
   * Persist (and rehydrate) summaries through `store`, content-addressed by a
   * stable fingerprint of the summarised slice — so they survive process
   * restarts and are shared across workers.
   */
  withPersistence(store: SummaryStore): this {
    this.#persistence = store;
    return this;
  }

  /** Use a provider-supplied estimator instead of the char-ratio fallback. */
  withEstimator(estimator: TokenEstimator): this {
    this.#estimator = estimator;
    return this;
  }

  async compact(messages: Message[]): Promise<Message[]> {
    const est = this.#estimator;
    const { systemIdxs, turns } = splitIntoTurns(messages);

    const systemTokens = systemIdxs.reduce((acc, i) => acc + est.estimateMessage(messages[i]!), 0);
    // Leave headroom for the synthetic summary message we may insert.
    const budget = Math.max(0, this.#maxTokens - systemTokens - SUMMARY_RESERVE_TOKENS);

    const turnCost = (turn: TurnIndices): number =>
      turn.reduce((acc, i) => acc + est.estimateMessage(messages[i]!), 0);

    // Cache-aware path mirrors SlidingWindowMemory: when an explicit
    // breakpoint exists, summarise turns *between* the cached prefix and the
    // recent tail rather than the cached prefix itself.
    const breakpoints = cacheBreakpointIndices(messages);
    const kept =
      breakpoints.length > 0
        ? selectRecentTurnsWithBreakpoint(turns, Math.max(...breakpoints), budget, turnCost)
        : selectRecentTurns(turns, budget, turnCost);

    const droppedCount = turns.length - kept.length;

    // Identify dropped turns by reference equality against the kept set. The
    // cache-aware selector can produce a non-contiguous kept set (cached
    // prefix + recent tail with a hole), so we cannot assume a [0..n) prefix.
    const keptSet = new Set<TurnIndices>(kept);
    const droppedMsgs: Message[] = [];
    for (const turn of turns) {
      if (!keptSet.has(turn)) {
        for (const i of turn) droppedMsgs.push(messages[i]!);
      }
    }

    // Summarise the dropped slice (soft-failing). The circuit breaker skips
    // the LLM entirely while open.
    let summary: string | undefined;
    if (droppedMsgs.length > 0 && !this.#circuitOpen()) {
      try {
        summary = await this.#summarise(droppedMsgs);
        this.#recordSuccess();
      } catch (err) {
        this.#recordFailure();
        // Soft-fail: a flaky summariser must not bring down the user's turn.
        // Fall through to the placeholder note. (Logged via console.warn so
        // the failure is not invisible; @jarvis/memory has no tracing dep.)
        console.warn(
          `summary failed; falling back to placeholder note (dropped=${droppedCount}): ${String(err)}`,
        );
      }
    }

    // Build the synthetic message that stands in for the dropped turns.
    let summaryMsg: Message | undefined;
    if (summary !== undefined) {
      summaryMsg = systemMessage(
        `Earlier conversation summary (${droppedCount} turn(s) compressed):\n${summary}`,
      );
    } else if (droppedCount > 0) {
      summaryMsg = systemMessage(
        `[${droppedCount} earlier turn(s) omitted — summary unavailable]`,
      );
    }

    // Emit leading systems, then walk turns in original order: kept turns in
    // place, the summary once at the position of the first dropped turn (so it
    // sits AFTER any cached prefix and BEFORE the recent tail).
    const out: Message[] = [];
    for (const i of systemIdxs) out.push(messages[i]!);

    let summaryEmitted = false;
    for (const turn of turns) {
      if (keptSet.has(turn)) {
        for (const i of turn) out.push(messages[i]!);
      } else if (!summaryEmitted) {
        if (summaryMsg !== undefined) out.push(summaryMsg);
        summaryEmitted = true;
      }
      // Subsequent dropped turns are skipped — already covered by the summary.
    }
    // Edge case: every turn dropped (no kept turns) → append the summary now.
    if (!summaryEmitted && summaryMsg !== undefined) out.push(summaryMsg);

    // PTL safety net: if the summary itself ran long, drop oldest turns until
    // the estimate fits. Never throws.
    return enforceTokenBudget(out, this.#maxTokens, est).out;
  }

  // --- circuit breaker ---

  /**
   * Whether the failure-streak has flipped the circuit open. Side-effect:
   * clears the latch once the deadline has passed so the next call may retry.
   */
  #circuitOpen(): boolean {
    if (this.#circuitUntil === undefined) return false;
    if (Date.now() < this.#circuitUntil) return true;
    // Deadline reached — re-arm so a single post-cooldown failure doesn't
    // immediately re-trip the breaker.
    this.#circuitUntil = undefined;
    this.#failureStreak = 0;
    return false;
  }

  #recordSuccess(): void {
    this.#failureStreak = 0;
  }

  #recordFailure(): void {
    this.#failureStreak += 1;
    if (this.#failureStreak >= CIRCUIT_FAILURE_THRESHOLD) {
      this.#circuitUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
      console.warn(
        `summary circuit opened — skipping LLM for ${CIRCUIT_OPEN_DURATION_MS / 1000}s ` +
          `(streak=${this.#failureStreak})`,
      );
    }
  }

  // --- three-tier lookup ---

  /**
   * Resolve a summary for `dropped` via, in order: (1) the in-memory slot,
   * (2) the persistent SummaryStore, (3) the LLM. On an LLM summary, write
   * back to the in-memory slot and (if present) the store. Store failures
   * degrade gracefully (warn-and-continue, fall through). Throws only when
   * the LLM call fails (the caller soft-fails to a placeholder).
   */
  async #summarise(dropped: Message[]): Promise<string> {
    const fp = fingerprint(dropped);

    // Tier 1: in-memory single-slot cache.
    if (this.#cache !== undefined && this.#cache.fingerprint === fp) {
      return this.#cache.text;
    }

    // Tier 2: durable store, when configured.
    if (this.#persistence !== undefined) {
      try {
        const text = await this.#persistence.get(fp);
        // Reject blank cached summaries — treat them as a miss so the next
        // call asks again and overwrites the bad row.
        if (text !== undefined && text.trim() !== "") {
          this.#cacheSet(fp, text);
          return text;
        }
      } catch (err) {
        // Don't fail compaction on a flaky backend — fall through to the LLM.
        console.warn(`summary store load failed (fingerprint=${fp}): ${String(err)}`);
      }
    }

    // Tier 3: ask the LLM. Pinned temperature, NO tools. The model is the
    // route policy's summarization override when present, else the default.
    const req: ChatRequest = {
      model: this.#resolveModel?.() ?? this.#model,
      messages: [
        systemMessage(this.#summaryPrompt),
        userMessage(`Summarise the following conversation excerpt:\n\n${renderForSummary(dropped)}`),
      ],
      tools: [],
      temperature: 0,
      max_tokens: this.#summaryMaxTokens,
    };

    // One retry on transient transport errors — the summariser shares a
    // connection pool with the foreground agent and sometimes hits a
    // half-closed keep-alive on first send. Auth refreshes / 401s / other
    // 4xxs are NOT retried (the second attempt would just fail the same
    // way). Mirrors the Rust `summarise`'s `is_transport_error` retry.
    let resp;
    try {
      resp = await this.#llm.complete(req);
    } catch (err) {
      if (!isTransportError(err)) throw err;
      console.warn(`summary llm transport error; retrying once: ${errorText(err)}`);
      resp = await this.#llm.complete(req);
    }
    const raw = extractAssistantText(resp.message);
    if (raw === undefined) {
      throw new Error("summariser returned empty content and reasoning");
    }
    const text = stripSummaryPreamble(raw);

    // Populate both cache tiers.
    this.#cacheSet(fp, text);
    if (this.#persistence !== undefined) {
      try {
        await this.#persistence.put(fp, text);
      } catch (err) {
        console.warn(`summary store save failed (fingerprint=${fp}): ${String(err)}`);
      }
    }
    return text;
  }

  #cacheSet(fingerprintHash: string, text: string): void {
    this.#cache = { fingerprint: fingerprintHash, text };
  }
}

/**
 * Heuristic — does this look like a network-layer flake worth retrying once?
 * Node LLM providers (`@jarvis/llm`) wrap a transport failure as
 * `ProviderError("transport: …")`, which `ProviderError` renders as
 * `"llm provider error: transport: …"`. We don't retry HTTP-level rejections
 * (`status 4xx/5xx`) — those won't fix themselves on a second attempt — but a
 * `transport:` failure (DNS, TLS handshake, half-closed keep-alive) often
 * does. Matched as a substring (not a prefix) because of the wrapper. Mirrors
 * the Rust `is_transport_error`; kept local so `@jarvis/memory` stays a leaf
 * that depends on `@jarvis/core` only.
 */
function isTransportError(err: unknown): boolean {
  return errorText(err).includes("transport:");
}

/**
 * Pull the visible answer out of an assistant message. Most providers put it
 * in `content`, but some thinking models leave `content` empty and emit the
 * visible answer in `reasoning_content`. Accept either, in priority order;
 * return `undefined` only when both are blank. Mirrors the Rust fallback.
 */
function extractAssistantText(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  const primary = message.content?.trim();
  if (primary !== undefined && primary !== "") return primary;
  const fallback = message.reasoning_content?.trim();
  if (fallback !== undefined && fallback !== "") return fallback;
  return undefined;
}

/**
 * Stable hash of the dropped messages. Rust uses BLAKE3; here we use SHA-256
 * hex via node:crypto — only stability matters (cross-restart cache hits). We
 * hash the JSON of each message with a `\n` separator, matching the Rust
 * fingerprint's structure so the digest is order- and content-sensitive.
 */
export function fingerprint(messages: Message[]): string {
  const h = createHash("sha256");
  for (const m of messages) {
    h.update(JSON.stringify(m));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Flatten messages into a plain-text transcript the summariser can digest.
 * Tool arguments are serialised compactly so structure survives without
 * overwhelming the model.
 */
export function renderForSummary(messages: Message[]): string {
  let s = "";
  for (const m of messages) {
    switch (m.role) {
      case "system":
        s += `[system] ${m.content}\n`;
        break;
      case "user":
        s += `[user] ${m.content}\n`;
        break;
      case "assistant": {
        s += "[assistant] ";
        if (m.content != null) s += m.content;
        for (const tc of m.tool_calls ?? []) {
          s += ` <call ${tc.name}(${compactArgs(tc.arguments)})>`;
        }
        s += "\n";
        break;
      }
      case "tool":
        s += `[tool ${m.tool_call_id}] ${m.content}\n`;
        break;
    }
  }
  return s;
}

function compactArgs(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Conservative preamble stripper for summariser output. Smaller models often
 * leak a "The user wants me to summarise..." opener that eats the cache slot
 * before the substantive content. We look for a known opener and, if found,
 * skip past the first paragraph break (`\n\n`). When no clear preamble is
 * present, or no paragraph break exists within budget, return the input
 * unchanged — better to keep a borderline first sentence than amputate
 * real content. Mirrors the Rust `strip_summary_preamble`.
 */
export function stripSummaryPreamble(text: string): string {
  const OPENERS = [
    "the user wants me to",
    "the user is asking",
    "the user has asked",
    "the user asked me to",
    "i'll summari",
    "i will summari",
    "let me summari",
    "here is a summary",
    "here's a summary",
    "this excerpt",
    "this conversation excerpt",
    "the conversation excerpt",
  ];
  // Window large enough for the opener but cheap to lowercase. Use the
  // codepoint-aware iterator so multi-byte leads don't desync (matches Rust's
  // `chars().take(40)`).
  const window = takeChars(text, 40).toLowerCase();
  if (!OPENERS.some((opener) => window.startsWith(opener))) return text;

  // Find the first paragraph break within a generous budget. If none, bail.
  const SCAN_BUDGET = 800;
  const head = takeChars(text, SCAN_BUDGET);
  const rel = head.indexOf("\n\n");
  if (rel >= 0) {
    const after = text.slice(rel + 2);
    const trimmed = after.replace(/^\s+/, "");
    if (trimmed !== "") return trimmed;
  }
  return text;
}

/** First `n` Unicode scalar values of `s` (matches Rust's `chars().take(n)`). */
function takeChars(s: string, n: number): string {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i++;
  }
  return out;
}

/**
 * Best-effort token-budget enforcement: if the compacted output still exceeds
 * `maxTokens`, drop turns from the oldest end while preserving the leading
 * system prefix and the most recent turn. Two rounds — first the oldest 20% of
 * non-latest turns, then everything except the latest — each followed by a
 * marker. Never throws; returns the input untouched when no pruning is needed.
 * Mirrors the Rust `enforce_token_budget` (the trailing working-context region
 * recognition is kept for parity even though that block isn't emitted yet).
 */
export function enforceTokenBudget(
  out: Message[],
  maxTokens: number,
  est: TokenEstimator,
): { out: Message[]; outcome: PtlOutcome } {
  if (maxTokens === 0 || estimateMessages(est, out) <= maxTokens) {
    return { out, outcome: "none" };
  }

  // Region 1: leading contiguous system messages (kept verbatim, including any
  // compaction summary we just inserted).
  let prefixEnd = 0;
  while (prefixEnd < out.length && out[prefixEnd]!.role === "system") prefixEnd++;

  // Region 3 (trailing): a working-context block, recognised by header.
  const last = out[out.length - 1];
  const trailing =
    last !== undefined && last.role === "system" && last.content.startsWith("=== working context ===")
      ? 1
      : 0;

  // Region 2: body where the turns live.
  const bodyStart = prefixEnd;
  const bodyEnd = out.length - trailing;
  if (bodyEnd <= bodyStart) return { out, outcome: "none" };

  const turnStarts: number[] = [];
  for (let i = bodyStart; i < bodyEnd; i++) {
    if (out[i]!.role === "user") turnStarts.push(i);
  }
  if (turnStarts.length <= 1) {
    // Only the latest turn is droppable, but the spec keeps it.
    return { out, outcome: "none" };
  }

  // Round 1: drop the oldest 20% of non-latest turns (round up, min 1).
  const droppableTurns = turnStarts.length - 1;
  let dropN = Math.max(Math.ceil(droppableTurns / 5), 1);
  if (dropN >= droppableTurns) dropN = droppableTurns; // never include the latest turn
  const cutAt = turnStarts[dropN]!;

  const pruned: Message[] = [
    ...out.slice(0, prefixEnd),
    ptlMarker(dropN),
    ...out.slice(cutAt, bodyEnd),
    ...out.slice(bodyEnd), // trailing working context
  ];
  if (estimateMessages(est, pruned) <= maxTokens) {
    return { out: pruned, outcome: "round-one" };
  }

  // Round 2: hard-prune to the latest turn only. Over-budget is preferable to
  // truncating the turn the user is actively interacting with.
  const lastTurnStart = turnStarts[turnStarts.length - 1]!;
  const droppedTotal = turnStarts.length - 1;
  const hard: Message[] = [
    ...out.slice(0, prefixEnd),
    ptlMarker(droppedTotal),
    ...out.slice(lastTurnStart, bodyEnd),
    ...out.slice(bodyEnd),
  ];
  return { out: hard, outcome: "round-two" };
}

function ptlMarker(dropped: number): Message {
  return systemMessage(`[${dropped} earlier turn(s) truncated to fit token budget]`);
}
