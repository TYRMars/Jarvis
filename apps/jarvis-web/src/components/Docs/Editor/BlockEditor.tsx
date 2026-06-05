// BlockEditor — Tiptap-backed WYSIWYG block editor that round-trips
// to markdown so the existing Docs autosave / outline / search code
// keeps working unchanged.
//
// Wire format on the way in / out is markdown. Internally Tiptap
// holds ProseMirror JSON; `fromMarkdown` parses on mount, and every
// transaction serialises the current document back to markdown via
// `toMarkdown` and fires `onMarkdownChange`. The parent treats us
// as uncontrolled (`key={docId}` forces a fresh instance when the
// user switches documents).
//
// Custom blocks (Callout, Toggle), the slash menu and the image
// upload pipeline are baked in here so a single import gets the
// full feature set. Importing the Callout / Toggle modules as a
// side effect also registers their markdown handlers with the
// serializer.

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";

import { fromMarkdown, toMarkdown } from "./markdown";
import { Callout, calloutCandidates } from "./extensions/callout";
import {
  Toggle,
  ToggleSummary,
  ToggleContent,
  toggleCandidate,
} from "./extensions/toggle";
import {
  ImageUpload,
  type ImageUploadAdapter,
} from "./extensions/imageUpload";
import {
  SlashMenu,
  STANDARD_CANDIDATES,
  type SlashCandidate,
} from "./extensions/slashMenu";
import { t } from "../../../utils/i18n";

export interface BlockEditorProps {
  /** Initial markdown content. Read once on mount; subsequent prop
   *  changes are ignored. Switch the `key` to remount with new
   *  content. */
  initialMarkdown: string;
  /** Fired on every editor transaction with the current markdown. */
  onMarkdownChange?: (md: string) => void;
  /** Renders the editor read-only. */
  readOnly?: boolean;
  /** Aria label applied to the contenteditable host. */
  ariaLabel?: string;
  /** Placeholder shown in the first empty paragraph. Defaults to a
   *  zh-CN hint that points at the slash menu. */
  placeholder?: string;
  /** Image upload backend. Without one, drag-drop / paste fall
   *  through to the browser default and slash-menu image insert
   *  produces an empty placeholder. */
  uploadAdapter?: ImageUploadAdapter;
  /** Extra slash-menu candidates appended after the standard set
   *  + Callout/Toggle. */
  extraCandidates?: readonly SlashCandidate[];
  /** Called once with the live editor handle so callers can wire
   *  imperative actions (Cmd+S flush, scroll-to-heading). */
  onReady?: (editor: Editor) => void;
}

