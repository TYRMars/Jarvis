// Coding-agent change-report rail card. Aggregates the current
// conversation's tool history into a Codex-style summary:
//
//   files modified  → set of paths from fs.edit / fs.write / fs.patch
//   checks run      → shell.exec calls grouped by command kind
//                     (test / lint / build / generic)
//   approvals       → counts by status (allowed / denied)
//
// Sourced from `appStore.tasks` so it stays in sync as tools land
// without any dedicated event plumbing. Cleared whenever the active
// conversation changes (the same place that resets `messages` /
// `toolBlocks`).

import { useMemo } from "react";
import { useAppStore, type TaskRailEntry } from "../../store/appStore";
import { t } from "../../utils/i18n";

interface FileChange {
  path: string;
  /// Most recent kind of edit. We keep only one entry per path so
  /// the list stays compact even when the model edits the same file
  /// repeatedly during a turn (the "ok" status of the latest tool
  /// run is what the user cares about).
  kind: "edit" | "write" | "patch";
  status: TaskRailEntry["status"];
}

interface CheckRun {
  id: string;
  command: string;
  kind: "test" | "lint" | "build" | "check" | "shell";
  status: TaskRailEntry["status"];
}

interface ApprovalCounts {
  allowed: number;
  denied: number;
  pending: number;
}

interface ChangeReport {
  files: FileChange[];
  checks: CheckRun[];
  approvals: ApprovalCounts;
}

/// Map a shell command line to a coarse "kind" so the UI can group
/// `cargo test` / `npm test` / `pytest` together as "test", etc.
/// Anything we don't recognise is just `shell` — still useful as a
/// "checks run" item, but doesn't get a special label.
function classifyCommand(cmd: string): CheckRun["kind"] {
  const lower = cmd.toLowerCase().trim();
  if (/\b(cargo\s+test|npm(\s+run)?\s+test|pytest|go\s+test|jest|vitest)\b/.test(lower)) {
    return "test";
  }
  if (/\b(clippy|eslint|ruff|pylint|tslint|cargo\s+clippy|npm(\s+run)?\s+lint)\b/.test(lower)) {
    return "lint";
  }
  if (/\b(cargo\s+build|npm(\s+run)?\s+build|make|tsc|vite\s+build|webpack)\b/.test(lower)) {
    return "build";
  }
  if (/\b(cargo\s+check|tsc\s+--noEmit|mypy|cargo\s+fmt\s+--check)\b/.test(lower)) {
    return "check";
  }
  return "shell";
}

function buildReport(tasks: TaskRailEntry[]): ChangeReport {
  // Files: dedupe by path, keep latest entry. Order by `updatedAt`
  // ascending so the report reads as "what was modified, in order".
  const byPath = new Map<string, FileChange>();
  let allowed = 0;
  let denied = 0;
  let pending = 0;
  const checks: CheckRun[] = [];

  for (const task of tasks) {
    if (task.name === "fs.edit" || task.name === "fs.write" || task.name === "fs.patch") {
      const path = extractFilePath(task);
      if (path) {
        const kind: FileChange["kind"] =
          task.name === "fs.edit" ? "edit" : task.name === "fs.write" ? "write" : "patch";
        byPath.set(path, { path, kind, status: task.status });
        if (task.status === "ok") allowed += 1;
        else if (task.status === "denied") denied += 1;
        else if (task.status === "running") pending += 1;
      }
    } else if (task.name === "shell.exec") {
      const command = typeof task.args?.command === "string" ? task.args.command : "";
      checks.push({
        id: task.id,
        command,
        kind: classifyCommand(command),
        status: task.status,
      });
      if (task.status === "ok") allowed += 1;
      else if (task.status === "denied") denied += 1;
      else if (task.status === "running") pending += 1;
    }
  }

  return {
    files: [...byPath.values()],
    checks,
    approvals: { allowed, denied, pending },
  };
}

/// Pull the file path out of a tool's args. fs.{edit,write,patch}
/// all use slightly different shapes — patch carries a unified diff
/// in `diff` and fs.{edit,write} carry `path`. For multi-file
/// patches we surface only the first; the full picture is in the
/// individual ToolBlock cards.
function extractFilePath(task: TaskRailEntry): string | null {
  const args = task.args ?? {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.diff === "string") {
    // Look for `+++ b/<path>` or `--- a/<path>` headers.
    const m = args.diff.match(/(?:\+\+\+|---)\s+[ab]\/([^\s]+)/);
    if (m) return m[1];
  }
  return null;
}

export function ChangeReport() {
  const tasks = useAppStore((s) => s.tasks);
  const report = useMemo(() => buildReport(tasks), [tasks]);

  if (report.files.length === 0 && report.checks.length === 0) {
    // Nothing yet. Render the heading + an empty hint so the user
    // knows what this rail card *will* show, rather than hiding it
    // entirely (less surprising when content suddenly appears).
    return (
      <div className="change-report-empty">{t("changeReportEmpty")}</div>
    );
  }

  return (
    <div className="change-report">
      {report.files.length > 0 ? (
        <div className="change-report-section">
          <div className="change-report-section-title">
            {t("changeReportFiles")}
            <span className="change-report-count">{report.files.length}</span>
          </div>
          <ul className="change-report-list">
            {report.files.map((f) => (
              <li
                key={f.path}
                className="change-report-file"
                data-status={f.status}
                title={`${f.kind}: ${f.path}`}
              >
                <span className={`change-report-kind kind-${f.kind}`}>
                  {f.kind === "edit" ? "M" : f.kind === "write" ? "A" : "P"}
                </span>
                <span className="change-report-path">{f.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.checks.length > 0 ? (
        <div className="change-report-section">
          <div className="change-report-section-title">
            {t("changeReportChecks")}
            <span className="change-report-count">{report.checks.length}</span>
          </div>
          <ul className="change-report-list">
            {report.checks.map((c) => (
              <li
                key={c.id}
                className="change-report-check"
                data-status={c.status}
                data-kind={c.kind}
                title={c.command}
              >
                <span className={`change-report-kind kind-${c.kind}`}>{c.kind}</span>
                <code className="change-report-cmd">{c.command || "(empty)"}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="change-report-summary">
        {t("changeReportSummary", report.approvals.allowed, report.approvals.denied)}
        {report.approvals.pending > 0
          ? ` · ${t("changeReportPending", report.approvals.pending)}`
          : ""}
      </div>
    </div>
  );
}

export function ChangeReportCount() {
  const tasks = useAppStore((s) => s.tasks);
  const report = useMemo(() => buildReport(tasks), [tasks]);
  return <span>{report.files.length + report.checks.length}</span>;
}
