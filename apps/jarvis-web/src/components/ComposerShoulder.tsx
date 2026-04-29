// "Shoulder" row above the composer — Claude Code style.
//
// Layout:
//   [⎇ main ← feat/jarvis_sidbar]      [+32092 −2710]  [Create draft PR ▼]
//
// Left:   branch crumb showing PR semantics (`<base> ← <branch>`).
//         Same data the WorkspaceDiff rail card reads, just
//         re-rendered as a single-line affordance.
//
// Center: aggregate diff stat (`+added −removed`). Clicking opens
//         (or focuses) the WorkspaceDiff panel in the right rail
//         so the user can drill into per-file diffs.
//
// Right:  Create draft PR button. Wires to the existing
//         `<CreatePrDialog>` flow we already built — same modal
//         the rail card uses; one entry point per dialog.
//
// Data source: `appStore.workspaceDiff`, populated by
// `refreshWorkspaceDiff()`. We auto-fetch once on mount so the
// shoulder is alive even when the user has the WorkspaceDiff
// rail panel hidden (defaults are now all-off).
//
// Falls back to a minimal WorkspaceBadge-style "path · branch"
// label when:
//   • data is still loading (`workspaceDiff == null`)
//   • the server has no workspace pinned (`"unavailable"`)
//   • the workspace isn't a git repo (no `branch`)
//
// In those cases the left crumb degrades to "no git" / loading
// and the right cluster (diff stat, PR button) is hidden.

import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { refreshWorkspaceDiff } from "../services/workspaceDiff";
import { CreatePrDialog } from "./Workspace/CreatePrDialog";
import { t } from "../utils/i18n";

export function ComposerShoulder() {
  const diff = useAppStore((s) => s.workspaceDiff);
  const setVisible = useAppStore((s) => s.setWorkspacePanelVisible);
  const [prOpen, setPrOpen] = useState(false);

  // Auto-fetch once on mount. The diff endpoint is ~50ms on a
  // typical repo and gives us branch + ahead/behind + per-file
  // numstat — everything the shoulder needs in one round-trip.
  // Subsequent updates flow through the WorkspaceDiff rail card's
  // refresh button or after a commit/PR action.
  useEffect(() => {
    if (diff == null) void refreshWorkspaceDiff();
    // We deliberately don't re-fetch on every diff change — that
    // would loop. The card / dialogs trigger refreshes when the
    // working tree actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Server doesn't have a workspace pinned at all → hide the row
  // entirely. The composer just renders flush against the message
  // list, like before any workspace work landed.
  if (diff === "unavailable") return null;

  // Loading or no git → minimal left crumb only, right cluster hidden.
  // Same affordance as WorkspaceBadge had: a path + spinner that
  // doesn't promise PR-creation features the server can't deliver.
  // The "unavailable" sentinel is already handled by the early
  // return above; here `diff` is `WorkspaceDiff | null`.
  const hasGit = diff != null && diff.branch != null;
  if (!hasGit) {
    return (
      <div className="composer-shoulder">
        <button
          type="button"
          className="shoulder-crumb shoulder-crumb-loading"
          onClick={() => void refreshWorkspaceDiff()}
          title={t("wsDiffRefresh") || "Refresh"}
        >
          <BranchIcon />
          <span className="shoulder-crumb-label">
            {diff == null ? "…" : t("wsContextNoVcs")}
          </span>
        </button>
      </div>
    );
  }

  // After the two narrowings above (`!== "unavailable"` and
  // `hasGit` checks), `diff` is necessarily a populated WorkspaceDiff
  // object. Pull what the shoulder actually renders.
  const data = diff;
  const { base, branch, stat, ahead } = data;
  const totalChanges = stat.added + stat.removed;
  const canOpenPr = data.base_exists && ahead > 0;

  return (
    <div className="composer-shoulder">
      <button
        type="button"
        className="shoulder-crumb"
        onClick={() => void refreshWorkspaceDiff(base)}
        title={`${branch} → ${base}\nclick to refresh`}
      >
        <BranchIcon />
        <span className="shoulder-crumb-base">{base}</span>
        <span className="shoulder-crumb-arrow" aria-hidden="true">
          ←
        </span>
        <span className="shoulder-crumb-branch">{branch}</span>
      </button>

      <div className="shoulder-actions">
        {totalChanges > 0 ? (
          <button
            type="button"
            className="shoulder-stat"
            onClick={() => {
              // Open the rail panel so the user can drill into
              // per-file diffs. Idempotent — if it's already open
              // the user just sees the highlight via natural focus.
              setVisible("diff", true);
            }}
            title={t("wsDiffCountLabel") || "files changed"}
          >
            <span className="shoulder-stat-add">+{stat.added}</span>
            <span className="shoulder-stat-del">−{stat.removed}</span>
          </button>
        ) : null}

        <button
          type="button"
          className={`shoulder-pr${canOpenPr ? "" : " is-disabled"}`}
          disabled={!canOpenPr}
          onClick={() => setPrOpen(true)}
          title={
            canOpenPr
              ? t("wsDiffCreatePrHint") || "Create draft PR"
              : t("wsDiffCreatePrDisabledHint") || "No commits ahead of base"
          }
        >
          <span>{t("shoulderCreatePr") || "Create draft PR"}</span>
          <ChevronDownIcon />
        </button>
      </div>

      <CreatePrDialog open={prOpen} onClose={() => setPrOpen(false)} base={base} />
    </div>
  );
}

function BranchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
