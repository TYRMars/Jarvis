// `SKILL.md` manifest parsing.
//
// Ported from crates/harness-skill/src/manifest.rs.
//
// A SKILL.md file is two halves separated by a `---\n` fence:
//
//   ---
//   name: code-review
//   description: Review a diff for bugs, taste, and missing tests.
//   activation: both
//   keywords: [review, diff, pr]
//   ---
//
//   When the user pastes a diff or asks for a code review, …
//
// Only the frontmatter is structured; the body is opaque markdown that gets
// prepended to the system prompt verbatim when the Skill is activated. The
// parser is permissive on body shape but strict on frontmatter (unknown
// fields rejected so typos surface early).
import { parse as parseYaml } from "yaml";

const MAX_DESCRIPTION_BYTES = 1024;

/**
 * When a skill should be considered for injection. Rust `SkillActivation`,
 * `#[serde(rename_all = "kebab-case")]` — single-word variants stay lowercase.
 *
 * - `manual` — only activated when the user explicitly toggles it on.
 * - `auto`   — eligible for automatic injection (intent-match or always-on).
 * - `both`   — both manual and auto pathways apply (the `#[default]`).
 */
export type SkillActivation = "manual" | "auto" | "both";

/** The serde `#[default]` for {@link SkillActivation}. */
export const DEFAULT_ACTIVATION: SkillActivation = "both";

/**
 * Parsed contents of a SKILL.md frontmatter block.
 *
 * The body is held alongside the manifest in {@link SkillEntry} (see
 * catalog.ts); this struct only models the YAML half so the parser stays
 * decoupled from the on-disk path / source.
 *
 * Serde shape (`#[serde(deny_unknown_fields)]`): the optional fields are
 * omitted from the wire form when at their default (`skip_serializing_if`):
 * `license` / `version` absent when None; `allowed_tools` / `keywords` /
 * `paths` absent when empty; `activation` carries its default `both`.
 */
export interface SkillManifest {
  /**
   * Unique kebab-case identifier. Used as the URL-safe key in the API and the
   * dir name on disk. `[a-z0-9-]+`, 1..=64 chars, no leading/trailing `-`.
   */
  name: string;
  /**
   * One-paragraph description. ≤ 1024 bytes; long enough for an LLM to decide
   * when the skill applies, short enough to ship in a system-prompt index.
   */
  description: string;
  /** SPDX license id. Free-form; informational only. Absent when unset. */
  license?: string;
  /**
   * Tools the skill expects to call. Empty / absent = inherit. Metadata only;
   * the harness's permission engine is the canonical gate. Wire key is
   * `allowed-tools` (alias `allowed_tools` accepted on read).
   */
  allowed_tools: string[];
  /** Activation hint. See {@link SkillActivation}. */
  activation: SkillActivation;
  /**
   * Optional keyword bag. Used by the auto-activation matcher to boost
   * relevance beyond the description text.
   */
  keywords: string[];
  /** Free-form version string. Display-only. Absent when unset. */
  version?: string;
  /**
   * File-path globs that auto-activate this skill when the agent touches a
   * matching file in the current session. Empty / absent disables the
   * path-based trigger. Pattern semantics live in path-match.ts.
   */
  paths: string[];
}

/**
 * Outcome of parsing a SKILL.md text: structured manifest + the markdown body
 * to prepend to the system prompt.
 */
export interface ParsedSkill {
  manifest: SkillManifest;
  body: string;
}

/**
 * Error kinds out of {@link parseSkill}. Mirrors the Rust `SkillError` enum;
 * carried on a thrown {@link SkillParseError} so callers can branch on `kind`.
 */
export type SkillErrorKind =
  | "no_frontmatter"
  | "unterminated_frontmatter"
  | "invalid_yaml"
  | "missing_field"
  | "invalid_name"
  | "description_too_long";

/** Thrown by {@link parseSkill}. `kind` mirrors the Rust `SkillError` variant. */
export class SkillParseError extends Error {
  readonly kind: SkillErrorKind;

  constructor(kind: SkillErrorKind, message: string) {
    super(message);
    this.name = "SkillParseError";
    this.kind = kind;
  }
}

/**
 * Split a SKILL.md text into (frontmatter, body) and parse the frontmatter as
 * YAML. The body is returned verbatim with leading blank lines after the
 * closing fence stripped. Throws {@link SkillParseError} on any failure.
 */
