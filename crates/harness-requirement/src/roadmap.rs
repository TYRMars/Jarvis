//! Generic roadmap → Work bridge.
//!
//! Given a workspace root, find a directory of markdown proposals
//! (`docs/proposals/` by default, with fallback discovery), parse
//! each one's `**Status:**` line, and upsert a [`Requirement`] per
//! proposal under a single [`Project`] auto-created for the workspace.
//!
//! **Not Jarvis-specific.** The defaults match Jarvis's own conventions
//! (so `cargo run -p jarvis` against this repo Just Works) but the
//! mechanism applies to any project that follows the
//! `**Status:** <keyword>` convention in proposal-style markdown.
//!
//! Idempotent: a hidden HTML comment marker
//! (`<!-- roadmap-source: <relative-path> -->`) is stored as the first
//! line of each Requirement's `description`. Re-running `import_proposals`
//! looks up existing Requirements by that marker and updates only the
//! ones whose title/description/status actually changed. Requirements
//! created by hand (no marker) are left alone — `prune` is opt-in.
//!
//! Status mapping mirrors the convention used by `docs/proposals/README.md`:
//!
//! | Wire keyword (case-insensitive, EN/中) | `RequirementStatus` |
//! |---|---|
//! | `Adopted` / `Done` / `Shipped` / `已落地` / `已采纳` / `完成` | `Done` |
//! | `Adopted partial` / `In progress` / `WIP` / `进行中` / `部分` | `InProgress` |
//! | `Review` / `Verifying` / `审核中` | `Review` |
//! | `Proposed` / `Planned` / `Backlog` / `提议` / `待办` | `Backlog` |
//! | `Superseded` / `被取代` | `Done` (description annotates) |
//! | (no `**Status:**` line / unparsable) | `Backlog` |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use harness_core::{
    derive_slug, BoxError, Project, ProjectStore, Requirement, RequirementStatus, RequirementStore,
};
use serde::{Deserialize, Serialize};

const MARKER_PREFIX: &str = "<!-- roadmap-source: ";
const MARKER_SUFFIX: &str = " -->";
const PROPOSAL_BODY_BUDGET: usize = 1024;
const READ_PREFIX_BYTES: usize = 8 * 1024;

const DISCOVERY_SUBDIRS: &[&str] = &["docs/proposals", "docs/roadmap", "roadmap"];
const DISCOVERY_SINGLE_FILE: &str = "ROADMAP.md";

/// Caller-supplied overrides for [`import_proposals`]. All fields are
/// optional — `None` falls back to the workspace-derived default.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ImportOptions {
    /// Override the auto-derived slug (`<workspace>-roadmap`).
    #[serde(default)]
    pub slug: Option<String>,
    /// Override the auto-derived display name (`<Workspace> Roadmap`).
    #[serde(default)]
    pub name: Option<String>,
    /// Override the source subdirectory under the workspace root.
    /// When set, discovery is skipped and this path is used verbatim.
    /// May point at a single `.md` file (treated as one Requirement).
    #[serde(default)]
    pub source_subdir: Option<PathBuf>,
    /// When `true`, Requirements that carry a `roadmap-source` marker
    /// pointing at a file no longer present in the source are deleted.
    /// Defaults to `false` so manual edits aren't lost.
    #[serde(default)]
    pub prune: bool,
}

/// Per-file outcome of an import run.
#[derive(Debug, Clone, Serialize)]
pub struct ImportItemReport {
    /// Source path relative to the workspace root.
    pub source: String,
    /// Proposal headline parsed from the `# Title` line.
    pub title: String,
    /// Final status assigned to the Requirement.
    pub status: String,
    /// One of `created` / `updated` / `unchanged` / `removed`.
    pub action: &'static str,
    /// Requirement id the change targeted (or removed).
    pub requirement_id: String,
}

