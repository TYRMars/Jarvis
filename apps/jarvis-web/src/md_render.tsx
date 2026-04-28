// Adapter that bridges the React tree to `@ant-design/x-markdown`.
//
// XMarkdown maintains its own React root inside the container div
// (via `createRoot`), so we cache one Root per element via a
// WeakMap and call `root.render(...)` on every content change.
// Strict-Mode double-mounts in dev rebind the cached root cleanly.
//
// **Streaming defaults — opt into the LLM-friendly XMarkdown
// features** that we previously left disabled:
//
// 1. `tail` (the blinking `▋` cursor) is ON during streaming so the
//    user has a clear "still typing" signal instead of wondering
//    whether the model stalled.
// 2. `enableAnimation` fades in each new block as it lands. With a
//    150ms duration it keeps streaming snappy without feeling
//    flat — matches Codex / Claude Code's rhythm.
// 3. `incompleteMarkdownComponentMap` defaults are ON (empty `{}`
//    accepts the package defaults: half-streamed links / images /
//    tables / code render as stable placeholder nodes instead of
//    flicker-rendering broken markdown). We add classes via CSS
//    so the placeholders read as muted "loading…" rows.
//
// All three are no-ops once `hasNextChunk` flips to false, so they
// don't affect finalised messages.

import { XMarkdown } from "@ant-design/x-markdown";
import { createRoot, type Root } from "react-dom/client";

const roots = new WeakMap<Element, Root>();

export function renderMarkdownInto(container: HTMLElement, content: string, streaming = false) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }

  root.render(
    <XMarkdown
      className="jarvis-x-markdown"
      content={content || ""}
      escapeRawHtml
      openLinksInNewTab
      streaming={{
        // True while a delta may still arrive. Drives every other
        // streaming behaviour below; flips false once the agent
        // emits `assistant_message`, at which point all transient
        // affordances (cursor + animation) stop.
        hasNextChunk: streaming,
        // Show the `▋` indicator at the writing position so the
        // user sees a clear "still typing" signal. Default content
        // is the block character; we re-style it in CSS to match
        // the chat surface (accent colour + steady blink).
        //
        // Note: half-streamed inline markdown (like a link in
        // flight) is HIDDEN by the package's default — it doesn't
        // need any extra config from us. Plumbing
        // `incompleteMarkdownComponentMap` only matters when you
        // provide custom React `components` for each placeholder
        // name; otherwise the package returns `undefined` and the
        // pending fragment quietly waits to be complete. That's
        // the right behaviour for our case (no flicker), so we
        // intentionally don't override it.
        tail: true,
        // Fade-in each block as it streams. Default is 200ms /
        // ease-in-out; we tighten to 150ms / ease-out so streaming
        // feels responsive, not stately.
        enableAnimation: true,
        animationConfig: {
          fadeDuration: 150,
          easing: "ease-out",
        },
      }}
    />,
  );
}
