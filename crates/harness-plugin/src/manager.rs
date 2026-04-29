//! Install / uninstall + ledger for plugins.
//!
//! Owns a `<plugins-root>` directory on disk. Each installed plugin
//! lives under `<plugins-root>/<name>/`; an `installed.json` ledger
//! at the root tracks install metadata so we can list / uninstall
//! without re-parsing every manifest.
//!
//! Mutating operations (`install_from_path`, `uninstall`) are
//! `async` because they delegate to the [`McpManager`] (which spawns
//! child processes) and to filesystem I/O. The internal lock surface
//! is a single `tokio::Mutex` over the in-memory ledger; no recursive
//! locking, no held guards across `.await`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use harness_mcp::{McpError, McpManager};
use harness_skill::{SkillCatalog, SkillEntry, SkillSource};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::manifest::{parse_plugin_manifest, PluginManifestError};

const LEDGER_FILE: &str = "installed.json";

#[derive(Debug, Error)]
pub enum PluginManagerError {
    #[error("plugin `{0}` is already installed")]
    AlreadyInstalled(String),
    #[error("plugin `{0}` is not installed")]
    NotInstalled(String),
    #[error("conflict: {kind} `{name}` is already registered (likely from a built-in or another plugin)")]
    Conflict { kind: &'static str, name: String },
    #[error("manifest: {0}")]
    Manifest(#[from] PluginManifestError),
    #[error("io: {0}")]
    Io(String),
    #[error("skill: {0}")]
    Skill(String),
    #[error("mcp: {0}")]
    Mcp(String),
}

impl From<std::io::Error> for PluginManagerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<McpError> for PluginManagerError {
    fn from(value: McpError) -> Self {
        Self::Mcp(value.to_string())
    }
}

/// What the manager records per installed plugin. Persisted to
/// `installed.json` so a fresh process can re-attach to running
/// plugins without re-parsing their manifests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub name: String,
    pub version: String,
    pub description: String,
    /// Absolute path to the installed copy
    /// (`<plugins-root>/<name>/`).
    pub install_dir: PathBuf,
    /// Where the plugin was originally installed from. `"path"`
    /// today; `"git"` reserved for future flavours.
    pub source_kind: String,
    pub source_value: String,
    pub installed_at: String, // RFC-3339
    /// Skill names the plugin contributed, so uninstall can pull
    /// them out of the catalog precisely.
    #[serde(default)]
    pub skill_names: Vec<String>,
    /// MCP prefixes the plugin owns, so uninstall can ask the
    /// `McpManager` to drop them.
    #[serde(default)]
    pub mcp_prefixes: Vec<String>,
}

/// Manager handle. Built once at startup; shared across the HTTP
/// router via `Arc`.
pub struct PluginManager {
    root: PathBuf,
    skills: Arc<RwLock<SkillCatalog>>,
    mcp: Arc<McpManager>,
    /// Outer mutex serialises mutating operations against the
    /// in-memory ledger. Read-only ops (`list`) take a brief lock.
    ledger: Mutex<BTreeMap<String, InstalledPlugin>>,
}

impl PluginManager {
    /// Build a manager pointed at `root`. Loads the ledger if
    /// present; absent file = empty ledger.
    pub fn new(
        root: PathBuf,
        skills: Arc<RwLock<SkillCatalog>>,
        mcp: Arc<McpManager>,
    ) -> Result<Self, PluginManagerError> {
        std::fs::create_dir_all(&root).ok();
        let ledger = read_ledger(&root)?;
        Ok(Self {
            root,
            skills,
            mcp,
            ledger: Mutex::new(ledger),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Snapshot of the install ledger.
    pub async fn list(&self) -> Vec<InstalledPlugin> {
        let g = self.ledger.lock().await;
        let mut out: Vec<InstalledPlugin> = g.values().cloned().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Look one up by name.
    pub async fn get(&self, name: &str) -> Option<InstalledPlugin> {
        self.ledger.lock().await.get(name).cloned()
    }

    /// Install from a local path. The directory must contain a
    /// `plugin.json` at its root.
    ///
    /// Steps (rolled back on any failure):
    /// 1. Parse manifest, validate identity, ensure not already installed.
    /// 2. Validate every shipped skill (path resolves, parses).
    /// 3. Conflict-check skill names + MCP prefixes against the live state.
    /// 4. Copy `<source>` → `<root>/<name>`.
    /// 5. Insert skills into the catalog with `source: Plugin`.
    /// 6. Add MCP servers to the manager.
    /// 7. Append entry to ledger and flush to disk.
    pub async fn install_from_path<P: AsRef<Path>>(
        &self,
        source: P,
    ) -> Result<PluginInstallReport, PluginManagerError> {
        let source = source.as_ref();
        let manifest_path = source.join("plugin.json");
        let text = std::fs::read_to_string(&manifest_path).map_err(|e| {
            PluginManagerError::Io(format!("read {}: {e}", manifest_path.display()))
        })?;
        let manifest = parse_plugin_manifest(&text)?;
        let name = manifest.name.clone();

        {
            let g = self.ledger.lock().await;
            if g.contains_key(&name) {
                return Err(PluginManagerError::AlreadyInstalled(name));
            }
        }

        // Pre-flight skill validation (parse every SKILL.md before
        // we copy anything). Each entry is held with `source:
        // Plugin`; insertion happens after the copy.
        let mut staged_skills: Vec<SkillEntry> = Vec::new();
        for rel in &manifest.skills {
            let abs = source.join(rel);
            let skill_md = if abs.is_dir() {
                abs.join("SKILL.md")
            } else {
                abs.clone()
            };
            let raw = std::fs::read_to_string(&skill_md)
                .map_err(|e| PluginManagerError::Io(format!("read {}: {e}", skill_md.display())))?;
            let parsed = harness_skill::parse_skill(&raw)
                .map_err(|e| PluginManagerError::Skill(format!("{}: {e}", skill_md.display())))?;
            staged_skills.push(SkillEntry {
                manifest: parsed.manifest,
                body: parsed.body,
                path: skill_md,
                source: SkillSource::Plugin,
            });
        }

        // Skill conflict check.
        {
            let cat = self
                .skills
                .read()
                .map_err(|e| PluginManagerError::Skill(format!("catalog poisoned: {e}")))?;
            for s in &staged_skills {
                if cat.get(&s.manifest.name).is_some() {
                    return Err(PluginManagerError::Conflict {
                        kind: "skill",
                        name: s.manifest.name.clone(),
                    });
                }
            }
        }

        // MCP conflict check (defer the actual add until after the
        // copy so failure paths stay clean).
        for prefix in manifest.mcp_servers.keys() {
            if self.mcp.get(prefix).await.is_some() {
                return Err(PluginManagerError::Conflict {
                    kind: "mcp prefix",
                    name: prefix.clone(),
                });
            }
        }

        // Copy plugin tree to <root>/<name>/.
        let install_dir = self.root.join(&name);
        if install_dir.exists() {
            // Stale leftover from a previous failed install — wipe
            // it to keep the install atomic from the user's POV.
            std::fs::remove_dir_all(&install_dir).map_err(|e| {
                PluginManagerError::Io(format!("rm stale {}: {e}", install_dir.display()))
            })?;
        }
        copy_tree(source, &install_dir)?;

        // Re-point staged skill paths at the installed copy so the
        // catalogue records the canonical post-install location.
        for s in &mut staged_skills {
            if let Ok(rel) = s.path.strip_prefix(source) {
                s.path = install_dir.join(rel);
            }
        }

        // Register skills.
        let mut added_skill_names: Vec<String> = Vec::new();
        {
            let mut cat = self
                .skills
                .write()
                .map_err(|e| PluginManagerError::Skill(format!("catalog poisoned: {e}")))?;
            for s in staged_skills {
                added_skill_names.push(s.manifest.name.clone());
                cat.insert(s);
            }
        }

        // Add MCP servers. If any add fails, roll back: pull added
        // ones, remove inserted skills, drop the install dir.
        let mut added_mcp: Vec<String> = Vec::new();
        for (prefix, cfg) in &manifest.mcp_servers {
            // Force prefix to match map key (also done in parser,
            // but defensive in case a future caller short-circuits).
            let mut cfg = cfg.clone();
            cfg.prefix = prefix.clone();
            if let Err(e) = self.mcp.add(cfg).await {
                self.rollback_partial(&added_skill_names, &added_mcp, &install_dir)
                    .await;
                return Err(PluginManagerError::Mcp(e.to_string()));
            }
            added_mcp.push(prefix.clone());
        }

        let entry = InstalledPlugin {
            name: name.clone(),
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            install_dir: install_dir.clone(),
            source_kind: "path".to_string(),
            source_value: source.display().to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            skill_names: added_skill_names.clone(),
            mcp_prefixes: added_mcp.clone(),
        };

        {
            let mut g = self.ledger.lock().await;
            g.insert(name.clone(), entry.clone());
            if let Err(e) = write_ledger(&self.root, &g) {
                // Ledger write failed — surface a warning but leave
                // the live registrations in place; `list` is best-
                // effort if the disk is misbehaving.
                warn!(error = %e, "ledger write failed after successful install");
            }
        }

        info!(
            plugin = %name,
            skills = added_skill_names.len(),
            mcp = added_mcp.len(),
            "plugin installed",
        );
        Ok(PluginInstallReport {
            plugin: entry,
            added_skills: added_skill_names,
            added_mcp,
        })
    }

    /// Uninstall a plugin by name. Pulls every skill / MCP server
    /// it owns, then deletes the install dir.
    pub async fn uninstall(&self, name: &str) -> Result<(), PluginManagerError> {
        let entry = {
            let mut g = self.ledger.lock().await;
            g.remove(name)
                .ok_or_else(|| PluginManagerError::NotInstalled(name.to_string()))?
        };
        // Pull MCP servers first so no in-flight tool call resolves
        // a tool whose backing client we're about to kill.
        for prefix in &entry.mcp_prefixes {
            if let Err(e) = self.mcp.remove(prefix).await {
                warn!(plugin = %name, %prefix, error = %e, "mcp remove failed during uninstall");
            }
        }
        if let Ok(mut cat) = self.skills.write() {
            for s in &entry.skill_names {
                cat.remove(s);
            }
        }
        if let Err(e) = std::fs::remove_dir_all(&entry.install_dir) {
            warn!(
                plugin = %name,
                path = %entry.install_dir.display(),
                error = %e,
                "rmdir failed; ledger entry already cleared",
            );
        }
        let g = self.ledger.lock().await;
        if let Err(e) = write_ledger(&self.root, &g) {
            warn!(error = %e, "ledger write failed after uninstall");
        }
        info!(plugin = %name, "plugin uninstalled");
        Ok(())
    }

    /// Re-attach to plugins recorded in the ledger. Called once at
    /// startup; for each entry, parse its manifest and re-register
    /// its skills + MCP servers without copying anything (the
    /// install dir already exists).
    pub async fn reattach_installed(&self) -> Result<(), PluginManagerError> {
        let entries: Vec<InstalledPlugin> = {
            let g = self.ledger.lock().await;
            g.values().cloned().collect()
        };
        for entry in entries {
            if let Err(e) = self.reattach_one(&entry).await {
                warn!(plugin = %entry.name, error = %e, "reattach failed; leaving ledger entry as-is");
            }
        }
        Ok(())
    }

    async fn reattach_one(&self, entry: &InstalledPlugin) -> Result<(), PluginManagerError> {
        let manifest_path = entry.install_dir.join("plugin.json");
        let text = std::fs::read_to_string(&manifest_path)?;
        let manifest = parse_plugin_manifest(&text)?;

        // Skills: re-load each one and insert.
        if let Ok(mut cat) = self.skills.write() {
            for rel in &manifest.skills {
                let abs = entry.install_dir.join(rel);
                let skill_md = if abs.is_dir() {
                    abs.join("SKILL.md")
                } else {
                    abs
                };
                let raw = std::fs::read_to_string(&skill_md)?;
                let parsed = harness_skill::parse_skill(&raw)
                    .map_err(|e| PluginManagerError::Skill(e.to_string()))?;
                cat.insert(SkillEntry {
                    manifest: parsed.manifest,
                    body: parsed.body,
                    path: skill_md,
                    source: SkillSource::Plugin,
                });
            }
        }

        // MCP: re-add each server. Failures are logged but not fatal —
        // we want the rest of the plugin to still come up.
        for (prefix, cfg) in manifest.mcp_servers {
            let mut cfg = cfg.clone();
            cfg.prefix = prefix.clone();
            if let Err(e) = self.mcp.add(cfg).await {
                warn!(plugin = %entry.name, %prefix, error = %e, "mcp add failed during reattach");
            }
        }
        info!(plugin = %entry.name, "plugin reattached");
        Ok(())
    }

    async fn rollback_partial(
        &self,
        skill_names: &[String],
        mcp_prefixes: &[String],
        install_dir: &Path,
    ) {
        if let Ok(mut cat) = self.skills.write() {
            for s in skill_names {
                cat.remove(s);
            }
        }
        for prefix in mcp_prefixes {
            let _ = self.mcp.remove(prefix).await;
        }
        if let Err(e) = std::fs::remove_dir_all(install_dir) {
            warn!(path = %install_dir.display(), error = %e, "rollback rmdir failed");
        }
    }
}

/// Result handed back to the HTTP / CLI caller after a successful
/// install. Includes the persisted ledger entry plus a flat list of
/// what the install actually added.
#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallReport {
    pub plugin: InstalledPlugin,
    pub added_skills: Vec<String>,
    pub added_mcp: Vec<String>,
}

fn read_ledger(root: &Path) -> Result<BTreeMap<String, InstalledPlugin>, PluginManagerError> {
    let path = root.join(LEDGER_FILE);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    let entries: Vec<InstalledPlugin> = serde_json::from_str(&text)
        .map_err(|e| PluginManagerError::Io(format!("parse {}: {e}", path.display())))?;
    Ok(entries.into_iter().map(|e| (e.name.clone(), e)).collect())
}

fn write_ledger(
    root: &Path,
    ledger: &BTreeMap<String, InstalledPlugin>,
) -> Result<(), PluginManagerError> {
    let path = root.join(LEDGER_FILE);
    let entries: Vec<&InstalledPlugin> = ledger.values().collect();
    let text = serde_json::to_string_pretty(&entries)
        .map_err(|e| PluginManagerError::Io(format!("serialize ledger: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), PluginManagerError> {
    std::fs::create_dir_all(dest)?;
    for entry in walkdir(source)? {
        let rel = entry.strip_prefix(source).unwrap_or(&entry);
        let target = dest.join(rel);
        let meta = std::fs::symlink_metadata(&entry)?;
        if meta.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if meta.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&entry, &target)?;
        }
        // Symlinks are skipped on purpose — we don't want to copy
        // dangling-or-targets-outside-the-plugin links into the
        // install dir.
    }
    Ok(())
}

fn walkdir(root: &Path) -> Result<Vec<PathBuf>, PluginManagerError> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        let meta = std::fs::symlink_metadata(&p)?;
        if meta.file_type().is_dir() {
            for entry in std::fs::read_dir(&p)? {
                let entry = entry?;
                stack.push(entry.path());
            }
            if p != root {
                out.push(p);
            }
        } else {
            out.push(p);
        }
    }
    Ok(out)
}

// Used by the wrapper crate's tests to construct a manager without
// going through tokio::spawn etc. Public so harness-server can use
// the same shape; not gated on `cfg(test)`.
//
// Tokio `Mutex` is used inside the manager so any caller already
// has an async runtime; the tests below set that up explicitly.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_skills_catalog() -> Arc<RwLock<SkillCatalog>> {
        Arc::new(RwLock::new(SkillCatalog::new()))
    }

