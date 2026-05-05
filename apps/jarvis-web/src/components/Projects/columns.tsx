// Shared kanban column definitions + their inline status glyphs.
//
// Per-project columns live on `Project.columns`. When the project
// hasn't customised its board (`columns` is null/absent), we fall back
// to the four built-in defaults below. The fallback labels go through
// i18n (`colBacklog` / …); custom columns render their saved `label`
// verbatim — by design, since they're already in the user's language
// at the moment of save.

import type { KanbanColumn, Project } from "../../types/frames";
import { t } from "../../utils/i18n";

/// Built-in kanban column kinds — the four glyphs the `StatusGlyph`
/// component knows how to draw. Custom columns can opt into one of
/// these by setting `kind`, or omit it for a neutral dot.
export type ColumnKind = "backlog" | "in_progress" | "review" | "done";

/// View-model the board / detail / chip components consume. Built from
/// `Project.columns` when present, otherwise from the four built-in
/// defaults. `label` is already localised at this point — consumers
/// should render it verbatim.
export interface BoardColumn {
  id: string;
  label: string;
  kind?: ColumnKind | null;
}

/// Materialise the columns to render for `project`. `project` may be
/// `null` (e.g. before the first load) — in that case we still return
/// the defaults so callers can render placeholder chrome.
export function columnsFor(project: Project | null | undefined): BoardColumn[] {
  const custom = project?.columns;
  if (custom && custom.length > 0) {
    return custom.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind ?? null,
    }));
  }
  return defaultBoardColumns();
}

/// The four built-in columns rendered with localised labels. Mirrors
/// `harness_core::default_kanban_columns()` field-for-field except the
/// labels are pulled from i18n at call time, so a language switch
/// re-renders the headers.
export function defaultBoardColumns(): BoardColumn[] {
  return [
    { id: "backlog", label: t("colBacklog"), kind: "backlog" },
    { id: "in_progress", label: t("colInProgress"), kind: "in_progress" },
    { id: "review", label: t("colReview"), kind: "review" },
    { id: "done", label: t("colDone"), kind: "done" },
  ];
}

/// Mirror of the server's default columns suitable for sending back in
/// a PATCH `/v1/projects/:id` body — labels are English (the canonical
/// form at rest), no i18n. The Web UI's column editor seeds new
/// projects from this when the user hits "Reset to default".
export function defaultColumnsForSave(): KanbanColumn[] {
  return [
    { id: "backlog", label: "Backlog", kind: "backlog" },
    { id: "in_progress", label: "In Progress", kind: "in_progress" },
    { id: "review", label: "Review", kind: "review" },
    { id: "done", label: "Done", kind: "done" },
  ];
}

// Small inline SVGs that ride alongside the column heading so users
// can scan column identity without parsing the label. The four kinds
// get specific glyphs; anything else (custom columns with no kind)
// renders a neutral filled dot.
export function StatusGlyph({ kind }: { kind?: ColumnKind | null }) {
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
  switch (kind) {
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
    default:
      // Neutral dot for custom columns with no kind hint.
      return (
        <svg
          {...common}
          className="status-glyph"
          fill="currentColor"
          stroke="none"
        >
          <circle cx="8" cy="8" r="3.5" />
        </svg>
      );
  }
}
