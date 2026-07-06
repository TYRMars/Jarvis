// Bridge between the React tree and the existing X-Markdown
// renderer (`md_render.tsx`). Mounts a div that the imperative
// `renderMarkdownInto` controls; we feed it new content on every
// render. The renderer maintains its own React root inside that
// div via `createRoot`, which means React Strict Mode's double-
// mount is fine — the cached root just rebinds.

import { useEffect, useRef } from "react";
import { renderMarkdownInto, unmountMarkdownFrom } from "../../md_render";

interface Props {
  content: string;
  /// True during streaming (a `delta` may still arrive); switches
  /// the X-Markdown component into its tail-tolerant mode so a
  /// half-fence renders without thrashing.
  streaming?: boolean;
}

export function MarkdownView({ content, streaming = false }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    renderMarkdownInto(ref.current, content, streaming);
  }, [content, streaming]);

  // Tear down the inner XMarkdown root when this view unmounts. Kept in its own
  // mount-only effect (deps `[]`) so a `content`/`streaming` change reuses the
  // cached root instead of unmounting and recreating it every render. On a
  // Strict-Mode remount the cleanup drops the WeakMap entry, so the render
  // effect above cleanly recreates the root on the same node.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) unmountMarkdownFrom(el);
    };
  }, []);

  return <div ref={ref} className="markdown-body" data-md-raw={content} />;
}
