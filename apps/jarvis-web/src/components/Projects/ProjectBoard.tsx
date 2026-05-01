import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { Project, Requirement, RequirementStatus } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  createRequirement,
  linkRequirementConversation,
  updateRequirement,
} from "../../services/requirements";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { COLUMNS, StatusGlyph } from "./columns";
import { MarkdownLite } from "./MarkdownLite";
import { RequirementDetail } from "./RequirementDetail";

// The kanban board for a single project: header row, optional inline
// "create requirement" panel, four columns (one per RequirementStatus).
// Each column carries its own Multica-style tint via `status-<x>`.
export function ProjectBoard({
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
  // `creatingForStatus` doubles as both visibility flag and which
  // initial column the new requirement should land in. `null` =
  // panel hidden; a status value = panel shown above the columns row,
  // pre-set to that lane (top-level + button = "backlog", per-column
  // + buttons = that column's status).
  const [creatingForStatus, setCreatingForStatus] =
    useState<RequirementStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    const target = String(e.over.id) as RequirementStatus;
    const req = requirements.find((r) => r.id === reqId);
    if (!req || req.status === target) return;
    updateRequirement(reqId, { status: target });
    onChanged();
  };

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
          <div className="project-board-kicker">{t("boardKicker")}</div>
          <h2>{project.name}</h2>
          {project.description && <p>{project.description}</p>}
        </div>
        <button
          type="button"
          className="projects-empty-btn"
          onClick={() => setCreatingForStatus("backlog")}
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
      </div>

      {creatingForStatus !== null && (
        <RequirementCreatePanel
          projectId={project.id}
          initialStatus={creatingForStatus}
          onDone={() => {
            setCreatingForStatus(null);
            onChanged();
          }}
        />
      )}

      {/* View toolbar — Multica-style tabs (Board / Filter / Display)
          on the left, total requirement count on the right. Filter
          and Display are placeholders (disabled until we have the
          query-builder + density toggles). The active "Board" tab
          carries no behaviour today either, but the visual frame
          tells operators "more views are coming here". */}
      <div className="project-board-toolbar">
        <div className="project-board-tabs" role="tablist" aria-label={t("boardViewBoard")}>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="project-board-tab active"
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
            disabled
            className="project-board-tab"
            title="(coming soon)"
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
              <path d="M4 6h16" />
              <path d="M7 12h10" />
              <path d="M10 18h4" />
            </svg>
            <span>{t("boardViewFilter")}</span>
          </button>
          <button
            type="button"
            role="tab"
            disabled
            className="project-board-tab"
            title="(coming soon)"
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
              <circle cx="12" cy="12" r="3" />
              <path d="M19 12c0 1.5-1 2.5-2 3l1 2-3 1-1-2c-.5.2-1 .2-1.5 0l-1 2-3-1 1-2c-1-.5-2-1.5-2-3s1-2.5 2-3l-1-2 3-1 1 2c.5-.2 1-.2 1.5 0l1-2 3 1-1 2c1 .5 2 1.5 2 3z" />
            </svg>
            <span>{t("boardViewDisplay")}</span>
          </button>
        </div>
        <span className="project-board-count tabular-nums">
          {t("boardCount", requirements.length)}
        </span>
      </div>

      {/* Tailwind utility on the kanban frame: ensures the columns row
          can shrink against the sidebar without forcing a horizontal
          scrollbar from the legacy `min-width: 0` plumbing. The
          existing `.project-board-columns` class still owns the grid
          template; this is additive, not a replacement. */}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="project-board-columns min-w-0">
          {COLUMNS.map((col) => (
            <section
              key={col.status}
              className={"project-board-column status-" + col.status}
            >
              <div className="project-board-column-head">
                <StatusGlyph status={col.status} />
                <h3>{t(col.labelKey)}</h3>
                <span>{grouped[col.status].length}</span>
                <button
                  type="button"
                  className="ghost-icon project-board-column-add"
                  onClick={() => setCreatingForStatus(col.status)}
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
              <DroppableCardList status={col.status}>
                {grouped[col.status].length === 0 ? (
                  <div className="project-board-empty">{t("boardEmptyCol")}</div>
                ) : (
                  grouped[col.status].map((req) => (
                    <RequirementCard
                      key={req.id}
                      requirement={req}
                      activeConversationId={activeConversationId}
                      onChanged={onChanged}
                      onOpenConversation={onOpenConversation}
                      onOpenDetail={() => setSelectedId(req.id)}
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
        activeConversationId={activeConversationId}
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
  onDone,
}: {
  projectId: string;
  initialStatus: RequirementStatus;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const targetCol = COLUMNS.find((c) => c.status === initialStatus);
  const targetLabel = targetCol ? t(targetCol.labelKey) : initialStatus;

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
    <section className="requirement-create-panel">
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
        <button
          type="button"
          className="projects-new-btn"
          disabled={!title.trim()}
          onClick={submit}
        >
          {t("reqCreateSubmit")}
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
  onOpenDetail,
}: {
  requirement: Requirement;
  activeConversationId: string | null;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
  onOpenDetail: () => void;
}) {
  const desc = requirement.description?.trim() ?? "";
  const sessions = requirement.conversation_ids.length;
  // Short, monospace-friendly handle for the card head — picks the
  // first 6 hex chars of the UUID so users have something stable to
  // reference verbally / in chat ("REQ-FA2B8E"). Server-side numeric
  // ids would be nicer (Multica's `MUL-17` style) but those need
  // schema work; UUID slicing is good enough for now.
  const idShort = requirement.id.replace(/-/g, "").slice(0, 6).toUpperCase();
  const canLink =
    !!activeConversationId &&
    !requirement.conversation_ids.includes(activeConversationId);
  const statusCol = COLUMNS.find((c) => c.status === requirement.status);
  const statusLabel = statusCol ? t(statusCol.labelKey) : requirement.status;

  const linkCurrent = () => {
    if (!activeConversationId) return;
    linkRequirementConversation(requirement.id, activeConversationId);
    onChanged();
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
      {/* Footer migrated to Tailwind utilities — `text-soft` / `bg-panel`
          etc. are token-bound via `@theme` in styles.css, so the dark
          theme cascade still works. The legacy `requirement-card-*`
          class names stay as semantic anchors but no longer carry
          their own rules. */}
      <div className="requirement-card-footer flex items-center gap-1.5 mt-2 text-xs text-soft">
        <span
          className={"requirement-status-pill status-" + requirement.status}
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
        {requirement.conversation_ids[0] && (
          <button
            type="button"
            className="requirement-link-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenConversation(requirement.conversation_ids[0]);
            }}
          >
            {t("reqOpen")}
          </button>
        )}
        {canLink && (
          <button
            type="button"
            className="requirement-link-btn"
            onClick={(e) => {
              e.stopPropagation();
              linkCurrent();
            }}
          >
            {t("reqLink")}
          </button>
        )}
      </div>
    </article>
  );
}
