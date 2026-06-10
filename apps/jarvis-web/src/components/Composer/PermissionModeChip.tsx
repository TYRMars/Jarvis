// Color-coded permission-mode chip for the composer toolbar.
//
// Mirrors `appStore.permissionMode` as a colored dot + label pill.
// Clicking it advances to the next mode in `PERMISSION_MODE_CYCLE`
// (same order as the textarea Tab-cycle in Composer.tsx) and ships
// the change to the server via `setSocketMode` (per-socket frame);
// the server echoes a `permission_mode` frame which keeps the store
// in sync. The dot colour is driven by the `data-mode` attribute so
// styling lives entirely in CSS.
//
// Bypass requires an explicit `confirm()` before flipping — once on,
// every gated tool runs unprompted — matching `ModeBadge`'s guard.
// The chip is non-interactive when no socket is open.

import { useAppStore } from "../../store/appStore";
import {
  nextPermissionMode,
  setSocketMode,
  type PermissionMode,
} from "../../services/permissions";
import { isOpen } from "../../services/socket";
import { t } from "../../utils/i18n";

const LABEL_KEYS: Record<PermissionMode, string> = {
  ask: "permModeAsk",
  "accept-edits": "permModeAcceptEdits",
  plan: "permModePlan",
  auto: "permModeAuto",
  bypass: "permModeBypass",
};

export function PermissionModeChip() {
  const mode = useAppStore((s) => s.permissionMode);
  const socketReady = isOpen();

  const cycle = () => {
    if (!socketReady) return;
    const next = nextPermissionMode(mode);
    if (next === "bypass") {
      const ok = window.confirm(t("permModeBypassConfirm"));
      if (!ok) return;
    }
    setSocketMode(next);
  };

  return (
    <button
      type="button"
      className="permission-mode-chip"
      data-mode={mode}
      disabled={!socketReady}
      onClick={cycle}
      title={t("composerPermissionModeChipTitle", t(LABEL_KEYS[mode]))}
      aria-label={t("composerPermissionModeChipTitle", t(LABEL_KEYS[mode]))}
    >
      <span className="permission-mode-chip-dot" aria-hidden="true" />
      <span className="permission-mode-chip-label">{t(LABEL_KEYS[mode])}</span>
    </button>
  );
}
