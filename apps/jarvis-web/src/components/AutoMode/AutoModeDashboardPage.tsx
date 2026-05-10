// Auto-mode scheduler dashboard. Shows what the background loop is
// doing right now: pause / resume toggle, scheduler config snapshot,
// in-flight runs, recent run history, recent failures, and
// blocked-by-guard requirements that the loop didn't pick up.
//
// Data flow: REST snapshots polled every 5s (no WS frame parsing —
// the dashboard is rarely the active tab and 5s lag is acceptable).
// On socket reconnect / window-focus the polling timer is reset so
// the user sees a fresh snapshot when they return.

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { useNavigate } from "react-router-dom";

import {
  AutoModeStatus,
  getAutoModeStatus,
  setAutoModeEnabled,
} from "../../services/autoMode";
import {
  getRun,
  listFailedRuns,
  listRecentRuns,
  listStuckRuns,
} from "../../services/diagnostics";
import {
  listRequirements,
  startRequirementRun,
  subscribeRequirements,
} from "../../services/requirements";
import { useAppStore } from "../../store/appStore";
import type {
  Project,
  Requirement,
  RequirementRun,
  RequirementRunStatus,
} from "../../types/frames";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";

const POLL_INTERVAL_MS = 5_000;

// ============================================================
// Page
// ============================================================

export function AutoModeDashboardPage() {
  // Subscribe to language so the whole page re-renders when the
  // user toggles zh ↔ en. Without this, t() reads the new language
  // on its next call but React doesn't know to re-render.
  useAppStore((s) => s.lang);
  const status = useAutoModeStatus();
  const inFlight = usePoll(() => listStuckRuns(0).then((rs) => rs ?? []), []);
  const recent = usePoll(() => listRecentRuns(50).then((rs) => rs ?? []), []);
  const failures = usePoll(() => listFailedRuns(20).then((rs) => rs ?? []), []);
  const projects = useAppStore((s) => s.projects);
  const requirementsCacheVersion = useRequirementsCacheVersion();
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const requirementsById = useMemo(() => {
    const m = new Map<string, Requirement>();
    projects.forEach((p) => {
      listRequirements(p.id).forEach((r) => m.set(r.id, r));
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, requirementsCacheVersion]);

  return (
    <main
      id="auto-mode-page"
      className="auto-mode-page"
      tabIndex={-1}
      style={pageStyle}
    >
      <header style={pageHeaderStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t("autoModePageTitle")}</h1>
          <p style={{ margin: "6px 0 0", opacity: 0.7, fontSize: 13 }}>
            {t("autoModePageSubtitle")}
          </p>
        </div>
      </header>

      <SchedulerHeaderStrip status={status} />

      <div style={panelGridStyle}>
        <Panel
          title={t("autoModePanelInFlight")}
          subtitle={t("autoModePanelInFlightCount", inFlight.length)}
        >
          <RunTable
            rows={inFlight}
            requirementsById={requirementsById}
            projectsById={projectsById}
            emptyText={t("autoModeEmptyInFlight")}
            onOpen={(r) => setOpenRunId(r.id)}
            showAge
          />
        </Panel>

        <Panel
          title={t("autoModePanelFailures")}
          subtitle={t("autoModePanelFailuresCount", failures.length)}
        >
          <RunTable
            rows={failures}
            requirementsById={requirementsById}
            projectsById={projectsById}
            emptyText={t("autoModeEmptyFailures")}
            onOpen={(r) => setOpenRunId(r.id)}
            onRetry={(r) => {
              void startRequirementRun(r.requirement_id).catch((err) => {
                console.warn("retry run failed", err);
              });
            }}
          />
        </Panel>
      </div>

      <Panel
        title={t("autoModePanelRecentRuns")}
        subtitle={t("autoModePanelRecentRunsCount", recent.length)}
      >
        <RunTable
          rows={recent}
          requirementsById={requirementsById}
          projectsById={projectsById}
          emptyText={t("autoModeEmptyRuns")}
          onOpen={(r) => setOpenRunId(r.id)}
          showStatus
        />
      </Panel>

      <Panel title={t("autoModePanelPendingTriage")}>
        <PendingTriagePanel
          projects={projects}
          requirementsById={requirementsById}
        />
      </Panel>

      <Panel title={t("autoModePanelBlocked")}>
        <BlockedRequirements
          projects={projects}
          requirementsById={requirementsById}
          maxRetries={status.data?.max_retries}
          recentRuns={recent}
        />
      </Panel>

      {openRunId && (
        <RunDetailDrawer runId={openRunId} onClose={() => setOpenRunId(null)} />
      )}
    </main>
  );
}

// ============================================================
// Hooks
// ============================================================

interface AutoModeStatusState {
  data: AutoModeStatus | null;
  toggling: boolean;
  toggle: (next: boolean) => Promise<void>;
}

function useAutoModeStatus(): AutoModeStatusState {
  const [data, setData] = useState<AutoModeStatus | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const s = await getAutoModeStatus();
      if (mounted) setData(s);
    };
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const toggle = async (next: boolean) => {
    setToggling(true);
    try {
      const s = await setAutoModeEnabled(next);
      setData((prev) => ({ ...(prev ?? s), ...s }));
    } catch (e) {
      console.warn("auto-mode toggle failed", e);
    } finally {
      setToggling(false);
    }
  };

  return { data, toggling, toggle };
}

function usePoll<T>(fetcher: () => Promise<T[]>, deps: unknown[]): T[] {
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const next = await fetcher();
        if (mounted) setRows(next);
      } catch (e) {
        console.warn("dashboard poll failed", e);
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // Caller-controlled deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return rows;
}

function useRequirementsCacheVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsub = subscribeRequirements(() => setVersion((v) => v + 1));
    return () => unsub();
  }, []);
  return version;
}

