// Read-only side drawer for the in-session execution context.
//
// Mirrors the right-side panel pattern from `RequirementDetail.tsx`
// — same `.requirement-detail-panel` / `.requirement-detail-backdrop`
// CSS so styling stays consistent — but does not carry the action
// chrome (start run, mark done, edit assignee, …). Action buttons
// live behind the spec's Phase 4 follow-up; the placeholder div
// below reserves the slot.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ActivityList } from "../Projects/activityRow";
import { MarkdownLite } from "../Projects/MarkdownLite";
import type { ConversationWorkContext } from "./sessionExecutionDisplay";
import { t } from "../../utils/i18n";

const VERIFY_OUTPUT_CAP = 4096;

export function SessionExecutionDrawer({
  ctx,
  onClose,
}: {
  ctx: ConversationWorkContext;
  onClose: () => void;
}) {
  // Close on Escape, mirroring `RequirementDetail`. Portal mount means
  // the listener has to live on `window`, not the parent tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const req = ctx.requirement;
  if (!req) return null;
  const run = ctx.latestRun;
  const verification = run?.verification ?? null;

  const node = (
    <>
      <div
        className="requirement-detail-backdrop"
        role="presentation"
        onClick={onClose}
      />
      <aside
        className="requirement-detail-panel session-exec-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
      >
        <header className="requirement-detail-head">
          <div className="requirement-detail-head-text">
            <span className="requirement-detail-head-id">
              REQ-{req.id.slice(0, 6)}
            </span>
            <h2 className="requirement-detail-head-title">{req.title}</h2>
            <span
              className={"requirement-status-pill status-" + req.status}
            >
              {req.status}
            </span>
          </div>
          <button
            type="button"
            className="requirement-detail-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {req.description && (
          <section className="requirement-detail-description">
            <MarkdownLite text={req.description} />
          </section>
        )}

        {req.verification_plan?.commands &&
          req.verification_plan.commands.length > 0 && (
            <section className="requirement-detail-verify-plan">
              <h3 className="requirement-detail-runs-heading">
                {t("verifyRunLabel")}
              </h3>
              <ul className="requirement-detail-run-cmds">
                {req.verification_plan.commands.map((c, i) => (
                  <li key={i} className="requirement-detail-run-cmd">
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}

        <section className="requirement-detail-runs">
          <h3 className="requirement-detail-runs-heading">
            {t("runsHeading")}
          </h3>
          {!run ? (
            <p className="requirement-detail-empty">{t("runsEmpty")}</p>
          ) : (
            <div className="requirement-detail-run-body">
              <p className="requirement-detail-run-text">
                <span className={"requirement-run-pill run-status-" + run.status}>
                  {run.status}
                </span>
                {"  "}
                <span title={run.started_at}>
                  {formatRange(run.started_at, run.finished_at)}
                </span>
              </p>
              {run.summary && (
                <p className="requirement-detail-run-text">{run.summary}</p>
              )}
              {run.error && (
                <p className="requirement-detail-run-text run-error">
                  {run.error}
                </p>
              )}
              {run.worktree_path && (
                <p
                  className="requirement-detail-run-worktree"
                  title={run.worktree_path}
                >
                  📁 worktree: <code>{run.worktree_path}</code>
                </p>
              )}
            </div>
          )}
        </section>

        {verification && (
          <section className="requirement-detail-verify">
            <h3 className="requirement-detail-runs-heading">Verification</h3>
            <p className="requirement-detail-run-text">
              <span
                className={
                  "requirement-run-verify verify-" + verification.status
                }
              >
                {verification.status}
              </span>
            </p>
            {verification.command_results &&
              verification.command_results.length > 0 && (
                <ul className="requirement-detail-run-cmds">
                  {verification.command_results.map((cmd, i) => (
                    <li key={i} className="requirement-detail-run-cmd">
                      <code>{cmd.command}</code>
                      <span className="requirement-detail-run-cmd-exit">
                        {cmd.exit_code === 0
                          ? "exit 0"
                          : "exit " + (cmd.exit_code ?? "?")}
                        {" · "}
                        {cmd.duration_ms}ms
                      </span>
                      {cmd.stdout && cmd.stdout.length > 0 && (
                        <pre className="session-exec-drawer-stream">
                          {truncate(cmd.stdout, VERIFY_OUTPUT_CAP)}
                        </pre>
                      )}
                      {cmd.stderr && cmd.stderr.length > 0 && (
                        <pre className="session-exec-drawer-stream stream-err">
                          {truncate(cmd.stderr, VERIFY_OUTPUT_CAP)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            {verification.diff_summary && (
              <p className="requirement-detail-run-text">
                {verification.diff_summary}
              </p>
            )}
          </section>
        )}

        <section className="requirement-detail-activities">
          <h3 className="requirement-detail-runs-heading">
            {t("activityHeading")}
          </h3>
          <ActivityList activities={ctx.recentActivities} />
        </section>

        <div data-testid="session-exec-drawer-actions" />
      </aside>
    </>
  );

  return createPortal(node, document.body);
}

function formatRange(startedAt: string, finishedAt: string | null | undefined): string {
  const start = safeTime(startedAt);
  const end = finishedAt ? safeTime(finishedAt) : null;
  return end ? `${start} → ${end}` : start;
}

function safeTime(iso: string): string {
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated to ${max} bytes)`;
}
