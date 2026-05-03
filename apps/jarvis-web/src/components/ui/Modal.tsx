// Reusable modal shell.
//
// Replaces the bespoke `<div className="docs-modal-overlay">` /
// `<div className="docs-modal-dialog">` pattern that was copy-pasted
// into ColumnEditor, ConfirmDeleteDialog, RequirementDetail,
// CreatePrDialog, CommitDialog, and a few smaller spots. The shell
// owns:
//
//  - Portal mount under `<body>` (escapes any `overflow: auto` /
//    transformed ancestor that would otherwise reposition the
//    dialog — see kanban scroll container for why this matters).
//  - Scrim (`.docs-modal-overlay` reused so visuals stay identical).
//  - ESC-to-close via a single window listener.
//  - Initial focus moves to the dialog so screen readers + keyboard
//    users land inside the modal. (Full focus-trap is a future bump
//    — modern browsers' built-in tab cycling is good enough for the
//    current scope; we'll add a trap when we hit a real issue.)
//  - Backdrop click closes; clicks inside the dialog don't bubble.
//
// Visuals reuse the docs-* CSS tokens so existing screenshots and
// dark-mode rules continue to apply with zero CSS churn. New
// callers should prefer this shell over hand-rolling another
// overlay+dialog div pair.

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  /// Whether the modal is currently shown. Renders nothing when false
  /// so consumers can keep the JSX inline at the call site without
  /// gating it behind their own conditional.
  open: boolean;
  /// Fires on backdrop click and on ESC. Consumers should swap
  /// internal state to `open=false` here. Optional only because
  /// some modals are non-dismissable (rare); pass `undefined` to
  /// disable both gestures.
  onClose?: () => void;
  /// Optional label that becomes the dialog's `aria-labelledby`
  /// target. When provided, the title also renders as the
  /// `<header>`'s `<h2>`.
  title?: ReactNode;
  /// Modal contents — usually form fields + a `<footer>` with action
  /// buttons. Layout is the caller's responsibility; we just give you
  /// a container with consistent chrome.
  children: ReactNode;
  /// Extra class on the dialog box itself. Use for sizing overrides
  /// (e.g. `column-editor-dialog` already declares `width: min(720px, ...)`).
  dialogClassName?: string;
  /// `"alertdialog"` for confirm-style modals (one decision; user can't
  /// dismiss without making a choice in the strictest sense, though we
  /// still allow ESC). Default `"dialog"` for everything else.
  role?: "dialog" | "alertdialog";
  /// When true, suppresses ESC and backdrop dismissal. Useful while a
  /// save is in flight to prevent the user from accidentally bailing
  /// mid-request.
  busy?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  dialogClassName,
  role = "dialog",
  busy = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC + initial focus. Effect runs only while `open` so closed modals
  // don't steal Escape keys from sibling features (search, command-K).
  useEffect(() => {
    if (!open) return;
    // Capture current focus so we can restore it on close — keyboard
    // users land back where they came from instead of at the document
    // start.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, busy]);

  if (!open) return null;

  const titleId = title ? "ui-modal-title" : undefined;

  const node = (
    <div
      className="docs-modal-overlay"
      role="presentation"
      onClick={() => {
        if (!busy && onClose) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={"docs-modal-dialog" + (dialogClassName ? " " + dialogClassName : "")}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <header className="ui-modal-header">
            <h2 id={titleId} className="ui-modal-title">
              {title}
            </h2>
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );

  // Portal to `<body>` so the modal escapes scroll containers,
  // transformed ancestors, and any `overflow: hidden` parent.
  return createPortal(node, document.body);
}