export function parseSkill(text: string): ParsedSkill {
  const trimmed = stripLeadingBom(text); // BOM
  const rest = stripPrefix(trimmed, "---\n") ?? stripPrefix(trimmed, "---\r\n");
  if (rest === undefined) {
    throw new SkillParseError(
      "no_frontmatter",
      "missing leading frontmatter fence (`---` on first line)",
    );
  }
  const split = splitAtCloseFence(rest);
  if (!split) {
    throw new SkillParseError(
      "unterminated_frontmatter",
      "unterminated frontmatter (no closing `---`)",
    );
  }
  const [yaml, bodyRaw] = split;
  let raw: unknown;
  try {
    // `prettyErrors` keeps the message in line with serde_yaml's surface.
    raw = parseYaml(yaml);
  } catch (e) {
    throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: ${errText(e)}`);
  }
  const manifest = manifestFromYaml(raw);
  validateManifest(manifest);
  // Strip leading `\n` / `\r` run after the closing fence (Rust
  // `trim_start_matches('\n').trim_start_matches('\r')`).
  const body = bodyRaw.replace(/^\n*/, "").replace(/^\r*/, "");
  return { manifest, body };
}

/** Allow-list the known frontmatter keys (serde `deny_unknown_fields`). */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "allowed_tools",
  "activation",
  "keywords",
  "version",
  "paths",
]);

/**
 * Decode a parsed-YAML value into a {@link SkillManifest}, rejecting unknown
 * keys, wrong types, and bad enum values to mirror serde's strictness. Throws
 * {@link SkillParseError} (`invalid_yaml`) on any shape violation.
 */
function manifestFromYaml(raw: unknown): SkillManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SkillParseError("invalid_yaml", "invalid frontmatter YAML: expected a mapping");
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: unknown field \`${key}\``);
    }
  }
  // serde rejects the same field given twice; `allowed-tools` + its
  // `allowed_tools` alias both present is a duplicate.
  if ("allowed-tools" in obj && "allowed_tools" in obj) {
    throw new SkillParseError(
      "invalid_yaml",
      "invalid frontmatter YAML: duplicate field `allowed-tools`",
    );
  }

  const name = reqString(obj, "name");
  const description = reqString(obj, "description");
  const license = optString(obj, "license");
  const allowedRaw = "allowed-tools" in obj ? obj["allowed-tools"] : obj["allowed_tools"];
  const allowed_tools = stringArray(allowedRaw, "allowed-tools");
  const activation = activationFromYaml(obj["activation"]);
  const keywords = stringArray(obj["keywords"], "keywords");
  const version = optString(obj, "version");
  const paths = stringArray(obj["paths"], "paths");

  const manifest: SkillManifest = {
    name,
    description,
    allowed_tools,
    activation,
    keywords,
    paths,
  };
  if (license !== undefined) manifest.license = license;
  if (version !== undefined) manifest.version = version;
  return manifest;
}

function reqString(obj: Record<string, unknown>, key: string): string {
  // Rust `SkillManifest.{name,description}` are plain `String` with no
  // `#[serde(default)]`, so serde_yaml fails *during deserialization* for a
  // missing-or-null required field ("missing field `name`") — that surfaces as
  // `SkillError::InvalidYaml`, NOT `MissingField`. The `MissingField` branch in
  // `validate_manifest` only fires for an explicit empty string (`name: ""`),
  // which deserializes fine and then trips the `is_empty()` check. Mirror that
  // split here: absent/null → invalid_yaml; present-but-empty → fall through to
  // validateManifest (missing_field).
  if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
    throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: missing field \`${key}\``);
  }
  const v = obj[key];
  if (typeof v !== "string") {
    throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: field \`${key}\` must be a string`);
  }
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!(key in obj) || obj[key] === null || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") {
    throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: field \`${key}\` must be a string`);
  }
  return v;
}

function stringArray(v: unknown, key: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: field \`${key}\` must be a sequence`);
  }
  const out: string[] = [];
  for (const el of v) {
    if (typeof el !== "string") {
      throw new SkillParseError("invalid_yaml", `invalid frontmatter YAML: field \`${key}\` must be a sequence of strings`);
    }
    out.push(el);
  }
  return out;
}

function activationFromYaml(v: unknown): SkillActivation {
  if (v === undefined || v === null) return DEFAULT_ACTIVATION;
  if (v === "manual" || v === "auto" || v === "both") return v;
  throw new SkillParseError(
    "invalid_yaml",
    `invalid frontmatter YAML: unknown variant \`${String(v)}\`, expected one of \`manual\`, \`auto\`, \`both\``,
  );
}

function validateManifest(m: SkillManifest): void {
  if (m.name.length === 0) {
    throw new SkillParseError("missing_field", "missing required field `name`");
  }
  if (!isKebabName(m.name)) {
    throw new SkillParseError(
      "invalid_name",
      `invalid skill name \`${m.name}\` (must be kebab-case \`[a-z0-9-]+\`, 1..=64 chars)`,
    );
  }
  if (m.description.length === 0) {
    throw new SkillParseError("missing_field", "missing required field `description`");
  }
  // Rust caps `description.len()` — that's UTF-8 byte length.
  if (utf8Len(m.description) > MAX_DESCRIPTION_BYTES) {
    throw new SkillParseError(
      "description_too_long",
      `description exceeds ${MAX_DESCRIPTION_BYTES} bytes`,
    );
  }
}

/** Kebab-case name: `[a-z0-9-]+`, 1..=64 bytes, no leading/trailing `-`. */
function isKebabName(s: string): boolean {
  // Length is in bytes in Rust (`s.len()`); names are ASCII so chars == bytes,
  // but be exact and measure UTF-8.
  if (s.length === 0 || utf8Len(s) > 64) return false;
  if (s.startsWith("-") || s.endsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(s);
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function stripLeadingBom(s: string): string {
  // Rust `trim_start_matches('\u{feff}')` strips a run of BOMs.
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 0xfeff) i += 1;
  return i === 0 ? s : s.slice(i);
}

function stripPrefix(s: string, prefix: string): string | undefined {
  return s.startsWith(prefix) ? s.slice(prefix.length) : undefined;
}

/**
 * Walk lines of `s` until a line that is exactly `---` (trailing `\r`
 * tolerated). Returns `[yaml, body]` where `yaml` is everything before that
 * line and `body` is everything after its newline. `undefined` when no
 * closing fence is found. Mirrors Rust `split_at_close_fence`.
 */
function splitAtCloseFence(s: string): [string, string] | undefined {
  let start = 0;
  while (start < s.length) {
    let nl = s.indexOf("\n", start);
    if (nl === -1) nl = s.length;
    const line = s.slice(start, nl);
    const trimmed = line.replace(/\r+$/, "");
    if (trimmed === "---") {
      const yaml = s.slice(0, start);
      const bodyStart = Math.min(nl + 1, s.length);
      return [yaml, s.slice(bodyStart)];
    }
    if (nl === s.length) return undefined;
    start = nl + 1;
  }
  return undefined;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
