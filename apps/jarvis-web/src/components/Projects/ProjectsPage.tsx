import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  ProjectsHome,
  ProjectUnavailable,
} from "./ProjectList";
import { OpenSidebarButton } from "../Workspace/WorkspaceToggles";

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
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [requirementsVersion, setRequirementsVersion] = useState(0);
  const navigate = useNavigate();
  // Selected project lives in the URL (`/projects/:projectId`) so the
  // back button, bookmarks, and sidebar links all behave correctly.
  // The plain `/projects` URL is the list view.
  const { projectId: selectedProjectId = null } = useParams<{
    projectId: string;
  }>();

  useEffect(() => {
    void refreshProjects(includeArchived);
  }, [includeArchived]);

  // `jarvis:new-project` is still fired by the sidebar's "新建项目"
  // button + the Cmd-shortcut wired in `useShortcuts.ts`, so the
  // listener stays. The old `jarvis:open-project` event is gone —
  // the sidebar and the leaderboard now navigate via `/projects/:id`
  // directly, which is cheaper and keeps URL state in sync.
  useEffect(() => {
    const onNewProject = () => setCreating(true);
    window.addEventListener("jarvis:new-project", onNewProject);
    return () => {
      window.removeEventListener("jarvis:new-project", onNewProject);
    };
  }, []);

  useEffect(() => {
    setCreating(false);
  }, [selectedProjectId]);

  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.name, p.slug, p.description ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [projects, query]);

  // ↑/↓ to cycle through the visible project list. Mirrors the docs
  // page pattern so the same muscle memory works on /, /projects,
  // /docs. Gated on `target inside #projects-page` (so arrows on the
  // sidebar / global modal still flow through their own handlers)
  // and `!inEditable` (so search-input cursor keys aren't hijacked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;
      const onPage =
        document.getElementById("projects-page")?.contains(target ?? null) ?? false;
      if (!onPage) return;
      if (visibleProjects.length === 0) return;
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const idx = visibleProjects.findIndex((p) => p.id === selectedProjectId);
      const nextIdx =
        idx < 0
          ? direction === 1
            ? 0
            : visibleProjects.length - 1
          : (idx + direction + visibleProjects.length) % visibleProjects.length;
      void navigate(`/projects/${visibleProjects[nextIdx].id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleProjects, selectedProjectId]);

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

  // Bind the composer's draft to the project the user is currently
  // viewing. The sidebar's "+ New session" reads `draftProjectId`
  // (with `activeProjectFilter` as a fallback), so this is what makes
  // a click in the sidebar create a project-bound chat instead of a
  // free-floating one. Cleared when the URL goes back to `/projects`
  // (no id) so leaving the project page doesn't strand the binding.
  useEffect(() => {
    useAppStore.getState().setDraftProjectId?.(selectedProjectId);
  }, [selectedProjectId]);

  return (
    <main
      id="projects-page"
      className="projects-page"
      aria-label={t("projectsTitle")}
      tabIndex={-1}
    >
      <header className="projects-page-header">
        <OpenSidebarButton />
        {selectedProject && (
          <button
            type="button"
            className="projects-back-btn projects-back-btn-leading"
            onClick={() => {
              void navigate("/projects");
              setQuery("");
            }}
            title={t("projectsBackBtn")}
            aria-label={t("projectsBackBtn")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
            <span>{t("projectsBackBtn")}</span>
          </button>
        )}
        <h1>{selectedProject ? selectedProject.name : t("projectsTitle")}</h1>
        <div className="projects-page-actions">
          {!selectedProject && (
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
          )}
          <label
            className="projects-search"
            aria-label={
              selectedProject
                ? t("projectsSearchInProject")
                : t("projectsSearch")
            }
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
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                selectedProject
                  ? t("projectsSearchInProject")
                  : t("projectsSearch")
              }
            />
          </label>
          {!selectedProject && (
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
          )}
        </div>
      </header>

      {creating && (
        <ProjectCreatePanel
          onDone={(created) => {
            setCreating(false);
            if (created) {
              void navigate(`/projects/${created.id}`);
            }
          }}
        />
      )}

      {selectedProject ? (
        <ProjectBoard
          key={selectedProject.id}
          project={selectedProject}
          requirements={requirements}
          query={query}
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
        <ProjectsHome
          projects={visibleProjects}
          onOpen={(id) => {
            void navigate(`/projects/${id}`);
            setQuery("");
          }}
        />
      )}
    </main>
  );
}
