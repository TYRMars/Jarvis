import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  Activity,
  Requirement,
  RequirementRun,
  RequirementRunLog,
  RequirementRunStatus,
  RequirementStatus,
  RequirementTodo,
  RequirementTodoStatus,
  VerificationStatus,
} from "../../types/frames";
import { t } from "../../utils/i18n";
import { appStore } from "../../store/appStore";
import { currentJarvisSoulPrompt } from "../../store/persistence";
import { sessionRoute } from "../../services/conversations";
import { startConversationTurn } from "../../services/conversationSockets";
import {
  listActivitiesForRequirement,
  listRunsForRequirement,
  loadActivitiesForRequirement,
  loadRunsForRequirement,
  rejectRequirement,
  startRequirementRun,
  subscribeRequirementActivities,
  subscribeRequirementRuns,
  updateRequirement,
  verifyRunByCommands,
} from "../../services/requirements";
import { pickedRouting } from "../../services/socket";
import {
  listWorkflowRuns,
  loadWorkflows,
  runWorkflow,
  subscribeWorkflows,
  workflowsLoaded,
  workflowsSnapshot,
  type WorkflowRun,
} from "../../services/workflows";
import { Button, Modal, Select } from "../ui";
import type { BoardColumn } from "./columns";
import { MarkdownLite } from "./MarkdownLite";
import { ActivityList } from "./activityRow";
import { parseRoadmapDescription } from "./roadmapDescription";
import { RequirementComments } from "./RequirementComments";
import {
  RequirementLabelChips,
  RequirementLabelPicker,
  useEnsureLabels,
} from "./RequirementLabels";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

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
  // "Start fresh run" UX state. Declared up here (alongside the
  // other ticks) so the hook count stays stable regardless of
  // whether `requirement` is null on this render — moving these
  // below the `if (!requirement) return null` guard would crash
  // React's hooks-order check when the detail panel opens.
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    if (!requirement) return;
    void loadRunsForRequirement(requirement.id);
    void loadActivitiesForRequirement(requirement.id);
    const offRuns = subscribeRequirementRuns(() => setRunsTick((n) => n + 1));
    const offActs = subscribeRequirementActivities(() =>
      setActsTick((n) => n + 1),
    );
    return () => {
      offRuns();
      offActs();
    };
  }, [requirement]);

  if (!requirement) return null;
  const runs = listRunsForRequirement(requirement.id);
  const activities = listActivitiesForRequirement(requirement.id);
  // Reading the ticks subscribes the component to cache mutations.
  void runsTick;
  void actsTick;

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
    const content = prompt ?? formatRequirementStartPrompt(requirement, todos);
    const verificationCommands = [
      ...(requirement.verification_plan?.commands ?? []),
      ...todos
        .map((todo) => todo.command?.trim() ?? "")
        .filter((command) => command.length > 0),
    ];
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
        verificationCommands,
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
          <div className="requirement-detail-head-actions">
            <button
              type="button"
              className="ghost-icon requirement-detail-activity-toggle"
              onClick={() => setActivityOpen(true)}
              aria-label={t("activityOpenAria")}
              title={t("activityOpenTitle")}
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
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
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
          </div>
        </header>

        <div className="requirement-detail-content">
          <h2
            id="requirement-detail-title"
            className="requirement-detail-title"
          >
            {requirement.title}
          </h2>

          <RequirementLabelsRow requirement={requirement} />

          <RequirementNextStep
            latestRun={latestRun}
            todos={todos}
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

          <RequirementWorkflowSection
            requirement={requirement}
            disabled={isLocalOnly}
          />

          <RequirementTodosSection
            requirement={requirement}
            onHandleTodo={(todo) =>
              void handleAgentWork(formatTodoInjection(requirement, todo))
            }
          />
          <SessionRecordsSection runs={runs} requirement={requirement} />
        </div>

        <footer className="requirement-detail-footer">
          {(sessions > 0 || startError || isProposed) && (
            <div className="requirement-detail-footer-meta">
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
            </div>
          )}
          <RequirementComments requirementId={requirement.id} />
        </footer>
        <ActivityModal
          open={activityOpen}
          activities={activities}
          onClose={() => setActivityOpen(false)}
        />
      </aside>
    </>
  );
}

