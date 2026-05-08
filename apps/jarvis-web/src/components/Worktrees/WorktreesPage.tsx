// Worktree management — surfaces orphan git worktrees that the
// auto-mode loop's per-run isolation left behind. Backend already
// has `/v1/diagnostics/worktrees/orphans` (read) and
// `/v1/diagnostics/worktrees/orphans/cleanup` (POST). This page
// turns them into a usable surface: list with size + age, run
// cleanup (with confirmation), and clear feedback when the feature
// isn't enabled (503 → "JARVIS_WORKTREE_MODE not set").

import { useEffect, useState } from "react";

import {
  cleanupOrphanWorktrees,
  CleanupReport,
  listOrphanWorktrees,
  OrphanWorktree,
} from "../../services/diagnostics";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";

const POLL_INTERVAL_MS = 15_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }
  | { kind: "ready"; orphans: OrphanWorktree[] };

export function WorktreesPage() {
  // Subscribe to lang for re-render on toggle
  useAppStore((s) => s.lang);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [cleaning, setCleaning] = useState(false);
  const [lastReport, setLastReport] = useState<CleanupReport | null>(null);

  const refresh = async () => {
    try {
      const items = await listOrphanWorktrees();
      if (items === null) {
        setState({ kind: "disabled" });
        return;
      }
      setState({ kind: "ready", orphans: items });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCleanup = async () => {
    if (state.kind !== "ready" || state.orphans.length === 0) return;
    if (cleaning) return;
    if (!window.confirm(t("worktreesCleanupConfirm", state.orphans.length))) {
      return;
    }
    setCleaning(true);
    try {
      const report = await cleanupOrphanWorktrees();
      setLastReport(report);
      await refresh();
    } catch (e) {
      console.warn("worktree cleanup failed", e);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <main
      id="worktrees-page"
      className="worktrees-page"
      tabIndex={-1}
      style={pageStyle}
    >
      <header style={pageHeaderStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t("worktreesTitle")}</h1>
          <p style={{ margin: "6px 0 0", opacity: 0.7, fontSize: 13 }}>
            {t("worktreesSubtitle")}
          </p>
        </div>
        {state.kind === "ready" && state.orphans.length > 0 && (
          <button
            type="button"
            style={cleanupBtnStyle}
            onClick={() => void handleCleanup()}
            disabled={cleaning}
          >
            {cleaning
              ? t("worktreesCleaningBtn")
              : t("worktreesCleanupBtn", state.orphans.length)}
          </button>
        )}
      </header>

      <Body state={state} />

      {lastReport && <CleanupReportPanel report={lastReport} />}
    </main>
  );
}

function Body({ state }: { state: LoadState }) {
  if (state.kind === "loading") {
    return (
      <div style={panelStyle}>
        <p style={emptyStyle}>{t("worktreesLoading")}</p>
      </div>
    );
  }
  if (state.kind === "disabled") {
    return (
      <div style={panelStyle}>
        <p style={emptyStyle}>{t("worktreesFeatureDisabled")}</p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={panelStyle}>
        <p style={errorStyle}>
          {t("worktreesLoadError", state.message)}
        </p>
      </div>
    );
  }
  if (state.orphans.length === 0) {
    return (
      <div style={panelStyle}>
        <p style={emptyStyle}>{t("worktreesEmpty")}</p>
      </div>
    );
  }
  return (
    <section style={panelStyle}>
      <header style={panelHeaderStyle}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("worktreesOrphansTitle")}
        </h2>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          {t("worktreesOrphansCount", state.orphans.length)}
        </span>
      </header>
      <ul style={listStyle}>
        {state.orphans.map((o) => (
          <li key={o.path} style={rowStyle}>
            <div style={rowMainStyle}>
              <span style={rowTitleStyle}>{basename(o.path)}</span>
              <span style={rowSubStyle}>
                <code style={pathStyle} title={o.path}>
                  {o.path}
                </code>
              </span>
              <span style={rowMetaStyle}>
                {t("worktreesRunIdLabel")}: <code>{o.run_id}</code>
                {" · "}
                {formatBytes(o.size_bytes)}
                {o.modified_at && ` · ${relTime(o.modified_at)}`}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CleanupReportPanel({ report }: { report: CleanupReport }) {
  return (
    <section style={panelStyle}>
      <header style={panelHeaderStyle}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("worktreesCleanupReportTitle")}
        </h2>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          {t("worktreesCleanupReportCount", report.removed, report.attempted)}
        </span>
      </header>
      {report.errors.length === 0 ? (
        <p style={emptyStyle}>{t("worktreesCleanupReportNoErrors")}</p>
      ) : (
        <ul style={listStyle}>
          {report.errors.map((e, i) => (
            <li key={i} style={rowStyle}>
              <div style={rowMainStyle}>
                <span style={rowTitleStyle}>{basename(e.path)}</span>
                <span style={errorStyle}>{e.reason}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ============================================================
// Helpers
// ============================================================

function basename(p: string): string {
  const ix = p.lastIndexOf("/");
  return ix < 0 ? p : p.slice(ix + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ============================================================
// Inline styles
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

const rowMainStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
};

const rowTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const rowSubStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.65,
};

const rowMetaStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  marginTop: 2,
};

const pathStyle: React.CSSProperties = {
  fontSize: 11,
  background: "rgba(0,0,0,0.2)",
  padding: "1px 4px",
  borderRadius: 3,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "inline-block",
  maxWidth: 360,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "16px 4px",
  fontSize: 12,
  opacity: 0.6,
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  padding: "8px 4px",
  fontSize: 12,
  color: "#d33b3b",
};

const cleanupBtnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "6px 12px",
  border: "1px solid #d33b3b",
  borderRadius: 5,
  background: "transparent",
  color: "#d33b3b",
  cursor: "pointer",
};
