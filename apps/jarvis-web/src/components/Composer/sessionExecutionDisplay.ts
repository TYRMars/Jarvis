// Pure derivation: ConversationWorkContext → SessionExecutionDisplay.
//
// Drives the in-session execution shoulder. Kept side-effect-free so
// it can be unit-tested deterministically — the shoulder component
// passes a frozen `now` for elapsed-label rendering and the active
// language; tests pin both.
//
// Strings live inline (not in `utils/i18n.ts`) because they only
// surface here and pinning them next to the mapping makes the
// spec ↔ code review trivial. If a future surface needs the same
// labels, lift them into `utils/i18n.ts` then.

import type {
  Activity,
  Requirement,
  RequirementRun,
  RequirementRunStatus,
  RequirementStatus,
  VerificationStatus,
} from "../../types/frames";

export type DisplayLang = "en" | "zh";

export type DisplayTone =
  | "neutral"
  | "running"
  | "success"
  | "warning"
  | "danger";

/// Aggregated input for derivation. Mirrors the spec's
/// `ConversationWorkContext` shape — see
/// `docs/proposals/session-execution-context.zh-CN.md`.
export interface ConversationWorkContext {
  conversationId: string;
  projectId: string | null;
  requirement: Requirement | null;
  latestRun: RequirementRun | null;
  recentActivities: Activity[];
}

/// One-row presentational shape rendered by
/// `SessionExecutionShoulder`. Returns `null` from the builder when
/// there's no Requirement to talk about — the shoulder hides itself
/// in that case (Free chat).
export interface SessionExecutionDisplay {
  requirementId: string;
  requirementLabel: string;
  title: string;
  requirementStatus: RequirementStatus;
  runStatus?: RequirementRunStatus;
  verificationStatus?: VerificationStatus;
  /// Human-readable status (`Running · 1m37s`, `已通过`, …).
  statusLabel: string;
  /// Optional sub-chip text (verification status / Git diff stub).
  /// Empty string when no secondary signal is worth showing.
  detailLabel: string;
  /// The right-side action button caption.
  actionLabel: string;
  tone: DisplayTone;
}

/// Pick the primary Requirement when a Conversation is linked to
/// several. Spec § "派生规则":
///   1. Newest pending/running run wins;
///   2. Else newest `updated_at`;
///   3. Else last entry in `conversation_ids` referencing the
///      current conversation.
export function pickPrimaryRequirement(
  candidates: Requirement[],
  runsByRequirement: Record<string, RequirementRun[]>,
  conversationId: string,
): Requirement | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const live = candidates.filter((r) => {
    const runs = runsByRequirement[r.id] ?? [];
    return runs.some((x) => x.status === "running" || x.status === "pending");
  });
  if (live.length > 0) {
    return [...live].sort((a, b) =>
      latestRunStarted(runsByRequirement[b.id] ?? []).localeCompare(
        latestRunStarted(runsByRequirement[a.id] ?? []),
      ),
    )[0];
  }

  const byUpdated = [...candidates].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  if (byUpdated.length > 0 && byUpdated[0].updated_at !== byUpdated[1]?.updated_at) {
    return byUpdated[0];
  }

  // Final fallback: the requirement that lists `conversationId` last
  // wins ties — i.e. the most recently linked.
  let chosen: Requirement | null = null;
  let chosenIndex = -1;
  for (const r of candidates) {
    const idx = r.conversation_ids.lastIndexOf(conversationId);
    if (idx > chosenIndex) {
      chosen = r;
      chosenIndex = idx;
    }
  }
  return chosen ?? byUpdated[0] ?? null;
}

