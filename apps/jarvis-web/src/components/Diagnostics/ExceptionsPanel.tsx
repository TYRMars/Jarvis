// v1.0 — Sentry-style exceptions panel for the WorkOverview.
//
// Replaces the three-section "异常排查" body with one aggregated
// issue feed: errors are grouped by signature (so 12 retries of the
// same root cause read as one card with `× 12`), each card carries
// a severity badge, last-seen relative time, affected resources,
// and an optional resolution hint. Operators can mark an issue
// "ignored" (browser-local) to dismiss known noise without losing
// the underlying record.
//
// Data sources (via existing services):
//   - workOverview.recent_failures → grouped agent errors
//   - diagnostics/orphans          → "Orphan worktrees on disk"
//   - diagnostics/runs/stuck       → "Runs stuck in <status>"
//
// The orphan-cleanup action stays here: clicking the Cleanup button
// on the orphan-summary card calls the same REST endpoint the old
// DiagnosticsPanels exposed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../utils/i18n";
import {
  cleanupOrphanWorktrees,
  listFailedRuns,
  listOrphanWorktrees,
  listStuckRuns,
  type OrphanWorktree,
  type StuckRun,
} from "../../services/diagnostics";
import {
  aggregateIssues,
  ignoredSignatures,
  ignoreIssue,
  subscribeIgnored,
  unignoreIssue,
  type Issue,
  type IssueSeverity,
} from "../../services/issueAggregator";
import type { RecentFailureRow, WorkOverview } from "../../services/workOverview";
import { resumeConversation } from "../../services/conversations";
import type { RequirementRun } from "../../types/frames";

interface Props {
  /// `WorkOverview` snapshot — `recent_failures` is the primary
  /// source. Pass through the same overview the page already
  /// fetched so we don't double-call /v1/work/overview.
  overview: WorkOverview | null;
}

type Filter = "open" | "critical" | "high" | "warning" | "ignored";

