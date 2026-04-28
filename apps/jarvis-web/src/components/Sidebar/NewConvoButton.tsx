// Sidebar "New session" button. When the server has projects
// configured, clicking opens a small popover with two paths:
//
//  - "Free chat" — same as the original behaviour.
//  - one-click pick from the existing project list.
//
// Without projects available it collapses back to the original
// single-action button so deployments without a project store don't
// pay any UX cost.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { newConversation } from "../../services/conversations";
import { isLocalProjectId } from "../../services/projects";
import { chipColor } from "./ProjectsList";
import { t } from "../../utils/i18n";

export function NewConvoButton() {
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const projectsAvailable = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const activeFilter = useAppStore((s) => s.activeProjectFilter);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onClick = () => {
    if (!projectsAvailable || projects.length === 0) {
      // No projects to pick from → behave like the legacy button:
      // start a free-chat session bound to the active filter (so a
      // user inside a project filter still gets a project chat by
      // default).
      const projectId = activeFilter ?? null;
      newConversation({ projectId: isLocalProjectId(projectId) ? null : projectId });
      navigate("/");
      return;
    }
    setOpen((v) => !v);
  };

  const pick = (projectId: string | null) => {
    setOpen(false);
    setSearch("");
    newConversation({ projectId: isLocalProjectId(projectId) ? null : projectId });
    navigate("/");
  };

  const visibleProjects = (() => {
    const q = search.trim().toLowerCase();
    const live = projects.filter((p) => !p.archived);
    if (!q) return live;
    return live.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
    );
  })();

  return (
    <div className="new-convo-wrapper" ref={containerRef}>
      <button
        id="new-convo"
        type="button"
        className="nav-item"
        title={t("newConversation")}
        disabled={!persistEnabled}
        onClick={onClick}
        aria-haspopup={projectsAvailable && projects.length > 0 ? "menu" : undefined}
        aria-expanded={open}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>{t("newSession")}</span>
      </button>

      {open && (
        <div className="new-convo-popover" role="menu">
          <button
            type="button"
            className="new-convo-popover-row default"
            onClick={() => pick(null)}
          >
            <span className="project-dot" aria-hidden="true" />
            <div className="new-convo-popover-text">
              <strong>Free chat</strong>
              <em>No project context</em>
            </div>
          </button>
          {projects.length > 5 && (
            <input
              type="search"
              className="new-convo-popover-search"
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          )}
          <div className="new-convo-popover-list">
            {visibleProjects.length === 0 && (
              <div className="new-convo-popover-empty">No matching projects</div>
            )}
            {visibleProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="new-convo-popover-row"
                onClick={() => pick(p.id)}
                title={p.description ?? p.name}
              >
                <span
                  className="project-dot"
                  style={{ background: chipColor(p.slug) }}
                  aria-hidden="true"
                />
                <div className="new-convo-popover-text">
                  <strong>{p.name}</strong>
                  {p.description ? (
                    <em>{p.description}</em>
                  ) : (
                    <em>{p.slug}</em>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
