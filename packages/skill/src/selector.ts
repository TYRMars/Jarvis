// Auto-activation scorer.
//
// Ported from crates/harness-skill/src/selector.rs.
//
// Picks the top-K skills (by relevance to the user's most recent message) for
// which `activation` is `auto` or `both`. The score is intentionally cheap —
// just keyword + description-token overlap, no LLM round-trip — so it's safe
// to run on every turn.
import type { SkillCatalog } from "./catalog.ts";
import type { SkillActivation } from "./manifest.ts";
import { anyGlobMatches } from "./path-match.ts";

const KEYWORD_WEIGHT = 4;
const DESC_TOKEN_WEIGHT = 1;
const NAME_TOKEN_WEIGHT = 2;
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "have", "from", "you", "use", "are", "is", "to",
  "a", "of", "in", "on", "or", "an", "be", "it", "at", "as", "we",
]);

/**
 * Score one skill against a token set. Higher = better match. Skills not
 * eligible for auto-activation (`activation === "manual"`) score 0
 * unconditionally. `queryTokens` is the output of {@link queryTokenSet}.
 */
export function scoreSkill(
  name: string,
  description: string,
  keywords: readonly string[],
  activation: SkillActivation,
  queryTokens: ReadonlySet<string>,
): number {
  if (activation === "manual") return 0;
  let score = 0;

  // Keyword hits dominate — these are the curator's signal.
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    const kwLc = kw.toLowerCase();
    // Non-ASCII keywords (e.g. CJK) can't be tokenised into the query token
    // set the same way, so they match as a substring of any query token.
    const substringMatch = !isAscii(kwLc) && [...queryTokens].some((tok) => tok.includes(kwLc));
    if (substringMatch) {
      score += KEYWORD_WEIGHT;
      continue;
    }
    // Multi-word keywords match if every word is in the query.
    const parts = kwLc.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 0 && parts.every((p) => queryTokens.has(p))) {
      score += KEYWORD_WEIGHT;
    }
  }

  // Name-token overlap (e.g. `pdf-helper` ⇒ tokens `pdf`, `helper`).
  for (const tok of tokenize(name)) {
    if (STOPWORDS.has(tok)) continue;
    if (queryTokens.has(tok)) score += NAME_TOKEN_WEIGHT;
  }

  // Description tokens contribute weakly. Drop stopwords + 1-char tokens.
  for (const tok of tokenize(description)) {
    if (tok.length <= 1 || STOPWORDS.has(tok)) continue;
    if (queryTokens.has(tok)) score += DESC_TOKEN_WEIGHT;
  }

  return score;
}

/**
 * Pick at most `topK` skills from `catalog` whose auto-activation is
 * permitted, ranked by {@link scoreSkill} against `query`. `exclude` hides
 * names that are already active manually.
 *
 * Returns names in descending-score order; ties break by name to keep output
 * stable. Skills with score 0 are dropped.
 */
export function pickAutoSkills(
  catalog: SkillCatalog,
  query: string,
  topK: number,
  exclude: readonly string[],
): string[] {
  if (topK === 0 || query.trim().length === 0) return [];
  const excludeSet = new Set(exclude);
  const queryTokens = queryTokenSet(query);
  const scored: Array<[number, string]> = [];
  for (const entry of catalog.entries()) {
    const name = entry.manifest.name;
    if (excludeSet.has(name)) continue;
    const s = scoreSkill(
      name,
      entry.manifest.description,
      entry.manifest.keywords,
      entry.manifest.activation,
      queryTokens,
    );
    if (s > 0) scored.push([s, name]);
  }
  // Sort: score desc, then name asc for stable order.
  scored.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.slice(0, topK).map(([, n]) => n);
}

/**
 * Pick skills whose `paths` glob matches any of `recentPaths`.
 *
 * Independent from {@link pickAutoSkills}: where that one matches against the
 * user's message text, this matches against the workspace-relative paths the
 * agent has recently touched. `manualActive` is the "already-on" set used for
 * dedup. `topK` caps the result.
 *
 * Iteration follows the catalog's deterministic name order, so the
 * `topK`-truncated result is stable across runs.
 */
export function pickPathMatchSkills(
  catalog: SkillCatalog,
  recentPaths: readonly string[],
  topK: number,
  manualActive: readonly string[],
): string[] {
  if (recentPaths.length === 0 || topK === 0) return [];
  const manual = new Set(manualActive);
  const picks: string[] = [];
  for (const entry of catalog.entries()) {
    if (entry.manifest.activation === "manual") continue;
    if (entry.manifest.paths.length === 0) continue;
    if (manual.has(entry.manifest.name)) continue;
    const hit = recentPaths.some((p) => anyGlobMatches(entry.manifest.paths, p));
    if (hit) {
      picks.push(entry.manifest.name);
      if (picks.length >= topK) break;
    }
  }
  return picks;
}

/**
 * Token set for one query string. Lowercased, alphanumeric runs only,
 * stopwords + 1-char tokens removed. Public so callers that score against the
 * same set repeatedly can build it once.
 */
export function queryTokenSet(s: string): Set<string> {
  return new Set(tokenize(s).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

/**
 * Split into lowercased alphanumeric runs. "Alphanumeric" is Unicode-aware
 * (matches Rust `char::is_alphanumeric`), so CJK characters are kept and a
 * CJK run becomes a single token. Punctuation / whitespace are separators.
 */
function tokenize(s: string): string[] {
  const lower = s.toLowerCase();
  const out: string[] = [];
  let cur = "";
  for (const ch of lower) {
    if (isAlphanumeric(ch)) {
      cur += ch;
    } else if (cur.length > 0) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Unicode-aware alphanumeric test over a single code point (string of len ≥ 1). */
function isAlphanumeric(ch: string): boolean {
  // `\p{L}` letters + `\p{N}` numbers — the Unicode-property equivalent of
  // Rust's `char::is_alphanumeric`. `u` flag enables the property escapes.
  return /[\p{L}\p{N}]/u.test(ch);
}

/** True when every code unit is in the ASCII range (mirrors Rust `str::is_ascii`). */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
