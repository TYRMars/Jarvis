import { useEffect, useState, type ReactNode } from "react";
import type {
  Activity,
  AgentProfile,
  Requirement,
  RequirementRun,
  RequirementRunLog,
  RequirementRunStatus,
  RequirementStatus,
  RequirementTodo,
  RequirementTodoKind,
  RequirementTodoStatus,
  VerificationStatus,
} from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  getAgentProfileFromCache,
  listAgentProfiles,
  loadAgentProfiles,
  subscribeAgentProfiles,
} from "../../services/agentProfiles";
import { appStore } from "../../store/appStore";
import { currentJarvisSoulPrompt } from "../../store/persistence";
import { startConversationTurn } from "../../services/conversationSockets";
import {
  listActivitiesForRequirement,
  listRunsForRequirement,
  loadActivitiesForRequirement,
  loadRunsForRequirement,
  createRequirementTodo,
  deleteRequirementTodo,
  rejectRequirement,
  startRequirementRun,
  subscribeRequirementActivities,
  subscribeRequirementRuns,
  updateRequirementTodo,
  updateRequirement,
  verifyRunByCommands,
} from "../../services/requirements";
import { pickedRouting } from "../../services/socket";
import { Select } from "../ui";
import type { BoardColumn } from "./columns";
import { MarkdownLite } from "./MarkdownLite";
import { ActivityList } from "./activityRow";
import { parseRoadmapDescription } from "./roadmapDescription";

