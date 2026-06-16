// @jarvis/skill — Anthropic-style Skills catalog.
//
// Ported from the harness-skill Rust crate. A *Skill* is a `SKILL.md` file:
// markdown body + a YAML frontmatter block (`name`, `description`,
// `activation`, `keywords`, `paths`, …). Skills are discovered on disk
// (per-user + per-workspace), loaded into a SkillCatalog, looked up by name,
// and either toggled on manually or picked automatically by the relevance
// selector. This package owns parsing + cataloguing + selection + the
// activation-state store; injection policy lives in the harness.

// ---------- manifest.ts (SKILL.md parsing + value types) ----------
export {
  type SkillManifest,
  type SkillActivation,
  type ParsedSkill,
  type SkillErrorKind,
  SkillParseError,
  DEFAULT_ACTIVATION,
  parseSkill,
} from "./manifest.ts";

// ---------- catalog.ts (disk-scanning catalog) ----------
export {
  type SkillSource,
  type SkillEntry,
  SkillCatalog,
  skillEntryName,
} from "./catalog.ts";

// ---------- path-match.ts (glob matcher for path-based activation) ----------
export { globMatches, anyGlobMatches } from "./path-match.ts";

// ---------- selector.ts (auto-activation scorer) ----------
export {
  scoreSkill,
  pickAutoSkills,
  pickPathMatchSkills,
  queryTokenSet,
} from "./selector.ts";

// ---------- store.ts (activation-state trait + value types) ----------
export {
  type Unsubscribe,
  type EventListener,
  type EventSource,
  type SkillActivationRecord,
  type SkillActivationEvent,
  type SkillStore,
  skillActivationEventScope,
} from "./store.ts";

// ---------- skill-store.ts (JsonFile + Memory backends) ----------
export { JsonFileSkillStore, MemorySkillStore } from "./skill-store.ts";
