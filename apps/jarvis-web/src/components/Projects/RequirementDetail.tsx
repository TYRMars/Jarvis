import { useEffect, useState } from "react";
import type {
  Activity,
  ActivityActor,
  AgentProfile,
  Requirement,
  RequirementRun,
  RequirementRunStatus,
  RequirementStatus,
  VerificationStatus,
} from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  getAgentProfileFromCache,
  listAgentProfiles,
  loadAgentProfiles,
  subscribeAgentProfiles,
} from "../../services/agentProfiles";
import {
  linkRequirementConversation,
  listActivitiesForRequirement,
  listRunsForRequirement,
  loadActivitiesForRequirement,
  loadRunsForRequirement,
  subscribeRequirementActivities,
  subscribeRequirementRuns,
  updateRequirement,
  verifyRunByCommands,
} from "../../services/requirements";
import { COLUMNS } from "./columns";
import { MarkdownLite } from "./MarkdownLite";

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
  activeConversationId,
  onClose,
  onChanged,
  onOpenConversation,
}: {
  requirement: Requirement | null;
  activeConversationId: string | null;
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

  const desc = requirement.description?.trim() ?? "";
  const sessions = requirement.conversation_ids.length;
  const idShort = requirement.id.replace(/-/g, "").slice(0, 6).toUpperCase();
  const canLink =
    !!activeConversationId &&
    !requirement.conversation_ids.includes(activeConversationId);
  const statusCol = COLUMNS.find((c) => c.status === requirement.status);
  const statusLabel = statusCol ? t(statusCol.labelKey) : requirement.status;

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

  const linkCurrent = () => {
    if (!activeConversationId) return;
    linkRequirementConversation(requirement.id, activeConversationId);
    onChanged();
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
            <select
              className={
                "requirement-status-pill status-" + requirement.status
              }
              value={requirement.status}
              onChange={(e) => setStatus(e.target.value as RequirementStatus)}
              aria-label={t("reqStatusAria", statusLabel)}
            >
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {t(c.labelKey)}
                </option>
              ))}
            </select>
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

        <h2
          id="requirement-detail-title"
          className="requirement-detail-title"
        >
          {requirement.title}
        </h2>

        <AssigneePicker
          assigneeId={requirement.assignee_id ?? null}
          profiles={profiles}
          onChange={setAssignee}
        />

        {desc ? (
          <div className="requirement-detail-body">
            <MarkdownLite text={desc} />
          </div>
        ) : (
          <p className="requirement-detail-empty">{t("detailEmptyDesc")}</p>
        )}

        <RunsSection runs={runs} />
        <ActivitySection activities={activities} />

        <footer className="requirement-detail-footer">
          {sessions > 0 && (
            <span className="requirement-detail-sessions">
              {t("reqSessions", sessions)}
            </span>
          )}
          <span className="flex-1" />
          {requirement.conversation_ids[0] && (
            <button
              type="button"
              className="requirement-link-btn"
              onClick={() =>
                onOpenConversation(requirement.conversation_ids[0])
              }
            >
              {t("detailOpenLatest")}
            </button>
          )}
          {canLink && (
            <button
              type="button"
              className="requirement-link-btn"
              onClick={linkCurrent}
            >
              {t("detailLinkCurrent")}
            </button>
          )}
        </footer>
      </aside>
    </>
  );
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

