// Write-side guard against prompt injection / credential leakage — Phase 1.
//
// Ported from crates/harness-learning/src/lib.rs (`validate_memory_safe` and
// its four scanners). The spec's threat model: "长期记忆会进入提示词，因此写入
// 前必须扫描" — long-term memory is a high-trust surface (it lands in the
// system prompt next turn) so anything hinting at instruction-override,
// credential capture, or hidden-from-user directives is dropped at the store
// boundary. Higher layers turn the rejection into a tool error / 400.
//
// All free text the write controls is scanned: `title`, `body`, `tags`, and
// the serialized `attributes`. The latter two are agent/user-controlled,
// persisted, and can reach prompt context, so leaving them unscanned would
// fully bypass the guard.
//
// The Rust patterns are `(?i)`-prefixed (case-insensitive) and use ASCII `\b`
// word boundaries — both port to JS regex unchanged. The zh-CN patterns are
// literal CJK characters and need no special flags. Each `regex::Regex` →
// a JS `RegExp` built once at module load (the Rust `OnceLock` lazy compile).
import type { MemoryItem } from "./memory.ts";

// ---------- MemoryRejection ------------------------------------------------

/**
 * Reason a {@link MemoryItem} write was refused by {@link validateMemorySafe}.
 * Rust `MemoryRejection` (a `thiserror`-derived enum) → a discriminated union
 * on `reason`, each carrying an `Error`-shaped `message`.
 */
export type MemoryRejection =
  | { reason: "prompt_injection"; phrase: string; message: string }
  | { reason: "credential_likely"; hint: string; message: string }
  | { reason: "invisible_unicode"; codepoint: string; message: string }
  | { reason: "hide_from_user"; phrase: string; message: string }
  | { reason: "empty"; message: string }
  | { reason: "too_large"; total: number; cap: number; message: string };

/** Thrown by store wrappers that wrap {@link validateMemorySafe} into a throw. */
export class MemoryRejectionError extends Error {
  readonly rejection: MemoryRejection;
  constructor(rejection: MemoryRejection) {
    super(rejection.message);
    this.name = "MemoryRejectionError";
    this.rejection = rejection;
  }
}

/**
 * Hard cap on the byte size of `title + body` *after* per-field truncation.
 * Belt-and-suspenders: rejects pathological combinations that bypassed the
 * constructor caps (e.g. a row deserialized straight from a REST body).
 */
export const MEMORY_TOTAL_SAFETY_CAP = 8 * 1024;

/** Byte length of a UTF-8 string (mirrors Rust `str::len`). */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---------- pattern tables -------------------------------------------------

interface LabelledPattern {
  re: RegExp;
  label: string;
}

const PROMPT_INJECTION: readonly LabelledPattern[] = [
  // ignore / disregard / forget … (the/all) … (previous/above/prior) … (instructions)
  {
    re: /\b(?:ignore|disregard|forget|discard|skip|bypass)\b[\s\-_]+(?:(?:all|any|the|everything|every|your|these|those)[\s\-_]+){0,3}(?:previous|prior|above|preceding|earlier|foregoing|prior)(?:[\s\-_]+(?:instructions?|messages?|prompts?|rules?|directions?|guidelines?|constraints?|context|setup))?/i,
    label: "ignore previous instructions",
  },
  // "new instructions:" / "new system prompt" — fresh-directive injection.
  {
    re: /\bnew[\s\-_]+(?:instructions?|system[\s\-_]+prompt|rules?|directives?)\b/i,
    label: "new instructions",
  },
  // Role reassignment: "you are now …".
  { re: /\byou[\s\-_]+are[\s\-_]+now\b/i, label: "you are now" },
  // Role-play jailbreak: "act as a(n) {AI,assistant,DAN,unrestricted…}".
  {
    re: /\bact[\s\-_]+as[\s\-_]+(?:an?[\s\-_]+)?(?:ai|assistant|model|chatbot|dan|jailbreak\w*|unrestricted|unfiltered|evil|developer[\s\-_]+mode|root|admin)/i,
    label: "act as (role injection)",
  },
  // "pretend the above did not happen / pretend you are …".
  {
    re: /\bpretend\b[\s\-_]+(?:that[\s\-_]+)?(?:the[\s\-_]+)?(?:above|previous|earlier|prior|preceding|nothing|you[\s\-_]+are)/i,
    label: "pretend the above did not happen",
  },
  {
    re: /system[\s\-_]+prompt[\s\-_]+(?:override|injection|bypass|hijack|leak)/i,
    label: "system prompt override",
  },
  // zh-CN: 忽略/无视/不管/忽视 (+上面/之前/以上…) (+所有/全部) (+的) 指令/规则/命令/设定…
  {
    re: /(?:忽略|忽视|无视|不管|别管|不要管|无须理会|不必理会)(?:[上前]面|之前|以上|先前|上述|前述)?(?:所有|全部|一切)?的?(?:指令|指示|规则|提示|命令|设定|设置|要求|约束|限制|对话)/,
    label: "ignore previous instructions (zh-CN)",
  },
];

