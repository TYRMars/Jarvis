// v1.0 — long-running token-usage accumulator (separate from the
// per-turn `usage.ts`). Keeps daily buckets in `localStorage` so the
// "today / last 7 days" totals on the WorkOverview survive reloads
// without needing a server schema migration on `RequirementRun`.
//
// Limitations the UsagePanel surfaces honestly:
// - Per-browser only (each device tracks its own counts).
// - Provider-reported tokens vary in completeness; cached counts are
//   only present on providers that emit `cached_prompt_tokens`.
// - Cost is estimated from a hardcoded price table keyed by model
//   name. Unknown models report `null` cost (panel shows "—").

import { appStore } from "../store/appStore";

const STORAGE_KEY = "jarvis.usage.daily.v1";
/// Ring-buffer cap. We keep the last 90 daily buckets — enough for
/// the 90-day window selector + a little headroom. Older buckets get
/// pruned on every write.
const MAX_DAYS = 100;

interface UsageFrameLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  reasoning_tokens?: number;
}

export interface DailyBucket {
  /// `YYYY-MM-DD` (local timezone).
  date: string;
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  /// Number of `usage` frames added to this bucket. ≈ "LLM calls"
  /// (one per provider response).
  calls: number;
}

interface PersistedShape {
  buckets: DailyBucket[];
  /// Schema version for forward-compat — bump when the bucket
  /// shape changes so we drop bad data on read instead of crashing.
  version: 1;
}

// ---------- in-memory cache + subscriber set ----------------------

let buckets: DailyBucket[] = [];
let hydrated = false;
const subscribers = new Set<() => void>();

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed?.version !== 1 || !Array.isArray(parsed.buckets)) return;
    buckets = parsed.buckets
      .filter((b) => typeof b?.date === "string")
      // Defensive: coerce missing numerics to 0 so sums never NaN.
      .map((b) => ({
        date: b.date,
        prompt: b.prompt ?? 0,
        completion: b.completion ?? 0,
        cached: b.cached ?? 0,
        reasoning: b.reasoning ?? 0,
        calls: b.calls ?? 0,
      }));
  } catch {
    // Corrupt localStorage — start clean rather than crash.
    buckets = [];
  }
}

function persist(): void {
  try {
    const payload: PersistedShape = { version: 1, buckets };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / private-mode failures. The in-memory cache
    // still serves the dashboard for the rest of this session.
  }
}

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("usageCumulator subscriber threw", e);
    }
  }
}

