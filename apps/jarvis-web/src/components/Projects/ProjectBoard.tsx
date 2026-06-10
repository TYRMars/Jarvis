import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Project, Requirement, RequirementRun, RequirementStatus } from "../../types/frames";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";
import {
  approveRequirement,
  createRequirement,
  rejectRequirement,
  updateRequirement,
} from "../../services/requirements";
import { sessionRoute } from "../../services/conversations";
import {
  fetchProjectRuns,
  type ProjectRunHistoryItem,
} from "../../services/projects";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { columnsFor, StatusGlyph, type BoardColumn } from "./columns";
import { ColumnEditor } from "./ColumnEditor";
import { MarkdownLite } from "./MarkdownLite";
import { RequirementDetail } from "./RequirementDetail";
import { RequirementLabelChips, useEnsureLabels } from "./RequirementLabels";
import { ProjectLessonsPanel } from "./ProjectLessonsPanel";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { FilesSurface } from "../Workspace/FilesSurface";
import { Modal } from "../ui";
import { parseRoadmapDescription } from "./roadmapDescription";

type ProjectBoardTab = "board" | "data" | "files";

// The kanban board for a single project: header row, optional inline
// "create requirement" panel, four columns (one per RequirementStatus).
// Each column carries its own Multica-style tint via `status-<x>`.
export function ProjectBoard({
  project,
  requirements,
  query,
  onChanged,
  onOpenConversation,
}: {
  project: Project;
  requirements: Requirement[];
  /// Free-text filter typed in the page header. When non-empty,
  /// requirements whose title or description don't match the query
  /// are hidden from both the kanban columns and the triage strip.
  query?: string;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  // `creatingForStatus` doubles as both visibility flag and which
  // initial column the new requirement should land in. `null` =
  // panel hidden; a status string = panel shown above the columns row,
  // pre-set to that lane (top-level + button = first column,
  // per-column + buttons = that column's id).
  const [creatingForStatus, setCreatingForStatus] =
    useState<RequirementStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phase 3.8 — keep the project's labels hydrated so kanban-card
  // chip lookups (`getLabel(id)`) resolve synchronously on first paint.
  // The hook is defensive when the project id changes; a no-op when
  // the cache is already populated.
  useEnsureLabels(project.id);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);
  const [activeTab, setActiveTab] = useState<ProjectBoardTab>("board");

  // Resolve the active column set. `Project.columns` is the customised
  // list when present; otherwise we get the four built-in defaults
  // (Backlog / In Progress / Review / Done). The memo keys on the
  // identity of the saved array so a PATCH that returns the same
  // shape doesn't churn render loops downstream.
  const cols: BoardColumn[] = useMemo(
    () => columnsFor(project),
    [project.columns],
  );
  const colIds = useMemo(() => new Set(cols.map((c) => c.id)), [cols]);
  const firstColId = cols[0]?.id ?? "backlog";
  const inProgressStatus = useMemo(
    () => cols.find((c) => c.kind === "in_progress" || c.id === "in_progress")?.id ?? null,
    [cols],
  );
  const selected = selectedId
    ? requirements.find((r) => r.id === selectedId) ?? null
    : null;

  // PointerSensor with a 6px activation threshold lets quick clicks
  // through to the card's `onClick` (open detail panel) while still
  // engaging drag for any deliberate motion. Without the threshold
  // every click would start a phantom drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const reqId = String(e.active.id);
    const target = String(e.over.id);
    // Guard against drops onto stale column ids. With custom columns
    // this matters: a board re-render mid-drag could leave a droppable
    // attached to a column that was just removed by the editor.
    if (!colIds.has(target)) return;
    const req = requirements.find((r) => r.id === reqId);
    if (!req || req.status === target) return;
    updateRequirement(reqId, { status: target });
    onChanged();
  };

  // Phase 3.8 — multi-select label filter (OR mode: a row passes
  // if it carries any of the selected ids). Persisted as an in-
  // memory `Set<string>`. Empty set = "show everything".
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
  const toggleLabelFilter = (id: string) => {
    setLabelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Free-text + label filter combined. Empty query and empty label
  // set both mean "no filter" so every requirement passes through.
  const filteredRequirements = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    const noQ = q.length === 0;
    const noLabels = labelFilter.size === 0;
    if (noQ && noLabels) return requirements;
    return requirements.filter((r) => {
      if (
        !noQ &&
        ![r.title, r.description ?? ""].some((v) =>
          v.toLowerCase().includes(q),
        )
      ) {
        return false;
      }
      if (
        !noLabels &&
        !(r.label_ids ?? []).some((id) => labelFilter.has(id))
      ) {
        return false;
      }
      return true;
    });
  }, [requirements, query, labelFilter]);

  // v1.0 — split the row set into kanban-eligible (triage_state
  // approved or absent) vs Triage-queue (anything else). Auto loop
  // would only consume the former, so the human gate is structural.
  // The split is also what the kanban renders over: a triage row in
  // "backlog" should NOT count towards the Backlog column tally.
  const { boardRequirements, triageRequirements } = useMemo(() => {
    const board: Requirement[] = [];
    const triage: Requirement[] = [];
    for (const r of filteredRequirements) {
      const ts = r.triage_state ?? "approved";
      if (ts === "approved") board.push(r);
      else triage.push(r);
    }
    return { boardRequirements: board, triageRequirements: triage };
  }, [filteredRequirements]);

  const { grouped, orphans } = useMemo(() => {
    // Seed with the active column ids so empty lanes still render.
    // Requirements whose `status` doesn't match any current column id
    // (e.g. a column was just removed) collect into a separate
    // bucket and surface as a warning above the board so the data
    // doesn't silently vanish when columns are edited.
    const map: Record<string, Requirement[]> = {};
    for (const c of cols) map[c.id] = [];
    const orphans: Requirement[] = [];
    for (const r of boardRequirements) {
      if (map[r.status]) map[r.status].push(r);
      else orphans.push(r);
    }
    return { grouped: map, orphans };
  }, [boardRequirements, cols]);

  const orphanStatuses = useMemo(() => {
    const set = new Set<string>();
    for (const r of orphans) set.add(r.status);
    return Array.from(set);
  }, [orphans]);

  return (
    <section className="project-board" aria-label={t("projBoardAria", project.name)}>
      <div className="project-board-head">
        {/* The project name is already in the page header (the
            ProjectsPage h1), so we don't repeat it here — duplicate
            titles read like a layout glitch. The optional description
            stays as a one-paragraph subtitle when present. */}
        <div className="project-board-head-meta">
          {project.description && <p>{project.description}</p>}
        </div>
        <div className="project-board-head-actions">
          <button
            type="button"
            className="projects-empty-btn project-board-primary-action"
            onClick={() => setCreatingForStatus(firstColId)}
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
            <span>{t("boardNewReq")}</span>
          </button>
          <button
            type="button"
            className="settings-btn project-board-columns-btn project-board-secondary-action"
            onClick={() => setMemoryOpen(true)}
            aria-label={t("projectMemoryTitle")}
            title={t("projectMemoryTitle")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <path d="M10 9H8" />
              <path d="M16 13H8" />
              <path d="M16 17H8" />
            </svg>
            <span>{t("projectMemoryButton")}</span>
          </button>
          <button
            type="button"
            className="settings-btn project-board-lessons-btn project-board-secondary-action"
            onClick={() => setLessonsOpen(true)}
            aria-label={t("projectLessonsTitle")}
            title={t("projectLessonsTitle")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5" />
              <path d="M9 18h6" />
              <path d="M10 22h4" />
            </svg>
            <span>{t("projectLessonsTitle")}</span>
          </button>
          <Link
            to="/projects/worktrees"
            className="settings-btn project-board-columns-btn project-board-secondary-action"
            aria-label={t("projectWorktreesButton")}
            title={t("projectWorktreesButton")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V3" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="18" r="3" />
              <path d="M12 12v3" />
              <circle cx="12" cy="18" r="3" />
            </svg>
            <span>{t("projectWorktreesButton")}</span>
          </Link>
          <button
            type="button"
            className="settings-btn project-board-columns-btn project-board-secondary-action"
            onClick={() => setEditingColumns(true)}
            aria-label={t("columnEditorOpenBtn")}
            title={t("columnEditorOpenBtn")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
              <path d="M15 3v18" />
            </svg>
            <span>{t("boardColumnSettings")}</span>
          </button>
          <button
            type="button"
            className="settings-btn project-board-columns-btn project-board-secondary-action"
            onClick={() => setSettingsOpen(true)}
            aria-label={t("projectSettingsTitle")}
            title={t("projectSettingsTitle")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{t("projectSettingsTitle")}</span>
          </button>
        </div>
      </div>
      <ProjectMemoryPanel
        project={project}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
      />
      <ProjectLessonsPanel
        project={project}
        open={lessonsOpen}
        onClose={() => setLessonsOpen(false)}
      />
      <ProjectSettingsPanel
        project={project}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      {editingColumns && (
        <ColumnEditor
          project={project}
          onClose={() => {
            setEditingColumns(false);
            onChanged();
          }}
        />
      )}

      {creatingForStatus !== null && (
        <RequirementCreatePanel
          projectId={project.id}
          initialStatus={creatingForStatus}
          columns={cols}
          onDone={() => {
            setCreatingForStatus(null);
            onChanged();
          }}
        />
      )}

      <div className="project-board-toolbar">
        <div
          className="project-board-tabs"
          role="tablist"
          aria-label={t("projectTabsAria")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "board"}
            className={"project-board-tab" + (activeTab === "board" ? " active" : "")}
            onClick={() => setActiveTab("board")}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="6" height="16" rx="1" />
              <rect x="11" y="4" width="6" height="10" rx="1" />
              <rect x="19" y="4" width="2" height="6" rx="1" />
            </svg>
            <span>{t("boardViewBoard")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "data"}
            className={"project-board-tab" + (activeTab === "data" ? " active" : "")}
            onClick={() => setActiveTab("data")}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 19V5" />
              <path d="M4 19h16" />
              <rect x="7" y="11" width="3" height="5" rx="1" />
              <rect x="12" y="7" width="3" height="9" rx="1" />
              <rect x="17" y="9" width="3" height="7" rx="1" />
            </svg>
            <span>{t("projectTabData")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            className={"project-board-tab" + (activeTab === "files" ? " active" : "")}
            onClick={() => setActiveTab("files")}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            <span>{t("projectTabFiles")}</span>
          </button>
        </div>
        <div className="project-board-toolbar-meta">
          <span className="project-board-count tabular-nums">
            {t("boardCount", boardRequirements.length)}
          </span>
        </div>
      </div>

      {activeTab === "data" ? (
        <div role="tabpanel" className="project-board-tab-panel">
          <ProjectAutomationOverview
            project={project}
            requirements={boardRequirements}
            onOpenDetail={(id) => setSelectedId(id)}
          />
        </div>
      ) : activeTab === "files" ? (
        <div role="tabpanel" className="project-board-tab-panel project-board-tab-panel-files">
          <FilesSurface project={project} />
        </div>
      ) : (
        <div role="tabpanel" className="project-board-tab-panel">
          <ProjectLabelFilterBar
            projectId={project.id}
            selected={labelFilter}
            onToggle={toggleLabelFilter}
            onClear={() => setLabelFilter(new Set())}
          />

          {triageRequirements.length > 0 && (
            <TriageDrawer
              candidates={triageRequirements}
              onChanged={onChanged}
              onOpenDetail={(id) => setSelectedId(id)}
            />
          )}

          {orphans.length > 0 && (
            <div
              className="project-board-orphan-banner"
              role="alert"
              aria-live="polite"
            >
              <span>
                {t("boardOrphanedHint", orphans.length, orphanStatuses[0] ?? "")}
              </span>
              <button
                type="button"
                className="ghost-icon"
                onClick={() => setEditingColumns(true)}
              >
                {t("boardEditColumns")}
              </button>
            </div>
          )}

          {/* Tailwind utility on the kanban frame: ensures the columns row
              can shrink against the sidebar without forcing a horizontal
              scrollbar from the legacy `min-width: 0` plumbing. The
              existing `.project-board-columns` class still owns the grid
              template; this is additive, not a replacement.

              The inline `--kanban-col-count` CSS var feeds the grid track
              count in styles.css (`repeat(var(--kanban-col-count, 4),
              minmax(180px, 1fr))`). Without it, customised projects with
              ≥5 columns squeeze into a 4-track grid; with it, the grid
              grows and the existing `overflow-x: auto` rule kicks in once
              the row exceeds the viewport. */}
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div
              className="project-board-columns min-w-0"
              style={
                { "--kanban-col-count": cols.length } as React.CSSProperties
              }
            >
              {cols.map((col) => (
                <section
                  key={col.id}
                  className={
                    "project-board-column" +
                    (col.kind ? " status-" + col.kind : " status-custom")
                  }
                >
                  <div className="project-board-column-head">
                    <StatusGlyph kind={col.kind ?? null} />
                    <h3>{col.label}</h3>
                    <span>{grouped[col.id]?.length ?? 0}</span>
                    <button
                      type="button"
                      className="ghost-icon project-board-column-add"
                      onClick={() => setCreatingForStatus(col.id)}
                      aria-label={t("boardNewReq")}
                      title={t("boardNewReq")}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <DroppableCardList status={col.id}>
                    {(grouped[col.id]?.length ?? 0) === 0 ? (
                      <div className="project-board-empty">{t("boardEmptyCol")}</div>
                    ) : (
                      grouped[col.id].map((req) => (
                        <RequirementCard
                          key={req.id}
                          requirement={req}
                          columns={cols}
                          inProgressStatus={inProgressStatus}
                          onChanged={onChanged}
                          onOpenDetail={() => setSelectedId(req.id)}
                          onOpenConversation={onOpenConversation}
                        />
                      ))
                    )}
                  </DroppableCardList>
                </section>
              ))}
            </div>
          </DndContext>
        </div>
      )}

      <RequirementDetail
        requirement={selected}
        columns={cols}
        onClose={() => setSelectedId(null)}
        onChanged={onChanged}
        onOpenConversation={onOpenConversation}
      />
    </section>
  );
}

// Wraps `.project-board-cards` with a dnd-kit drop zone keyed by
// status. Setting the data via the `id` lets `onDragEnd` resolve the
// target column directly: `String(over.id)` is the new status.
function DroppableCardList({
  status,
  children,
}: {
  status: RequirementStatus;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={"project-board-cards" + (isOver ? " is-drop-target" : "")}
    >
      {children}
    </div>
  );
}

function RequirementCreatePanel({
  projectId,
  initialStatus,
  columns,
  onDone,
}: {
  projectId: string;
  initialStatus: RequirementStatus;
  columns: BoardColumn[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const targetCol = columns.find((c) => c.id === initialStatus);
  const targetLabel = targetCol ? targetCol.label : initialStatus;

  const submit = () => {
    if (!title.trim()) return;
    createRequirement({
      projectId,
      title,
      description,
      status: initialStatus,
    });
    setTitle("");
    setDescription("");
    onDone();
  };

  return (
    <Modal
      open
      onClose={onDone}
      title={t("reqCreateTitle")}
      size="md"
    >
      <form
        className="requirement-create-panel"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="requirement-create-target text-xs text-soft mb-1">
          → {targetLabel}
        </div>
        <label>
          <span>{t("reqCreateTitle")}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          <span>{t("reqCreateDesc")}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </label>
        <div className="projects-create-actions">
          <button type="button" className="settings-btn" onClick={onDone}>
            {t("reqCreateCancel")}
          </button>
          <button type="submit" className="projects-new-btn" disabled={!title.trim()}>
            {t("reqCreateSubmit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RequirementCard({
  requirement,
  columns,
  inProgressStatus,
  onChanged,
  onOpenDetail,
  onOpenConversation,
}: {
  requirement: Requirement;
  columns: BoardColumn[];
  inProgressStatus: RequirementStatus | null;
  onChanged: () => void;
  onOpenDetail: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const desc = parseRoadmapDescription(requirement.description).text;
  const sessions = requirement.conversation_ids.length;
  // Short, monospace-friendly handle for the card head — picks the
  // first 6 hex chars of the UUID so users have something stable to
  // reference verbally / in chat ("REQ-FA2B8E"). Server-side numeric
  // ids would be nicer (Multica's `MUL-17` style) but those need
  // schema work; UUID slicing is good enough for now.
  const idShort = requirement.id.replace(/-/g, "").slice(0, 6).toUpperCase();
  const statusCol = columns.find((c) => c.id === requirement.status);
  const statusLabel = statusCol ? statusCol.label : requirement.status;
  const todos = requirement.todos ?? [];
  const openTodos = todos.filter(
    (todo) => !["passed", "skipped"].includes(todo.status),
  ).length;
  // Pill class still uses kind so the legacy status-* CSS rules apply
  // for built-in columns; custom columns fall through to a neutral
  // class. Without this, a renamed Backlog (`kind: "backlog"`) keeps
  // its dashed-circle pill, while a brand-new "Blocked" custom column
  // gets a token-coloured neutral chip.
  const pillKind = statusCol?.kind ?? null;
  const latestConversationId = requirement.conversation_ids[0] ?? null;
  const isBacklog = statusCol?.kind === "backlog" || requirement.status === "backlog";
  const isInProgress =
    statusCol?.kind === "in_progress" || requirement.status === "in_progress";
  const isDone = statusCol?.kind === "done" || requirement.status === "done";
  const canStart =
    isBacklog && Boolean(inProgressStatus) && !requirement.id.startsWith("req-local-");
  const canOpenConversation =
    Boolean(latestConversationId) && (isInProgress || isDone);
  const primaryActionLabel = canStart
    ? t("reqStart")
    : isInProgress && latestConversationId
      ? t("reqContinue")
      : isDone && latestConversationId
        ? t("reqViewResult")
        : t("reqOpen");

  const handlePrimaryAction = () => {
    if (canStart && inProgressStatus) {
      updateRequirement(requirement.id, { status: inProgressStatus });
      onChanged();
      return;
    }
    if (canOpenConversation && latestConversationId) {
      onOpenConversation(latestConversationId);
      return;
    }
    onOpenDetail();
  };

  // dnd-kit hook: gives us a ref + drag listeners + transform offset
  // while the card is being dragged. The PointerSensor's 6px threshold
  // (configured at the DndContext level) keeps clicks separate from
  // drags so `onCardClick` still opens the detail panel on a tap.
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: requirement.id });
  const dragStyle = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : undefined;

  // Click on blank surface opens the detail panel — buttons / links
  // keep their own click semantics via stopPropagation below.
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    onOpenDetail();
  };

  return (
    <article
      ref={setNodeRef}
      style={dragStyle}
      className={
        "requirement-card has-desc" + (isDragging ? " dragging" : "")
      }
      onClick={onCardClick}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if ((e.target as HTMLElement).closest("button, a")) return;
        e.preventDefault();
        onOpenDetail();
      }}
      aria-label={t("reqOpenDetailAria", requirement.title)}
      {...attributes}
      {...listeners}
    >
      <div className="requirement-card-id">REQ-{idShort}</div>
      <h4 className="requirement-card-title">{requirement.title}</h4>
      {requirement.label_ids && requirement.label_ids.length > 0 && (
        <div className="requirement-card-labels">
          <RequirementLabelChips ids={requirement.label_ids} emptyHint={null} />
        </div>
      )}
      {desc && (
        <div className="requirement-card-desc">
          <MarkdownLite text={desc} />
          <div className="requirement-card-fade" aria-hidden="true" />
        </div>
      )}
      {todos.length > 0 && (
        <div
          className="requirement-card-todos"
          title={`${openTodos}/${todos.length}`}
        >
          <span className="requirement-card-todos-dot" aria-hidden="true" />
          <span className="tabular-nums">
            {openTodos}/{todos.length}
          </span>
        </div>
      )}
      {/* Footer migrated to Tailwind utilities — `text-soft` / `bg-panel`
          etc. are token-bound via `@theme` in styles.css, so the dark
          theme cascade still works. The legacy `requirement-card-*`
          class names stay as semantic anchors but no longer carry
          their own rules. */}
      <div className="requirement-card-footer flex items-center gap-1.5 mt-2 text-xs text-soft">
        <span
          className={
            "requirement-status-pill" +
            (pillKind ? " status-" + pillKind : " status-custom")
          }
          aria-label={t("reqStatusAria", statusLabel)}
        >
          {statusLabel}
        </span>
        {sessions > 0 && latestConversationId && (
          <Link
            to={sessionRoute(latestConversationId)}
            className="requirement-card-sessions shrink-0 px-1 text-soft tabular-nums"
            title={`${t("reqSessions", sessions)} · ${sessionRoute(latestConversationId)}`}
            onClick={(e) => e.stopPropagation()}
          >
            {sessions}×
          </Link>
        )}
        <span className="requirement-card-spacer flex-1" />
        <span className="requirement-card-action-hint">{t("reqClickHint")}</span>
        <div className="requirement-card-actions" aria-label={t("reqCardActions")}>
          <button
            type="button"
            className="requirement-link-btn"
            onClick={(e) => {
              e.stopPropagation();
              handlePrimaryAction();
            }}
            title={canStart ? t("reqStartTitle") : undefined}
          >
            {primaryActionLabel}
          </button>
        </div>
      </div>
    </article>
  );
}

// v1.0 — Triage drawer. Sits above the kanban columns when there's
// at least one `triage_state in {proposed_by_agent, proposed_by_scan}`
// row. Each row gets Approve / Reject buttons that call the matching
// REST endpoint; the cache update is optimistic so the drawer empties
// immediately on click. Reject prompts for a reason (the server's
// `/reject` requires it, and we want it on the audit timeline).
function TriageDrawer({
  candidates,
  onChanged,
  onOpenDetail,
}: {
  candidates: Requirement[];
  onChanged: () => void;
  /// v1.0 polish — let the row title open the detail panel so the
  /// user can read the full description / activity timeline before
  /// approving or rejecting. The detail panel itself surfaces a
  /// "Reject" button when `triage_state` is one of `proposed_by_*`.
  onOpenDetail: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);

  const handleApprove = async (id: string) => {
    await approveRequirement(id);
    onChanged();
  };

  const handleReject = async (id: string) => {
    const raw = window.prompt(t("triageRejectPrompt"));
    if (raw === null) return;
    const reason = raw.trim();
    if (!reason) return;
    try {
      await rejectRequirement(id, reason);
      onChanged();
    } catch (e) {
      console.warn("reject failed", e);
    }
  };

  /// Bulk approve fires every visible candidate's approve in parallel.
  /// We cap parallelism implicitly — the candidate set is the whole
  /// drawer (already filtered to "Backlog + needs triage"), so the
  /// browser's native HTTP queueing is enough headroom. Optimistic
  /// updates land per-row as each promise resolves; the WS frame
  /// reconciliation cleans up if the server rejects any.
  const handleApproveAll = async () => {
    if (bulkPending) return;
    if (!window.confirm(t("triageApproveAllConfirm", candidates.length))) {
      return;
    }
    setBulkPending(true);
    const settled = await Promise.allSettled(
      candidates.map((c) => approveRequirement(c.id)),
    );
    const failed = settled.filter((s) => s.status === "rejected").length;
    setBulkPending(false);
    onChanged();
    if (failed > 0) {
      console.warn(`triage: ${failed}/${candidates.length} approve failed`);
    }
  };

  return (
    <section className="triage-drawer" aria-label={t("projBoardTriageQueueAria")}>
      <header className="triage-drawer-head">
        <span className="triage-drawer-title tabular-nums" aria-live="polite">
          {t("triageHeader", candidates.length)}
        </span>
        <div className="triage-drawer-head-actions">
          {candidates.length >= 2 && (
            <button
              type="button"
              className="triage-drawer-approve-all"
              onClick={() => void handleApproveAll()}
              disabled={bulkPending}
              title={t("triageApproveAllHint")}
            >
              {bulkPending
                ? t("triageApproveAllBusy")
                : t("triageApproveAll", candidates.length)}
            </button>
          )}
          <button
            type="button"
            className="triage-drawer-toggle"
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? t("triageExpand") : t("triageCollapse")}
          </button>
        </div>
      </header>
      {!collapsed && (
        <ul className="triage-list">
          {candidates.map((c) => {
            const source: "agent" | "scan" =
              c.triage_state === "proposed_by_scan" ? "scan" : "agent";
            return (
              <li key={c.id} className="triage-row">
                <span className={"triage-source triage-source-" + source}>
                  {source === "agent"
                    ? t("triageSourceAgent")
                    : t("triageSourceScan")}
                </span>
                <button
                  type="button"
                  className="triage-title triage-title-link"
                  title={c.title}
                  onClick={() => onOpenDetail(c.id)}
                >
                  {c.title}
                </button>
                <div className="triage-actions">
                  <button
                    type="button"
                    className="triage-btn triage-btn-approve"
                    onClick={() => void handleApprove(c.id)}
                  >
                    {t("triageApprove")}
                  </button>
                  <button
                    type="button"
                    className="triage-btn triage-btn-reject"
                    onClick={() => void handleReject(c.id)}
                  >
                    {t("triageReject")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProjectAutomationOverview({
  project,
  requirements,
  onOpenDetail,
}: {
  project: Project;
  requirements: Requirement[];
  onOpenDetail: (id: string) => void;
}) {
  const [runs, setRuns] = useState<ProjectRunHistoryItem[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setUnavailable(false);
    void fetchProjectRuns(project.id, 40)
      .then((body) => {
        if (cancelled) return;
        if (!body) {
          setRuns([]);
          setUnavailable(true);
          return;
        }
        setRuns(body.items);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const eligible = requirements.filter((r) => {
    const triage = r.triage_state ?? "approved";
    return (
      triage === "approved" &&
      (r.status === "backlog" || r.status === "in_progress" || r.status === "review")
    );
  }).length;
  const running = runs?.filter((r) => r.status === "pending" || r.status === "running").length ?? 0;
  const failed = runs?.filter((r) => r.status === "failed") ?? [];
  const completed = runs?.filter((r) => r.status === "completed").length ?? 0;
  const recent = runs?.slice(0, 5) ?? [];
  const latestFailed = failed.slice(0, 3);

  return (
    <section className="project-automation-overview" aria-label={t("projectAutomationOverview")}>
      <div className="project-automation-kpis">
        <OverviewKpi label={t("projectAutoEligible")} value={eligible} />
        <OverviewKpi label={t("projectAutoRunning")} value={running} tone={running ? "info" : undefined} />
        <OverviewKpi label={t("projectAutoCompleted")} value={completed} tone="success" />
        <OverviewKpi label={t("projectAutoFailed")} value={failed.length} tone={failed.length ? "danger" : undefined} />
      </div>
      <div className="project-automation-lists">
        <div className="project-automation-list">
          <div className="project-automation-list-head">
            <span>{t("projectAutoRecentRuns")}</span>
            {unavailable && <span className="text-soft">{t("diagnosticsRunStoreUnavailable")}</span>}
            {err && <span className="project-automation-error">{err}</span>}
          </div>
          {recent.length === 0 ? (
            <p className="project-automation-empty">{t("runsEmpty")}</p>
          ) : (
            <ul>
              {recent.map((run) => (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenDetail(run.requirement_id)}>
                    <span className={"requirement-run-pill run-status-" + run.status}>
                      {runStatusText(run)}
                    </span>
                    <span className="project-automation-run-title">
                      {run.requirement_title ?? run.requirement_id}
                    </span>
                    <span className="project-automation-run-time">{relTime(run.started_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="project-automation-list">
          <div className="project-automation-list-head">
            <span>{t("projectAutoFailures")}</span>
          </div>
          {latestFailed.length === 0 ? (
            <p className="project-automation-empty">{t("diagnosticsNoFailed")}</p>
          ) : (
            <ul>
              {latestFailed.map((run) => (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenDetail(run.requirement_id)}>
                    <span className="project-automation-run-title">
                      {run.requirement_title ?? run.requirement_id}
                    </span>
                    <span className="project-automation-error-line">
                      {firstRunError(run)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function OverviewKpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "info" | "success" | "danger";
}) {
  return (
    <div className={"project-automation-kpi" + (tone ? " tone-" + tone : "")}>
      <span className="project-automation-kpi-value tabular-nums">{value}</span>
      <span className="project-automation-kpi-label">{label}</span>
    </div>
  );
}

function runStatusText(run: RequirementRun): string {
  switch (run.status) {
    case "pending":
      return t("runStatusPending");
    case "running":
      return t("runStatusRunning");
    case "completed":
      return t("runStatusCompleted");
    case "failed":
      return t("runStatusFailed");
    case "cancelled":
      return t("runStatusCancelled");
  }
}

function firstRunError(run: RequirementRun): string {
  const log = run.logs?.find((entry) => entry.level === "error");
  return run.error || log?.message || t("error");
}

// =============================================================
// Label filter bar — Phase 3.8.
// =============================================================
//
// Renders a row of toggleable label chips above the kanban columns.
// One chip per project label, plus a "Clear" affordance when at
// least one filter is active. Chips use the same `LabelChip`
// component the kanban cards do, so a recolour in Settings → Labels
// repaints both surfaces in lockstep.
//
// The filter state itself is owned by the parent `ProjectBoard`
// so it can feed into the requirement-filter `useMemo`.

import {
  listLabelsForProject,
  subscribeLabels,
} from "../../services/labels";
import { LabelChip } from "./RequirementLabels";

function ProjectLabelFilterBar({
  projectId,
  selected,
  onToggle,
  onClear,
}: {
  projectId: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [, bump] = useState(0);
  // Subscribe to per-project label cache mutations so the bar
  // repaints when settings adds / renames / removes a label.
  useEffect(() => subscribeLabels(projectId, () => bump((n) => n + 1)), [
    projectId,
  ]);
  const labels = listLabelsForProject(projectId);
  if (labels.length === 0) return null;
  const activeCount = selected.size;
  return (
    <div
      className="project-board-label-filter"
      role="toolbar"
      aria-label={t("labelsFilterAriaLabel")}
    >
      <span className="project-board-label-filter-label">
        {t("labelsFilterHeading")}
      </span>
      {labels.map((l) => {
        const on = selected.has(l.id);
        return (
          <button
            key={l.id}
            type="button"
            className={
              "project-board-label-filter-chip" + (on ? " is-on" : "")
            }
            aria-pressed={on}
            onClick={() => onToggle(l.id)}
            title={l.description ?? l.name}
          >
            <LabelChip label={l} />
          </button>
        );
      })}
      {activeCount > 0 && (
        <button
          type="button"
          className="project-board-label-filter-clear"
          onClick={onClear}
        >
          {t("labelsFilterClear", activeCount)}
        </button>
      )}
    </div>
  );
}