function RunsSection({ runs }: { runs: RequirementRun[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="requirement-detail-runs">
      <h3 className="requirement-detail-runs-heading">{t("runsHeading")}</h3>
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
                    Run #{displayNumber}
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
                {isOpen && <RunDetail run={run} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function RunStatusPill({ status }: { status: RequirementRunStatus }) {
  const labelKey = {
    pending: "runStatusPending",
    running: "runStatusRunning",
    completed: "runStatusCompleted",
    failed: "runStatusFailed",
    cancelled: "runStatusCancelled",
  }[status];
  return (
    <span className={"requirement-run-pill run-status-" + status}>
      {t(labelKey)}
    </span>
  );
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

function RunDetail({ run }: { run: RequirementRun }) {
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
      <VerifyRunForm run={run} />
    </div>
  );
}

// Phase 4 — inline "Run verification" form. Runs sequentially
// against `/v1/runs/:id/verify`; the resulting `verification` is
// applied through the WS frame, so we just need to fire-and-await
// the request and surface errors.
function VerifyRunForm({ run }: { run: RequirementRun }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <form className="requirement-detail-run-verify" onSubmit={submit}>
      <label className="requirement-detail-run-verify-label">
        {t("verifyRunLabel")}
      </label>
      <textarea
        className="requirement-detail-run-verify-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="cargo test&#10;npm --prefix apps/jarvis-web test -- --run"
        rows={3}
        disabled={busy}
      />
      {error && <p className="requirement-detail-run-verify-error">{error}</p>}
      <button type="submit" disabled={busy || run.status === "running"}>
        {busy ? t("verifyRunRunning") : t("verifyRunButton")}
      </button>
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
    <section className="requirement-detail-activities">
      <h3 className="requirement-detail-runs-heading">{t("activityHeading")}</h3>
      {activities.length === 0 ? (
        <p className="requirement-detail-empty">{t("activityEmpty")}</p>
      ) : (
        <ol className="requirement-detail-activity-list">
          {activities.map((a) => (
            <li key={a.id} className={"requirement-detail-activity-row kind-" + a.kind}>
              <span className="requirement-detail-activity-time">
                {formatTime(a.created_at)}
              </span>
              <span className="requirement-detail-activity-actor">
                {actorLabel(a.actor)}
              </span>
              <span className="requirement-detail-activity-text">
                {activityText(a)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function actorLabel(actor: ActivityActor): string {
  switch (actor.type) {
    case "human":
      return t("activityActorHuman");
    case "system":
      return t("activityActorSystem");
    case "agent":
      return t("activityActorAgent", actor.profile_id);
  }
}

function activityText(a: Activity): string {
  const body = a.body as Record<string, string | undefined>;
  switch (a.kind) {
    case "status_change":
      return t("activityStatusChange", body.from ?? "?", body.to ?? "?");
    case "run_started":
      return t("activityRunStarted", shortenId(body.run_id));
    case "run_finished":
      return t(
        "activityRunFinished",
        shortenId(body.run_id),
        body.status ?? "?",
      );
    case "verification_finished":
      return t(
        "activityVerificationFinished",
        shortenId(body.run_id),
        body.status ?? "?",
      );
    case "assignee_change": {
      const fromName = assigneeName(body.from);
      const toName = assigneeName(body.to);
      return t("activityAssigneeChange", fromName, toName);
    }
    default:
      return t("activityFallback", a.kind);
  }
}

/// Resolve an assignee id (from an `assignee_change` activity body)
/// into a human-readable label. `null` / `undefined` ⇒ "Unassigned";
/// known id ⇒ the profile name; unknown id ⇒ short id stub.
function assigneeName(id: string | undefined | null): string {
  if (id == null) return t("detailAssigneeUnassigned");
  const p = getAgentProfileFromCache(id);
  return p ? p.name : shortenId(id);
}

function shortenId(id: string | undefined): string {
  if (!id) return "?";
  return id.slice(0, 8);
}

// =============================================================
// Assignee picker — Phase 3.6.
// =============================================================
//
// Compact <select> rendered above the description in the detail
// panel. Empty option = unassigned; remaining options come from
// the cached AgentProfile list. When the cache is empty (no
// profiles yet, or `agent_profiles` store not configured) the
// row collapses to a tiny hint text linking to the Settings tab.

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

  return (
    <div className="requirement-detail-assignee">
      <label className="requirement-detail-assignee-label">
        {t("detailAssigneeLabel")}
      </label>
      <select
        className="requirement-detail-assignee-select"
        value={assigneeId ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("detailAssigneeUnassigned")}</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.avatar ? `${p.avatar} ${p.name}` : p.name}
          </option>
        ))}
        {hasUnknownAssignee && (
          <option value={assigneeId}>{`(unknown ${shortenId(
            assigneeId,
          )})`}</option>
        )}
      </select>
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
