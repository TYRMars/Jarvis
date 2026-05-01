import type { CSSProperties } from "react";
import type { DocKind } from "../../types/frames";
import { t } from "../../utils/i18n";

const KIND_PALETTE: Record<DocKind, string> = {
  note: "#6b7280",
  research: "#0ea5e9",
  report: "#22c55e",
  design: "#a855f7",
  guide: "#f59e0b",
};

export const KIND_ORDER: DocKind[] = [
  "note",
  "research",
  "report",
  "design",
  "guide",
];

const KIND_LABEL_KEYS: Record<DocKind, string> = {
  note: "docsKindNote",
  research: "docsKindResearch",
  report: "docsKindReport",
  design: "docsKindDesign",
  guide: "docsKindGuide",
};

/// Localized display label for a DocKind. Re-evaluates on every call
/// so a language switch (which bumps `appStore.lang`) is reflected as
/// soon as React re-renders the consumer.
export function kindLabel(kind: DocKind): string {
  return t(KIND_LABEL_KEYS[kind]);
}

/// Convenience map matching the eager `KIND_LABELS` shape some
/// consumers want. Built fresh on each call so it tracks the active
/// language. Prefer `kindLabel(kind)` for one-off lookups.
export function kindLabels(): Record<DocKind, string> {
  return {
    note: kindLabel("note"),
    research: kindLabel("research"),
    report: kindLabel("report"),
    design: kindLabel("design"),
    guide: kindLabel("guide"),
  };
}

export function kindColor(kind: DocKind): string {
  return KIND_PALETTE[kind];
}

export function kindChipStyle(kind: DocKind): CSSProperties {
  const c = KIND_PALETTE[kind];
  return {
    background: c + "1a",
    color: c,
    border: `1px solid ${c}33`,
    borderRadius: "9999px",
    padding: "1px 8px",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    whiteSpace: "nowrap",
  };
}

interface KindIconProps {
  kind: DocKind;
  size?: number;
}

/// Single-colour SVG icon per DocKind, sized for inline-with-chip use.
/// Heroicons-outline shapes; never emoji (per design system guidance).
export function KindIcon({ kind, size = 12 }: KindIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "note":
      // pencil-square
      return (
        <svg {...common}>
          <path d="M16.862 4.487a2.06 2.06 0 1 1 2.916 2.916L7.5 19.682l-4 1 1-4 12.362-12.195z" />
        </svg>
      );
    case "research":
      // magnifying-glass
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20.5 20.5-3.7-3.7" />
        </svg>
      );
    case "report":
      // document-chart-bar
      return (
        <svg {...common}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
          <path d="M9 17v-3M12 17v-5M15 17v-2" />
        </svg>
      );
    case "design":
      // paint-brush
      return (
        <svg {...common}>
          <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128M14.25 5.5l4.25 4.25" />
          <path d="m13.06 6.69 4.25 4.25-7.06 7.06-4.25-4.25 7.06-7.06z" />
        </svg>
      );
    case "guide":
      // book-open
      return (
        <svg {...common}>
          <path d="M12 6.5C10.5 5 8 4 4.5 4v13c3.5 0 6 1 7.5 2.5C13.5 18 16 17 19.5 17V4c-3.5 0-6 1-7.5 2.5z" />
          <path d="M12 6.5V19.5" />
        </svg>
      );
  }
}