/// Aggregated outcome of an import run.
#[derive(Debug, Clone, Serialize)]
pub struct ImportSummary {
    /// Project the Requirements are attached to.
    pub project_id: String,
    /// Slug of the (created or reused) Project.
    pub slug: String,
    /// Display name of the Project.
    pub name: String,
    /// Resolved source path (relative to the workspace root) actually scanned.
    /// `None` when no source could be discovered and an empty Project was created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Counts.
    pub created: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub removed: u32,
    pub total: u32,
    /// Per-file breakdown, sorted by source path.
    pub items: Vec<ImportItemReport>,
    /// Human-readable note when something noteworthy happened
    /// (e.g. no source found, source was a single file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Scan the workspace's roadmap source and upsert one [`Requirement`]
/// per proposal under a workspace-derived [`Project`].
///
/// Behaviour summary:
/// - Project is reused (looked up by slug) or freshly created with
///   sensible defaults if absent.
/// - Each proposal file is matched to an existing Requirement via the
///   `<!-- roadmap-source: ... -->` marker stored as the first line of
///   `description`.
/// - Requirements whose (title, description, status) differ from the
///   parsed proposal are upserted; matching ones are reported as
///   `unchanged`.
/// - Translations (`<base>.zh-CN.md`) are merged into their English peer
///   when one exists; otherwise the zh-CN file becomes the main entry.
/// - When `prune == true`, marker-bearing Requirements whose source
///   file is missing are deleted.
///
/// Returns an [`ImportSummary`] suitable for direct JSON serialisation
/// to the tool / REST caller.
pub async fn import_proposals(
    workspace: &Path,
    projects: &Arc<dyn ProjectStore>,
    requirements: &Arc<dyn RequirementStore>,
    opts: ImportOptions,
) -> Result<ImportSummary, BoxError> {
    let workspace = workspace.to_path_buf();
    let workspace_canon = std::fs::canonicalize(&workspace).unwrap_or_else(|_| workspace.clone());
    let workspace_basename = workspace_canon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();

    let derived_slug_base = derive_slug(&workspace_basename);
    let slug = opts
        .slug
        .clone()
        .unwrap_or_else(|| format!("{derived_slug_base}-roadmap"));
    harness_core::validate_slug(&slug).map_err(|e| -> BoxError {
        format!("invalid slug `{slug}`: {e}").into()
    })?;
    let name = opts
        .name
        .clone()
        .unwrap_or_else(|| format!("{} Roadmap", titlecase_words(&workspace_basename)));

    // Find or create the Project.
    let project = match projects.find_by_slug(&slug).await? {
        Some(p) => p,
        None => {
            let mut p = Project::new(name.clone(), default_project_instructions(&name))
                .with_slug(slug.clone())
                .with_tags(vec!["roadmap".into()]);
            p.description = Some(format!(
                "Auto-imported roadmap project for workspace `{workspace_basename}`. Re-run `roadmap.import` to refresh."
            ));
            projects.save(&p).await?;
            p
        }
    };
    let project_id = project.id.clone();
    let project_slug = project.slug.clone();
    let project_name = project.name.clone();

    // Parse-then-discover source.
    let (source_root, source_kind, source_display) =
        match resolve_source(&workspace_canon, opts.source_subdir.as_deref()) {
            Some(found) => found,
            None => {
                return Ok(ImportSummary {
                    project_id,
                    slug: project_slug,
                    name: project_name,
                    source: None,
                    created: 0,
                    updated: 0,
                    unchanged: 0,
                    removed: 0,
                    total: 0,
                    items: Vec::new(),
                    note: Some(
                        "no roadmap source found at docs/proposals/, docs/roadmap/, roadmap/, or ROADMAP.md; \
                         use requirement.create to populate this Project, or set `source_subdir` explicitly".into(),
                    ),
                });
            }
        };

    let parsed = match source_kind {
        SourceKind::Directory => collect_directory(&source_root)?,
        SourceKind::SingleFile => {
            let mut entry = parse_proposal_file(&source_root, &workspace_canon)?;
            entry.source_rel = single_file_rel(&workspace_canon, &source_root);
            vec![entry]
        }
    };

    // Index existing requirements by their roadmap-source marker.
    // Anything without a marker is left untouched — those are user-
    // authored Requirements we never want to clobber.
    let existing = requirements.list(&project_id).await?;
    let mut by_source: HashMap<String, Requirement> = HashMap::new();
    for req in existing {
        if let Some(src) = extract_marker(req.description.as_deref()) {
            by_source.insert(src, req);
        }
    }

    let mut created = 0u32;
    let mut updated = 0u32;
    let mut unchanged = 0u32;
    let mut removed = 0u32;
    let mut items: Vec<ImportItemReport> = Vec::new();
    let mut handled_sources = std::collections::HashSet::new();

    for parsed_entry in parsed.iter() {
        handled_sources.insert(parsed_entry.source_rel.clone());
        let target_description = render_description(parsed_entry);

        match by_source.remove(&parsed_entry.source_rel) {
            Some(mut req) => {
                let mut changed = false;
                if req.title != parsed_entry.title {
                    req.title = parsed_entry.title.clone();
                    changed = true;
                }
                let new_desc_opt = Some(target_description.clone());
                if req.description != new_desc_opt {
                    req.description = new_desc_opt;
                    changed = true;
                }
                if req.status != parsed_entry.status {
                    req.status = parsed_entry.status;
                    changed = true;
                }
                if changed {
                    req.touch();
                    requirements.upsert(&req).await?;
                    updated += 1;
                    items.push(ImportItemReport {
                        source: parsed_entry.source_rel.clone(),
                        title: req.title.clone(),
                        status: req.status.as_wire().into(),
                        action: "updated",
                        requirement_id: req.id.clone(),
                    });
                } else {
                    unchanged += 1;
                    items.push(ImportItemReport {
                        source: parsed_entry.source_rel.clone(),
                        title: req.title.clone(),
                        status: req.status.as_wire().into(),
                        action: "unchanged",
                        requirement_id: req.id.clone(),
                    });
                }
            }
            None => {
                let mut req = Requirement::new(&project_id, parsed_entry.title.clone());
                req.description = Some(target_description);
                req.status = parsed_entry.status;
                requirements.upsert(&req).await?;
                created += 1;
                items.push(ImportItemReport {
                    source: parsed_entry.source_rel.clone(),
                    title: req.title.clone(),
                    status: req.status.as_wire().into(),
                    action: "created",
                    requirement_id: req.id,
                });
            }
        }
    }

    // Anything left in `by_source` has a marker but no longer maps to a
    // source file. Prune iff opted in.
    if opts.prune {
        for (source_rel, req) in by_source {
            requirements.delete(&req.id).await?;
            removed += 1;
            items.push(ImportItemReport {
                source: source_rel,
                title: req.title,
                status: req.status.as_wire().into(),
                action: "removed",
                requirement_id: req.id,
            });
        }
    }

    items.sort_by(|a, b| a.source.cmp(&b.source));

    let total = parsed.len() as u32;
    let note = match source_kind {
        SourceKind::SingleFile => Some(format!("source is a single file: {source_display}")),
        SourceKind::Directory => None,
    };

    // Touch the Project's updated_at so list views surface the import.
    let mut project_to_touch = project;
    project_to_touch.touch();
    projects.save(&project_to_touch).await?;

    Ok(ImportSummary {
        project_id,
        slug: project_slug,
        name: project_name,
        source: Some(source_display),
        created,
        updated,
        unchanged,
        removed,
        total,
        items,
        note,
    })
}

#[derive(Debug, Clone, Copy)]
enum SourceKind {
    Directory,
    SingleFile,
}

#[derive(Debug, Clone)]
struct ParsedProposal {
    /// Path relative to workspace root, forward-slashed.
    source_rel: String,
    title: String,
    status: RequirementStatus,
    /// Raw `**Status:** ...` line text (without the marker), for the
    /// rendered description's first line.
    status_text: Option<String>,
    /// Body excerpt — first ~1KB of the proposal after the front matter.
    body_excerpt: String,
    /// Translation source path (relative to workspace root), if a
    /// `.zh-CN.md` peer was merged in.
    translation_rel: Option<String>,
}

fn resolve_source(
    workspace: &Path,
    explicit: Option<&Path>,
) -> Option<(PathBuf, SourceKind, String)> {
    if let Some(rel) = explicit {
        if rel.is_absolute() {
            return None;
        }
        let abs = workspace.join(rel);
        if abs.is_dir() {
            return Some((abs, SourceKind::Directory, rel.to_string_lossy().into_owned()));
        }
        if abs.is_file() {
            return Some((abs, SourceKind::SingleFile, rel.to_string_lossy().into_owned()));
        }
        return None;
    }
    for sub in DISCOVERY_SUBDIRS {
        let abs = workspace.join(sub);
        if abs.is_dir() {
            return Some((abs, SourceKind::Directory, (*sub).to_string()));
        }
    }
    let single = workspace.join(DISCOVERY_SINGLE_FILE);
    if single.is_file() {
        return Some((single, SourceKind::SingleFile, DISCOVERY_SINGLE_FILE.into()));
    }
    None
}

fn collect_directory(dir: &Path) -> Result<Vec<ParsedProposal>, BoxError> {
    let mut all_md: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| -> BoxError { format!("read_dir {}: {e}", dir.display()).into() })?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n != "README.md")
                .unwrap_or(false)
        })
        .collect();
    all_md.sort();

    // Build a fast set of stems and a lookup of zh-CN files.
    let mut english_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut translations: HashMap<String, PathBuf> = HashMap::new();
    for path in &all_md {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(stem) = name.strip_suffix(".zh-CN.md") {
            translations.insert(stem.to_string(), path.clone());
        } else if let Some(stem) = name.strip_suffix(".md") {
            english_stems.insert(stem.to_string());
        }
    }

    let mut out: Vec<ParsedProposal> = Vec::new();
    let workspace_for_relpath = dir
        .ancestors()
        .nth(2)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| dir.to_path_buf());

    for path in &all_md {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(stem) = name.strip_suffix(".zh-CN.md") {
            // Skip zh-CN files that have an English peer; they're attached as a translation below.
            if english_stems.contains(stem) {
                continue;
            }
        }
        let mut entry = parse_proposal_file(path, &workspace_for_relpath)?;
        entry.source_rel = rel_from_workspace(&workspace_for_relpath, path);
        if let Some(stem) = name.strip_suffix(".md") {
            // Not stripping `.zh-CN.md` here on purpose: that branch
            // already `continue`d above. So this is the English peer.
            if let Some(translation_path) = translations.get(stem) {
                entry.translation_rel =
                    Some(rel_from_workspace(&workspace_for_relpath, translation_path));
            }
        }
        out.push(entry);
    }

    Ok(out)
}

