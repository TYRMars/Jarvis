import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import type { Project, Requirement, RequirementStatus } from "../../types/frames";
import { t } from "../../utils/i18n";
import { archiveProject, createProject, refreshProjects, restoreProject } from "../../services/projects";
import { resumeConversation } from "../../services/conversations";
import {
  createRequirement,
  linkRequirementConversation,
  listRequirements,
  updateRequirement,
} from "../../services/requirements";
import { chipColor } from "../Sidebar/ProjectsList";

const COLUMNS: Array<{ status: RequirementStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export function ProjectsPage() {
  const available = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const activeConversationId = useAppStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [requirementsVersion, setRequirementsVersion] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    void refreshProjects(includeArchived);
  }, [includeArchived]);

  useEffect(() => {
    const onNewProject = () => setCreating(true);
    const onOpenProject = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) setSelectedProjectId(id);
      setCreating(false);
    };
    window.addEventListener("jarvis:new-project", onNewProject);
    window.addEventListener("jarvis:open-project", onOpenProject);
    return () => {
      window.removeEventListener("jarvis:new-project", onNewProject);
      window.removeEventListener("jarvis:open-project", onOpenProject);
    };
  }, []);

  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.name, p.slug, p.description ?? ""].some((v) => v.toLowerCase().includes(q)),
    );
  }, [projects, query]);

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;
  const requirements = useMemo(
    () => (selectedProject ? listRequirements(selectedProject.id) : []),
    [selectedProject, requirementsVersion],
  );
  const refreshRequirements = () => setRequirementsVersion((v) => v + 1);

  return (
    <main id="projects-page" className="projects-page" aria-label="Projects">
      <header className="projects-page-header">
        <h1>Projects</h1>
        <div className="projects-page-actions">
          <button
            type="button"
            className={"ghost-icon projects-archive-toggle" + (includeArchived ? " active" : "")}
            aria-label={includeArchived ? "Hide archived projects" : "Show archived projects"}
            title={includeArchived ? "Hide archived projects" : "Show archived projects"}
            onClick={() => setIncludeArchived((v) => !v)}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h16" />
              <path d="M7 11h10" />
              <path d="M10 15h4" />
            </svg>
          </button>
          <label className="projects-search" aria-label="Search projects">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
            />
          </label>
          {selectedProject && (
            <button type="button" className="projects-back-btn" onClick={() => setSelectedProjectId(null)}>
              Projects
            </button>
          )}
          <button type="button" className="projects-new-btn" onClick={() => setCreating(true)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span>New project</span>
          </button>
        </div>
      </header>

      {creating ? (
        <ProjectCreatePanel onDone={() => setCreating(false)} />
      ) : selectedProject ? (
        <ProjectBoard
          project={selectedProject}
          requirements={requirements}
          activeConversationId={activeConversationId}
          onChanged={refreshRequirements}
          onOpenConversation={(id) => {
            void resumeConversation(id);
            navigate("/");
          }}
        />
      ) : !available ? (
        <ProjectUnavailable />
      ) : visibleProjects.length === 0 ? (
        <ProjectEmptyState hasQuery={query.trim().length > 0} onCreate={() => setCreating(true)} />
      ) : (
        <ul className="projects-page-list">
          {visibleProjects.map((project) => (
            <ProjectListRow
              key={project.id}
              project={project}
              onOpen={() => setSelectedProjectId(project.id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function ProjectEmptyState({
  hasQuery,
  onCreate,
}: {
  hasQuery: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="projects-empty" aria-live="polite">
      <div className="projects-empty-icon" aria-hidden="true">
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 18h16v16H18z" />
          <path d="M38 18h16v16H38z" />
          <path d="M18 38h16v16H18z" />
          <path d="M42 40h13v13H42z" />
          <path d="M50 52c2 1 4.4 1.2 6.4.4 2.3-.9 3.8-3.1 3.8-5.6V36.5" />
        </svg>
      </div>
      <h2>{hasQuery ? "No matching projects" : "Looking to start a project?"}</h2>
      {!hasQuery && <p>Point Jarvis at a folder on your machine and work on it together.</p>}
      <button type="button" className="projects-empty-btn" onClick={onCreate}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>New project</span>
      </button>
    </section>
  );
}

function ProjectUnavailable() {
  return (
    <section className="projects-empty" aria-live="polite">
      <h2>Projects unavailable</h2>
      <p>Set JARVIS_DB_URL to enable the project store.</p>
    </section>
  );
}

function ProjectListRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const bound = typeof project.conversation_count === "number" ? project.conversation_count : 0;
  return (
    <li className={"projects-page-row" + (project.archived ? " archived" : "")}>
      <button type="button" className="projects-row-main" onClick={onOpen}>
        <span className="project-dot" style={{ background: chipColor(project.slug) }} aria-hidden="true" />
        <span className="projects-row-copy">
          <strong>{project.name}</strong>
          <span>
            {project.slug}
            {project.description ? ` · ${project.description}` : ""}
          </span>
        </span>
      </button>
      <span className="projects-row-count">{t("settingsProjectsBound", bound).replace("{n}", String(bound))}</span>
      <div className="projects-row-actions">
        {project.archived ? (
          <button type="button" className="settings-btn" onClick={() => void restoreProject(project.id)}>
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="settings-btn settings-btn-danger"
            onClick={() => {
              if (confirm(`Archive "${project.name}"? Bound conversations keep working.`)) {
                void archiveProject(project.id);
              }
            }}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  );
}

function ProjectBoard({
  project,
  requirements,
  activeConversationId,
  onChanged,
  onOpenConversation,
}: {
  project: Project;
  requirements: Requirement[];
  activeConversationId: string | null;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const grouped = useMemo(() => {
    const map: Record<RequirementStatus, Requirement[]> = {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const r of requirements) map[r.status].push(r);
    return map;
  }, [requirements]);

  return (
    <section className="project-board" aria-label={`${project.name} board`}>
      <div className="project-board-head">
        <div>
          <div className="project-board-kicker">Project</div>
          <h2>{project.name}</h2>
          {project.description && <p>{project.description}</p>}
        </div>
        <button type="button" className="projects-empty-btn" onClick={() => setCreating(true)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span>New requirement</span>
        </button>
      </div>

      {creating && (
        <RequirementCreatePanel
          projectId={project.id}
          onDone={() => {
            setCreating(false);
            onChanged();
          }}
        />
      )}

      <div className="project-board-columns">
        {COLUMNS.map((col) => (
          <section key={col.status} className="project-board-column">
            <div className="project-board-column-head">
              <h3>{col.label}</h3>
              <span>{grouped[col.status].length}</span>
            </div>
            <div className="project-board-cards">
              {grouped[col.status].length === 0 ? (
                <div className="project-board-empty">No requirements</div>
              ) : (
                grouped[col.status].map((req) => (
                  <RequirementCard
                    key={req.id}
                    requirement={req}
                    activeConversationId={activeConversationId}
                    onChanged={onChanged}
                    onOpenConversation={onOpenConversation}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function RequirementCreatePanel({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    createRequirement({ projectId, title, description });
    setTitle("");
    setDescription("");
    onDone();
  };

  return (
    <section className="requirement-create-panel">
      <label>
        <span>Requirement</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label>
        <span>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      <div className="projects-create-actions">
        <button type="button" className="settings-btn" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="projects-new-btn"
          disabled={!title.trim()}
          onClick={submit}
        >
          Create
        </button>
      </div>
    </section>
  );
}

function RequirementCard({
  requirement,
  activeConversationId,
  onChanged,
  onOpenConversation,
}: {
  requirement: Requirement;
  activeConversationId: string | null;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const canLink =
    !!activeConversationId &&
    !requirement.conversation_ids.includes(activeConversationId);

  const setStatus = (status: RequirementStatus) => {
    updateRequirement(requirement.id, { status });
    onChanged();
  };

  const linkCurrent = () => {
    if (!activeConversationId) return;
    linkRequirementConversation(requirement.id, activeConversationId);
    onChanged();
  };

  return (
    <article className="requirement-card">
      <div className="requirement-card-title">{requirement.title}</div>
      {requirement.description && (
        <p className="requirement-card-desc">{requirement.description}</p>
      )}
      <label className="requirement-status-select">
        <span>Status</span>
        <select value={requirement.status} onChange={(e) => setStatus(e.target.value as RequirementStatus)}>
          {COLUMNS.map((col) => (
            <option key={col.status} value={col.status}>
              {col.label}
            </option>
          ))}
        </select>
      </label>
      <div className="requirement-card-footer">
        <span>{requirement.conversation_ids.length} sessions</span>
        {requirement.conversation_ids[0] && (
          <button type="button" className="requirement-link-btn" onClick={() => onOpenConversation(requirement.conversation_ids[0])}>
            Open
          </button>
        )}
        {canLink && (
          <button type="button" className="requirement-link-btn" onClick={linkCurrent}>
            Link current
          </button>
        )}
      </div>
    </article>
  );
}

function ProjectCreatePanel({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const created = await createProject({
      name: name.trim(),
      description: description.trim() || undefined,
    });
    setBusy(false);
    if (created) onDone();
  };

  return (
    <section className="projects-create-panel">
      <label>
        <span>Project name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </label>
      <div className="projects-create-actions">
        <button type="button" className="settings-btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="projects-new-btn"
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Creating..." : "Create"}
        </button>
      </div>
    </section>
  );
}
