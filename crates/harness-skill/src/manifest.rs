//! `SKILL.md` manifest parsing.
//!
//! A SKILL.md file is two halves separated by a `---\n` fence:
//!
//! ```markdown
//! ---
//! name: code-review
//! description: Review a diff for bugs, taste, and missing tests.
//! activation: both
//! keywords: [review, diff, pr]
//! ---
//!
//! When the user pastes a diff or asks for a code review, …
//! ```
//!
//! Only the frontmatter is structured; the body is opaque markdown
//! that gets prepended to the system prompt verbatim when the Skill
//! is activated. The parser is permissive on body shape but strict
//! on frontmatter (unknown fields rejected so typos surface early).

use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_DESCRIPTION_BYTES: usize = 1024;

/// Errors that come out of parsing a SKILL.md.
#[derive(Debug, Error)]
pub enum SkillError {
    #[error("missing leading frontmatter fence (`---` on first line)")]
    NoFrontmatter,
    #[error("unterminated frontmatter (no closing `---`)")]
    UnterminatedFrontmatter,
    #[error("invalid frontmatter YAML: {0}")]
    InvalidYaml(String),
    #[error("missing required field `{0}`")]
    MissingField(&'static str),
    #[error("invalid skill name `{0}` (must be kebab-case `[a-z0-9-]+`, 1..=64 chars)")]
    InvalidName(String),
    #[error("description exceeds {limit} bytes")]
    DescriptionTooLong { limit: usize },
}

/// When a skill should be considered for injection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SkillActivation {
    /// Only activated when the user explicitly toggles it on.
    Manual,
    /// Eligible for automatic injection (intent-match or always-on).
    Auto,
    /// Both manual and auto pathways apply.
    #[default]
    Both,
}

/// Parsed contents of a SKILL.md frontmatter block.
///
/// The body is held alongside the manifest in [`Skill`] (see
/// `catalog.rs`); this struct only models the YAML half so the
/// parser stays decoupled from the on-disk path / source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillManifest {
    /// Unique kebab-case identifier. Used as the URL-safe key in
    /// the API and the dir name on disk.
    pub name: String,
    /// One-paragraph description. ≤ 1024 chars; long enough for an
    /// LLM to decide when the skill applies, short enough to ship
    /// in a system-prompt index.
    pub description: String,
    /// SPDX license id. Free-form; informational only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Tools the skill expects to call. Empty / absent = inherit.
    /// Today this is metadata only; the harness's permission
    /// engine is the canonical gate.
    #[serde(
        default,
        rename = "allowed-tools",
        alias = "allowed_tools",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub allowed_tools: Vec<String>,
    /// Activation hint. See [`SkillActivation`].
    #[serde(default)]
    pub activation: SkillActivation,
    /// Optional keyword bag. Used by the auto-activation matcher to
    /// boost relevance beyond the description text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Free-form version string. Display-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Outcome of parsing a SKILL.md text: structured manifest + the
/// markdown body to prepend to the system prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkill {
    pub manifest: SkillManifest,
    pub body: String,
}

/// Split a SKILL.md text into (frontmatter, body) and parse the
/// frontmatter as YAML. The body is returned verbatim with leading
/// blank lines after the closing fence stripped.
pub fn parse_skill(text: &str) -> Result<ParsedSkill, SkillError> {
    let trimmed = text.trim_start_matches('\u{feff}'); // BOM
    let rest = trimmed
        .strip_prefix("---\n")
        .or_else(|| trimmed.strip_prefix("---\r\n"))
        .ok_or(SkillError::NoFrontmatter)?;
    let (yaml, body) = split_at_close_fence(rest).ok_or(SkillError::UnterminatedFrontmatter)?;
    let manifest: SkillManifest =
        serde_yaml::from_str(yaml).map_err(|e| SkillError::InvalidYaml(e.to_string()))?;
    validate_manifest(&manifest)?;
    let body = body
        .trim_start_matches('\n')
        .trim_start_matches('\r')
        .to_string();
    Ok(ParsedSkill { manifest, body })
}

