import { useEffect, useState } from "react";
import { t } from "../../utils/i18n";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "offline" }
  | { kind: "error"; message: string };

interface SaveStatePillProps {
  state: SaveState;
  /** Click handler — only fires when state is `error`. */
  onRetry?: () => void;
}

export function SaveStatePill({ state, onRetry }: SaveStatePillProps) {
  // Re-render every 30s so the relative time stays fresh without a global timer.
  const [, force] = useState(0);
  useEffect(() => {
    if (state.kind !== "saved") return;
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [state.kind]);

  switch (state.kind) {
    case "idle":
      return (
        <span className="docs-save-pill is-idle" aria-live="polite">
          {t("docsSaveUnsaved")}
        </span>
      );
    case "saving":
      return (
        <span className="docs-save-pill is-saving" aria-live="polite">
          <Spinner />
          {t("docsSaveSaving")}
        </span>
      );
    case "saved":
      return (
        <span
          className="docs-save-pill is-saved"
          aria-live="polite"
          title={new Date(state.at).toLocaleString()}
        >
          <span className="docs-save-pill-tick" aria-hidden>
            ✓
          </span>
          {t("docsSaveSaved", timeAgo(state.at))}
        </span>
      );
    case "offline":
      return (
        <span className="docs-save-pill is-offline" aria-live="polite">
          {t("docsSaveOffline")}
        </span>
      );
    case "error":
      return (
        <button
          type="button"
          className="docs-save-pill is-error"
          aria-label={t("docsSaveError", state.message)}
          title={state.message}
          onClick={onRetry}
        >
          {t("docsSaveRetry")}
        </button>
      );
  }
}

function timeAgo(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  const sec = Math.round(diff / 1000);
  if (sec < 5) return t("docsSaveTimeJustNow");
  if (sec < 60) return t("docsSaveTimeS", sec);
  const min = Math.round(sec / 60);
  if (min < 60) return t("docsSaveTimeM", min);
  const hr = Math.round(min / 60);
  if (hr < 24) return t("docsSaveTimeH", hr);
  return new Date(at).toLocaleDateString();
}

function Spinner() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
      style={{ animation: "docs-spin 0.9s linear infinite" }}
    >
      <path d="M12 3a9 9 0 1 1-6.36 2.64" />
    </svg>
  );
}