    fn make_mcp_manager() -> Arc<McpManager> {
        let registry =
            Arc::new(std::sync::RwLock::new(harness_core::ToolRegistry::new()));
        Arc::new(McpManager::new(registry))
    }

    fn write_skill(dir: &Path, name: &str, frontmatter: &str, body: &str) {
        let d = dir.join(name);
        fs::create_dir_all(&d).unwrap();
        let text = format!("---\n{frontmatter}---\n{body}");
        fs::write(d.join("SKILL.md"), text).unwrap();
    }

    fn write_plugin(dir: &Path, manifest_json: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("plugin.json"), manifest_json).unwrap();
    }

    #[tokio::test]
    async fn install_records_skills_and_writes_ledger() {
        let staging = TempDir::new().unwrap();
        let plugin_src = staging.path().join("src");
        write_plugin(
            &plugin_src,
            r#"{
                "name": "demo",
                "version": "0.1.0",
                "description": "Demo plugin.",
                "skills": ["skills/hello"]
            }"#,
        );
        write_skill(
            &plugin_src.join("skills"),
            "hello",
            "name: hello\ndescription: Says hi.\n",
            "Body.",
        );

        let install_root = staging.path().join("plugins");
        let cat = make_skills_catalog();
        let mcp = make_mcp_manager();
        let mgr = PluginManager::new(install_root.clone(), cat.clone(), mcp).unwrap();

