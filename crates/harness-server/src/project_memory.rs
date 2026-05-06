//! Project-scoped file memory for persisted kanban boards.
//!
//! This is the durable, transparent layer that sits beside the
//! conversation memory backends. It follows Claude Code's file-memory
//! shape: a small `MEMORY.md` index plus topic files the model can read
//! on demand. Jarvis owns two generated topic files per project:
//! `kanban.md` and `calendar.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use harness_core::{
    BoxError, Project, ProjectStore, Requirement, RequirementStatus, RequirementStore,
    RequirementTodo,
};
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::{debug, warn};

const ENTRYPOINT: &str = "MEMORY.md";
const KANBAN_FILE: &str = "kanban.md";
const CALENDAR_FILE: &str = "calendar.md";
const INDEX_START: &str = "<!-- jarvis:project-memory-index:start -->";
const INDEX_END: &str = "<!-- jarvis:project-memory-index:end -->";
const MAX_PROMPT_FILE_BYTES: usize = 12_000;
const MAX_MANAGED_FILE_BYTES: usize = 128 * 1024;

/// Runtime configuration for project memory.
#[derive(Debug, Clone)]
pub struct ProjectMemoryConfig {
    workspace_root: PathBuf,
    memory_dir: PathBuf,
    max_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectMemorySnapshot {
    pub project_id: String,
    pub dir: String,
    pub files: Vec<ProjectMemoryFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectMemoryFile {
    pub name: String,
    pub content: String,
    pub generated: bool,
    pub bytes: usize,
}

impl ProjectMemoryConfig {
    pub fn new(
        workspace_root: impl Into<PathBuf>,
        memory_dir: impl Into<PathBuf>,
        max_bytes: usize,
    ) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            memory_dir: memory_dir.into(),
            max_bytes,
        }
    }

    fn base_dir(&self) -> PathBuf {
        if self.memory_dir.is_absolute() {
            self.memory_dir.clone()
        } else {
            self.workspace_root.join(&self.memory_dir)
        }
    }

    fn project_dir(&self, project: &Project) -> PathBuf {
        let key = if project.slug.trim().is_empty() {
            project.id.as_str()
        } else {
            project.slug.as_str()
        };
        self.base_dir()
            .join("projects")
            .join(sanitize_component(key))
    }
}

/// Load project memory for prompt injection. Returns `None` when the
/// project memory directory has not been created yet.
pub fn load_project_memory_prompt(
    config: &ProjectMemoryConfig,
    project: &Project,
) -> Option<String> {
    let dir = config.project_dir(project);
    if !dir.is_dir() {
        return None;
    }
    let index = read_limited(&dir.join(ENTRYPOINT), config.max_bytes).unwrap_or_default();
    let kanban = read_limited(&dir.join(KANBAN_FILE), MAX_PROMPT_FILE_BYTES).unwrap_or_default();
    let calendar =
        read_limited(&dir.join(CALENDAR_FILE), MAX_PROMPT_FILE_BYTES).unwrap_or_default();

    let mut out = String::new();
    out.push_str("=== project memory files ===\n");
    out.push_str(&format!("Project memory directory: `{}`\n", dir.display()));
    out.push_str("Memory is layered: user preferences, feedback, project facts, reference pointers, and calendar/delivery dates.\n");
    out.push_str("Treat these files as context, not authority. Verify stale facts against the current project state before acting.\n\n");
    append_file_section(&mut out, ENTRYPOINT, &index);
    append_file_section(&mut out, KANBAN_FILE, &kanban);
    append_file_section(&mut out, CALENDAR_FILE, &calendar);
    out.push_str("=== /project memory files ===");
    Some(out)
}

