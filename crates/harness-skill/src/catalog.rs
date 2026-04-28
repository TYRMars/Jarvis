//! Disk-scanning skill catalog.
//!
//! Walks one or more "skill roots" (e.g. `~/.config/jarvis/skills`,
//! `<workspace>/.jarvis/skills`). Each subdirectory of a root is a
//! skill: reading `<dir>/SKILL.md` produces one [`SkillEntry`].
//! Project-scope entries shadow user-scope entries with the same
//! `name`; merge order is the order roots are passed to
//! [`SkillCatalog::load`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tracing::{debug, warn};

use crate::manifest::{parse_skill, ParsedSkill, SkillManifest};

const SKILL_FILE: &str = "SKILL.md";

/// Where this skill came from. Drives display labels and the
/// "project-shadows-user" precedence in [`SkillCatalog::load`].
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum SkillSource {
    /// User-scope: `~/.config/jarvis/skills/...`.
    User,
    /// Project-scope: `<workspace>/.jarvis/skills/...`.
    Workspace,
    /// Came from an installed plugin (set by the plugin manager
    /// when it adds skills out of `plugin.json`).
    Plugin,
}

/// One skill in the catalog.
#[derive(Debug, Clone, Serialize)]
pub struct SkillEntry {
    pub manifest: SkillManifest,
    pub body: String,
    /// Absolute path to the source `SKILL.md`. Useful for the UI's
    /// "open in editor" affordance and for `jarvis skill show`.
    pub path: PathBuf,
    pub source: SkillSource,
}

impl SkillEntry {
    pub fn name(&self) -> &str {
        &self.manifest.name
    }
}

/// In-memory catalog. Lookup by `name`; iteration is sorted by
/// `name` so the API list / Settings UI is deterministic.
#[derive(Debug, Default, Clone)]
pub struct SkillCatalog {
    by_name: BTreeMap<String, SkillEntry>,
}

impl SkillCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan the given (root, source) pairs in order; later entries
    /// with the same `name` win (project shadows user).
    pub fn load<I>(roots: I) -> Self
    where
        I: IntoIterator<Item = (PathBuf, SkillSource)>,
    {
        let mut by_name: BTreeMap<String, SkillEntry> = BTreeMap::new();
        for (root, source) in roots {
            let entries = scan_root(&root, source);
            for entry in entries {
                let key = entry.manifest.name.clone();
                let shadowed = by_name.insert(key.clone(), entry).is_some();
                if shadowed {
                    debug!(
                        name = %key,
                        root = %root.display(),
                        source = ?source,
                        "skill shadowed by later root",
                    );
                }
            }
        }
        Self { by_name }
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&SkillEntry> {
        self.by_name.get(name)
    }

    /// All entries, deterministically ordered by name.
    pub fn entries(&self) -> impl Iterator<Item = &SkillEntry> {
        self.by_name.values()
    }

    /// Insert / replace an entry programmatically — used by the
    /// plugin manager when it wires installed skills in.
    pub fn insert(&mut self, entry: SkillEntry) {
        self.by_name.insert(entry.manifest.name.clone(), entry);
    }

    /// Remove a skill by name. Returns `true` if present.
    pub fn remove(&mut self, name: &str) -> bool {
        self.by_name.remove(name).is_some()
    }
}

fn scan_root(root: &Path, source: SkillSource) -> Vec<SkillEntry> {
    let read = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(e) => {
            // Not-found is the usual case for an unconfigured user.
            // Permission errors are worth a warn so operators notice.
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(path = %root.display(), error = %e, "skill root unreadable");
            }
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let skill_md = path.join(SKILL_FILE);
        if !skill_md.is_file() {
            continue;
        }
        match load_skill(&skill_md, source) {
            Ok(s) => out.push(s),
            Err(e) => warn!(path = %skill_md.display(), error = %e, "skipping skill"),
        }
    }
    out
}

fn load_skill(path: &Path, source: SkillSource) -> Result<SkillEntry, LoadError> {
    let text = std::fs::read_to_string(path).map_err(LoadError::Io)?;
    let ParsedSkill { manifest, body } = parse_skill(&text).map_err(LoadError::Parse)?;
    Ok(SkillEntry {
        manifest,
        body,
        path: path.to_path_buf(),
        source,
    })
}

#[derive(Debug, thiserror::Error)]
enum LoadError {
    #[error("io: {0}")]
    Io(std::io::Error),
    #[error("parse: {0}")]
    Parse(crate::manifest::SkillError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, frontmatter: &str, body: &str) {
        let d = dir.join(name);
        fs::create_dir_all(&d).unwrap();
        let text = format!("---\n{frontmatter}---\n{body}");
        fs::write(d.join(SKILL_FILE), text).unwrap();
    }

    #[test]
    fn loads_skills_from_one_root() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "alpha", "name: alpha\ndescription: a\n", "Body A");
        write(tmp.path(), "beta", "name: beta\ndescription: b\n", "Body B");
        let cat = SkillCatalog::load([(tmp.path().to_path_buf(), SkillSource::User)]);
        assert_eq!(cat.len(), 2);
        let names: Vec<&str> = cat.entries().map(|e| e.name()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(cat.get("alpha").unwrap().body, "Body A");
    }

    #[test]
    fn workspace_shadows_user() {
        let user = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write(user.path(), "shared", "name: shared\ndescription: user one\n", "USER");
        write(project.path(), "shared", "name: shared\ndescription: project one\n", "PROJECT");

        let cat = SkillCatalog::load([
            (user.path().to_path_buf(), SkillSource::User),
            (project.path().to_path_buf(), SkillSource::Workspace),
        ]);
        let entry = cat.get("shared").unwrap();
        assert_eq!(entry.source, SkillSource::Workspace);
        assert_eq!(entry.body, "PROJECT");
    }

    #[test]
    fn skips_non_skill_dirs_and_bad_skills() {
        let tmp = tempfile::tempdir().unwrap();
        // Valid skill.
        write(tmp.path(), "good", "name: good\ndescription: g\n", "B");
        // Subdir without SKILL.md — silently ignored.
        fs::create_dir_all(tmp.path().join("noskill")).unwrap();
        // Skill with bad frontmatter — warns + skips.
        let bad = tmp.path().join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join(SKILL_FILE), "no frontmatter").unwrap();

        let cat = SkillCatalog::load([(tmp.path().to_path_buf(), SkillSource::User)]);
        assert_eq!(cat.len(), 1);
        assert!(cat.get("good").is_some());
    }

    #[test]
    fn missing_root_is_silent() {
        let cat = SkillCatalog::load([(
            PathBuf::from("/nonexistent/path/skills"),
            SkillSource::User,
        )]);
        assert!(cat.is_empty());
    }
}