const CREDENTIAL_LIKE: readonly LabelledPattern[] = [
  // OpenAI-style API keys.
  { re: /\bsk-[A-Za-z0-9_\-]{20,}/, label: "sk-…" },
  // GitHub personal access tokens / fine-grained PATs.
  { re: /\bghp_[A-Za-z0-9]{20,}/, label: "ghp_…" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, label: "github_pat_…" },
  // AWS access key ids.
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AKIA…" },
  // Bearer-style auth headers.
  { re: /bearer\s+[A-Za-z0-9_\-.=]{20,}/i, label: "Bearer …" },
  // Explicit credential-grab commands — reading a dotenv / secret file.
  {
    re: /\b(?:cat|less|head|tail|source|copy|read|more|nano|vim|vi|emacs|open|type|cp|scp)\b[\s\-_]+\S*(?:\.env\b|credentials\b|id_rsa\b|id_ed25519\b|\.netrc\b|\.pgpass\b|\.npmrc\b|secrets?\.(?:json|ya?ml|txt|toml))/i,
    label: "read secret file",
  },
  // Dumping the environment (often to find a key).
  { re: /\bprintenv\b/i, label: "printenv" },
  { re: /\benv\b\s*\|\s*\b(?:grep|cat|less|sort)\b/i, label: "env | grep" },
  // Echoing / referencing a secret-shaped environment variable.
  {
    re: /\$\{?(?:[A-Za-z0-9_]*_)?(?:API_?KEY|ACCESS_?KEY|SECRET(?:_?[A-Za-z]+)?|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\b/i,
    label: "secret env var",
  },
  {
    re: /~\/\.(?:ssh|aws|kube|gnupg|config\/gh)\/[A-Za-z0-9_\-./]+/i,
    label: "personal secret path",
  },
];

const HIDE_FROM_USER: readonly LabelledPattern[] = [
  // don't / do not / never  tell|mention|inform|reveal|disclose … the user
  {
    re: /\b(?:don'?t|do[\s\-_]+not|never|avoid)\b[\s\-_]+(?:ever[\s\-_]+)?(?:tell|mention|inform|notify|reveal|disclose|alert|show)\b(?:[\s\-_]+(?:this|that|it|them|anything))?[\s\-_]+(?:to[\s\-_]+)?the[\s\-_]+user/i,
    label: "don't tell the user",
  },
  // hide / conceal / keep … from the user.
  {
    re: /\b(?:hide|conceal|keep)\b[\s\-_]+(?:this|that|it|them)?(?:[\s\-_]+(?:hidden|secret|away))?[\s\-_]*from[\s\-_]+the[\s\-_]+user/i,
    label: "hide from the user",
  },
  // without telling / informing / notifying the user.
  {
    re: /\bwithout[\s\-_]+(?:telling|informing|notifying|alerting|the[\s\-_]+user[\s\-_]+knowing)\b(?:[\s\-_]+the[\s\-_]+user)?/i,
    label: "without telling the user",
  },
  // Bare adverb — "secretly do X", "covertly".
  { re: /\b(?:secretly|covertly|surreptitiously)\b/i, label: "secretly" },
  // zh-CN: 不要告诉/不让…知道, 隐瞒/瞒着/背着 用户, 偷偷.
  {
    re: /不要告诉用户|不准告诉用户|别告诉用户|对用户隐瞒|隐瞒用户|瞒着用户|背着用户|不让用户(?:知道|发现|察觉)|偷偷/,
    label: "hide from user (zh-CN)",
  },
];

// ---------- scanners -------------------------------------------------------

function scanInvisibleUnicode(s: string): MemoryRejection | undefined {
  for (const ch of s) {
    // Allow common whitespace.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    const cp = ch.codePointAt(0) ?? 0;
    const banned =
      // Zero-width characters (most common smuggling vector).
      (cp >= 0x200b && cp <= 0x200f) ||
      // Line/paragraph separators that look like newlines but aren't.
      cp === 0x2028 ||
      cp === 0x2029 ||
      // Word joiner / BOM / interlinear annotation.
      (cp >= 0x2060 && cp <= 0x2064) ||
      cp === 0xfeff ||
      // Bidi controls.
      (cp >= 0x202a && cp <= 0x202e) ||
      // Tag characters — the trojan-text-encoding range.
      (cp >= 0xe0000 && cp <= 0xe007f);
    if (banned) {
      return invisible(cp);
    }
    // Reject all other C0/C1 control codes too.
    const isC0Control = cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
    const isC1Control = cp >= 0x7f && cp <= 0x9f;
    if (isC0Control || isC1Control) {
      return invisible(cp);
    }
  }
  return undefined;
}

function invisible(cp: number): MemoryRejection {
  const codepoint = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return {
    reason: "invisible_unicode",
    codepoint,
    message: `memory write rejected: invisible / control unicode (${codepoint})`,
  };
}

function scanPatterns(
  s: string,
  patterns: readonly LabelledPattern[],
  build: (label: string) => MemoryRejection,
): MemoryRejection | undefined {
  for (const { re, label } of patterns) {
    if (re.test(s)) return build(label);
  }
  return undefined;
}

// ---------- validateMemorySafe ---------------------------------------------

/**
 * Reject memory writes that look like prompt-injection, credential capture, or
 * hidden-from-user directives. Returns `undefined` when safe, or a structured
 * {@link MemoryRejection} describing the first failure. Mirrors Rust
 * `validate_memory_safe` (which returns `Result<(), MemoryRejection>`).
 *
 * Order of checks (kept identical to Rust so the same input yields the same
 * rejection variant): empty → oversized → invisible-unicode → prompt-injection
 * → credential → hide-from-user. The latter three scan the combined
 * `title\nbody[\ntags…][\nattributes]` string.
 */
export function validateMemorySafe(item: MemoryItem): MemoryRejection | undefined {
  const title = item.title.trim();
  const body = item.body.trim();
  if (title === "" || body === "") {
    return { reason: "empty", message: "memory write rejected: empty title or body after trim" };
  }
  const total = utf8Len(title) + utf8Len(body);
  if (total > MEMORY_TOTAL_SAFETY_CAP) {
    return {
      reason: "too_large",
      total,
      cap: MEMORY_TOTAL_SAFETY_CAP,
      message: `memory write rejected: oversized after concatenation (${total}-byte total > ${MEMORY_TOTAL_SAFETY_CAP}-byte cap)`,
    };
  }

  // `tags` and `attributes` are agent/user-controlled and persisted, then
  // surface in the UI and can reach prompt context — scan them too. Scanning
  // after the title/body checks keeps the common-case rejection ordering. The
  // serialized `attributes` form is lossy for structure but every string value
  // (the only place an injection/credential can hide) is present verbatim.
  let combined = `${title}\n${body}`;
  if (item.tags.length > 0) {
    combined += "\n" + item.tags.join("\n");
  }
  if (item.attributes !== null) {
    combined += "\n" + JSON.stringify(item.attributes);
  }

  return (
    scanInvisibleUnicode(combined) ??
    scanPatterns(combined, PROMPT_INJECTION, (phrase) => ({
      reason: "prompt_injection",
      phrase,
      message: `memory write rejected: prompt-injection phrase detected (${phrase})`,
    })) ??
    scanPatterns(combined, CREDENTIAL_LIKE, (hint) => ({
      reason: "credential_likely",
      hint,
      message: `memory write rejected: looks like a credential or token (${hint})`,
    })) ??
    scanPatterns(combined, HIDE_FROM_USER, (phrase) => ({
      reason: "hide_from_user",
      phrase,
      message: `memory write rejected: explicit hide-from-user directive (${phrase})`,
    }))
  );
}
