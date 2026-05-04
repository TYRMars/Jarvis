import { useEffect, useMemo, useState } from "react";
import type {
  Project,
  ProjectWorkspace,
  RequirementStatus,
} from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  archiveProject,
  createProject,
  restoreProject,
} from "../../services/projects";
import {
  listRequirements,
  loadRequirements,
} from "../../services/requirements";
import { EmptyState } from "../shared/EmptyState";
import { chipColor } from "../../utils/chipColor";
import {
  ProjectWorkspacesEditor,
  compactWorkspaces,
} from "./ProjectWorkspacesEditor";

// Note: `t` is imported above (already used by `projects-row-count`).
// Recent additions wire it through every user-visible string in this
// file so the projects index follows the active language.

// Single row in the projects list view (renders for each project the
// user has access to). Clicking the row body opens the kanban; the
// archive / restore action sits as a tail button.
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

// v1.0 — single project tile in the home grid. Pulls the cached
// requirements for the project and renders a tiny "backlog · in
// progress · review · done" count strip so the user can spot
// where the work is at a glance without drilling in. Click anywhere
// on the tile to open the kanban.
//
// The card subscribes implicitly via [`listRequirements`] which
// reads the in-memory cache; the parent page already invokes
// `loadRequirements(p.id)` for every visible project on mount and
// re-renders on cache change, so we don't need our own loader here.
export function ProjectGridCard({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  const reqs = listRequirements(project.id);
  const counts = useMemo(() => {
    const c: Record<RequirementStatus, number> = {
      backlog: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };
    for (const r of reqs) {
      const triage = r.triage_state ?? "approved";
      if (triage !== "approved") continue; // exclude proposed-by-* (Triage queue)
      c[r.status] = (c[r.status] ?? 0) + 1;
    }
    return c;
  }, [reqs]);
  const total = counts.backlog + counts.in_progress + counts.review + counts.done;

  return (
    <button
      type="button"
      className={"project-grid-card" + (project.archived ? " archived" : "")}
      onClick={onOpen}
    >
      <header className="project-grid-card-head">
        <span
          className="project-dot"
          style={{ background: chipColor(project.slug) }}
          aria-hidden="true"
        />
        <h3>{project.name}</h3>
        {project.archived && (
          <span className="project-grid-card-archived">
            {t("projectListArchived")}
          </span>
        )}
      </header>
      {/* Description slot is always rendered (em-dash placeholder when
          empty) so every card has the same height — without it cards
          with descriptions sit taller than ones without and the grid
          looks ragged. The `title` attribute carries the full text so
          the 2-line clamp doesn't silently swallow long descriptions. */}
      <p
        className={
          "project-grid-card-desc" +
          (project.description ? "" : " is-empty")
        }
        title={project.description || undefined}
      >
        {project.description || "—"}
      </p>
      <footer className="project-grid-card-counts">
        <CountChip label={t("colBacklog")} value={counts.backlog} tone="backlog" />
        <CountChip label={t("colInProgress")} value={counts.in_progress} tone="in_progress" />
        <CountChip label={t("colReview")} value={counts.review} tone="review" />
        <CountChip label={t("colDone")} value={counts.done} tone="done" />
        <span className="project-grid-card-total">
          {t("projectGridTotal", total)}
        </span>
      </footer>
    </button>
  );
}

function CountChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span
      className={"project-grid-count count-" + tone + (value === 0 ? " is-zero" : "")}
      title={label}
    >
      <span className="project-grid-count-label">{label}</span>
      <span className="project-grid-count-value tabular-nums">{value}</span>
    </span>
  );
}

// v1.0 — projects-home body: a grid of project cards covering the
// content area, plus a one-line aggregate summary above the grid.
// Replaces the previous "drop the whole WorkOverview here" choice,
// which left the page empty of project chrome and forced users to
// hit the sidebar to find their projects.
//
// Side effect on mount / projects-list change: kick a
// `loadRequirements(p.id)` for every visible project so the count
// chips render with real data instead of zeroes. Idempotent — the
// service-layer cache dedupes follow-ups.
export function ProjectsHome({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
}) {
  const ids = projects.map((p) => p.id).join(",");
  useEffect(() => {
    for (const p of projects) {
      void loadRequirements(p.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // Re-read every render. The parent (ProjectsPage) re-renders on
  // every requirements-cache bump (via `subscribeRequirements`), so
  // memoising on `[projects, ids]` here would silently freeze the
  // summary at boot-time zeros — `projects` reference + the joined
  // ids string don't change when only the per-project requirement
  // lists do. The loop is O(projects × requirements), cheap.
  const totals: Record<RequirementStatus, number> = {
    backlog: 0,
    in_progress: 0,
    review: 0,
    done: 0,
  };
  for (const p of projects) {
    for (const r of listRequirements(p.id)) {
      const triage = r.triage_state ?? "approved";
      if (triage !== "approved") continue;
      totals[r.status] = (totals[r.status] ?? 0) + 1;
    }
  }

  return (
    <section className="projects-home" aria-label={t("projectsTitle")}>
      <div className="projects-home-summary text-soft">
        <span>{t("projectGridProjectCount", projects.length)}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t("colBacklog")} <strong>{totals.backlog}</strong>
        </span>
        <span>
          {t("colInProgress")} <strong>{totals.in_progress}</strong>
        </span>
        <span>
          {t("colReview")} <strong>{totals.review}</strong>
        </span>
        <span>
          {t("colDone")} <strong>{totals.done}</strong>
        </span>
      </div>
      <div className="projects-grid">
        {projects.map((p) => (
          <ProjectGridCard key={p.id} project={p} onOpen={() => onOpen(p.id)} />
        ))}
      </div>
    </section>
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
    <EmptyState
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
          <path d="M3 10h18" />
        </svg>
      }
      title={hasQuery ? t("projectListEmptyNoMatch") : t("projectListEmptyTitle")}
      hint={hasQuery ? undefined : t("projectListEmptyHint")}
      cta={
        hasQuery
          ? undefined
          : {
              label: t("projectsNewBtn"),
              onClick: onCreate,
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              ),
            }
      }
    />
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
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const created = await createProject({
      name: name.trim(),
      description: description.trim() || undefined,
      workspaces: compactWorkspaces(workspaces),
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
      <div className="projects-create-section">
        <span className="projects-create-section-title">
          {t("projectWorkspacesTitle")}
        </span>
        <p className="projects-create-section-hint">{t("projectWorkspacesHint")}</p>
        <ProjectWorkspacesEditor value={workspaces} onChange={setWorkspaces} />
      </div>
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
