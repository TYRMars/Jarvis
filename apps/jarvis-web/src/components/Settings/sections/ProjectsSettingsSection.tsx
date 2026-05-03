// Project management section. Lists every project (including
// archived ones if the user toggles the switch), shows each one's
// metadata + bound conversation count, and exposes archive /
// restore / hard-delete actions per row. Inline edit of name /
// description / instructions stays in the sidebar's modal +
// `jarvis project edit` for v1; the v1 settings page focuses on
// "is this project still useful?" — the lifecycle stuff.

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../../store/appStore";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  archiveProject,
  refreshProjects,
  restoreProject,
  updateProject,
} from "../../../services/projects";
import { chipColor } from "../../../utils/chipColor";
import { confirm } from "../../ui";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function ProjectsSettingsSection({ embedded }: { embedded?: boolean } = {}) {
  const available = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const [showArchived, setShowArchived] = useState(false);

  // Fetch with the right `include_archived` whenever the toggle
  // flips, so the archived rows actually show up.
  useEffect(() => {
    void refreshProjects(showArchived);
  }, [showArchived]);

  if (!available) {
    return (
      <Section
        id="projects"
        titleKey="settingsProjectsTitle"
        titleFallback="Projects"
        descKey="settingsServerDesc"
        descFallback="Server has no project store configured."
        embedded={embedded}
      >
        <p className="settings-empty">
          {tx(
            "settingsServerNotConfigured",
            "Project store not configured on the server.",
          )}
        </p>
      </Section>
    );
  }

  return (
    <Section
      id="projects"
      titleKey="settingsProjectsTitle"
      titleFallback="Projects"
      descKey="settingsProjectsDesc"
      descFallback="Reusable context containers."
      embedded={embedded}
    >
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{tx("settingsProjectsArchived", "Archived")}</div>
        </div>
        <div className="settings-row-control">
          <label className="settings-toggle">
            <span className="settings-toggle-label">{tx("settingsProjectsArchived", "Archived")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={showArchived}
              className={"settings-switch" + (showArchived ? " on" : "")}
              onClick={() => setShowArchived((v) => !v)}
              title={showArchived ? "show all" : "hide archived"}
            >
              <span className="settings-switch-thumb" />
            </button>
          </label>
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="settings-empty">
          {tx("settingsProjectsEmpty", "No projects yet.")}
        </p>
      ) : (
        <ul className="settings-projects">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </ul>
      )}

      <p className="settings-row-hint">
        {tx(
          "settingsProjectsManageHint",
          "For richer editing use `jarvis project edit <slug>`.",
        )}
      </p>
    </Section>
  );
}

function ProjectRow({
  project,
}: {
  project: ReturnType<typeof useAppStore.getState>["projects"][number];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [busy, setBusy] = useState(false);

  // If the row prop changes underneath us (refresh after edit / archive
  // elsewhere), seed the editor with the latest values rather than
  // showing stale text.
  useEffect(() => {
    setName(project.name);
    setInstructions(project.instructions);
  }, [project.name, project.instructions]);

  const dot = useMemo(() => chipColor(project.slug), [project.slug]);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    await updateProject(project.id, {
      name: name.trim() || undefined,
      instructions: instructions.trim() || undefined,
    });
    setBusy(false);
    setEditing(false);
  };

  return (
    <li className={"settings-project-row" + (project.archived ? " archived" : "")}>
      <div className="settings-project-head">
        <span className="project-dot" style={{ background: dot }} aria-hidden="true" />
        <div className="settings-project-meta">
          <strong>{project.name}</strong>
          <span className="muted mono"> · {project.slug}</span>
          {project.archived && (
            <span className="settings-tag" style={{ marginLeft: 8 }}>
              {tx("settingsProjectsArchived", "Archived")}
            </span>
          )}
          {typeof project.conversation_count === "number" && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              · {tx("settingsProjectsBound", `${project.conversation_count} bound`)
                .replace("{n}", String(project.conversation_count))}
            </span>
          )}
        </div>
        <div className="settings-project-actions">
          {project.archived ? (
            <button
              type="button"
              className="settings-btn settings-btn-ghost"
              onClick={() => void restoreProject(project.id)}
            >
              {tx("settingsRefresh", "Restore")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="settings-btn settings-btn-ghost"
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? tx("cancel", "Cancel") : tx("rename", "Edit")}
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Archive "${project.name}"?`,
                    detail: "Bound conversations keep working.",
                    danger: true,
                    confirmLabel: t("uiConfirmArchiveOk"),
                  });
                  if (ok) void archiveProject(project.id);
                }}
              >
                {tx("delete", "Archive")}
              </button>
            </>
          )}
        </div>
      </div>

      {project.description && (
        <div className="settings-project-desc muted">{project.description}</div>
      )}

      {editing && (
        <div className="settings-project-edit">
          <label>
            <span className="settings-row-hint">{tx("rename", "Name")}</span>
            <input
              type="text"
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span className="settings-row-hint">instructions</span>
            <textarea
              className="settings-input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
            />
          </label>
          <div className="settings-input-row">
            <button
              type="button"
              className="settings-btn"
              disabled={busy || (!name.trim() && !instructions.trim())}
              onClick={() => void onSave()}
            >
              {busy ? "…" : tx("settingsSave", "Save")}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-ghost"
              onClick={() => {
                setName(project.name);
                setInstructions(project.instructions);
                setEditing(false);
              }}
              disabled={busy}
            >
              {tx("cancel", "Cancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
