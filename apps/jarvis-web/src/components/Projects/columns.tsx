// Shared kanban column definitions + their inline status glyphs.
// Lives in its own module so any component (board, card, settings,
// future filters) can reference the same labels and icon set.

import type { RequirementStatus } from "../../types/frames";

// `labelKey` is the i18n message key — consumers call
// `t(col.labelKey)` at render time so column labels follow the
// active language. The constant stays a plain array (not a hook /
// store selector) so we don't pay a re-subscription cost per render
// and tests can assert on the static set directly.
export const COLUMNS: Array<{ status: RequirementStatus; labelKey: string }> = [
  { status: "backlog", labelKey: "colBacklog" },
  { status: "in_progress", labelKey: "colInProgress" },
  { status: "review", labelKey: "colReview" },
  { status: "done", labelKey: "colDone" },
];

// Small inline SVGs that ride alongside the column heading so users
// can scan column identity without parsing the label. Matches the
// Multica board's Backlog / In progress / Review / Done glyph set.
export function StatusGlyph({ status }: { status: RequirementStatus }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (status) {
    case "backlog":
      return (
        <svg {...common} className="status-glyph">
          <circle cx="8" cy="8" r="6" strokeDasharray="2 2.4" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common} className="status-glyph">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4v4l2.5 1.5" />
        </svg>
      );
    case "review":
      return (
        <svg {...common} className="status-glyph">
          <circle cx="8" cy="8" r="6" />
          <path d="M5.5 8.4l1.8 1.7L11 6.5" />
        </svg>
      );
    case "done":
      return (
        <svg
          {...common}
          className="status-glyph"
          fill="currentColor"
          stroke="none"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path
            d="M5.4 8.4l1.8 1.7L11 6.5"
            stroke="var(--panel)"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}