function todayKey(): string {
  // Local date so the "today" bucket aligns with the user's wall
  // clock, not UTC. Keeps the daily reset feeling natural at
  // midnight local time.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------- public API --------------------------------------------

/// Add a usage frame to today's bucket. Called from the WS-frame
/// pipeline alongside the existing `recordUsage` so the long-term
/// totals stay in lockstep with the per-turn composer badge.
export function recordUsageDaily(ev: UsageFrameLike): void {
  hydrate();
  const today = todayKey();
  let bucket = buckets.find((b) => b.date === today);
  if (!bucket) {
    bucket = {
      date: today,
      prompt: 0,
      completion: 0,
      cached: 0,
      reasoning: 0,
      calls: 0,
    };
    buckets.push(bucket);
    // Keep only the most recent MAX_DAYS buckets, sorted ascending.
    buckets.sort((a, b) => a.date.localeCompare(b.date));
    if (buckets.length > MAX_DAYS) {
      buckets = buckets.slice(buckets.length - MAX_DAYS);
    }
  }
  if (typeof ev.prompt_tokens === "number") bucket.prompt += ev.prompt_tokens;
  if (typeof ev.completion_tokens === "number") bucket.completion += ev.completion_tokens;
  if (typeof ev.cached_prompt_tokens === "number") bucket.cached += ev.cached_prompt_tokens;
  if (typeof ev.reasoning_tokens === "number") bucket.reasoning += ev.reasoning_tokens;
  bucket.calls += 1;
  persist();
  notify();
}

export function listDailyBuckets(): DailyBucket[] {
  hydrate();
  return buckets.slice();
}

export interface WindowTotals {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  calls: number;
  /// Sum of `prompt + completion`. The headline "tokens used"
  /// figure — cached + reasoning are surfaced separately so the
  /// panel doesn't double-count.
  total: number;
}

export function totalsForWindow(days: number): WindowTotals {
  hydrate();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  const totals: WindowTotals = {
    prompt: 0,
    completion: 0,
    cached: 0,
    reasoning: 0,
    calls: 0,
    total: 0,
  };
  for (const b of buckets) {
    if (b.date < cutoffKey) continue;
    totals.prompt += b.prompt;
    totals.completion += b.completion;
    totals.cached += b.cached;
    totals.reasoning += b.reasoning;
    totals.calls += b.calls;
  }
  totals.total = totals.prompt + totals.completion;
  return totals;
}

/// Today's bucket only. Returns zero-valued bucket when nothing
/// recorded yet (so callers don't need null-check every field).
export function todaysTotals(): WindowTotals {
  hydrate();
  const today = todayKey();
  const b = buckets.find((x) => x.date === today);
  if (!b) {
    return { prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0, total: 0 };
  }
  return {
    prompt: b.prompt,
    completion: b.completion,
    cached: b.cached,
    reasoning: b.reasoning,
    calls: b.calls,
    total: b.prompt + b.completion,
  };
}

export function resetUsageHistory(): void {
  buckets = [];
  hydrated = true;
  persist();
  notify();
}

export function subscribeUsageCumulator(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// ---------- cost estimation ---------------------------------------

/// USD per 1M tokens for known providers. Conservative public rates;
/// users on Codex / Ollama see $0 since those flow under flat-rate
/// or local execution. Extend as needed — the panel falls back to
/// `null` (rendered as "—") for unknown models so a missing entry
/// is never a crash.
const PRICE_TABLE: Record<string, { in: number; out: number; cachedDiscount?: number }> = {
  // OpenAI
  "gpt-4o": { in: 5, out: 15 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4-turbo": { in: 10, out: 30 },
  "o1": { in: 15, out: 60 },
  "o1-mini": { in: 3, out: 12 },
  "o3-mini": { in: 1.1, out: 4.4 },
  "gpt-5.4-mini": { in: 0.25, out: 1.0 }, // codex flat-rate; estimate kept for "what would API cost"
  "gpt-5.4": { in: 2.5, out: 10 },
  // Anthropic
  "claude-3-5-sonnet-latest": { in: 3, out: 15 },
  "claude-3-5-sonnet-20241022": { in: 3, out: 15 },
  "claude-3-5-haiku-latest": { in: 0.8, out: 4 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  // Google
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  // Kimi
  "kimi-k2": { in: 0.6, out: 2.5 },
  "kimi-k2-thinking": { in: 0.6, out: 2.5 },
  "kimi-k2.6": { in: 0.6, out: 2.5 },
  "kimi-latest": { in: 0.6, out: 2.5 },
  "moonshot-v1-32k": { in: 1.7, out: 1.7 },
  "kimi-for-coding": { in: 0.6, out: 2.5 },
  // Ollama is local, no $.
};

/// Returns USD cost for the given prompt + completion + cached
/// counts under the given model. Returns `null` when the model
/// isn't in the table (UI shows "—" + a hint). Cached prompt tokens
/// are billed at 50% of the prompt rate (rough industry default;
/// override per-model via `cachedDiscount`).
export function estimateCostUSD(
  model: string,
  totals: { prompt: number; completion: number; cached: number },
): number | null {
  const price = PRICE_TABLE[model];
  if (!price) return null;
  const cachedDiscount = price.cachedDiscount ?? 0.5;
  const billablePrompt = Math.max(0, totals.prompt - totals.cached);
  const cost =
    (billablePrompt * price.in) / 1_000_000 +
    (totals.cached * price.in * cachedDiscount) / 1_000_000 +
    (totals.completion * price.out) / 1_000_000;
  return cost;
}

// ---------- store integration -------------------------------------
//
// Returns the active model the user is currently routing through, so
// the panel can label its cost estimate ("based on gpt-5.4-mini").
// Reads from the same `appStore` slice the ModelMenu writes to.

export function activeModelLabel(): string {
  const s = appStore.getState();
  // `routing` is stored as "<provider>|<model>"; empty string when
  // no override is set. Fall back to the default provider's default
  // model from the cached `providers` catalogue.
  const routing: string | undefined = s.routing;
  if (routing && routing.includes("|")) {
    return routing.split("|")[1] ?? "(unknown)";
  }
  const providers: Array<{ is_default?: boolean; default_model?: string }> | undefined =
    s.providers;
  const def = providers?.find((p) => p.is_default);
  return def?.default_model ?? "(unknown)";
}
