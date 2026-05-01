import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { refreshProjects } from "../../services/projects";
import { resumeConversation } from "../../services/conversations";
import {
  listRequirements,
  loadRequirements,
  subscribeRequirements,
} from "../../services/requirements";
import { ProjectBoard } from "./ProjectBoard";
import {
  ProjectCreatePanel,
  ProjectEmptyState,
  ProjectListRow,
  ProjectUnavailable,
} from "./ProjectList";

// Top-level Projects route: search + list + create + open. Three view
// modes share the same chrome (header search / new-project), the body
// switches between create panel, board (when a project is selected),
// or the list. Children live in sibling files:
//
//   ./columns          — COLUMNS const + StatusGlyph SVG set
//   ./MarkdownLite     — tiny renderer used by RequirementCard
//   ./ProjectBoard     — kanban + RequirementCard + status chip
//   ./ProjectList      — list row, empty-state, unavailable, create panel
export function ProjectsPage() {
  const available = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const activeConversationId = useAppStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
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
      [p.name, p.slug, p.description ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
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

  // Re-render whenever the requirements service cache changes —
  // covers REST loads, optimistic mutations, and WS-driven
  // reconciliation (`requirement_upserted` / `requirement_deleted`).
  useEffect(() => {
    return subscribeRequirements(() =>
      setRequirementsVersion((v) => v + 1),
    );
  }, []);

  // Refresh from the server when the selected project changes.
  // Idempotent — falls back to localStorage-backed cache on 503 /
  // network failure, so the kanban stays usable air-gapped.
  useEffect(() => {
    if (selectedProject) void loadRequirements(selectedProject.id);
  }, [selectedProject?.id]);

  return (
    <main
      id="projects-page"
      className="projects-page"
      aria-label={t("projectsTitle")}
      tabIndex={-1}
    >
      <header className="projects-page-header">
        <h1>{t("projectsTitle")}</h1>
        <div className="projects-page-actions">
          <button
            type="button"
            className={
              "ghost-icon projects-archive-toggle" +
              (includeArchived ? " active" : "")
            }
            aria-label={
              includeArchived
                ? t("projectsArchiveHide")
                : t("projectsArchiveShow")
            }
            title={
              includeArchived
                ? t("projectsArchiveHide")
                : t("projectsArchiveShow")
            }
            onClick={() => setIncludeArchived((v) => !v)}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 7h16" />
              <path d="M7 11h10" />
              <path d="M10 15h4" />
            </svg>
          </button>
          <label className="projects-search" aria-label={t("projectsSearch")}>
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("projectsSearch")}
            />
          </label>
          {selectedProject && (
            <button
              type="button"
              className="projects-back-btn"
              onClick={() => setSelectedProjectId(null)}
            >
              {t("projectsBackBtn")}
            </button>
          )}
          <button
            type="button"
            className="projects-new-btn"
            onClick={() => setCreating(true)}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span>{t("projectsNewBtn")}</span>
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
            void navigate("/");
          }}
        />
      ) : !available ? (
        <ProjectUnavailable />
      ) : visibleProjects.length === 0 ? (
        <ProjectEmptyState
          hasQuery={query.trim().length > 0}
          onCreate={() => setCreating(true)}
        />
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