function RequirementNextStep({
  latestRun,
  todos,
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
  const startLabel = t("detailProgressStart");

  return (
    <section className={"requirement-next-step tone-" + tone}>
      <div className="requirement-next-copy">
        <span className="requirement-next-kicker">
          {t("detailProgressHeading")}
        </span>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
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

// Bind a declarative workflow to this requirement and run / inspect it.
// When a workflow is bound, "working" the card (auto loop or the Run
// button here) executes the whole recipe instead of a single agent turn.
function RequirementWorkflowSection({
  requirement,
  disabled,
}: {
  requirement: Requirement;
  disabled: boolean;
}) {
  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!workflowsLoaded()) void loadWorkflows().catch(() => {});
    const unsub = subscribeWorkflows(() => {
      if (alive) setTick((n) => n + 1);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  void tick;

  const workflows = workflowsSnapshot();
  const boundId = requirement.workflow_id ?? "";

  const refreshRuns = async (wfId: string) => {
    try {
      const all = await listWorkflowRuns(wfId);
      setRuns(all.filter((r) => r.requirement_id === requirement.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (boundId) void refreshRuns(boundId);
    else setRuns(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundId, requirement.id]);

  const onPick = (value: string) => {
    setError(null);
    updateRequirement(requirement.id, { workflow_id: value || null });
  };

  const onRun = async () => {
    if (!boundId) return;
    setBusy(true);
    setError(null);
    try {
      await runWorkflow(boundId, requirement.id);
      await refreshRuns(boundId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = [
    {
      value: "",
      label: tx("requirementWorkflowNone", "No workflow (single agent run)"),
      searchText: "none",
    },
    ...workflows.map((w) => ({ value: w.id, label: w.name, searchText: w.name })),
  ];

  return (
    <section className="requirement-detail-topic requirement-workflow">
      <h3 className="requirement-detail-section-heading">
        {tx("requirementWorkflowHeading", "Workflow")}
      </h3>
      <div className="requirement-workflow-row">
        <Select
          value={boundId}
          onChange={onPick}
          options={options}
          ariaLabel={tx("requirementWorkflowPick", "Bind a workflow")}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || busy || !boundId}
          onClick={() => void onRun()}
        >
          {busy
            ? tx("requirementWorkflowRunning", "Running…")
            : tx("requirementWorkflowRun", "Run workflow")}
        </Button>
      </div>
      {error && (
        <p className="requirement-detail-start-error" role="alert">
          {error}
        </p>
      )}
      {boundId && <WorkflowRunTimeline runs={runs} />}
    </section>
  );
}

// Compact run timeline for the requirement detail — one entry per
// WorkflowRun bound to this requirement, with per-step status.
function WorkflowRunTimeline({ runs }: { runs: WorkflowRun[] | null }) {
  if (runs === null) return null;
  if (runs.length === 0) {
    return (
      <p className="requirement-detail-empty">
        {tx("requirementWorkflowNoRuns", "No workflow runs yet.")}
      </p>
    );
  }
  return (
    <ul className="workflow-runs-list">
      {runs.map((r) => (
        <li key={r.id} className={`workflow-run-item workflow-run-${r.status}`}>
          <div className="workflow-run-head">
            <span className={`workflow-run-badge workflow-run-badge-${r.status}`}>
              {r.status}
            </span>
            <span className="workflow-run-time">{r.started_at}</span>
          </div>
          <ol className="workflow-run-steps">
            {r.step_results.map((s) => (
              <li
                key={s.step_id}
                className={`workflow-run-step workflow-run-step-${s.status}`}
              >
                <span className="workflow-run-step-name">{s.name}</span>
                <span
                  className={`workflow-run-step-status workflow-run-step-status-${s.status}`}
                >
                  {s.status}
                </span>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

function RequirementTodosSection({
  requirement,
  onHandleTodo,
}: {
  requirement: Requirement;
  onHandleTodo: (todo: RequirementTodo) => void;
}) {
  const todos = requirement.todos ?? [];
  const [sectionOpen, setSectionOpen] = useState(true);

  useEffect(() => {
    setSectionOpen(true);
  }, [todos.length]);

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
          <p>{t("reqTodoHeadingHint")}</p>
        </div>
        <span className="requirement-detail-todos-count">{todos.length}</span>
      </summary>
      {todos.length === 0 ? (
        <p className="requirement-detail-empty">{t("reqTodoEmpty")}</p>
      ) : (
        <ul className="requirement-detail-todo-list">
          {todos.map((todo) => (
            <RequirementTodoRow
              key={todo.id}
              todo={todo}
              onHandleTodo={onHandleTodo}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

function RequirementTodoRow({
  todo,
  onHandleTodo,
}: {
  todo: RequirementTodo;
  onHandleTodo: (todo: RequirementTodo) => void;
}) {
  const [injected, setInjected] = useState(false);

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

function formatRequirementStartPrompt(
  req: Requirement,
  todos: RequirementTodo[],
): string {
  const lines = [
    t("detailStartPromptPrefill", req.title),
  ];
  if (todos.length > 0) {
    lines.push("", t("reqTodoExecutionPromptHeader"));
    for (const [idx, todo] of todos.entries()) {
      const parts = [
        `${idx + 1}. ${todo.title}`,
        `[${t(`reqTodoKind_${todo.kind}`)} / ${t(`reqTodoStatus_${todo.status}`)}]`,
      ];
      if (todo.command?.trim()) {
        parts.push(t("reqTodoInjectPromptCommand", todo.command.trim()));
      }
      lines.push(parts.join(" "));
    }
    lines.push(t("reqTodoExecutionPromptAsk"));
  }
  return lines.join("\n");
}

// =============================================================
// Session records section — RequirementRun history rendering.
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

function SessionRecordsSection({
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
        <div className="requirement-detail-record-title">
          <span className="requirement-detail-runs-heading">
            {t("runsHeading")}
          </span>
          <p>{t("runsHeadingHint")}</p>
        </div>
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
      <Link
        to={sessionRoute(run.conversation_id)}
        className="requirement-detail-run-session-link"
      >
        {sessionRoute(run.conversation_id)}
      </Link>
      {run.error && (
        <p className="requirement-detail-run-text run-error">{run.error}</p>
      )}
      {run.worktree_path && (
        <p
          className="requirement-detail-run-worktree"
          title={run.worktree_path}
        >
          {t("projDetailWorktreeLabel")} <code>{run.worktree_path}</code>
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
                    ? t("projDetailExitCode", 0)
                    : t("projDetailExitCode", cmd.exit_code ?? "?")}
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
    <form
      className="requirement-detail-run-verify"
      onSubmit={(e) => void submit(e)}
    >
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

function ActivityModal({
  open,
  activities,
  onClose,
}: {
  open: boolean;
  activities: Activity[];
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("activityHeading")}
      size="md"
      dialogClassName="requirement-activity-modal"
    >
      <div className="requirement-activity-modal-body">
        <p className="requirement-activity-modal-hint">
          {t("activityHint")}
        </p>
        <span className="requirement-detail-record-meta requirement-activity-modal-count">
          {t("activitySummary", activities.length)}
        </span>
      </div>
      <ActivityList activities={activities} />
    </Modal>
  );
}

// =============================================================
// Labels row — Phase 3.8.
// =============================================================
//
// Shows the requirement's existing label chips and a tiny "Edit"
// button that opens the multi-select picker. Saving fires
// `updateRequirement(id, { label_ids })` which optimistically
// repaints the row and PATCHes the server in the background.

function RequirementLabelsRow({ requirement }: { requirement: Requirement }) {
  const [picking, setPicking] = useState(false);
  // Hydrate label cache for this project so chips resolve.
  useEnsureLabels(requirement.project_id);

  return (
    <div className="requirement-detail-labels-row">
      <RequirementLabelChips
        ids={requirement.label_ids}
        emptyHint={t("labelsEmptyHint")}
      />
      <button
        type="button"
        className="requirement-detail-comment-action"
        onClick={() => setPicking(true)}
      >
        {t("labelsEditButton")}
      </button>
      <RequirementLabelPicker
        projectId={requirement.project_id}
        selected={requirement.label_ids ?? []}
        open={picking}
        onClose={() => setPicking(false)}
        onSave={(nextIds) => {
          updateRequirement(requirement.id, { label_ids: nextIds });
        }}
      />
    </div>
  );
}