// ============================================================
// Sub-components
// ============================================================

function SchedulerHeaderStrip({ status }: { status: AutoModeStatusState }) {
  const data = status.data;
  if (!data) {
    return <div style={headerStripStyle}>{t("autoModeLoading")}</div>;
  }
  if (!data.configured) {
    return <div style={headerStripStyle}>{t("autoModeNotConfigured")}</div>;
  }
  return (
    <div style={headerStripStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ToggleButton
          enabled={data.enabled}
          busy={status.toggling}
          onChange={(next) => void status.toggle(next)}
        />
        <strong style={{ fontSize: 14 }}>
          {data.enabled
            ? t("autoModeSchedulerRunning")
            : t("autoModeSchedulerPaused")}
        </strong>
      </div>
      <div style={statRowStyle}>
        <Stat label={t("autoModeStatMode")} value={data.mode ?? "—"} />
        <Stat
          label={t("autoModeStatTick")}
          value={fmtSeconds(data.tick_seconds)}
        />
        <Stat
          label={t("autoModeStatPermits")}
          value={
            data.available_permits != null && data.max_concurrent_units != null
              ? `${data.available_permits}/${data.max_concurrent_units}`
              : "—"
          }
        />
        <Stat
          label={t("autoModeStatBurstPerTick")}
          value={
            data.max_units_per_tick != null
              ? String(data.max_units_per_tick)
              : "—"
          }
        />
        <Stat
          label={t("autoModeStatRetries")}
          value={data.max_retries != null ? String(data.max_retries) : "—"}
        />
        <Stat
          label={t("autoModeStatRunTimeout")}
          value={
            data.run_timeout_ms != null
              ? `${Math.round(data.run_timeout_ms / 1000)}s`
              : "—"
          }
        />
        <Stat
          label={t("autoModeStatLastTick")}
          value={data.last_tick_at ? relTime(data.last_tick_at) : "—"}
        />
      </div>
    </div>
  );
}

function ToggleButton({
  enabled,
  busy,
  onChange,
}: {
  enabled: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  const hint = enabled ? t("autoModePauseHint") : t("autoModeResumeHint");
  return (
    <button
      type="button"
      className={
        "project-auto-switch" +
        (enabled ? " is-on" : "") +
        (busy ? " is-pending" : "")
      }
      onClick={() => onChange(!enabled)}
      disabled={busy}
      aria-pressed={enabled}
      aria-label={hint}
      title={hint}
    >
      <span className="project-auto-switch-track" aria-hidden="true">
        <span className="project-auto-switch-knob" />
      </span>
      <span>{enabled ? t("autoModeOnLabel") : t("autoModeOffLabel")}</span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <span style={{ opacity: 0.55, fontSize: 11, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={panelStyle}>
      <header style={panelHeaderStyle}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
        {subtitle && <span style={{ opacity: 0.6, fontSize: 12 }}>{subtitle}</span>}
      </header>
      <div>{children}</div>
    </section>
  );
}

interface RunRow extends RequirementRun {
  age_seconds?: number; // present on StuckRun rows
}

function RunTable({
  rows,
  requirementsById,
  projectsById,
  emptyText,
  onOpen,
  onRetry,
  showAge,
  showStatus,
}: {
  rows: RunRow[];
  requirementsById: Map<string, Requirement>;
  projectsById: Map<string, Project>;
  emptyText: string;
  onOpen: (r: RunRow) => void;
  onRetry?: (r: RunRow) => void;
  showAge?: boolean;
  showStatus?: boolean;
}) {
  if (rows.length === 0) {
    return <p style={emptyStyle}>{emptyText}</p>;
  }
  return (
    <ul style={listStyle}>
      {rows.map((r) => {
        const req = requirementsById.get(r.requirement_id);
        const project = req ? projectsById.get(req.project_id) : undefined;
        return (
          <li key={r.id} style={rowStyle}>
            <button
              type="button"
              style={rowMainBtnStyle}
              onClick={() => onOpen(r)}
              title={r.id}
            >
              <span style={rowTitleStyle}>
                {req?.title ??
                  t("autoModeFallbackTitle", r.requirement_id.slice(0, 8))}
              </span>
              <span style={rowSubStyle}>
                {project?.name ?? "—"} ·{" "}
                {r.age_seconds != null && showAge
                  ? formatAge(r.age_seconds)
                  : relTime(r.finished_at ?? r.started_at)}
                {showStatus ? ` · ${r.status}` : ""}
              </span>
              {(showStatus || onRetry) && r.error && (
                <span style={errorLineStyle} title={r.error}>
                  {firstLine(r.error)}
                </span>
              )}
            </button>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <StatusBadge status={r.status} />
              {onRetry && (
                <button
                  type="button"
                  style={retryBtnStyle}
                  onClick={() => onRetry(r)}
                  title={t("autoModeRetryHint")}
                >
                  {t("autoModeRetryButton")}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({ status }: { status: RequirementRunStatus }) {
  return (
    <span
      style={{
        ...badgeStyle,
        background: badgeColor(status),
        color: badgeTextColor(status),
      }}
    >
      {status}
    </span>
  );
}

function PendingTriagePanel({
  projects,
  requirementsById,
}: {
  projects: Project[];
  requirementsById: Map<string, Requirement>;
}) {
  const navigate = useNavigate();
  const pending = useMemo(() => {
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const out: Array<{ req: Requirement; project: Project; source: string }> = [];
    for (const req of requirementsById.values()) {
      const ts = req.triage_state;
      if (!ts || ts === "approved") continue;
      const project = projectsById.get(req.project_id);
      if (!project) continue;
      const source =
        ts === "proposed_by_scan"
          ? t("triageSourceScan")
          : t("triageSourceAgent");
      out.push({ req, project, source });
    }
    // Newest first by updated_at
    out.sort((a, b) => b.req.updated_at.localeCompare(a.req.updated_at));
    return out;
  }, [projects, requirementsById]);

  if (pending.length === 0) {
    return <p style={emptyStyle}>{t("autoModeEmptyPendingTriage")}</p>;
  }

  return (
    <ul style={listStyle}>
      {pending.map(({ req, project, source }) => (
        <li key={req.id} style={rowStyle}>
          <button
            type="button"
            style={rowMainBtnStyle}
            onClick={() => void navigate(`/projects/${project.id}`)}
            title={t("autoModePendingTriageOpenHint", project.name)}
          >
            <span style={rowTitleStyle}>{req.title}</span>
            <span style={rowSubStyle}>
              {project.name} · {source}
            </span>
          </button>
          <span
            style={{
              ...badgeStyle,
              background: "#bf7d3a",
              color: "#fff",
            }}
          >
            {source}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BlockedRequirements({
  projects,
  requirementsById,
  maxRetries,
  recentRuns,
}: {
  projects: Project[];
  requirementsById: Map<string, Requirement>;
  maxRetries: number | undefined;
  recentRuns: RequirementRun[];
}) {
  const blocked = useMemo(() => {
    const out: Array<{ req: Requirement; project: Project; reason: string }> = [];
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    for (const req of requirementsById.values()) {
      if (req.status !== "backlog") continue;
      // Triage gate: only Approved (or absent — legacy rows) qualify
      // for auto-mode pickup. ProposedBy* rows are pre-triage.
      if (req.triage_state && req.triage_state !== "approved") continue;
      const reasons: string[] = [];
      const deps = req.depends_on ?? [];
      const unmet = deps.filter((depId) => {
        const dep = requirementsById.get(depId);
        return !dep || dep.status !== "done";
      });
      if (unmet.length > 0) {
        reasons.push(t("autoModeBlockedReasonDeps", unmet.length));
      }
      if (maxRetries != null) {
        const failedRecently = recentRuns.filter(
          (r) => r.requirement_id === req.id && r.status === "failed",
        ).length;
        if (failedRecently >= maxRetries) {
          reasons.push(
            t("autoModeBlockedReasonRetries", failedRecently, maxRetries),
          );
        }
      }
      if (reasons.length === 0) continue;
      const project = projectsById.get(req.project_id);
      if (!project) continue;
      out.push({ req, project, reason: reasons.join(" · ") });
    }
    return out;
  }, [projects, requirementsById, maxRetries, recentRuns]);

  if (blocked.length === 0) {
    return <p style={emptyStyle}>{t("autoModeEmptyBlocked")}</p>;
  }

  return (
    <ul style={listStyle}>
      {blocked.map(({ req, project, reason }) => (
        <li key={req.id} style={rowStyle}>
          <div style={rowMainBtnStyle}>
            <span style={rowTitleStyle}>{req.title}</span>
            <span style={rowSubStyle}>
              {project.name} · {reason}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RunDetailDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<RequirementRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void getRun(runId).then((r) => {
      if (mounted) {
        setRun(r);
        setLoading(false);
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      mounted = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [runId, onClose]);

  return (
    <div style={drawerOverlayStyle} onClick={onClose}>
      <aside
        style={drawerStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("runDetailDialogAria")}
      >
        <header style={drawerHeaderStyle}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{t("runDetailTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
            aria-label={t("runDetailCloseAria")}
          >
            ×
          </button>
        </header>
        <div style={{ padding: 16, overflow: "auto" }}>
          {loading ? (
            <p style={emptyStyle}>{t("runDetailLoading")}</p>
          ) : !run ? (
            <p style={emptyStyle}>{t("runDetailNotFound")}</p>
          ) : (
            <DetailBody run={run} />
          )}
        </div>
      </aside>
    </div>
  );
}

function DetailBody({ run }: { run: RequirementRun }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <KV label={t("runDetailRunId")} value={<code>{run.id}</code>} />
      <KV
        label={t("runDetailStatusLabel")}
        value={<StatusBadge status={run.status} />}
      />
      <KV
        label={t("runDetailRequirementLabel")}
        value={<code>{run.requirement_id}</code>}
      />
      <KV
        label={t("runDetailConversationLabel")}
        value={<code>{run.conversation_id}</code>}
      />
      <KV
        label={t("runDetailStartedLabel")}
        value={`${run.started_at} (${relTime(run.started_at)})`}
      />
      {run.finished_at && (
        <KV
          label={t("runDetailFinishedLabel")}
          value={`${run.finished_at} (${relTime(run.finished_at)})`}
        />
      )}
      {run.summary && (
        <KV
          label={t("runDetailSummaryLabel")}
          value={<pre style={preStyle}>{run.summary}</pre>}
        />
      )}
      {run.error && (
        <KV
          label={t("runDetailErrorLabel")}
          value={<pre style={preStyle}>{run.error}</pre>}
        />
      )}
      {run.verification && (
        <KV
          label={t("runDetailVerificationLabel")}
          value={
            <span>
              {run.verification.status}
              {run.verification.notes ? ` — ${run.verification.notes}` : ""}
            </span>
          }
        />
      )}
      {run.logs && run.logs.length > 0 && (
        <div>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
            {t("runDetailLogsLabel")}
          </div>
          <ul style={{ ...listStyle, gap: 4 }}>
            {run.logs.map((l) => (
              <li key={l.id} style={logRowStyle}>
                <span style={{ opacity: 0.5, fontSize: 11 }}>
                  {l.created_at}
                </span>
                <span style={{ marginLeft: 6 }}>
                  [{l.level}] {l.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={{ opacity: 0.55, fontSize: 11, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function fmtSeconds(s?: number): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return t("autoModeAgeStartedSeconds", seconds);
  if (seconds < 3600)
    return t("autoModeAgeStartedMinutes", Math.round(seconds / 60));
  return t("autoModeAgeStartedHours", (seconds / 3600).toFixed(1));
}

function firstLine(s: string): string {
  const ix = s.indexOf("\n");
  return ix < 0 ? s : s.slice(0, ix);
}

function badgeColor(status: RequirementRunStatus): string {
  switch (status) {
    case "running":
      return "#1f77ff";
    case "pending":
      return "#888";
    case "completed":
      return "#1f9e54";
    case "failed":
      return "#d33b3b";
    case "cancelled":
      return "#bf7d3a";
    default:
      return "#666";
  }
}

function badgeTextColor(_: RequirementRunStatus): string {
  return "#fff";
}

// ============================================================
// Inline styles — kept local so this surface ships without
// depending on style refactors elsewhere. Class-name based styling
// can come later once the shape settles.
// ============================================================

const pageStyle: React.CSSProperties = {
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  overflowY: "auto",
  height: "100vh",
  boxSizing: "border-box",
};

const pageHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
};

const headerStripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  alignItems: "center",
  padding: 16,
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 8,
  background: "var(--card-bg, rgba(255,255,255,0.02))",
};

const statRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 18,
  marginLeft: "auto",
};

const statStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const panelGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
  gap: 16,
};

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 8,
  background: "var(--card-bg, rgba(255,255,255,0.02))",
  padding: 12,
};

const panelHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "8px 10px",
  border: "1px solid var(--border-subtle, rgba(255,255,255,0.06))",
  borderRadius: 6,
};

const rowMainBtnStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
  padding: 0,
};

const rowTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const rowSubStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.65,
};

const errorLineStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#d33b3b",
  marginTop: 2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "16px 4px",
  fontSize: 12,
  opacity: 0.6,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  padding: "2px 6px",
  borderRadius: 4,
  fontWeight: 600,
};

const retryBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

const drawerOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  zIndex: 200,
  display: "flex",
  justifyContent: "flex-end",
};

const drawerStyle: React.CSSProperties = {
  width: "min(560px, 95vw)",
  height: "100vh",
  background: "var(--bg, #1a1a1a)",
  borderLeft: "1px solid var(--border, #2b2b2b)",
  display: "flex",
  flexDirection: "column",
};

const drawerHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: 16,
  borderBottom: "1px solid var(--border, #2b2b2b)",
};

const closeBtnStyle: React.CSSProperties = {
  fontSize: 22,
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 0,
  width: 32,
  height: 32,
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: "rgba(0,0,0,0.25)",
  borderRadius: 4,
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const logRowStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
  padding: "4px 6px",
  background: "rgba(0,0,0,0.2)",
  borderRadius: 4,
};