export function ExceptionsPanel({ overview }: Props) {
  const [orphans, setOrphans] = useState<OrphanWorktree[] | null>(null);
  const [stuck, setStuck] = useState<StuckRun[] | null>(null);
  const [, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("open");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cleaningUp, setCleaningUp] = useState(false);
  const [ignoredVersion, setIgnoredVersion] = useState(0);
  const navigate = useNavigate();

  // Diagnostics services aren't on the WorkOverview snapshot; pull
  // them ourselves. Two endpoints, fail-soft to `null` on 503 (the
  // aggregator just produces fewer issues — never crashes).
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [o, s] = await Promise.all([listOrphanWorktrees(), listStuckRuns()]);
      setOrphans(o);
      setStuck(s);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cumulative refresh: subscribe to the ignore-list so the panel
  // re-renders when the user (or another tab) flips an issue's
  // ignored state.
  useEffect(() => subscribeIgnored(() => setIgnoredVersion((v) => v + 1)), []);

  // Aggregate. Recompute whenever any of the inputs change.
  const allIssues = useMemo(() => {
    const failures = overview?.recent_failures ?? [];
    return aggregateIssues({
      failures,
      orphans: orphans ?? [],
      stuck: stuck ?? [],
    });
  }, [overview, orphans, stuck]);

  const ignored = useMemo(() => ignoredSignatures(), [ignoredVersion]);

  const visible = useMemo(() => {
    return allIssues.filter((i) => {
      const isIgnored = ignored.has(i.signature);
      if (filter === "ignored") return isIgnored;
      if (isIgnored) return false;
      if (filter === "open") return true;
      return i.severity === filter;
    });
  }, [allIssues, ignored, filter]);

  const counts = useMemo(() => {
    const c = { open: 0, critical: 0, high: 0, warning: 0, ignored: 0 };
    for (const i of allIssues) {
      if (ignored.has(i.signature)) {
        c.ignored++;
        continue;
      }
      c.open++;
      c[i.severity]++;
    }
    return c;
  }, [allIssues, ignored]);

  const toggleExpanded = (sig: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sig)) next.delete(sig);
      else next.add(sig);
      return next;
    });
  };

  const handleOpenAffected = (
    affId: string,
    convoId: string | null | undefined,
  ) => {
    if (convoId) {
      void resumeConversation(convoId);
      void navigate("/");
      return;
    }
    // Fallback: jump to the requirement's parent project (we don't
    // have project_id on every affected row, so navigate to the
    // requirement detail page if needed). Simpler: open the
    // requirement-detail panel in the project — but that requires
    // project_id. For now just navigate to /projects.
    void navigate(`/projects`);
    void affId;
  };

  const handleCleanupOrphans = async () => {
    if (cleaningUp) return;
    if (!orphans || orphans.length === 0) return;
    if (!window.confirm(t("diagnosticsConfirmCleanup"))) return;
    setCleaningUp(true);
    try {
      await cleanupOrphanWorktrees();
      await refresh();
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <section className="exceptions-panel" aria-label={t("exceptionsTitle")}>
      <header className="exceptions-head">
        <div className="exceptions-head-titles">
          <h3>{t("exceptionsTitle")}</h3>
          <p className="exceptions-subtitle">{t("exceptionsSubtitle")}</p>
        </div>
        <button
          type="button"
          className="exceptions-refresh"
          onClick={() => void refresh()}
          title={t("statusManualRefresh")}
          aria-label={t("statusRefresh")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 4v5h-5" />
          </svg>
        </button>
      </header>

      <div className="exceptions-filters" role="tablist" aria-label={t("exceptionsFilterLabel")}>
        <FilterChip filter="open" current={filter} count={counts.open} onClick={setFilter} label={t("exceptionsFilterOpen")} />
        <FilterChip filter="critical" current={filter} count={counts.critical} onClick={setFilter} label={t("exceptionsFilterCritical")} severity="critical" />
        <FilterChip filter="high" current={filter} count={counts.high} onClick={setFilter} label={t("exceptionsFilterHigh")} severity="high" />
        <FilterChip filter="warning" current={filter} count={counts.warning} onClick={setFilter} label={t("exceptionsFilterWarning")} severity="warning" />
        <FilterChip filter="ignored" current={filter} count={counts.ignored} onClick={setFilter} label={t("exceptionsFilterIgnored")} />
      </div>

      {visible.length === 0 ? (
        <EmptyState filter={filter} totalIssues={allIssues.length} />
      ) : (
        <ul className="exceptions-list">
          {visible.map((issue) => (
            <IssueCard
              key={issue.signature}
              issue={issue}
              expanded={expanded.has(issue.signature)}
              onToggle={() => toggleExpanded(issue.signature)}
              onIgnore={() => {
                if (ignored.has(issue.signature)) unignoreIssue(issue.signature);
                else ignoreIssue(issue.signature);
              }}
              isIgnored={ignored.has(issue.signature)}
              onOpenAffected={handleOpenAffected}
              onCleanupOrphans={
                issue.signature === "ow_summary" ? handleCleanupOrphans : undefined
              }
              cleaningUp={cleaningUp}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FilterChip({
  filter,
  current,
  count,
  onClick,
  label,
  severity,
}: {
  filter: Filter;
  current: Filter;
  count: number;
  onClick: (f: Filter) => void;
  label: string;
  severity?: IssueSeverity;
}) {
  const active = current === filter;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={
        "exceptions-filter-chip" +
        (active ? " is-active" : "") +
        (severity ? " sev-" + severity : "")
      }
      onClick={() => onClick(filter)}
    >
      <span>{label}</span>
      <span className="exceptions-filter-count tabular-nums">{count}</span>
    </button>
  );
}

function EmptyState({ filter, totalIssues }: { filter: Filter; totalIssues: number }) {
  if (totalIssues === 0) {
    return (
      <div className="exceptions-empty">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <p>{t("exceptionsAllClear")}</p>
        <p className="exceptions-empty-hint">{t("exceptionsAllClearHint")}</p>
      </div>
    );
  }
  return (
    <div className="exceptions-empty">
      <p>{t("exceptionsFilterEmpty", filter)}</p>
    </div>
  );
}

function IssueCard({
  issue,
  expanded,
  onToggle,
  onIgnore,
  isIgnored,
  onOpenAffected,
  onCleanupOrphans,
  cleaningUp,
}: {
  issue: Issue;
  expanded: boolean;
  onToggle: () => void;
  onIgnore: () => void;
  isIgnored: boolean;
  onOpenAffected: (id: string, convoId: string | null | undefined) => void;
  onCleanupOrphans?: () => void;
  cleaningUp: boolean;
}) {
  const lastSeen = formatRelative(issue.last_seen);
  const firstSeen = formatRelative(issue.first_seen);
  const severityLabel = {
    critical: t("severityCritical"),
    high: t("severityHigh"),
    warning: t("severityWarning"),
  }[issue.severity];

  return (
    <li
      className={
        "exception-card sev-" + issue.severity + (isIgnored ? " is-ignored" : "")
      }
    >
      <div className="exception-card-bar" aria-hidden="true" />
      <div className="exception-card-body">
        <header className="exception-card-head">
          <span
            className={"exception-severity-pill sev-" + issue.severity}
            title={severityLabel}
          >
            {severityLabel}
          </span>
          <h4 className="exception-card-title" title={issue.title}>
            {issue.title}
          </h4>
          <span className="exception-count tabular-nums" title={t("exceptionsCountTitle")}>
            × {issue.count}
          </span>
        </header>

        <div className="exception-meta">
          <CategoryChip category={issue.category} />
          <span className="exception-meta-pill">
            <span className="exception-meta-dot" aria-hidden="true" />
            {t("exceptionLastSeen", lastSeen)}
          </span>
          {issue.first_seen !== issue.last_seen && (
            <span className="exception-meta-soft">
              {t("exceptionFirstSeen", firstSeen)}
            </span>
          )}
        </div>

        {issue.hint && !isIgnored && (
          <p className="exception-hint" role="note">
            <strong>{t("exceptionHintLabel")}</strong> {issue.hint}
          </p>
        )}

        <details
          className="exception-details"
          open={expanded}
          onToggle={(e) => {
            const target = e.currentTarget;
            if (target.open !== expanded) onToggle();
          }}
        >
          <summary>
            {t("exceptionShowAffected", issue.affected.length)}
          </summary>
          <ul className="exception-affected">
            {issue.affected.slice(0, 10).map((a) => (
              <li key={a.id + a.at}>
                <span className="exception-affected-label">
                  {a.label || a.id.slice(0, 12)}
                </span>
                {a.project_name && (
                  <span className="exception-affected-project">{a.project_name}</span>
                )}
                <span className="exception-affected-time tabular-nums">
                  {formatRelative(a.at)}
                </span>
                {a.conversation_id && (
                  <button
                    type="button"
                    className="exception-affected-open"
                    onClick={() => onOpenAffected(a.id, a.conversation_id)}
                  >
                    {t("workOpenConversation")}
                  </button>
                )}
              </li>
            ))}
            {issue.affected.length > 10 && (
              <li className="exception-affected-more">
                {t("exceptionAffectedMore", issue.affected.length - 10)}
              </li>
            )}
          </ul>
          {issue.sample && (
            <pre className="exception-sample" aria-label={t("exceptionSampleLabel")}>
              {issue.sample.slice(0, 800)}
              {issue.sample.length > 800 ? "\n…" : ""}
            </pre>
          )}
        </details>

        <div className="exception-actions">
          <button
            type="button"
            className="exception-action"
            onClick={onIgnore}
          >
            {isIgnored ? t("exceptionUnignore") : t("exceptionIgnore")}
          </button>
          {onCleanupOrphans && (
            <button
              type="button"
              className="exception-action exception-action-primary"
              onClick={onCleanupOrphans}
              disabled={cleaningUp}
            >
              {cleaningUp
                ? t("diagnosticsCleanupPending")
                : t("diagnosticsCleanupAll")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function CategoryChip({ category }: { category: Issue["category"] }) {
  const labelMap = {
    agent_error: t("exceptionCategoryAgentError"),
    orphan_worktree: t("exceptionCategoryOrphanWorktree"),
    stuck_run: t("exceptionCategoryStuckRun"),
  };
  return (
    <span className={"exception-category-chip cat-" + category}>
      {labelMap[category]}
    </span>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return iso.slice(11, 19);
  if (ms < 60_000) return t("statusJustNow");
  if (ms < 3_600_000) return t("statusMinutesAgo", Math.floor(ms / 60_000));
  if (ms < 86_400_000) return t("statusHoursAgo", Math.floor(ms / 3_600_000));
  const days = Math.floor(ms / 86_400_000);
  return t("relDaysAgo", days);
}

// Backwards-compat: allow the panel to render even when callers
// don't have an overview yet (loading state). Kept as a separate
// loose export so the WorkOverview shell can fall through.
export type { RecentFailureRow, RequirementRun };