/// Read all top-level markdown memory files for UI management. The
/// caller is expected to call [`sync_project_memory`] first when it
/// wants generated board files to be up to date.
pub fn snapshot_project_memory(
    config: &ProjectMemoryConfig,
    project: &Project,
) -> Result<ProjectMemorySnapshot, BoxError> {
    let dir = config.project_dir(project);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    update_index(&dir, project)?;

    let mut names = Vec::new();
    for special in [ENTRYPOINT, KANBAN_FILE, CALENDAR_FILE] {
        names.push(special.to_string());
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !name.ends_with(".md") || names.iter().any(|n| n == name) {
                continue;
            }
            names.push(name.to_string());
        }
    }
    names.sort_by_key(|name| match name.as_str() {
        ENTRYPOINT => (0, name.clone()),
        KANBAN_FILE => (1, name.clone()),
        CALENDAR_FILE => (2, name.clone()),
        _ => (3, name.clone()),
    });

    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let path = dir.join(&name);
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let bytes = content.len();
        let content = if bytes > MAX_MANAGED_FILE_BYTES {
            let mut truncated = content;
            truncated.truncate(MAX_MANAGED_FILE_BYTES);
            truncated
                .push_str("\n\n> WARNING: file truncated while loading memory management view.");
            truncated
        } else {
            content
        };
        files.push(ProjectMemoryFile {
            generated: matches!(name.as_str(), KANBAN_FILE | CALENDAR_FILE),
            name,
            content,
            bytes,
        });
    }

    Ok(ProjectMemorySnapshot {
        project_id: project.id.clone(),
        dir: dir.display().to_string(),
        files,
    })
}

pub fn write_project_memory_file(
    config: &ProjectMemoryConfig,
    project: &Project,
    name: &str,
    content: &str,
) -> Result<ProjectMemorySnapshot, BoxError> {
    validate_user_file_name(name)?;
    if matches!(name, KANBAN_FILE | CALENDAR_FILE) {
        return Err(format!("{name} is generated; update the board instead").into());
    }
    if content.len() > MAX_MANAGED_FILE_BYTES {
        return Err(format!(
            "{name} is too large: {} bytes (limit {MAX_MANAGED_FILE_BYTES})",
            content.len()
        )
        .into());
    }
    let dir = config.project_dir(project);
    std::fs::create_dir_all(&dir)?;
    write_atomic(&dir.join(name), content)?;
    snapshot_project_memory(config, project)
}

pub fn delete_project_memory_file(
    config: &ProjectMemoryConfig,
    project: &Project,
    name: &str,
) -> Result<ProjectMemorySnapshot, BoxError> {
    validate_user_file_name(name)?;
    if matches!(name, ENTRYPOINT | KANBAN_FILE | CALENDAR_FILE) {
        return Err(format!("{name} is managed and cannot be deleted").into());
    }
    let dir = config.project_dir(project);
    let path = dir.join(name);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    snapshot_project_memory(config, project)
}

