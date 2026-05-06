import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { Project, Requirement, RequirementStatus } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  approveRequirement,
  createRequirement,
  rejectRequirement,
  updateRequirement,
} from "../../services/requirements";
import {
  getAutoModeStatus,
  setAutoModeEnabled,
  type AutoModeStatus,
} from "../../services/autoMode";
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
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { Modal } from "../ui";
import { parseRoadmapDescription } from "./roadmapDescription";

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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);

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

  // Free-text filter typed in the page header. Match on title +
  // description, case-insensitive. Empty query means "no filter" so
  // every requirement passes through.
  const filteredRequirements = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return requirements;
    return requirements.filter((r) =>
      [r.title, r.description ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [requirements, query]);

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

  const grouped = useMemo(() => {
    // Seed with the active column ids so empty lanes still render.
    // Requirements whose `status` doesn't match any current column id
    // (e.g. a column was just removed) land in a synthetic bucket
    // keyed by the orphan status — they're not displayed on the
    // board, but the data isn't lost on disk and a future column
    // edit can restore them.
    const map: Record<string, Requirement[]> = {};
    for (const c of cols) map[c.id] = [];
    for (const r of boardRequirements) {
      if (map[r.status]) map[r.status].push(r);
    }
    return map;
  }, [boardRequirements, cols]);

  return (
    <section className="project-board" aria-label={`${project.name} board`}>
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
          <span className="project-board-action-separator" aria-hidden="true" />
          <button
            type="button"
            className="settings-btn project-board-columns-btn"
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
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15z" />
              <path d="M8 7h8" />
              <path d="M8 11h6" />
            </svg>
            <span>{t("projectMemoryButton")}</span>
          </button>
          <button
            type="button"
            className="settings-btn project-board-columns-btn"
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
              <rect x="3" y="4" width="5" height="16" rx="1" />
              <rect x="10" y="4" width="5" height="16" rx="1" />
              <rect x="17" y="4" width="4" height="10" rx="1" />
            </svg>
            <span>{t("boardColumnSettings")}</span>
          </button>
          <button
            type="button"
            className="settings-btn project-board-columns-btn"
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
        <div className="project-board-view-label" aria-label={t("boardViewBoard")}>
          <span className="project-board-tab active">
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
          </span>
        </div>
        <div className="project-board-toolbar-meta">
          <AutoModeToggle />
          <span className="project-board-count tabular-nums">
            {t("boardCount", boardRequirements.length)}
          </span>
        </div>
      </div>

      {triageRequirements.length > 0 && (
        <TriageDrawer
          candidates={triageRequirements}
          onChanged={onChanged}
          onOpenDetail={(id) => setSelectedId(id)}
        />
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
        {sessions > 0 && (
          <span
            className="requirement-card-sessions shrink-0 px-1 text-soft tabular-nums"
            title={t("reqSessions", sessions)}
          >
            {sessions}×
          </span>
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

  return (
    <section className="triage-drawer" aria-label="Triage queue">
      <header className="triage-drawer-head">
        <span className="triage-drawer-title tabular-nums" aria-live="polite">
          {t("triageHeader", candidates.length)}
        </span>
        <button
          type="button"
          className="triage-drawer-toggle"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? t("triageExpand") : t("triageCollapse")}
        </button>
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

// v1.0 — runtime on/off switch for the auto-mode scheduler. Polls
// `/v1/auto-mode` once on mount so the toggle reflects the binary's
// startup state (`JARVIS_WORK_MODE`); subsequent flips POST and
// reconcile from the server's response. Hides itself entirely when
// the binary isn't wired with an `AutoModeRuntime` (tests, mcp-serve)
// — no point showing a control that returns 503.
function AutoModeToggle() {
  const [status, setStatus] = useState<AutoModeStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAutoModeStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.configured) return null;

  const handleToggle = async () => {
    if (pending) return;
    setPending(true);
    setErr(null);
    try {
      const next = await setAutoModeEnabled(!status.enabled);
      setStatus(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      className={
        "auto-mode-toggle" + (status.enabled ? " is-on" : "") + (pending ? " is-pending" : "")
      }
      onClick={() => void handleToggle()}
      disabled={pending}
      title={
        err
          ? `${t("autoModeFailed")}: ${err}`
          : status.enabled
            ? t("autoModeOnHint")
            : t("autoModeOffHint")
      }
    >
      <span className="auto-mode-toggle-dot" aria-hidden="true" />
      {pending
        ? t("autoModePending")
        : status.enabled
          ? t("autoModeOn")
          : t("autoModeOff")}
    </button>
  );
}