// Right-side slide-in panel that replaces the previous in-place
// expand interaction. The card surface stays compact (single
// description-clamp); clicking the card opens this panel with full
// markdown + actions.
//
// Owned by `ProjectBoard`: `requirement` is `null` when closed,
// `Requirement` when a card is selected. Backdrop click, ESC, and
// the X button all dispatch `onClose`.
export function RequirementDetail({
  requirement,
  columns,
  onClose,
  onChanged,
  onOpenConversation,
}: {
  requirement: Requirement | null;
  columns: BoardColumn[];
  onClose: () => void;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  // Close on Escape — common modal/panel behaviour. Effect guard:
  // only attach the listener while the panel is open so we don't
  // intercept Escape from sibling features (search, command-K).
  useEffect(() => {
    if (!requirement) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requirement, onClose]);

  // Subscribe to the run + activity caches + load on open. WS
  // frames (`requirement_run_*`, `activity_appended`) refresh the
  // caches server-side, so we don't refetch on every event — the
  // subscriptions bump tick counters and the synchronous list
  // reads pick up the latest snapshot.
  const [runsTick, setRunsTick] = useState(0);
  const [actsTick, setActsTick] = useState(0);
  const [profilesTick, setProfilesTick] = useState(0);
  // "Start fresh run" UX state. Declared up here (alongside the
  // other ticks) so the hook count stays stable regardless of
  // whether `requirement` is null on this render — moving these
  // below the `if (!requirement) return null` guard would crash
  // React's hooks-order check when the detail panel opens.
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!requirement) return;
    void loadRunsForRequirement(requirement.id);
    void loadActivitiesForRequirement(requirement.id);
    void loadAgentProfiles();
    const offRuns = subscribeRequirementRuns(() => setRunsTick((n) => n + 1));
    const offActs = subscribeRequirementActivities(() =>
      setActsTick((n) => n + 1),
    );
    const offProfs = subscribeAgentProfiles(() => setProfilesTick((n) => n + 1));
    return () => {
      offRuns();
      offActs();
      offProfs();
    };
  }, [requirement]);

  if (!requirement) return null;
  const runs = listRunsForRequirement(requirement.id);
  const activities = listActivitiesForRequirement(requirement.id);
  const profiles = listAgentProfiles();
  // Reading the ticks subscribes the component to cache mutations.
  void runsTick;
  void actsTick;
  void profilesTick;

  const parsedDescription = parseRoadmapDescription(requirement.description);
  const desc = parsedDescription.text;
  const sessions = requirement.conversation_ids.length;
  const idShort = requirement.id.replace(/-/g, "").slice(0, 6).toUpperCase();
  const statusCol = columns.find((c) => c.id === requirement.status);
  const statusLabel = statusCol ? statusCol.label : requirement.status;
  // Use the column's `kind` (when set) so the chip's pill class still
  // resolves the legacy `status-<x>` palette for built-in columns;
  // custom columns fall through to a neutral chip.
  const pillKind = statusCol?.kind ?? null;

  const setStatus = (status: RequirementStatus) => {
    updateRequirement(requirement.id, { status });
    onChanged();
  };

  const setAssignee = (assigneeId: string) => {
    // Empty string from the picker means "unassigned" (we render
    // it as the leading `<option value="">`).
    updateRequirement(requirement.id, {
      assignee_id: assigneeId === "" ? null : assigneeId,
    });
    onChanged();
  };

  // "Start fresh run" button state. Disable when the requirement is
  // already done (no point queueing more work), when there's an
  // in-flight run (Pending/Running) we'd otherwise double-fire, or
  // while our own POST is still on the wire. The local-id check
  // guards optimistic Requirement rows that the server hasn't
  // reconciled yet — server-side `/runs` would 404 on those.
  // (`starting` / `startError` themselves are declared at the top of
  // the component so the hook count stays stable across renders.)
  const inFlightRun = runs.find(
    (r) => r.status === "pending" || r.status === "running",
  );
  const isLocalOnly = requirement.id.startsWith("req-local-");
  const startDisabled =
    starting ||
    isLocalOnly ||
    requirement.status === "done" ||
    Boolean(inFlightRun);

  // v1.0 polish — reject button is shown only when the row is in
  // the Triage queue (`triage_state` is one of the `proposed_by_*`
  // values). Approved rows stay in the kanban and don't carry a
  // reject affordance — there's no audit story for "reject already-
  // approved work" (the user would archive or delete instead). The
  // handler reuses the same `rejectRequirement` service helper as
  // the Triage drawer; the server records the reason on the
  // activity timeline and soft-deletes the row.
  const isProposed = requirement.triage_state === "proposed_by_agent" ||
    requirement.triage_state === "proposed_by_scan";
  const latestRun = runs[0] ?? null;
  const latestConversationId =
    latestRun?.conversation_id ?? requirement.conversation_ids[0] ?? null;
  const assignedProfile = getAgentProfileFromCache(
    requirement.assignee_id ?? null,
  );
  const agentName = assignedProfile?.name ?? null;
  const todos = requirement.todos ?? [];
  const firstActionableTodo =
    todos.find((todo) => todo.status === "failed" || todo.status === "blocked") ??
    todos.find((todo) => todo.status === "pending" || todo.status === "running") ??
    todos[0] ??
    null;

  const handleReject = async () => {
    const raw = window.prompt(t("triageRejectPrompt"));
    if (raw === null) return;
    const reason = raw.trim();
    if (!reason) return;
    try {
      await rejectRequirement(requirement.id, reason);
      onChanged();
      onClose();
    } catch (e) {
      console.warn("reject from detail failed", e);
    }
  };

  const seedBackgroundConversationSurface = (
    conversationId: string,
    content: string,
  ) => {
    const store = appStore.getState();
    const activeBefore = store.activeId;
    if (activeBefore) store.saveConversationSurface(activeBefore);
    const hadSurface = store.restoreConversationSurface(conversationId);
    if (!hadSurface) {
      store.clearMessages();
      store.clearApprovals();
      store.clearHitls();
      store.clearTasks();
      store.setPlan([]);
      store.setProposedPlan(null);
      store.clearSubAgentRuns();
    }
    store.pushUserMessage(content);
    store.saveConversationSurface(conversationId);
    if (activeBefore) {
      store.restoreConversationSurface(activeBefore);
    } else {
      store.clearMessages();
      store.clearApprovals();
      store.clearHitls();
      store.clearTasks();
      store.setPlan([]);
      store.setProposedPlan(null);
      store.clearSubAgentRuns();
    }
  };

  const handleAgentWork = async (prompt?: string) => {
    if (startDisabled && !latestConversationId) return;
    setStartError(null);
    setStarting(true);
    const content = prompt ?? t("detailStartPromptPrefill", requirement.title);
    try {
      if (inFlightRun) return;
      if (startDisabled) return;
      const { run, conversation_id } = await startRequirementRun(requirement.id);
      onChanged();
      const ok = startConversationTurn({
        conversationId: conversation_id,
        content,
        routing: pickedRouting(),
        isNew: false,
        soulPrompt: currentJarvisSoulPrompt(),
        requirementRunId: run.id,
        verificationCommands: requirement.verification_plan?.commands ?? [],
      });
      if (ok) seedBackgroundConversationSurface(conversation_id, content);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const handleTodoPrompt = () => {
    if (!firstActionableTodo) return;
    void handleAgentWork(formatTodoInjection(requirement, firstActionableTodo));
  };

  return (
    <>
      <div
        className="requirement-detail-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="requirement-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="requirement-detail-title"
      >
        <header className="requirement-detail-head">
          <div className="requirement-detail-meta">
            <span className="requirement-card-id">REQ-{idShort}</span>
            <Select
              className={
                "requirement-status-pill" +
                (pillKind ? " status-" + pillKind : " status-custom")
              }
              value={requirement.status}
              onChange={setStatus}
              options={columns.map((c) => ({
                value: c.id,
                label: c.label,
                searchText: c.label,
              }))}
              ariaLabel={t("reqStatusAria", statusLabel)}
            />
          </div>
          <button
            type="button"
            className="ghost-icon requirement-detail-close"
            onClick={onClose}
            aria-label={t("detailClose")}
            title={t("detailCloseTitle")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12" />
              <path d="M6 18l12-12" />
            </svg>
          </button>
        </header>

        <div className="requirement-detail-content">
          <h2
            id="requirement-detail-title"
            className="requirement-detail-title"
          >
            {requirement.title}
          </h2>

          <RequirementNextStep
            latestRun={latestRun}
            todos={todos}
            agentName={agentName}
            agentControl={
              <AssigneePicker
                assigneeId={requirement.assignee_id ?? null}
                profiles={profiles}
                onChange={setAssignee}
              />
            }
            startDisabled={startDisabled}
            starting={starting}
            inFlightRun={Boolean(inFlightRun)}
            isLocalOnly={isLocalOnly}
            isDone={requirement.status === "done"}
            onStart={() => void handleAgentWork()}
            onTodoPrompt={firstActionableTodo ? handleTodoPrompt : undefined}
            onOpenLatest={
              latestConversationId
                ? () => onOpenConversation(latestConversationId)
                : undefined
            }
          />

          <section className="requirement-detail-topic">
            <h3 className="requirement-detail-section-heading">
              {t("detailTopicHeading")}
            </h3>
            {desc ? (
              <div className="requirement-detail-body">
                {parsedDescription.source && (
                  <div
                    className="requirement-detail-source"
                    title={parsedDescription.source}
                  >
                    <span>{t("roadmapSourceLabel")}</span>
                    <code>{parsedDescription.source}</code>
                  </div>
                )}
                <MarkdownLite text={desc} />
              </div>
            ) : (
              <>
                {parsedDescription.source && (
                  <div
                    className="requirement-detail-source"
                    title={parsedDescription.source}
                  >
                    <span>{t("roadmapSourceLabel")}</span>
                    <code>{parsedDescription.source}</code>
                  </div>
                )}
                <p className="requirement-detail-empty">
                  {t("detailEmptyDesc")}
                </p>
              </>
            )}
          </section>

          <RequirementTodosSection
            requirement={requirement}
            onChanged={onChanged}
            onHandleTodo={(todo) =>
              void handleAgentWork(formatTodoInjection(requirement, todo))
            }
          />
          <RunsSection runs={runs} requirement={requirement} />
          <ActivitySection activities={activities} />
        </div>

        {(sessions > 0 || startError || isProposed) && (
          <footer className="requirement-detail-footer">
            {sessions > 0 && (
              <span className="requirement-detail-sessions">
                {t("reqSessions", sessions)}
              </span>
            )}
            {startError && (
              <span
                className="requirement-detail-start-error"
                role="alert"
                title={startError}
              >
                {t("detailStartFailed")}
              </span>
            )}
            <span className="flex-1" />
            {isProposed && (
              <button
                type="button"
                className="triage-btn triage-btn-reject"
                onClick={() => void handleReject()}
                title={t("triageReject")}
              >
                {t("triageReject")}
              </button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

const TODO_KINDS: RequirementTodoKind[] = [
  "work",
  "check",
  "ci",
  "deploy",
  "review",
  "manual",
];

const TODO_STATUSES: RequirementTodoStatus[] = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "blocked",
];

function RequirementNextStep({
  latestRun,
  todos,
  agentName,
  agentControl,
  startDisabled,
  starting,
  inFlightRun,
  isLocalOnly,
  isDone,
  onStart,
  onTodoPrompt,
  onOpenLatest,
}: {
  latestRun: RequirementRun | null;
  todos: RequirementTodo[];
  agentName: string | null;
  agentControl: ReactNode;
  startDisabled: boolean;
  starting: boolean;
  inFlightRun: boolean;
  isLocalOnly: boolean;
  isDone: boolean;
  onStart: () => void;
  onTodoPrompt?: () => void;
  onOpenLatest?: () => void;
}) {
  const failedTodos = todos.filter((todo) =>
    todo.status === "failed" || todo.status === "blocked",
  );
  const verification = latestRun?.verification?.status ?? null;
  const tone =
    verification === "failed" || latestRun?.status === "failed" || failedTodos.length > 0
      ? "failed"
      : verification === "passed"
        ? "passed"
        : latestRun?.status === "running" || latestRun?.status === "pending" || inFlightRun
          ? "running"
          : "idle";

  const title =
    tone === "failed"
      ? t("detailProgressFailedTitle")
      : tone === "passed"
        ? t("detailProgressPassedTitle")
        : tone === "running"
          ? t("detailProgressRunningTitle")
          : t("detailProgressIdleTitle");

  const detail =
    tone === "failed"
      ? t("detailProgressFailedDetail", failedTodos.length || 1)
      : tone === "passed"
        ? t("detailProgressPassedDetail")
        : tone === "running"
          ? t("detailProgressRunningDetail")
          : todos.length > 0
            ? t("detailProgressIdleWithChecks", todos.length)
            : t("detailProgressIdleNoChecks");
  const startLabel = agentName
    ? t("detailProgressStartWithAgent", agentName)
    : t("detailProgressStart");

  return (
    <section className={"requirement-next-step tone-" + tone}>
      <div className="requirement-next-copy">
        <span className="requirement-next-kicker">
          {t("detailProgressHeading")}
        </span>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {agentControl}
      <div className="requirement-next-actions">
        {tone === "failed" && onTodoPrompt && (
          <button
            type="button"
            className="requirement-next-btn primary"
            onClick={onTodoPrompt}
          >
            {t("detailProgressFixFailed")}
          </button>
        )}
        {tone !== "running" && (
          <button
            type="button"
            className={"requirement-next-btn" + (tone !== "failed" ? " primary" : "")}
            onClick={onStart}
            disabled={startDisabled}
            title={
              isLocalOnly
                ? t("detailStartHintLocal")
                : isDone
                  ? t("detailStartHintDone")
                  : inFlightRun
                    ? t("detailStartHintInflight")
                    : undefined
            }
          >
            {starting
              ? t("detailStartPending")
              : tone === "failed"
                ? t("detailProgressRerun")
                : startLabel}
          </button>
        )}
        {onOpenLatest && (
          <button
            type="button"
            className={"requirement-next-btn" + (tone === "running" ? " primary" : "")}
            onClick={onOpenLatest}
          >
            {tone === "running"
              ? t("detailProgressOpenRun")
              : t("detailOpenLatest")}
          </button>
        )}
      </div>
    </section>
  );
}

function RequirementTodosSection({
  requirement,
  onChanged,
  onHandleTodo,
}: {
  requirement: Requirement;
  onChanged: () => void;
  onHandleTodo: (todo: RequirementTodo) => void;
}) {
  const todos = requirement.todos ?? [];
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<RequirementTodoKind>("ci");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(() => todos.length > 0);
  const kindOptions = todoKindOptions();

  useEffect(() => {
    if (todos.length > 0) setSectionOpen(true);
  }, [todos.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void createTodo();
  };

  const createTodo = async () => {
    const nextTitle = title.trim();
    if (!nextTitle || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createRequirementTodo(requirement.id, {
        title: nextTitle,
        kind,
        command: command.trim() || null,
        created_by: "human",
      });
      setTitle("");
      setCommand("");
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details
      className="requirement-detail-todos"
      open={sectionOpen}
      onToggle={(e) => setSectionOpen(e.currentTarget.open)}
    >
      <summary className="requirement-detail-record-summary">
        <div className="requirement-detail-todos-title">
          <h3 className="requirement-detail-runs-heading">
            {t("reqTodoHeading")}
          </h3>
          <p>
            {todos.length === 0
              ? t("reqTodoOptionalHint")
              : t("reqTodoHeadingHint")}
          </p>
        </div>
        <span className="requirement-detail-todos-count">{todos.length}</span>
      </summary>
      {!adding && (
        <button
          type="button"
          className="requirement-detail-todo-add requirement-detail-todo-add-toggle"
          onClick={() => {
            setSectionOpen(true);
            setAdding(true);
          }}
        >
          {t("reqTodoAddStep")}
        </button>
      )}
      {adding && (
        <form className="requirement-detail-todo-form" onSubmit={submit}>
          <input
            className="requirement-detail-todo-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("reqTodoAddPlaceholder")}
            aria-label={t("reqTodoTitleAria")}
            autoFocus
          />
          <Select<RequirementTodoKind>
            className="requirement-detail-todo-select"
            value={kind}
            onChange={setKind}
            options={kindOptions}
            ariaLabel={t("reqTodoKindAria")}
          />
          <input
            className="requirement-detail-todo-command-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("reqTodoCommandPlaceholder")}
            aria-label={t("reqTodoCommandAria")}
          />
          <button
            type="submit"
            className="requirement-detail-todo-add"
            disabled={busy || title.trim().length === 0}
          >
            {busy ? t("reqTodoAdding") : t("reqTodoAdd")}
          </button>
          <button
            type="button"
            className="requirement-detail-todo-edit"
            onClick={() => {
              setAdding(false);
              setTitle("");
              setCommand("");
              setError(null);
            }}
            disabled={busy}
          >
            {t("reqTodoCancelEdit")}
          </button>
        </form>
      )}
      {error && (
        <p className="requirement-detail-todo-error" role="alert">
          {error}
        </p>
      )}
      {todos.length === 0 ? (
        <p className="requirement-detail-empty">{t("reqTodoEmpty")}</p>
      ) : (
        <ul className="requirement-detail-todo-list">
          {todos.map((todo) => (
            <RequirementTodoRow
              key={todo.id}
              requirementId={requirement.id}
              todo={todo}
              onChanged={onChanged}
              onHandleTodo={onHandleTodo}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

function RequirementTodoRow({
  requirementId,
  todo,
  onChanged,
  onHandleTodo,
}: {
  requirementId: string;
  todo: RequirementTodo;
  onChanged: () => void;
  onHandleTodo: (todo: RequirementTodo) => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [kind, setKind] = useState<RequirementTodoKind>(todo.kind);
  const [status, setStatus] = useState<RequirementTodoStatus>(todo.status);
  const [command, setCommand] = useState(todo.command ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [injected, setInjected] = useState(false);
  const [editing, setEditing] = useState(false);
  const kindOptions = todoKindOptions();
  const statusOptions = todoStatusOptions();

  useEffect(() => {
    setTitle(todo.title);
    setKind(todo.kind);
    setStatus(todo.status);
    setCommand(todo.command ?? "");
  }, [todo.id, todo.title, todo.kind, todo.status, todo.command]);

  const changed =
    title.trim() !== todo.title ||
    kind !== todo.kind ||
    status !== todo.status ||
    command.trim() !== (todo.command ?? "");

  const save = async () => {
    const nextTitle = title.trim();
    if (!nextTitle || !changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateRequirementTodo(requirementId, todo.id, {
        title: nextTitle,
        kind,
        status,
        command: command.trim() || null,
      });
      onChanged();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = window.confirm(t("reqTodoDeleteConfirm", todo.title));
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRequirementTodo(requirementId, todo.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const inject = () => {
    onHandleTodo(todo);
    setInjected(true);
    window.setTimeout(() => setInjected(false), 1400);
  };

  return (
    <li className={"requirement-detail-todo todo-status-" + todo.status}>
      <div className="requirement-detail-todo-summary">
        <span className={"requirement-detail-todo-status status-" + todo.status}>
          {todoStatusGlyph(todo.status)} {t(`reqTodoStatus_${todo.status}`)}
        </span>
        <strong>{todo.title}</strong>
        <span className="requirement-detail-todo-kind">
          {t(`reqTodoKind_${todo.kind}`)}
        </span>
      </div>
      {todo.command && (
        <code className="requirement-detail-todo-command">{todo.command}</code>
      )}
      {todo.evidence?.note && (
        <span className="requirement-detail-todo-evidence">
          {todo.evidence.note}
        </span>
      )}
      {editing && (
        <div className="requirement-detail-todo-editor">
          <div className="requirement-detail-todo-edit-grid">
            <input
              className="requirement-detail-todo-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label={t("reqTodoTitleAria")}
            />
            <Select<RequirementTodoKind>
              className="requirement-detail-todo-select"
              value={kind}
              onChange={setKind}
              options={kindOptions}
              ariaLabel={t("reqTodoKindAria")}
            />
            <Select<RequirementTodoStatus>
              className="requirement-detail-todo-select"
              value={status}
              onChange={setStatus}
              options={statusOptions}
              ariaLabel={t("reqTodoStatusAria")}
            />
          </div>
          <input
            className="requirement-detail-todo-command-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("reqTodoCommandPlaceholder")}
            aria-label={t("reqTodoCommandAria")}
          />
        </div>
      )}
      {error && (
        <p className="requirement-detail-todo-error" role="alert">
          {error}
        </p>
      )}
      <div className="requirement-detail-todo-actions">
        <button
          type="button"
          className={
            "requirement-detail-todo-inject" +
            (todo.status === "failed" || todo.status === "blocked" ? " primary" : "")
          }
          onClick={inject}
          title={t("reqTodoInjectTitle")}
        >
          {injected ? t("reqTodoInjected") : t("reqTodoInject")}
        </button>
        {!editing && (
          <button
            type="button"
            className="requirement-detail-todo-edit"
            onClick={() => setEditing(true)}
          >
            {t("reqTodoEdit")}
          </button>
        )}
        {editing && (
          <button
            type="button"
            className="requirement-detail-todo-edit"
            onClick={() => {
              setTitle(todo.title);
              setKind(todo.kind);
              setStatus(todo.status);
              setCommand(todo.command ?? "");
              setEditing(false);
              setError(null);
            }}
            disabled={busy}
          >
            {t("reqTodoCancelEdit")}
          </button>
        )}
        <button
          type="button"
          className="requirement-detail-todo-save"
          onClick={() => void save()}
          disabled={!editing || busy || !changed || title.trim().length === 0}
        >
          {busy ? t("reqTodoSaving") : t("reqTodoSave")}
        </button>
        <button
          type="button"
          className="requirement-detail-todo-delete"
          onClick={() => void remove()}
          disabled={busy}
        >
          {t("reqTodoDelete")}
        </button>
      </div>
    </li>
  );
}

function todoStatusGlyph(status: RequirementTodoStatus): string {
  if (status === "passed") return "✓";
  if (status === "failed" || status === "blocked") return "×";
  if (status === "running") return "…";
  if (status === "skipped") return "−";
  return "○";
}

function todoKindOptions() {
  return TODO_KINDS.map((value) => ({
    value,
    label: t(`reqTodoKind_${value}`),
    searchText: t(`reqTodoKind_${value}`),
  }));
}

function todoStatusOptions() {
  return TODO_STATUSES.map((value) => ({
    value,
    label: t(`reqTodoStatus_${value}`),
    searchText: t(`reqTodoStatus_${value}`),
  }));
}

function formatTodoInjection(req: Requirement, todo: RequirementTodo): string {
  const lines = [
    t("reqTodoInjectPromptHeader"),
    "",
    t("reqTodoInjectPromptRequirement", req.title),
    t("reqTodoInjectPromptRequirementId", req.id),
    t("reqTodoInjectPromptTodo", todo.title),
    `${t("reqTodoKindAria")}: ${t(`reqTodoKind_${todo.kind}`)}`,
    `${t("reqTodoStatusAria")}: ${t(`reqTodoStatus_${todo.status}`)}`,
  ];
  if (todo.command?.trim()) {
    lines.push(t("reqTodoInjectPromptCommand", todo.command.trim()));
  }
  if (todo.evidence?.note) {
    lines.push(t("reqTodoInjectPromptEvidence", todo.evidence.note));
  }
  lines.push("", t("reqTodoInjectPromptAsk"));
  return lines.join("\n");
}

// =============================================================
// Runs section — Phase 3.5 RequirementRun history rendering.
// =============================================================
//
// Self-contained block rendered beneath the description in the card
// detail panel. Reads from the `runsByRequirement` cache (kept in
// sync via WS frames `requirement_run_started/finished/verified`
// and the `loadRunsForRequirement` REST loader on open).
//
// The list itself stays plain — index, status pill, started_at /
// finished_at timestamps, and the verification badge when present.
// Click a row to expand the inline summary / error / per-command
// stdout details.

function RunsSection({
  runs,
  requirement,
}: {
  runs: RequirementRun[];
  requirement: Requirement;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const latest = runs[0] ?? null;
  const latestIsRunning =
    latest?.status === "pending" || latest?.status === "running";
  const [sectionOpen, setSectionOpen] = useState(latestIsRunning);
  useEffect(() => {
    if (latestIsRunning) {
      setSectionOpen(true);
      setExpanded((current) => current ?? latest?.id ?? null);
    }
  }, [latest?.id, latestIsRunning]);
  return (
    <details
      className="requirement-detail-runs"
      open={sectionOpen}
      onToggle={(e) => setSectionOpen(e.currentTarget.open)}
    >
      <summary className="requirement-detail-record-summary">
        <span className="requirement-detail-runs-heading">
          {t("runsHeading")}
        </span>
        <span className="requirement-detail-record-meta">
          {runs.length === 0
            ? t("runsEmpty")
            : t(
                "runsSummary",
                runs.length,
                latest ? t(runStatusKey(latest.status)) : "",
              )}
        </span>
      </summary>
      {runs.length === 0 ? (
        <p className="requirement-detail-empty">{t("runsEmpty")}</p>
      ) : (
        <ol className="requirement-detail-runs-list">
          {runs.map((run, idx) => {
            const isOpen = expanded === run.id;
            // Newest is index 0 in the cache; humans count runs from
            // 1 with the oldest first ("Run #1 was the first attempt").
            const displayNumber = runs.length - idx;
            return (
              <li
                key={run.id}
                className={
                  "requirement-detail-run-row run-status-" + run.status
                }
              >
                <button
                  type="button"
                  className="requirement-detail-run-summary"
                  onClick={() => setExpanded(isOpen ? null : run.id)}
                  aria-expanded={isOpen}
                >
                  <span className="requirement-detail-run-num">
                    {t("runDisplayName", displayNumber)}
                  </span>
                  <RunStatusPill status={run.status} />
                  <span className="requirement-detail-run-times">
                    {t("runStartedLabel", formatTime(run.started_at))}
                    {run.finished_at &&
                      " " + t("runFinishedLabel", formatTime(run.finished_at))}
                  </span>
                  {run.verification && (
                    <VerificationBadge status={run.verification.status} />
                  )}
                </button>
                {isOpen && <RunDetail run={run} requirement={requirement} />}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}

function RunStatusPill({ status }: { status: RequirementRunStatus }) {
  const labelKey = runStatusKey(status);
  return (
    <span className={"requirement-run-pill run-status-" + status}>
      {t(labelKey)}
    </span>
  );
}

function runStatusKey(status: RequirementRunStatus) {
  return {
    pending: "runStatusPending",
    running: "runStatusRunning",
    completed: "runStatusCompleted",
    failed: "runStatusFailed",
    cancelled: "runStatusCancelled",
  }[status];
}

function VerificationBadge({ status }: { status: VerificationStatus }) {
  const labelKey = {
    passed: "runVerifyPassed",
    failed: "runVerifyFailed",
    needs_review: "runVerifyNeedsReview",
    skipped: "runVerifySkipped",
  }[status];
  const glyph = status === "passed" ? "✓" : status === "failed" ? "✗" : "·";
  return (
    <span
      className={"requirement-run-verify verify-" + status}
      title={t(labelKey)}
    >
      {glyph} {t(labelKey)}
    </span>
  );
}

function RunDetail({
  run,
  requirement,
}: {
  run: RequirementRun;
  requirement: Requirement;
}) {
  return (
    <div className="requirement-detail-run-body">
      {run.summary && (
        <p className="requirement-detail-run-text">{run.summary}</p>
      )}
      {run.error && (
        <p className="requirement-detail-run-text run-error">{run.error}</p>
      )}
      {run.worktree_path && (
        <p
          className="requirement-detail-run-worktree"
          title={run.worktree_path}
        >
          📁 worktree: <code>{run.worktree_path}</code>
        </p>
      )}
      {run.verification?.command_results &&
        run.verification.command_results.length > 0 && (
          <ul className="requirement-detail-run-cmds">
            {run.verification.command_results.map((cmd, i) => (
              <li key={i} className="requirement-detail-run-cmd">
                <code>{cmd.command}</code>
                <span className="requirement-detail-run-cmd-exit">
                  {cmd.exit_code === 0
                    ? "exit 0"
                    : "exit " + (cmd.exit_code ?? "?")}
                  {" · "}
                  {cmd.duration_ms}ms
                </span>
              </li>
            ))}
          </ul>
        )}
      {run.logs && run.logs.length > 0 && <RunLogs logs={run.logs} />}
      <VerifyRunForm run={run} requirement={requirement} />
    </div>
  );
}

function RunLogs({ logs }: { logs: RequirementRunLog[] }) {
  return (
    <section className="requirement-detail-run-logs">
      <h4 className="requirement-detail-run-logs-heading">
        {t("runLogsHeading")}
      </h4>
      <ol className="requirement-detail-run-logs-list">
        {logs.map((log) => {
          const details = formatRunLogData(log.data);
          return (
            <li
              key={log.id}
              className={
                "requirement-detail-run-log run-log-level-" + log.level
              }
            >
              <div className="requirement-detail-run-log-head">
                <span className="requirement-detail-run-log-level">
                  {t(runLogLevelLabel(log.level))}
                </span>
                <span className="requirement-detail-run-log-time">
                  {formatTime(log.created_at)}
                </span>
              </div>
              <p className="requirement-detail-run-log-message">
                {log.message}
              </p>
              {details && (
                <pre className="requirement-detail-run-log-data">
                  {details}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function runLogLevelLabel(level: RequirementRunLog["level"]): string {
  return {
    info: "runLogLevelInfo",
    warn: "runLogLevelWarn",
    error: "runLogLevelError",
    success: "runLogLevelSuccess",
  }[level];
}

function formatRunLogData(data: RequirementRunLog["data"]): string {
  if (!data || typeof data !== "object") return "";
  const record = data;
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    const text = formatLogValue(value);
    lines.push(`${label}: ${text}`);
  };
  add(t("runLogDataCommand"), record.command);
  add(t("runLogDataExit"), record.exit_code);
  add(t("runLogDataDuration"), record.duration_ms);
  add(t("runLogDataCommands"), record.commands);
  add(t("runLogDataTimeout"), record.timeout_ms);
  add(t("runLogDataWorkspace"), record.workspace);
  add(t("runLogDataPath"), record.path);
  add(t("runLogDataReason"), record.reason);
  add(t("runLogDataStatus"), record.status);
  add(t("runLogDataConversation"), record.conversation_id);
  add(t("runLogDataProfile"), record.profile_id);
  add(t("runLogDataStdout"), record.stdout_excerpt);
  add(t("runLogDataStderr"), record.stderr_excerpt);
  return lines.join("\n");
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  return JSON.stringify(value);
}

// Phase 4 — inline "Run verification" form. Runs sequentially
// against `/v1/runs/:id/verify`; the resulting `verification` is
// applied through the WS frame, so we just need to fire-and-await
// the request and surface errors.
//
// UX rules learned from operator feedback:
//   - Default-fill from `requirement.verification_plan.commands` so
//     operators don't stare at an empty textarea wondering whether
//     the placeholder is real input. The plan is the canonical
//     "what success looks like" — manual runs should match the
//     auto-mode loop unless the operator deliberately overrides.
//   - Clear the error as soon as the user starts typing. The
//     previous version left "至少加一条命令" pinned even after the
//     operator added input, which read as "rejected" rather than
//     "stale".
//   - Surface a short hint above the textarea explaining where the
//     defaults came from + the manual-vs-auto relationship — the
//     button is wired but the relationship was opaque.
function VerifyRunForm({
  run,
  requirement,
}: {
  run: RequirementRun;
  requirement: Requirement;
}) {
  const planCommands = requirement.verification_plan?.commands ?? [];
  const [text, setText] = useState(() => planCommands.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hint = planCommands.length > 0
    ? t("verifyRunHintFromPlan", planCommands.length)
    : t("verifyRunHintNoPlan");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const commands = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (commands.length === 0) {
      setError(t("verifyRunNoCommands"));
      return;
    }
    setBusy(true);
    try {
      await verifyRunByCommands(run.id, commands);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTextChange = (v: string) => {
    setText(v);
    if (error) setError(null);
  };

  return (
    <form className="requirement-detail-run-verify" onSubmit={submit}>
      <div className="requirement-detail-run-verify-head">
        <label className="requirement-detail-run-verify-label">
          {t("verifyRunLabel")}
        </label>
        <span className="requirement-detail-run-verify-hint">{hint}</span>
      </div>
      <textarea
        className="requirement-detail-run-verify-input"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder={t("verifyRunPlaceholder")}
        rows={3}
        disabled={busy}
        spellCheck={false}
      />
      {error && <p className="requirement-detail-run-verify-error">{error}</p>}
      <div className="requirement-detail-run-verify-actions">
        {planCommands.length > 0 && text !== planCommands.join("\n") && (
          <button
            type="button"
            className="requirement-detail-run-verify-reset"
            onClick={() => {
              setText(planCommands.join("\n"));
              setError(null);
            }}
            disabled={busy}
          >
            {t("verifyRunResetToPlan")}
          </button>
        )}
        <button type="submit" disabled={busy || run.status === "running"}>
          {busy ? t("verifyRunRunning") : t("verifyRunButton")}
        </button>
      </div>
    </form>
  );
}

function formatTime(iso: string): string {
  // Minimal local-time HH:MM rendering. The full ISO is preserved
  // behind a `title` if downstream wants it; for the narrow detail
  // panel a clipped time keeps each row to one line.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// =============================================================
// Activity timeline section — Phase 3.7.
// =============================================================
//
// Append-only audit feed under the runs list. Each row renders a
// single line: time · actor · action. Action text comes from
// per-kind i18n templates that read the typed payload off the
// activity's `body`. Unknown / new kinds fall through to a generic
// "event: <kind>" so a future server can add rows without breaking
// the UI.

function ActivitySection({ activities }: { activities: Activity[] }) {
  return (
    <details className="requirement-detail-activities">
      <summary className="requirement-detail-record-summary">
        <span className="requirement-detail-runs-heading">
          {t("activityHeading")}
        </span>
        <span className="requirement-detail-record-meta">
          {t("activitySummary", activities.length)}
        </span>
      </summary>
      <ActivityList activities={activities} />
    </details>
  );
}

function shortenId(id: string | undefined): string {
  if (!id) return "?";
  return id.slice(0, 8);
}

// =============================================================
// Handling agent picker — Phase 3.6.
// =============================================================
//
// Compact shared Select rendered inside the progress panel. Empty
// option = the default Jarvis execution path; remaining options come
// from the cached AgentProfile list. The selected id is still persisted
// as `assignee_id` because the scheduler/backend already consumes that
// field to choose the Agent profile for requirement work.

function AssigneePicker({
  assigneeId,
  profiles,
  onChange,
}: {
  assigneeId: string | null;
  profiles: AgentProfile[];
  onChange: (id: string) => void;
}) {
  // If the requirement is assigned but the profile isn't in cache
  // (e.g. server lookup race), still render the id as a stub option
  // so the select shows the correct selection rather than silently
  // falling back to "unassigned".
  const hasUnknownAssignee =
    assigneeId !== null && !profiles.some((p) => p.id === assigneeId);
  const shown = getAgentProfileFromCache(assigneeId);
  const options = [
    {
      value: "",
      label: t("detailAssigneeUnassigned"),
      searchText: t("detailAssigneeUnassigned"),
    },
    ...profiles.map((p) => ({
      value: p.id,
      label: p.avatar ? `${p.avatar} ${p.name}` : p.name,
      searchText: p.name,
    })),
    ...(hasUnknownAssignee
      ? [
          {
            value: assigneeId,
            label: `(unknown ${shortenId(assigneeId)})`,
            searchText: shortenId(assigneeId),
          },
        ]
      : []),
  ];

  return (
    <div className="requirement-detail-assignee">
      <label className="requirement-detail-assignee-label">
        {t("detailAssigneeLabel")}
      </label>
      <Select
        className="requirement-detail-assignee-select"
        value={assigneeId ?? ""}
        onChange={onChange}
        options={options}
        ariaLabel={t("detailAssigneeLabel")}
        searchable={profiles.length > 8}
      />
      {shown?.system_prompt && (
        <p
          className="requirement-detail-assignee-prompt"
          title={shown.system_prompt}
        >
          {shown.system_prompt.length > 80
            ? shown.system_prompt.slice(0, 80) + "…"
            : shown.system_prompt}
        </p>
      )}
    </div>
  );
}