fn parse_proposal_file(path: &Path, workspace: &Path) -> Result<ParsedProposal, BoxError> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| -> BoxError { format!("open {}: {e}", path.display()).into() })?;
    let mut buf = vec![0u8; READ_PREFIX_BYTES];
    let n = f
        .read(&mut buf)
        .map_err(|e| -> BoxError { format!("read {}: {e}", path.display()).into() })?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf).into_owned();

    let title = extract_title(&text).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled")
            .to_string()
    });
    let status_text = extract_status_text(&text);
    let status = match status_text.as_deref() {
        Some(s) => classify_status(s),
        None => RequirementStatus::Backlog,
    };
    let body_excerpt = extract_body_excerpt(&text);

    Ok(ParsedProposal {
        source_rel: rel_from_workspace(workspace, path),
        title,
        status,
        status_text,
        body_excerpt,
        translation_rel: None,
    })
}

fn rel_from_workspace(workspace: &Path, file: &Path) -> String {
    let workspace = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let file = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    file.strip_prefix(&workspace)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file.to_string_lossy().into_owned())
}

fn single_file_rel(workspace: &Path, file: &Path) -> String {
    rel_from_workspace(workspace, file)
}

fn render_description(entry: &ParsedProposal) -> String {
    let mut out = String::new();
    out.push_str(MARKER_PREFIX);
    out.push_str(&entry.source_rel);
    out.push_str(MARKER_SUFFIX);
    out.push('\n');
    if let Some(s) = &entry.status_text {
        out.push_str("**Status:** ");
        out.push_str(s);
        out.push('\n');
    }
    if !entry.body_excerpt.is_empty() {
        out.push('\n');
        out.push_str(&entry.body_excerpt);
        if !entry.body_excerpt.ends_with('\n') {
            out.push('\n');
        }
    }
    if let Some(t) = &entry.translation_rel {
        out.push('\n');
        out.push_str("Translation: ");
        out.push_str(t);
        out.push('\n');
    }
    // Trim trailing whitespace for stable equality checks.
    while out.ends_with(['\n', ' ', '\t']) {
        out.pop();
    }
    out
}