/// Spawn a best-effort synchronizer. Every RequirementStore mutation
/// rebuilds the generated memory files for the affected project, so
/// REST routes, Web UI edits, auto mode, and `requirement.*` tools all
/// converge through the same path.
pub fn spawn_project_memory_sync(
    config: ProjectMemoryConfig,
    projects: Arc<dyn ProjectStore>,
    requirements: Arc<dyn RequirementStore>,
) {
    let mut rx = requirements.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let project_id = event.project_id().to_string();
                    if let Err(e) =
                        sync_project_memory(&config, &projects, &requirements, &project_id).await
                    {
                        warn!(error = %e, project_id, "project memory sync failed");
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(
                        lagged = n,
                        "project memory sync lagged; next event will resync its project"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Rebuild generated files for one project.
pub async fn sync_project_memory(
    config: &ProjectMemoryConfig,
    projects: &Arc<dyn ProjectStore>,
    requirements: &Arc<dyn RequirementStore>,
    project_id: &str,
) -> Result<(), BoxError> {
    let Some(project) = projects.load(project_id).await? else {
        return Ok(());
    };
    if project.archived {
        return Ok(());
    }
    let requirements = requirements.list(project_id).await?;
    let cfg = config.clone();
    tokio::task::spawn_blocking(move || write_project_memory(&cfg, &project, &requirements))
        .await
        .map_err(|e| -> BoxError { format!("project memory task panicked: {e}").into() })?
}

fn write_project_memory(
    config: &ProjectMemoryConfig,
    project: &Project,
    requirements: &[Requirement],
) -> Result<(), BoxError> {
    let dir = config.project_dir(project);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    let kanban = render_kanban(project, requirements);
    let calendar = render_calendar(project, requirements);
    write_atomic(&dir.join(KANBAN_FILE), &kanban)?;
    write_atomic(&dir.join(CALENDAR_FILE), &calendar)?;
    update_index(&dir, project)?;
    debug!(
        project_id = project.id,
        requirements = requirements.len(),
        dir = %dir.display(),
        "project memory synced"
    );
    Ok(())
}

fn update_index(dir: &Path, project: &Project) -> Result<(), BoxError> {
    let path = dir.join(ENTRYPOINT);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let generated = format!(
        "{INDEX_START}\n\
         - [Kanban snapshot]({KANBAN_FILE}) - generated from the current project board; updated after every board mutation.\n\
         - [Calendar memory]({CALENDAR_FILE}) - generated dated milestones and deadlines mentioned on board cards.\n\
         {INDEX_END}\n"
    );
    let body = replace_managed_block(&existing, &generated);
    let final_body = if body.trim().is_empty() {
        format!("# {} memory\n\n{generated}", project.name)
    } else if body == existing && !existing.contains(INDEX_START) {
        format!("{}\n\n{}", existing.trim_end(), generated)
    } else {
        body
    };
    write_atomic(&path, &final_body)
}

fn replace_managed_block(existing: &str, generated: &str) -> String {
    let Some(start) = existing.find(INDEX_START) else {
        return existing.to_string();
    };
    let Some(end_rel) = existing[start..].find(INDEX_END) else {
        return existing.to_string();
    };
    let end = start + end_rel + INDEX_END.len();
    let mut out = String::new();
    out.push_str(existing[..start].trim_end());
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(generated.trim_end());
    let suffix = existing[end..].trim_start();
    if !suffix.is_empty() {
        out.push_str("\n\n");
        out.push_str(suffix);
    }
    out.push('\n');
    out
}

fn render_kanban(project: &Project, requirements: &[Requirement]) -> String {
    let mut by_status: BTreeMap<&'static str, Vec<&Requirement>> = BTreeMap::new();
    for req in requirements {
        by_status.entry(req.status.as_wire()).or_default().push(req);
    }

    let mut out = String::new();
    out.push_str(&format!("# Kanban memory: {}\n\n", project.name));
    out.push_str("Generated from the persisted project board. Do not edit this file by hand; update the board instead.\n\n");
    out.push_str(&format!("- Project id: `{}`\n", project.id));
    if !project.slug.is_empty() {
        out.push_str(&format!("- Slug: `{}`\n", project.slug));
    }
    out.push_str(&format!("- Requirement count: {}\n\n", requirements.len()));

    for status in [
        RequirementStatus::Backlog,
        RequirementStatus::InProgress,
        RequirementStatus::Review,
        RequirementStatus::Done,
    ] {
        out.push_str(&format!("## {}\n\n", status_label(project, status)));
        let items = by_status.remove(status.as_wire()).unwrap_or_default();
        if items.is_empty() {
            out.push_str("_No cards._\n\n");
            continue;
        }
        for req in items {
            out.push_str(&format!("- `{}` {}\n", req.id, req.title.trim()));
            if let Some(desc) = req
                .description
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                out.push_str(&format!("  - Description: {}\n", one_line(desc)));
            }
            if req.triage_state.needs_triage() {
                out.push_str(&format!("  - Triage: {}\n", req.triage_state.as_wire()));
            }
            if let Some(assignee) = req.assignee_id.as_deref() {
                out.push_str(&format!("  - Assignee: `{assignee}`\n"));
            }
            if !req.depends_on.is_empty() {
                out.push_str(&format!("  - Depends on: {}\n", req.depends_on.join(", ")));
            }
            if !req.conversation_ids.is_empty() {
                out.push_str(&format!(
                    "  - Conversations: {}\n",
                    req.conversation_ids.len()
                ));
            }
            append_todos_summary(&mut out, &req.todos);
            out.push_str(&format!("  - Updated: {}\n", req.updated_at));
        }
        out.push('\n');
    }
    out
}

fn render_calendar(project: &Project, requirements: &[Requirement]) -> String {
    let mut hits: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for req in requirements {
        let mut haystacks = vec![("title", req.title.as_str())];
        if let Some(desc) = req.description.as_deref() {
            haystacks.push(("description", desc));
        }
        for todo in &req.todos {
            haystacks.push(("todo", todo.title.as_str()));
            if let Some(command) = todo.command.as_deref() {
                haystacks.push(("todo command", command));
            }
            if let Some(evidence) = &todo.evidence {
                if let Some(note) = evidence.note.as_deref() {
                    haystacks.push(("todo evidence", note));
                }
            }
        }
        for (source, text) in haystacks {
            for date in find_iso_dates(text) {
                hits.entry(date).or_default().push(format!(
                    "- `{}` {} ({source}, status: {})",
                    req.id,
                    req.title.trim(),
                    req.status.as_wire()
                ));
            }
        }
    }

    let mut out = String::new();
    out.push_str(&format!("# Calendar memory: {}\n\n", project.name));
    out.push_str("Generated from absolute dates written on kanban cards and their TODO/check items. Use this as a dated recall aid, then verify against the live board.\n\n");
    if hits.is_empty() {
        out.push_str("_No absolute dates found on the board yet. When users mention deadlines, launches, freezes, meetings, or follow-ups, save them on the relevant card using `YYYY-MM-DD` so they appear here._\n");
        return out;
    }
    for (date, rows) in hits {
        out.push_str(&format!("## {date}\n\n"));
        for row in dedupe(rows) {
            out.push_str(&row);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

fn append_todos_summary(out: &mut String, todos: &[RequirementTodo]) {
    if todos.is_empty() {
        return;
    }
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for todo in todos {
        *counts.entry(todo.status.as_wire()).or_default() += 1;
    }
    let summary = counts
        .into_iter()
        .map(|(status, count)| format!("{status}:{count}"))
        .collect::<Vec<_>>()
        .join(", ");
    out.push_str(&format!("  - Checks: {summary}\n"));
}

fn find_iso_dates(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..=bytes.len() - 10 {
        let window = &bytes[i..i + 10];
        if !(window[0..4].iter().all(u8::is_ascii_digit)
            && window[4] == b'-'
            && window[5..7].iter().all(u8::is_ascii_digit)
            && window[7] == b'-'
            && window[8..10].iter().all(u8::is_ascii_digit))
        {
            continue;
        }
        let s = &text[i..i + 10];
        if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() {
            out.push(s.to_string());
        }
    }
    dedupe(out)
}

fn append_file_section(out: &mut String, name: &str, content: &str) {
    out.push_str(&format!("## {name}\n\n"));
    if content.trim().is_empty() {
        out.push_str("_Empty._\n\n");
    } else {
        out.push_str(content.trim());
        out.push_str("\n\n");
    }
}

fn read_limited(path: &Path, max_bytes: usize) -> std::io::Result<String> {
    let mut s = std::fs::read_to_string(path)?;
    if s.len() > max_bytes {
        s.truncate(max_bytes);
        s.push_str("\n\n> WARNING: file truncated while loading project memory.");
    }
    Ok(s)
}

fn write_atomic(path: &Path, body: &str) -> Result<(), BoxError> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn validate_user_file_name(name: &str) -> Result<(), BoxError> {
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(".md")
    {
        return Err("memory file must be a top-level markdown file name like `topic.md`".into());
    }
    if name.len() > 96 {
        return Err("memory file name must be at most 96 characters".into());
    }
    Ok(())
}

fn sanitize_component(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "project".to_string()
    } else {
        out
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn dedupe(mut rows: Vec<String>) -> Vec<String> {
    rows.sort();
    rows.dedup();
    rows
}

fn status_label(project: &Project, status: RequirementStatus) -> String {
    if let Some(cols) = &project.columns {
        if let Some(col) = cols.iter().find(|c| c.id == status.as_wire()) {
            return col.label.clone();
        }
    }
    match status {
        RequirementStatus::Backlog => "Backlog".to_string(),
        RequirementStatus::InProgress => "In Progress".to_string(),
        RequirementStatus::Review => "Review".to_string(),
        RequirementStatus::Done => "Done".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Requirement;

    #[test]
    fn date_scanner_only_keeps_valid_iso_dates() {
        let dates = find_iso_dates("ship 2026-05-05, not 2026-99-99, again 2026-05-05");
        assert_eq!(dates, vec!["2026-05-05"]);
    }

    #[test]
    fn sync_writes_kanban_calendar_and_index() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = ProjectMemoryConfig::new(tmp.path(), ".jarvis/memory", 25_000);
        let project = Project::new("Apollo", "build").with_slug("apollo");
        let mut req = Requirement::new(project.id.clone(), "Freeze on 2026-05-05");
        req.description = Some("Launch review on 2026-05-06".into());

        write_project_memory(&cfg, &project, &[req]).unwrap();

        let dir = tmp.path().join(".jarvis/memory/projects/apollo");
        let index = std::fs::read_to_string(dir.join(ENTRYPOINT)).unwrap();
        let kanban = std::fs::read_to_string(dir.join(KANBAN_FILE)).unwrap();
        let calendar = std::fs::read_to_string(dir.join(CALENDAR_FILE)).unwrap();
        assert!(index.contains("[Kanban snapshot](kanban.md)"));
        assert!(kanban.contains("Freeze on 2026-05-05"));
        assert!(calendar.contains("2026-05-05"));
        assert!(calendar.contains("2026-05-06"));
    }
}
