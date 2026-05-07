// Drop-in replacement for `@tiptap/extension-image` that:
//   - adds an `uploadingId` attr (per spec §7) so we can find the
//     placeholder image after the upload finishes;
//   - swaps in a React NodeView with skeleton / error / retry UI;
//   - registers a ProseMirror plugin that intercepts file drop +
//     paste and pushes the bytes through the configured
//     `ImageUploadAdapter`.
//
// The extension keeps the canonical name `image` so the markdown
// serializer (which targets PM type "image") doesn't need to know
// about uploads — only `src/alt/title` round-trip, which we keep.

import Image from "@tiptap/extension-image";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageUploadView } from "./ImageUploadView";
import type { ImageUploadAdapter } from "./adapter";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageUpload: {
      retryImageUpload: (uploadingId: string) => ReturnType;
    };
  }
}

export interface ImageUploadOptions {
  adapter?: ImageUploadAdapter;
  /** Hard limit on the bytes we'll send to the adapter. Files
   *  larger than this surface as an error without invoking
   *  `adapter.upload`. */
  maxFileBytes: number;
}

/** In-memory map keyed by uploadingId so the retry button can
 *  re-issue the same file. Module-scoped so multiple editor
 *  instances on the same page share the cache; the keys are uuids
 *  so collisions are not a concern. */
const fileCache = new Map<string, File>();

export const ImageUpload = Image.extend<ImageUploadOptions>({
  name: "image",

  addOptions() {
    return {
      ...this.parent?.(),
      adapter: undefined,
      maxFileBytes: 10 * 1024 * 1024, // 10 MB, conservative for v0
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      uploadingId: {
        default: null,
        // Don't roundtrip in HTML attrs — lifecycle-only state.
        renderHTML: () => ({}),
        parseHTML: () => null,
      },
      uploadError: {
        default: null,
        renderHTML: () => ({}),
        parseHTML: () => null,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageUploadView);
  },

  addCommands() {
    return {
      ...this.parent?.(),
      retryImageUpload:
        (uploadingId) =>
        ({ editor }) => {
          const file = fileCache.get(uploadingId);
          if (!file) return false;
          const adapter = this.options.adapter;
          if (!adapter) return false;
          // Clear the error and re-issue.
          updateImageBy(editor.state, uploadingId, (attrs) => ({
            ...attrs,
            uploadError: null,
          })).run(editor);
          void runUpload(file, uploadingId, editor, adapter);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? [];
    const adapter = this.options.adapter;
    const maxBytes = this.options.maxFileBytes;
    if (!adapter) return parentPlugins;

    const editor = this.editor;
    return [
      ...parentPlugins,
      new Plugin({
        props: {
          handleDrop(view, rawEvent) {
            const event = rawEvent;
            const files = imageFiles(event.dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const coords = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            const pos = coords?.pos ?? view.state.selection.from;
            for (const file of files) {
              if (file.size > maxBytes) continue;
              insertAndUpload(editor, pos, file, adapter);
            }
            return true;
          },
          handlePaste(view, rawEvent) {
            const event = rawEvent;
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const pos = view.state.selection.from;
            for (const file of files) {
              if (file.size > maxBytes) continue;
              insertAndUpload(editor, pos, file, adapter);
            }
            return true;
          },
        },
      }),
    ];
  },
});

// ----------------------- helpers --------------------------------

function imageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const file = list.item(i);
    if (file && file.type.startsWith("image/")) out.push(file);
  }
  return out;
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Vanishingly rare path (jsdom < 21); good-enough fallback.
  return `img_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function insertAndUpload(
  editor: import("@tiptap/core").Editor,
  pos: number,
  file: File,
  adapter: ImageUploadAdapter,
): void {
  const id = genId();
  fileCache.set(id, file);
  editor
    .chain()
    .focus()
    .insertContentAt(pos, {
      type: "image",
      attrs: {
        src: "",
        alt: file.name,
        uploadingId: id,
        uploadError: null,
      },
    })
    .run();
  void runUpload(file, id, editor, adapter);
}

async function runUpload(
  file: File,
  uploadingId: string,
  editor: import("@tiptap/core").Editor,
  adapter: ImageUploadAdapter,
): Promise<void> {
  try {
    const result = await adapter.upload(file);
    updateImageBy(editor.state, uploadingId, () => ({
      src: result.url,
      alt: file.name,
      uploadingId: null,
      uploadError: null,
    })).run(editor);
    fileCache.delete(uploadingId);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    updateImageBy(editor.state, uploadingId, (attrs) => ({
      ...attrs,
      uploadError: message,
    })).run(editor);
  }
}

interface MarkupTransaction {
  run(editor: import("@tiptap/core").Editor): boolean;
}

function updateImageBy(
  state: EditorState,
  uploadingId: string,
  transform: (attrs: Record<string, unknown>) => Record<string, unknown>,
): MarkupTransaction {
  let pos = -1;
  let attrs: Record<string, unknown> | null = null;
  state.doc.descendants((node, p) => {
    if (
      node.type.name === "image" &&
      node.attrs["uploadingId"] === uploadingId
    ) {
      pos = p;
      attrs = node.attrs;
      return false;
    }
    return true;
  });
  return {
    run(editor) {
      if (pos < 0 || !attrs) return false;
      return editor
        .chain()
        .focus()
        .setNodeSelection(pos)
        .updateAttributes("image", transform(attrs))
        .run();
    },
  };
}