fn extract_marker(desc: Option<&str>) -> Option<String> {
    let d = desc?;
    let first_line = d.lines().next()?;
    let trimmed = first_line.trim();
    let inner = trimmed.strip_prefix(MARKER_PREFIX)?;
    let payload = inner.strip_suffix(MARKER_SUFFIX)?;
    Some(payload.trim().to_string())
}

fn extract_title(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let trimmed = line.trim_start();
        trimmed
            .strip_prefix("# ")
            .map(|rest| rest.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

fn extract_status_text(text: &str) -> Option<String> {
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let stripped = match strip_status_marker(line) {
            Some(s) => s,
            None => continue,
        };
        let mut buf = stripped.trim().to_string();
        while let Some(next) = lines.peek() {
            let trimmed = next.trim();
            if trimmed.is_empty() || is_field_marker(trimmed) {
                break;
            }
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.push_str(trimmed);
            lines.next();
        }
        return Some(buf).filter(|s| !s.is_empty());
    }
    None
}

fn strip_status_marker(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    for prefix in ["**Status:**", "**Status：**", "**状态：**", "**状态:**"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn is_field_marker(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() < 5 || &bytes[..2] != b"**" {
        return false;
    }
    let rest = &line[2..];
    let close = match rest.find("**") {
        Some(i) => i,
        None => return false,
    };
    let label = &rest[..close];
    label
        .chars()
        .next_back()
        .map(|c| c == ':' || c == '：')
        .unwrap_or(false)
}

/// Public for unit testing — translate a `**Status:**` line to a
/// `RequirementStatus`. Order matters: `Adopted partial` must classify
/// as `InProgress`, not `Done`. Unknown / unparseable text falls
/// through to `Backlog`.
pub fn classify_status(status_text: &str) -> RequirementStatus {
    let lower = status_text.to_lowercase();
    let head: String = lower.chars().take(160).collect();
    if head.contains("partial")
        || head.contains("部分")
        || head.contains("in progress")
        || head.contains("in-progress")
        || head.contains("wip")
        || head.contains("进行中")
    {
        RequirementStatus::InProgress
    } else if head.contains("review") || head.contains("verifying") || head.contains("审核") {
        RequirementStatus::Review
    } else if head.contains("superseded")
        || head.contains("被取代")
        || head.contains("adopted")
        || head.contains("shipped")
        || head.contains("done")
        || head.contains("已落地")
        || head.contains("已采纳")
        || head.contains("完成")
    {
        RequirementStatus::Done
    } else {
        // proposed / planned / backlog / 提议 / 待办 / unknown all collapse here.
        RequirementStatus::Backlog
    }
}

fn extract_body_excerpt(text: &str) -> String {
    // Strip the leading `# Title` line and the `**Status:** ...` block,
    // keep the next ~1KB. Stops at a hard ceiling so descriptions don't
    // explode for long proposals.
    let mut lines = text.lines();
    let mut buf = String::new();
    let mut in_status_block = false;
    let mut seen_title = false;
    let mut seen_first_para = false;

    for line in lines.by_ref() {
        let trimmed = line.trim();
        if !seen_title && trimmed.starts_with("# ") {
            seen_title = true;
            continue;
        }
        if strip_status_marker(line).is_some() {
            in_status_block = true;
            continue;
        }
        if in_status_block {
            if trimmed.is_empty() {
                in_status_block = false;
                continue;
            }
            if is_field_marker(trimmed) {
                in_status_block = false;
                continue;
            }
            // Continuation of the status block — skip.
            continue;
        }
        if is_field_marker(trimmed) {
            // Skip other top-of-file metadata fields (e.g. `**Touches:**`).
            continue;
        }
        if trimmed.starts_with("##") {
            // Stop at the first subsection heading; we just want the lede.
            if seen_first_para {
                break;
            }
            continue;
        }
        if trimmed.is_empty() {
            if seen_first_para {
                // One blank line is OK between the lede and a subsequent paragraph.
                buf.push('\n');
                continue;
            }
            continue;
        }
        seen_first_para = true;
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(line);
        if buf.len() >= PROPOSAL_BODY_BUDGET {
            break;
        }
    }

    if buf.len() > PROPOSAL_BODY_BUDGET {
        // Truncate on a UTF-8 boundary.
        let mut cut = PROPOSAL_BODY_BUDGET;
        while cut > 0 && !buf.is_char_boundary(cut) {
            cut -= 1;
        }
        buf.truncate(cut);
        buf.push('…');
    }

    buf.trim().to_string()
}

fn titlecase_words(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut new_word = true;
    for ch in s.chars() {
        if ch == '-' || ch == '_' || ch.is_whitespace() {
            out.push(' ');
            new_word = true;
            continue;
        }
        if new_word {
            for upper in ch.to_uppercase() {
                out.push(upper);
            }
            new_word = false;
        } else {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn default_project_instructions(name: &str) -> String {
    format!(
        "{name} — auto-imported roadmap project. Each Requirement here is sourced from a proposal-style \
markdown file under `docs/proposals/` (or `ROADMAP.md`); the Requirement's `description` carries a \
`<!-- roadmap-source: ... -->` marker pointing back to the file. Re-run `roadmap.import` to refresh status \
from the docs. The doc is the source of truth — manual edits to imported Requirements will be overwritten \
on the next import."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_store::{MemoryProjectStore, MemoryRequirementStore};
    use std::sync::Arc;
    use tempfile::tempdir;

    fn make_stores() -> (Arc<dyn ProjectStore>, Arc<dyn RequirementStore>) {
        (
            Arc::new(MemoryProjectStore::new()),
            Arc::new(MemoryRequirementStore::new()),
        )
    }

    fn write_proposal(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[tokio::test]
    async fn empty_workspace_creates_project_with_note() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("acme");
        std::fs::create_dir_all(&workspace).unwrap();
        let (projects, requirements) = make_stores();

        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();

        assert_eq!(summary.slug, "acme-roadmap");
        assert_eq!(summary.name, "Acme Roadmap");
        assert_eq!(summary.created, 0);
        assert_eq!(summary.total, 0);
        assert!(summary.note.as_ref().unwrap().contains("no roadmap source"));
        assert!(projects.find_by_slug("acme-roadmap").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn first_import_creates_requirements_per_proposal() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Adopted (shipped)\n\nFirst para of alpha.\n");
        write_proposal(&proposals, "beta.md", "# Beta\n\n**Status:** Proposed\n\nFirst para of beta.\n");
        write_proposal(&proposals, "README.md", "# Index\n\nSkip me.\n");

        let (projects, requirements) = make_stores();
        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();

        assert_eq!(summary.created, 2);
        assert_eq!(summary.total, 2);
        assert_eq!(summary.slug, "jarvis-roadmap");
        let reqs = requirements.list(&summary.project_id).await.unwrap();
        let titles: std::collections::HashSet<_> = reqs.iter().map(|r| r.title.clone()).collect();
        assert!(titles.contains("Alpha"));
        assert!(titles.contains("Beta"));

        let alpha = reqs.iter().find(|r| r.title == "Alpha").unwrap();
        assert_eq!(alpha.status, RequirementStatus::Done);
        let beta = reqs.iter().find(|r| r.title == "Beta").unwrap();
        assert_eq!(beta.status, RequirementStatus::Backlog);

        let alpha_desc = alpha.description.as_ref().unwrap();
        assert!(alpha_desc.starts_with("<!-- roadmap-source: docs/proposals/alpha.md -->"));
        assert!(alpha_desc.contains("**Status:** Adopted"));
    }

    #[tokio::test]
    async fn rerun_with_no_changes_reports_unchanged() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Adopted\n\nBody.\n");

        let (projects, requirements) = make_stores();
        let s1 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s1.created, 1);

        let s2 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s2.created, 0);
        assert_eq!(s2.updated, 0);
        assert_eq!(s2.unchanged, 1);
    }

    #[tokio::test]
    async fn changing_status_in_doc_triggers_update() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Proposed\n");

        let (projects, requirements) = make_stores();
        let s1 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s1.created, 1);
        let req_id = requirements.list(&s1.project_id).await.unwrap()[0].id.clone();

        // Edit the doc.
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Adopted\n");

        let s2 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s2.updated, 1);
        assert_eq!(s2.created, 0);
        assert_eq!(s2.unchanged, 0);
        let req = requirements.get(&req_id).await.unwrap().unwrap();
        assert_eq!(req.status, RequirementStatus::Done);
    }

    #[tokio::test]
    async fn zh_cn_translation_pairs_with_english() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Proposed\n");
        write_proposal(&proposals, "alpha.zh-CN.md", "# 阿尔法\n\n**状态：** 提议\n");

        let (projects, requirements) = make_stores();
        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();
        assert_eq!(summary.created, 1, "zh-CN should not create a second requirement");
        let req = &requirements.list(&summary.project_id).await.unwrap()[0];
        assert_eq!(req.title, "Alpha");
        let desc = req.description.as_ref().unwrap();
        assert!(desc.contains("Translation: docs/proposals/alpha.zh-CN.md"));
    }

    #[tokio::test]
    async fn standalone_zh_cn_becomes_main_entry() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "work.zh-CN.md", "# 工作编排\n\n**状态：** Adopted partial — phase 0 done\n");

        let (projects, requirements) = make_stores();
        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();
        assert_eq!(summary.created, 1);
        let req = &requirements.list(&summary.project_id).await.unwrap()[0];
        assert_eq!(req.status, RequirementStatus::InProgress);
        let desc = req.description.as_ref().unwrap();
        assert!(desc.starts_with("<!-- roadmap-source: docs/proposals/work.zh-CN.md -->"));
    }

    #[tokio::test]
    async fn workspace_basename_drives_default_slug() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("My Project!");
        std::fs::create_dir_all(&workspace).unwrap();
        let (projects, requirements) = make_stores();
        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();
        assert_eq!(summary.slug, "my-project-roadmap");
        assert_eq!(summary.name, "My Project! Roadmap");
    }

    #[tokio::test]
    async fn explicit_slug_overrides_derivation() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        std::fs::create_dir_all(&workspace).unwrap();
        let (projects, requirements) = make_stores();
        let opts = ImportOptions {
            slug: Some("custom-roadmap".into()),
            name: Some("Custom Name".into()),
            ..Default::default()
        };
        let summary = import_proposals(&workspace, &projects, &requirements, opts)
            .await
            .unwrap();
        assert_eq!(summary.slug, "custom-roadmap");
        assert_eq!(summary.name, "Custom Name");
    }

    #[tokio::test]
    async fn discovery_falls_through_to_single_roadmap_file() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            workspace.join("ROADMAP.md"),
            "# All-in-one roadmap\n\n**Status:** In progress\n\nThis is everything.\n",
        )
        .unwrap();

        let (projects, requirements) = make_stores();
        let summary =
            import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
                .await
                .unwrap();
        assert_eq!(summary.created, 1);
        assert_eq!(summary.source.as_deref(), Some("ROADMAP.md"));
        assert!(summary.note.as_ref().unwrap().contains("single file"));
        let req = &requirements.list(&summary.project_id).await.unwrap()[0];
        assert_eq!(req.status, RequirementStatus::InProgress);
    }

    #[tokio::test]
    async fn prune_removes_orphan_marker_requirements() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Proposed\n");
        write_proposal(&proposals, "beta.md", "# Beta\n\n**Status:** Proposed\n");

        let (projects, requirements) = make_stores();
        let s1 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s1.created, 2);

        // Remove beta.md.
        std::fs::remove_file(proposals.join("beta.md")).unwrap();

        // Without prune: beta stays around.
        let s2 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        assert_eq!(s2.removed, 0);
        assert_eq!(requirements.list(&s2.project_id).await.unwrap().len(), 2);

        // With prune: beta gets deleted.
        let opts = ImportOptions { prune: true, ..Default::default() };
        let s3 = import_proposals(&workspace, &projects, &requirements, opts)
            .await
            .unwrap();
        assert_eq!(s3.removed, 1);
        assert_eq!(requirements.list(&s3.project_id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn manually_added_requirement_without_marker_is_left_alone() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("jarvis");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        write_proposal(&proposals, "alpha.md", "# Alpha\n\n**Status:** Proposed\n");

        let (projects, requirements) = make_stores();
        let s1 = import_proposals(&workspace, &projects, &requirements, ImportOptions::default())
            .await
            .unwrap();
        // Add a manual Requirement (no marker).
        let mut manual = Requirement::new(&s1.project_id, "Hand-rolled");
        manual.description = Some("No marker here.".into());
        requirements.upsert(&manual).await.unwrap();

        // Re-import with prune=true: only the orphan-marker rule applies; this one stays.
        let opts = ImportOptions { prune: true, ..Default::default() };
        let s2 = import_proposals(&workspace, &projects, &requirements, opts)
            .await
            .unwrap();
        assert_eq!(s2.removed, 0);
        let titles: std::collections::HashSet<_> = requirements
            .list(&s2.project_id)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.title)
            .collect();
        assert!(titles.contains("Hand-rolled"));
        assert!(titles.contains("Alpha"));
    }

    #[test]
    fn classify_status_priority() {
        assert_eq!(classify_status("Adopted partial — phase 1"), RequirementStatus::InProgress);
        assert_eq!(classify_status("Adopted (shipped)"), RequirementStatus::Done);
        assert_eq!(classify_status("Proposed"), RequirementStatus::Backlog);
        assert_eq!(classify_status("In progress"), RequirementStatus::InProgress);
        assert_eq!(classify_status("review pending"), RequirementStatus::Review);
        assert_eq!(classify_status("Superseded by other.md"), RequirementStatus::Done);
        assert_eq!(classify_status("已采纳"), RequirementStatus::Done);
        assert_eq!(classify_status("提议中"), RequirementStatus::Backlog);
        assert_eq!(classify_status("进行中"), RequirementStatus::InProgress);
        assert_eq!(classify_status("nonsense"), RequirementStatus::Backlog);
    }

    #[test]
    fn extract_marker_round_trips() {
        let entry = ParsedProposal {
            source_rel: "docs/proposals/web-ui.md".into(),
            title: "Minimal browser UI".into(),
            status: RequirementStatus::Done,
            status_text: Some("Adopted".into()),
            body_excerpt: "Body.".into(),
            translation_rel: None,
        };
        let desc = render_description(&entry);
        let parsed = extract_marker(Some(&desc));
        assert_eq!(parsed.as_deref(), Some("docs/proposals/web-ui.md"));
    }

    #[test]
    fn extract_marker_returns_none_for_arbitrary_text() {
        assert!(extract_marker(Some("Plain description")).is_none());
        assert!(extract_marker(Some("<!-- something else: x -->")).is_none());
        assert!(extract_marker(None).is_none());
    }

    #[test]
    fn titlecase_words_handles_separators() {
        assert_eq!(titlecase_words("jarvis"), "Jarvis");
        assert_eq!(titlecase_words("my-project"), "My Project");
        assert_eq!(titlecase_words("My Project!"), "My Project!");
        assert_eq!(titlecase_words("foo_bar"), "Foo Bar");
    }
}
