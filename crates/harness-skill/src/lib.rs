//! Skill catalog for the agent harness.
//!
//! A *Skill* is a markdown file with a YAML frontmatter block, in
//! the Anthropic style: `SKILL.md` with `name`, `description`, etc.
//! Skills are discovered on disk (per-user + per-workspace), loaded
//! into a [`SkillCatalog`], and looked up by name. The harness
//! injects a Skill's body into a per-session system prompt when the
//! Skill is activated; this crate stays out of that policy and only
//! owns parsing + cataloguing.
//!
//! Filesystem layout (resolution: explicit > `JARVIS_SKILLS_DIR` env >
//! per-source defaults):
//!
//! ```text
//! ~/.config/jarvis/skills/<name>/SKILL.md   # user-scope
//! <workspace>/.jarvis/skills/<name>/SKILL.md # project-scope (priority)
//! ```
//!
//! Project-scope entries with the same `name` shadow user-scope ones.

pub mod catalog;
pub mod manifest;
pub mod selector;

pub use catalog::{SkillCatalog, SkillEntry, SkillSource};
pub use manifest::{parse_skill, SkillActivation, SkillError, SkillManifest};
pub use selector::{pick_auto_skills, query_token_set, score_skill};
