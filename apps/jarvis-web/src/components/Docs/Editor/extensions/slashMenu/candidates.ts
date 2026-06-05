// Slash-menu candidate registry.
//
// Each candidate is a flat data record so adding new entries (or
// reordering them) is just a config change. Custom blocks
// (Callout / Toggle) export their own helpers that the editor
// concatenates on top of `STANDARD_CANDIDATES`.

import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { t } from "../../../../../utils/i18n";

export interface SlashCandidate {
  /** Stable identifier — used for `key=` and tests. */
  id: string;
  /** Bold first-line label shown in the popover. */
  title: string;
  /** Greyer second line. Optional. */
  description?: string;
  /** Substrings the fuzzy filter checks alongside the title. */
  keywords: readonly string[];
  /** Optional left icon (any React node — emoji, svg, lucide…). */
  icon?: ReactNode;
  /** Imperative action when the candidate is picked. The plugin
   *  passes a `range` covering the trigger char + filter text so
   *  callers can `chain().deleteRange(range)` first. */
  command(args: { editor: Editor; range: { from: number; to: number } }): void;
}

/** Fuzzy match by simple substring on title + keywords. Empty
 *  query matches everything (the popover stays open right after
 *  `/` is typed). */
export function filterCandidates(
  candidates: readonly SlashCandidate[],
  query: string,
): SlashCandidate[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...candidates];
  return candidates.filter((c) => {
    if (c.title.toLowerCase().includes(q)) return true;
    if (c.description && c.description.toLowerCase().includes(q)) return true;
    return c.keywords.some((k) => k.toLowerCase().includes(q));
  });
}

/** Standard block candidates available in every editor instance. */
export const STANDARD_CANDIDATES: readonly SlashCandidate[] = [
  {
    id: "h1",
    title: t("docsEdSlashH1"),
    description: t("docsEdSlashH1Desc"),
    keywords: ["h1", "heading", "title", "大标题"],
    icon: "H1",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
    },
  },
  {
    id: "h2",
    title: t("docsEdSlashH2"),
    description: t("docsEdSlashH2Desc"),
    keywords: ["h2", "heading", "subtitle"],
    icon: "H2",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
    },
  },
  {
    id: "h3",
    title: t("docsEdSlashH3"),
    description: t("docsEdSlashH3Desc"),
    keywords: ["h3", "heading"],
    icon: "H3",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
    },
  },
  {
    id: "bullet",
    title: t("docsEdSlashBullet"),
    description: t("docsEdSlashBulletDesc"),
    keywords: ["ul", "list", "bullet", "无序"],
    icon: "•",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: "ordered",
    title: t("docsEdSlashOrdered"),
    description: t("docsEdSlashOrderedDesc"),
    keywords: ["ol", "ordered", "list", "number", "有序"],
    icon: "1.",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: "task",
    title: t("docsEdSlashTask"),
    description: t("docsEdSlashTaskDesc"),
    keywords: ["todo", "task", "checkbox", "checklist", "任务"],
    icon: "☐",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: "quote",
    title: t("docsEdSlashQuote"),
    description: t("docsEdSlashQuoteDesc"),
    keywords: ["quote", "blockquote", "引用"],
    icon: "❞",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: "code",
    title: t("docsEdSlashCode"),
    description: t("docsEdSlashCodeDesc"),
    keywords: ["code", "pre", "代码"],
    icon: "</>",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    id: "divider",
    title: t("docsEdSlashDivider"),
    description: t("docsEdSlashDividerDesc"),
    keywords: ["hr", "divider", "rule", "分隔"],
    icon: "—",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    id: "image",
    title: t("docsEdSlashImage"),
    description: t("docsEdSlashImageDesc"),
    keywords: ["image", "img", "photo", "picture", "图片"],
    icon: "🖼",
    command: ({ editor, range }) => {
      // Defer to the Image NodeView's drag-drop / paste flow; the
      // slash-menu insert just creates an empty image placeholder
      // pointing at no source so the user can drop a file on it.
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setImage({ src: "" })
        .run();
    },
  },
  {
    id: "table",
    title: t("docsEdSlashTable"),
    description: t("docsEdSlashTableDesc"),
    keywords: ["table", "grid", "表格"],
    icon: "▦",
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
];
