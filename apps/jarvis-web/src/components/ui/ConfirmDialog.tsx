// Promise-based confirmation dialog — drop-in replacement for the
// browser's `window.confirm()`.
//
//   const ok = await confirm({ title: "Delete?", danger: true });
//   if (!ok) return;
//
// Architecture:
//
//   - A single module-level subscriber list ("the host store") tracks
//     the current confirm request. Calling `confirm({...})` pushes the
//     request and returns a Promise whose `resolve` is invoked when
//     the user picks confirm / cancel / dismiss.
//   - `<ConfirmDialogHost />` is mounted ONCE near the app root
//     (`App.tsx`) and subscribes to the store. It renders the
//     `<Modal>` with the current request's options. There can only
//     ever be one confirm at a time — a second `confirm()` while one
//     is open will queue (FIFO) so neither prompt is dropped.
//
// Why this shape (not React Context):
//
//   - Lots of `confirm()` callers live in services / event handlers /
//     non-React code paths (services/conversations.ts, store actions,
//     etc). A module-level imperative API works from anywhere; React
//     Context would force every caller to be inside a hook scope.
//   - Promise semantics map exactly to the existing `if
//     (!confirm(...)) return;` pattern, so callsite migration is a
//     `confirm` → `await confirm` mechanical edit.

import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { t } from "../../utils/i18n";

export interface ConfirmOptions {
  /// Headline. Free-form ReactNode so callers can include `<b>` / `<code>` etc.
  title: ReactNode;
  /// Optional body text below the title.
  detail?: ReactNode;
  /// Confirm button label. Defaults to a localised "Confirm".
  confirmLabel?: string;
  /// Cancel button label. Defaults to a localised "Cancel".
  cancelLabel?: string;
  /// When true, the confirm button uses the danger styling (red). Use
  /// for destructive actions (delete, archive, irreversible moves).
  danger?: boolean;
}

interface PendingRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

// Module-level state. One queue, FIFO. `current` is the head being
// shown right now; `queue` holds anything that arrived while busy.
const queue: PendingRequest[] = [];
let current: PendingRequest | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function pump() {
  if (current) return;
  current = queue.shift() ?? null;
  notify();
}

/// Show a confirmation dialog. Returns a promise that resolves to
/// `true` on confirm and `false` on cancel / ESC / backdrop click.
///
/// **Async** — callers must `await` the result. The legacy
/// `if (!confirm(...))` pattern becomes:
///
///     if (!await confirm({ title: "Delete this row?" })) return;
///
/// Multiple calls queue FIFO; there's no way to show two confirms
/// stacked because the host is a single Modal mount.
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ ...options, resolve });
    if (!current) pump();
  });
}

/// Resolve the active confirm and advance the queue. Exported so the
/// `<ConfirmDialogHost />` can call it; not part of the public API.
function settle(answer: boolean) {
  const req = current;
  current = null;
  notify();
  // Resolve AFTER notifying so the host re-renders with the next
  // queued request immediately (no flash of empty modal).
  req?.resolve(answer);
  pump();
}

/// React subscription hook. Only used by `<ConfirmDialogHost />`.
function useCurrentRequest(): PendingRequest | null {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return current;
}

/// Mount once near the app root (App.tsx). Subscribes to the
/// module-level queue and renders the active confirm (if any) inside
/// a `<Modal>`. Renders nothing when the queue is empty so there's
/// zero overhead at idle.
export function ConfirmDialogHost() {
  const req = useCurrentRequest();
  return (
    <Modal
      open={!!req}
      onClose={() => settle(false)}
      role="alertdialog"
      title={req?.title}
    >
      {req?.detail ? <p className="ui-confirm-detail">{req.detail}</p> : null}
      <footer className="ui-modal-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={() => settle(false)}
        >
          {req?.cancelLabel ?? t("docsCreateCancel")}
        </button>
        <button
          type="button"
          className={
            "settings-btn " +
            (req?.danger ? "settings-btn-danger" : "settings-btn-primary")
          }
          onClick={() => settle(true)}
          autoFocus
        >
          {req?.confirmLabel ?? t("uiConfirmOk")}
        </button>
      </footer>
    </Modal>
  );
}
