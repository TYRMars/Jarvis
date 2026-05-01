import { useState } from "react";
import type { Project } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  archiveProject,
  createProject,
  restoreProject,
} from "../../services/projects";
import { chipColor } from "../Sidebar/ProjectsList";

// Note: `t` is imported above (already used by `projects-row-count`).
// Recent additions wire it through every user-visible string in this
// file so the projects index follows the active language.

// Single row in the projects list view (renders for each project the
// user has access to). Clicking the row body opens the kanban; the
// archive / restore action sits as a tail button.
//
// Distinct from `Sidebar/ProjectsList.tsx` which is the smaller chip
// list in the left rail — same data, different presentation.
export function ProjectListRow({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  const bound =
    typeof project.conversation_count === "number"
      ? project.conversation_count
      : 0;
  return (
    <li
      className={"projects-page-row" + (project.archived ? " archived" : "")}
    >
      <button type="button" className="projects-row-main" onClick={onOpen}>
        <span
          className="project-dot"
          style={{ background: chipColor(project.slug) }}
          aria-hidden="true"
        />
        <span className="projects-row-copy">
          <strong>{project.name}</strong>
          <span>
            {project.slug}
            {project.description ? ` · ${project.description}` : ""}
          </span>
        </span>
      </button>
      <span className="projects-row-count">
        {t("settingsProjectsBound", bound).replace("{n}", String(bound))}
      </span>
      <div className="projects-row-actions">
        {project.archived ? (
          <button
            type="button"
            className="settings-btn"
            onClick={() => void restoreProject(project.id)}
          >
            {t("projectListRestore")}
          </button>
        ) : (
          <button
            type="button"
            className="settings-btn settings-btn-danger"
            onClick={() => {
              if (confirm(t("projectListArchiveConfirm", project.name))) {
                void archiveProject(project.id);
              }
            }}
          >
            {t("projectListArchive")}
          </button>
        )}
      </div>
    </li>
  );
}

// Shown when the user has no projects yet, or when their search
// query yields zero matches. The "create" CTA is conditional on
// query state — we don't tell people to "start a project" when
// they're already in a search session.
export function ProjectEmptyState({
  hasQuery,
  onCreate,
}: {
  hasQuery: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="projects-empty" aria-live="polite">
      <div className="projects-empty-icon" aria-hidden="true">
        <svg
          width="72"
          height="72"
          viewBox="0 0 72 72"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 18h16v16H18z" />
          <path d="M38 18h16v16H38z" />
          <path d="M18 38h16v16H38z" />
          <path d="M42 40h13v13H42z" />
          <path d="M50 52c2 1 4.4 1.2 6.4.4 2.3-.9 3.8-3.1 3.8-5.6V36.5" />
        </svg>
      </div>
      <h2>
        {hasQuery ? t("projectListEmptyNoMatch") : t("projectListEmptyTitle")}
      </h2>
      {!hasQuery && <p>{t("projectListEmptyHint")}</p>}
      <button type="button" className="projects-empty-btn" onClick={onCreate}>
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
    </section>
  );
}

// Shown when the server's project store is unconfigured (no
// `JARVIS_DB_URL` or 503 from `/v1/projects`). Distinct copy from
// the empty state — this is an operator config problem, not a "you
// have nothing yet" state.
export function ProjectUnavailable() {
  return (
    <section className="projects-empty" aria-live="polite">
      <h2>{t("projectListUnavailable")}</h2>
      <p>{t("projectListUnavailableHint")}</p>
    </section>
  );
}

export function ProjectCreatePanel({ onDone }: { onDone: () => void }) {
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
        <span>{t("projectCreateName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label>
        <span>{t("projectCreateDesc")}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </label>
      <div className="projects-create-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={onDone}
          disabled={busy}
        >
          {t("projectCreateCancel")}
        </button>
        <button
          type="button"
          className="projects-new-btn"
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
        >
          {busy ? t("projectCreateBusy") : t("projectCreateSubmit")}
        </button>
      </div>
    </section>
  );
}