function latestRunStarted(runs: RequirementRun[]): string {
  if (runs.length === 0) return "";
  return [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
    .started_at;
}

interface Strings {
  reqLabel: (id: string) => string;
  ready: string;
  queued: string;
  running: (elapsed: string) => string;
  passed: string;
  needsReview: string;
  failed: string;
  cancelled: string;
  review: string;
  done: string;
  verifying: string;
  openDetail: string;
  viewLogs: string;
  viewRecord: string;
  retry: string;
}

const STRINGS: Record<DisplayLang, Strings> = {
  en: {
    reqLabel: (id) => `REQ-${id.slice(0, 6)}`,
    ready: "Ready · not started",
    queued: "Queued",
    running: (elapsed) => `Running · ${elapsed}`,
    passed: "Passed",
    needsReview: "Needs review",
    failed: "Failed",
    cancelled: "Cancelled",
    review: "Review",
    done: "Done",
    verifying: "Verifying",
    openDetail: "Open detail",
    viewLogs: "View logs",
    viewRecord: "View record",
    retry: "Retry",
  },
  zh: {
    reqLabel: (id) => `REQ-${id.slice(0, 6)}`,
    ready: "就绪 · 尚未开始",
    queued: "排队中",
    running: (elapsed) => `执行中 · ${elapsed}`,
    passed: "已通过",
    needsReview: "待 review",
    failed: "失败",
    cancelled: "已取消",
    review: "审核",
    done: "已完成",
    verifying: "验证中",
    openDetail: "打开详情",
    viewLogs: "查看日志",
    viewRecord: "查看记录",
    retry: "重试",
  },
};

/// Format a duration into `1m37s` / `45s` / `2h05m`. Stable output
/// for the same inputs (no rounding wobble across re-renders).
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/// Map a Requirement / latest-run / verification triple to the
/// display row. Returns `null` when there is no Requirement (Free
/// chat — the shoulder hides itself).
///
/// The mapping follows spec § "文案映射" verbatim. Keep that table
/// and this function in sync when either side changes.
export function buildSessionExecutionDisplay(
  ctx: ConversationWorkContext,
  now: number,
  lang: DisplayLang = "en",
): SessionExecutionDisplay | null {
  const req = ctx.requirement;
  if (!req) return null;
  const s = STRINGS[lang];
  const run = ctx.latestRun;
  const verification = run?.verification ?? null;

  const base = {
    requirementId: req.id,
    requirementLabel: s.reqLabel(req.id),
    title: req.title,
    requirementStatus: req.status,
    runStatus: run?.status,
    verificationStatus: verification?.status,
  };

  // Terminal Requirement statuses dominate everything below.
  if (req.status === "done") {
    return {
      ...base,
      statusLabel: s.done,
      detailLabel: verification?.status === "passed" ? s.passed : "",
      actionLabel: s.viewRecord,
      tone: "success",
    };
  }
  if (req.status === "review") {
    return {
      ...base,
      statusLabel: s.review,
      detailLabel: verification?.status === "needs_review" ? s.needsReview : "",
      actionLabel: s.openDetail,
      tone: "warning",
    };
  }

  // Requirement in_progress / backlog: the run drives the display.
  if (!run) {
    // No run yet — show "Ready" so the user knows the chat is bound.
    return {
      ...base,
      statusLabel: s.ready,
      detailLabel: "",
      actionLabel: s.openDetail,
      tone: "neutral",
    };
  }

  switch (run.status) {
    case "pending":
      return {
        ...base,
        statusLabel: s.queued,
        detailLabel: "",
        actionLabel: s.openDetail,
        tone: "neutral",
      };
    case "running": {
      const started = Date.parse(run.started_at);
      const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
      return {
        ...base,
        statusLabel: s.running(formatElapsed(elapsedMs)),
        detailLabel: verification ? "" : s.verifying,
        actionLabel: s.openDetail,
        tone: "running",
      };
    }
    case "completed":
      if (verification?.status === "passed") {
        return {
          ...base,
          statusLabel: s.passed,
          detailLabel: "",
          actionLabel: s.viewRecord,
          tone: "success",
        };
      }
      if (verification?.status === "needs_review") {
        return {
          ...base,
          statusLabel: s.needsReview,
          detailLabel: "",
          actionLabel: s.openDetail,
          tone: "warning",
        };
      }
      if (verification?.status === "failed") {
        return {
          ...base,
          statusLabel: s.failed,
          detailLabel: firstFailingCommand(verification),
          actionLabel: s.viewLogs,
          tone: "danger",
        };
      }
      // Completed with no verification yet — verification probably
      // about to start. Mirror the running tone.
      return {
        ...base,
        statusLabel: s.verifying,
        detailLabel: "",
        actionLabel: s.openDetail,
        tone: "running",
      };
    case "failed":
      return {
        ...base,
        statusLabel: s.failed,
        detailLabel: run.error ? truncate(run.error, 80) : "",
        actionLabel: s.viewLogs,
        tone: "danger",
      };
    case "cancelled":
      return {
        ...base,
        statusLabel: s.cancelled,
        detailLabel: "",
        actionLabel: s.retry,
        tone: "warning",
      };
    default:
      return {
        ...base,
        statusLabel: run.status,
        detailLabel: "",
        actionLabel: s.openDetail,
        tone: "neutral",
      };
  }
}

function firstFailingCommand(
  v: { command_results?: { command: string; exit_code?: number | null }[] } | null,
): string {
  if (!v?.command_results) return "";
  const failed = v.command_results.find(
    (c) => typeof c.exit_code === "number" && c.exit_code !== 0,
  );
  if (!failed) return "";
  return truncate(failed.command, 60);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
