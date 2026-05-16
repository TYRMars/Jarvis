// Header trigger for `<BackgroundTasksPanel>`. Lives next to
// `<WorkspacePanelMenu>` in `<AppChatPane>`'s header-actions slot.
// The panel itself is portal-free and renders right under the button
// — the visible chrome is just an icon + label; click toggles open.

import { useState } from "react";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel";

export function BackgroundTasksButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-tasks-trigger-wrap">
      <button
        type="button"
        className="bg-tasks-trigger"
        aria-expanded={open}
        aria-label="Background tasks"
        title="Background tasks"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15 14" />
        </svg>
      </button>
      <BackgroundTasksPanel open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