fn split_at_close_fence(s: &str) -> Option<(&str, &str)> {
    // Walk lines until we hit a `---` line on its own.
    let bytes = s.as_bytes();
    let mut start = 0usize;
    while start < bytes.len() {
        let nl = bytes[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| start + i)
            .unwrap_or(bytes.len());
        let line = &s[start..nl];
        let trimmed = line.trim_end_matches('\r');
        if trimmed == "---" {
            let yaml = &s[..start];
            let body_start = (nl + 1).min(s.len());
            return Some((yaml, &s[body_start..]));
        }
        if nl == bytes.len() {
            return None;
        }
        start = nl + 1;
    }
    None
}

fn validate_manifest(m: &SkillManifest) -> Result<(), SkillError> {
    if m.name.is_empty() {
        return Err(SkillError::MissingField("name"));
    }
    if !is_kebab_name(&m.name) {
        return Err(SkillError::InvalidName(m.name.clone()));
    }
    if m.description.is_empty() {
        return Err(SkillError::MissingField("description"));
    }
    if m.description.len() > MAX_DESCRIPTION_BYTES {
        return Err(SkillError::DescriptionTooLong {
            limit: MAX_DESCRIPTION_BYTES,
        });
    }
    Ok(())
}

fn is_kebab_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    if s.starts_with('-') || s.ends_with('-') {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_skill() {
        let text = "---\nname: hello\ndescription: Says hi.\n---\n\nBody goes here.";
        let parsed = parse_skill(text).unwrap();
        assert_eq!(parsed.manifest.name, "hello");
        assert_eq!(parsed.manifest.description, "Says hi.");
        assert_eq!(parsed.manifest.activation, SkillActivation::Both);
        assert!(parsed.manifest.keywords.is_empty());
        assert_eq!(parsed.body, "Body goes here.");
    }

    #[test]
    fn parses_full_frontmatter() {
        let text = "---\nname: code-review\ndescription: review diffs.\nlicense: MIT\nactivation: auto\nallowed-tools: [\"fs.read\", \"git.diff\"]\nkeywords: [diff, pr, review]\nversion: \"0.1.0\"\n---\nBody.";
        let p = parse_skill(text).unwrap();
        assert_eq!(p.manifest.activation, SkillActivation::Auto);
        assert_eq!(p.manifest.allowed_tools, vec!["fs.read", "git.diff"]);
        assert_eq!(p.manifest.keywords, vec!["diff", "pr", "review"]);
        assert_eq!(p.manifest.version.as_deref(), Some("0.1.0"));
        assert_eq!(p.manifest.license.as_deref(), Some("MIT"));
    }

    #[test]
    fn rejects_missing_frontmatter() {
        let text = "no frontmatter here";
        assert!(matches!(parse_skill(text), Err(SkillError::NoFrontmatter)));
    }

    #[test]
    fn rejects_unterminated_frontmatter() {
        let text = "---\nname: x\ndescription: y\nstill yaml";
        assert!(matches!(
            parse_skill(text),
            Err(SkillError::UnterminatedFrontmatter)
        ));
    }

    #[test]
    fn rejects_unknown_field() {
        let text = "---\nname: x\ndescription: y\nzzz: 1\n---\nbody";
        let err = parse_skill(text).unwrap_err();
        assert!(matches!(err, SkillError::InvalidYaml(_)));
    }

    #[test]
    fn rejects_invalid_name() {
        let text = "---\nname: Bad_Name\ndescription: y\n---\nbody";
        assert!(matches!(parse_skill(text), Err(SkillError::InvalidName(_))));
    }

    #[test]
    fn rejects_long_description() {
        let long = "x".repeat(MAX_DESCRIPTION_BYTES + 1);
        let text = format!("---\nname: x\ndescription: {long}\n---\nbody");
        assert!(matches!(
            parse_skill(&text),
            Err(SkillError::DescriptionTooLong { .. })
        ));
    }

    #[test]
    fn accepts_alias_allowed_tools_underscore() {
        let text = "---\nname: x\ndescription: y\nallowed_tools: [a, b]\n---\nbody";
        let p = parse_skill(text).unwrap();
        assert_eq!(p.manifest.allowed_tools, vec!["a", "b"]);
    }
}
