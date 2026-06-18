// Difficulty classifiers. Ported from harness-router/src/classify.rs.
//
// P0 ships a zero-cost heuristic; the Classifier interface leaves room for a
// future LLM judge with the same shape (async so a judge can issue a cheap,
// timeout-bounded classification call).
import type { Tier } from "./tier.ts";

/**
 * Decides the Tier for a turn from its latest user message.
 *
 * Async so a future LLM-backed judge can issue a (cheap, timeout-bounded)
 * classification call; the heuristic impl simply returns without awaiting
 * anything real.
 */
export interface Classifier {
  classify(lastUserMessage: string): Promise<Tier>;
}

/**
 * ASCII keywords that bias a turn toward "complex". Matched case-insensitively
 * against WHOLE TOKENS of the lowercased message (split on non-alphanumeric
 * boundaries), so e.g. "implement" does not fire on "implementation" /
 * "implemented" and "design" does not fire on "redesigned" / "designer".
 * Substring matching here mis-routed trivial turns to the expensive "complex"
 * tier (see #89).
 */
const ASCII_COMPLEX_KEYWORDS: readonly string[] = [
  "refactor",
  "architecture",
  "debug",
  "implement",
  "benchmark",
  "optimize",
  "optimise",
  "design",
];

/**
 * CJK keywords that bias a turn toward "complex". CJK has no word boundaries,
 * so these are matched as substrings (`includes`) — and they are unaffected by
 * lowercasing, so they match verbatim.
 */
const CJK_COMPLEX_KEYWORDS: readonly string[] = ["重构", "架构", "分析", "设计", "优化", "调试", "实现"];

const ASCII_COMPLEX_SET = new Set(ASCII_COMPLEX_KEYWORDS);

/**
 * Whether `lower` (an already-lowercased message) carries a complexity
 * keyword: a whole-token ASCII match or a CJK substring match.
 *
 * The token split mirrors Rust's `split(|c| !c.is_alphanumeric())`. JS's
 * `\W` is ASCII-only and would split inside CJK runs, so we explicitly split
 * on any non-alphanumeric Unicode code point via a Unicode-aware regex (the
 * resulting empty tokens never match a keyword, matching Rust's behaviour).
 */
function hasComplexKeyword(lower: string): boolean {
  for (const token of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (ASCII_COMPLEX_SET.has(token)) return true;
  }
  return CJK_COMPLEX_KEYWORDS.some((k) => lower.includes(k));
}

export interface HeuristicConfig {
  /** Inclusive upper bound (chars) for the "simple" bucket. Default 48. */
  simpleMaxChars?: number;
  /**
   * Inclusive lower bound (chars) that forces "complex" regardless of
   * keywords — long prompts tend to carry multi-step intent. Default 600.
   */
  complexMinChars?: number;
}

/**
 * Zero-cost, no-LLM classifier. Routes by three cheap signals on the latest
 * user message:
 *
 *   * a fenced code block (```) or a complexity keyword (English + 中文)
 *     ⇒ "complex";
 *   * very short text (≤ simpleMaxChars) ⇒ "simple";
 *   * anything else ⇒ "medium".
 *
 * It never emits "reasoning" — that tier is reserved for the LLM judge. Empty
 * input is treated as "medium" (safe middle ground) rather than "simple",
 * since an empty trailing user message usually means a tool-driven
 * continuation, not a trivial ask.
 */
export class HeuristicClassifier implements Classifier {
  readonly simpleMaxChars: number;
  readonly complexMinChars: number;

  constructor(cfg: HeuristicConfig = {}) {
    this.simpleMaxChars = cfg.simpleMaxChars ?? 48;
    this.complexMinChars = cfg.complexMinChars ?? 600;
  }

  classify(lastUserMessage: string): Promise<Tier> {
    const text = lastUserMessage.trim();
    if (text === "") return Promise.resolve("medium");
    // Count Unicode code points (mirrors Rust `chars().count()`), not UTF-16
    // units, so a CJK turn isn't over-counted toward the "complex" threshold.
    const chars = [...text].length;
    const lower = text.toLowerCase();
    if (text.includes("```") || chars >= this.complexMinChars || hasComplexKeyword(lower)) {
      return Promise.resolve("complex");
    }
    if (chars <= this.simpleMaxChars) return Promise.resolve("simple");
    return Promise.resolve("medium");
  }
}
