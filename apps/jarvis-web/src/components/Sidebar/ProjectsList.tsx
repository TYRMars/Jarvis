// Sidebar Projects section. Sits above the conversation list and lets
// the user filter the conversation rail by project. The "+" button
// pops up an inline create form (slug derives from name; pass through
// to the REST CRUD in `services/projects.ts`).
//
// Hidden entirely when the server has no `ProjectStore` configured
// (`projectsAvailable === false`) — the conversation list keeps
// working without it.

import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { archiveProject, createProject, restoreProject } from "../../services/projects";
import { refreshConvoList } from "../../services/conversations";

export function ProjectsList() {
  const available = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const activeFilter = useAppStore((s) => s.activeProjectFilter);
  const setFilter = useAppStore((s) => s.setActiveProjectFilter);
  const [creating, setCreating] = useState(false);

  if (!available) return null;

  const onPickFilter = (id: string | null) => {
    setFilter(id);
    void refreshConvoList();
  };

  return (
    <div className="sidebar-section projects-section">
      <div className="section-label projects-section-header">
        <span>Projects</span>
        <button
          type="button"
          className="ghost-icon projects-create-btn"
          title="New project"
          aria-label="New project"
          onClick={() => setCreating(true)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>

      {creating && <CreateProjectForm onDone={() => setCreating(false)} />}

      <ul className="projects-list">
        <li
          className={"project-row" + (activeFilter === null ? " active" : "")}
          onClick={() => onPickFilter(null)}
          role="button"
          tabIndex={0}
        >
          <span className="project-dot all" aria-hidden="true" />
          <span className="project-name">All conversations</span>
        </li>
        {projects.map((p) => (
          <li
            key={p.id}
            className={
              "project-row" +
              (activeFilter === p.id ? " active" : "") +
              (p.archived ? " archived" : "")
            }
            onClick={() => onPickFilter(p.id)}
            role="button"
            tabIndex={0}
            title={p.description ?? p.name}
          >
            <span className="project-dot" style={{ background: chipColor(p.slug) }} aria-hidden="true" />
            <span className="project-name">{p.name}</span>
            {typeof p.conversation_count === "number" && p.conversation_count > 0 && (
              <span className="project-count">{p.conversation_count}</span>
            )}
            <ProjectRowActions project={p} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectRowActions({ project }: { project: { id: string; archived: boolean } }) {
  return (
    <div className="project-row-actions">
      {project.archived ? (
        <button
          type="button"
          className="convo-action"
          title="Restore"
          aria-label="Restore project"
          onClick={(e) => {
            e.stopPropagation();
            void restoreProject(project.id);
          }}
        >
          ↺
        </button>
      ) : (
        <button
          type="button"
          className="convo-action delete"
          title="Archive"
          aria-label="Archive project"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm("Archive this project? Bound conversations keep working.")) {
              void archiveProject(project.id);
            }
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !instructions.trim() || busy) return;
    setBusy(true);
    const created = await createProject({
      name: name.trim(),
      instructions: instructions.trim(),
    });
    setBusy(false);
    if (created) onDone();
  };

  return (
    <div className="project-create-form" onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <textarea
        placeholder="Instructions injected into every turn..."
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={4}
      />
      <div className="project-create-form-actions">
        <button type="button" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !instructions.trim()}
        >
          {busy ? "Creating..." : "Create"}
        </button>
      </div>
    </div>
  );
}

/// Deterministic colour from a slug, so a chip looks the same every
/// session without the server tracking colour. Hash → HSL.
export function chipColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}deg 55% 55%)`;
}