export function BlockEditor({
  initialMarkdown,
  onMarkdownChange,
  readOnly = false,
  ariaLabel,
  placeholder = t("docsEdPlaceholder"),
  uploadAdapter,
  extraCandidates,
  onReady,
}: BlockEditorProps) {
  // Mount-only — once Tiptap is up its internal state is the source
  // of truth, and the parent feeds new content via the `key` prop.
  const [initialJson] = useState(() => fromMarkdown(initialMarkdown));

  // Hold the latest onChange in a ref so we can emit without
  // recreating the editor whenever the parent re-renders.
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const candidates = useMemo<SlashCandidate[]>(
    () => [
      ...STANDARD_CANDIDATES,
      ...calloutCandidates(),
      toggleCandidate(),
      ...(extraCandidates ?? []),
    ],
    [extraCandidates],
  );

  const editor = useEditor({
    extensions: [
      // StarterKit ships paragraph / heading / list / blockquote /
      // code block / hr / hard break / history + the basic inline
      // marks. We trim heading levels to 1-3 (spec §2.1).
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      // The Placeholder extension adds `data-placeholder` on every
      // empty node; we only style the *first* empty paragraph
      // through CSS so the hint disappears as soon as the user
      // starts typing or adds blocks.
      Placeholder.configure({
        placeholder,
        showOnlyWhenEditable: true,
        showOnlyCurrent: false,
        includeChildren: false,
      }),
      ImageUpload.configure({
        ...(uploadAdapter ? { adapter: uploadAdapter } : {}),
        maxFileBytes: 10 * 1024 * 1024,
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Callout,
      Toggle,
      ToggleSummary,
      ToggleContent,
      SlashMenu.configure({ candidates }),
    ],
    content: initialJson,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: "block-editor-surface",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
      handleDOMEvents: {
        contextmenu(view, event) {
          if (readOnly) return false;
          event.preventDefault();
          view.focus();
          const e = event as MouseEvent;
          setContextMenu({ x: e.clientX, y: e.clientY });
          return true;
        },
      },
    },
    onUpdate({ editor }) {
      const fn = onChangeRef.current;
      if (!fn) return;
      try {
        const md = toMarkdown(editor.getJSON() as Parameters<typeof toMarkdown>[0]);
        fn(md);
      } catch (e) {
        // Surface but never crash the editor — round-trip failures
        // here would lose a keystroke at worst.
         
        console.error("BlockEditor: serialise failed", e);
      }
    },
  });

  useEffect(() => {
    if (!editor) return;
    onReady?.(editor);
  }, [editor, onReady]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".block-editor-context-menu")) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  return (
    <div className="block-editor-shell">
      <EditorContent editor={editor} className="block-editor-host" />
      {editor && contextMenu ? (
        <EditorContextMenu
          editor={editor}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

interface EditorContextMenuProps {
  editor: Editor;
  x: number;
  y: number;
  onClose: () => void;
}

function EditorContextMenu({ editor, x, y, onClose }: EditorContextMenuProps) {
  const run = (fn: (editor: Editor) => void) => {
    fn(editor);
    onClose();
  };
  const hasSelection =
    editor.state.selection.from !== editor.state.selection.to;
  const selectedText = () =>
    editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      "\n",
    );
  const setLink = () => {
    const current = editor.getAttributes("link").href as string | undefined;
    const next = window.prompt(
      t("docsContextLinkPrompt"),
      current ?? "https://",
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      run((ed) => ed.chain().focus().extendMarkRange("link").unsetLink().run());
      return;
    }
    run((ed) =>
      ed
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: trimmed })
        .run(),
    );
  };
  const copySelection = async () => {
    const text = selectedText();
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
    } finally {
      onClose();
    }
  };
  const viewportWidth =
    typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.max(8, Math.min(x, viewportWidth - 232));
  const top = Math.max(8, Math.min(y, viewportHeight - 352));

  return (
    <div
      className="block-editor-context-menu"
      role="menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuButton
        active={editor.isActive("bold")}
        label={t("docsContextBold")}
        shortcut="⌘B"
        onClick={() => run((ed) => ed.chain().focus().toggleBold().run())}
      />
      <ContextMenuButton
        active={editor.isActive("italic")}
        label={t("docsContextItalic")}
        shortcut="⌘I"
        onClick={() => run((ed) => ed.chain().focus().toggleItalic().run())}
      />
      <ContextMenuButton
        active={editor.isActive("code")}
        label={t("docsContextInlineCode")}
        onClick={() => run((ed) => ed.chain().focus().toggleCode().run())}
      />
      <div className="block-editor-context-menu-separator" role="separator" />
      <ContextMenuButton
        active={editor.isActive("heading", { level: 1 })}
        label={t("docsContextHeading1")}
        onClick={() =>
          run((ed) => ed.chain().focus().toggleHeading({ level: 1 }).run())
        }
      />
      <ContextMenuButton
        active={editor.isActive("heading", { level: 2 })}
        label={t("docsContextHeading2")}
        onClick={() =>
          run((ed) => ed.chain().focus().toggleHeading({ level: 2 }).run())
        }
      />
      <ContextMenuButton
        active={editor.isActive("bulletList")}
        label={t("docsContextBulletList")}
        onClick={() => run((ed) => ed.chain().focus().toggleBulletList().run())}
      />
      <ContextMenuButton
        active={editor.isActive("orderedList")}
        label={t("docsContextOrderedList")}
        onClick={() =>
          run((ed) => ed.chain().focus().toggleOrderedList().run())
        }
      />
      <ContextMenuButton
        active={editor.isActive("taskList")}
        label={t("docsContextTaskList")}
        onClick={() => run((ed) => ed.chain().focus().toggleTaskList().run())}
      />
      <ContextMenuButton
        active={editor.isActive("blockquote")}
        label={t("docsContextQuote")}
        onClick={() => run((ed) => ed.chain().focus().toggleBlockquote().run())}
      />
      <ContextMenuButton
        active={editor.isActive("codeBlock")}
        label={t("docsContextCodeBlock")}
        onClick={() => run((ed) => ed.chain().focus().toggleCodeBlock().run())}
      />
      <div className="block-editor-context-menu-separator" role="separator" />
      <ContextMenuButton
        active={editor.isActive("link")}
        label={t("docsContextLink")}
        onClick={setLink}
      />
      <ContextMenuButton
        disabled={!hasSelection}
        label={t("docsContextCopy")}
        shortcut="⌘C"
        onClick={() => void copySelection()}
      />
      <ContextMenuButton
        disabled={!hasSelection}
        label={t("docsContextDelete")}
        onClick={() =>
          run((ed) => ed.chain().focus().deleteSelection().run())
        }
      />
      <ContextMenuButton
        label={t("docsContextClear")}
        onClick={() =>
          run((ed) => ed.chain().focus().unsetAllMarks().clearNodes().run())
        }
      />
    </div>
  );
}

interface ContextMenuButtonProps {
  active?: boolean;
  disabled?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
}

function ContextMenuButton({
  active = false,
  disabled = false,
  label,
  shortcut,
  onClick,
}: ContextMenuButtonProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={
        "block-editor-context-menu-item" + (active ? " is-active" : "")
      }
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut ? (
        <kbd className="block-editor-context-menu-shortcut">{shortcut}</kbd>
      ) : null}
    </button>
  );
}