        let report = mgr.install_from_path(&plugin_src).await.unwrap();
        assert_eq!(report.added_skills, vec!["hello".to_string()]);
        assert!(install_root.join("demo").join("plugin.json").exists());
        assert!(install_root.join("installed.json").exists());
        assert!(cat.read().unwrap().get("hello").is_some());

        let listed = mgr.list().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "demo");
    }

    #[tokio::test]
    async fn duplicate_install_is_rejected() {
        let staging = TempDir::new().unwrap();
        let plugin_src = staging.path().join("src");
        write_plugin(
            &plugin_src,
            r#"{ "name": "demo", "version": "0.1.0", "description": "x" }"#,
        );

        let mgr = PluginManager::new(
            staging.path().join("plugins"),
            make_skills_catalog(),
            make_mcp_manager(),
        )
        .unwrap();
        mgr.install_from_path(&plugin_src).await.unwrap();
        let err = mgr.install_from_path(&plugin_src).await.unwrap_err();
        assert!(matches!(err, PluginManagerError::AlreadyInstalled(_)));
    }

    #[tokio::test]
    async fn skill_conflict_blocks_install() {
        let staging = TempDir::new().unwrap();
        let plugin_src = staging.path().join("src");
        write_plugin(
            &plugin_src,
            r#"{ "name": "demo", "version": "0.1.0", "description": "x", "skills": ["skills/hello"] }"#,
        );
        write_skill(
            &plugin_src.join("skills"),
            "hello",
            "name: hello\ndescription: y\n",
            "Body.",
        );

        let cat = make_skills_catalog();
        // Pre-seed the conflict.
        cat.write().unwrap().insert(SkillEntry {
            manifest: harness_skill::SkillManifest {
                name: "hello".into(),
                description: "preexisting".into(),
                license: None,
                allowed_tools: vec![],
                activation: harness_skill::SkillActivation::Both,
                keywords: vec![],
                version: None,
            },
            body: "x".into(),
            path: PathBuf::from("/dev/null"),
            source: SkillSource::User,
        });

        let mgr = PluginManager::new(
            staging.path().join("plugins"),
            cat.clone(),
            make_mcp_manager(),
        )
        .unwrap();
        let err = mgr.install_from_path(&plugin_src).await.unwrap_err();
        assert!(matches!(
            err,
            PluginManagerError::Conflict {
                kind: "skill",
                ..
            }
        ));
        // Catalog still has the original; no plugin entry inserted.
        assert!(cat.read().unwrap().get("hello").is_some());
    }

    #[tokio::test]
    async fn uninstall_pulls_skills() {
        let staging = TempDir::new().unwrap();
        let plugin_src = staging.path().join("src");
        write_plugin(
            &plugin_src,
            r#"{ "name": "demo", "version": "0.1.0", "description": "x", "skills": ["skills/hello"] }"#,
        );
        write_skill(
            &plugin_src.join("skills"),
            "hello",
            "name: hello\ndescription: y\n",
            "Body.",
        );

        let cat = make_skills_catalog();
        let mgr = PluginManager::new(
            staging.path().join("plugins"),
            cat.clone(),
            make_mcp_manager(),
        )
        .unwrap();
        mgr.install_from_path(&plugin_src).await.unwrap();
        assert!(cat.read().unwrap().get("hello").is_some());

        mgr.uninstall("demo").await.unwrap();
        assert!(cat.read().unwrap().get("hello").is_none());
        assert!(mgr.get("demo").await.is_none());
    }
}
