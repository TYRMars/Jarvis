// Scroll-to-bottom hook for `<MessageList>`. Three layers cover the
// cases that a naive "scroll on every render" effect would miss
// because the inner `<MarkdownView>` mounts its own `createRoot()`
// and renders the XMarkdown subtree asynchronously:
//
//   1. **Sticky-bottom flag** updated on user scroll. While the user
//      is near the bottom (< `threshold`px) we follow the content;
//      once they scroll up we leave them alone (no more yanking back
//      during streaming).
//
//   2. **useLayoutEffect on every render** — sync scroll-to-bottom
//      iff sticky. Handles the streaming-delta case, where each
//      delta lands as a new commit.
//
//   3. **Multi-rAF chase on activeId change** — when the caller-
//      supplied `activeId` flips (history opened, fork accepted,
//      new convo started), we run `chaseFrames` rAF passes that
//      re-snap to bottom every frame. This catches the async
//      XMarkdown roots as they commit one by one over the next
//      ~200ms.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseStickToBottomOpts {
  /// Conversation / view id. When this flips, the hook treats it
  /// as a "new content batch" and runs the rAF chase.
  activeId: string | null;
  /// rAF passes to chase the bottom on activeId change. Default 12
  /// (~200ms at 60fps), enough to catch async XMarkdown commits.
  chaseFrames?: number;
  /// "Near the bottom" band in px. Within this distance the user
  /// is considered to want auto-follow; beyond it we leave them
  /// alone. Default 120.
  threshold?: number;
}

export function useStickToBottom<E extends HTMLElement = HTMLElement>(
  opts: UseStickToBottomOpts,
) {
  const { activeId, chaseFrames = 12, threshold = 120 } = opts;
  const ref = useRef<E | null>(null);
  // Track whether the user wants the view to follow new content
  // (true = stick to bottom, false = preserve their scroll position).
  // Mutated by the scroll listener; read synchronously by Layers 2/3
  // (the layout-effect chain), so it must stay a ref — React state is
  // async and would lag the in-flight content snap by a frame.
  const stickToBottomRef = useRef(true);
  // Subscribable mirror of `stickToBottomRef` for render-time reads
  // (the scroll-to-bottom FAB). Only flips when the boolean actually
  // changes, so a stream of scroll events at the same band doesn't
  // churn re-renders.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Last activeId we reacted to — used to detect view switches.
  const prevActiveIdRef = useRef<string | null>(null);

  // Keep the ref + the subscribable state in lockstep. Skips the
  // setState when the value is unchanged so identical scroll events
  // don't re-render consumers.
  const setSticky = useCallback((next: boolean) => {
    stickToBottomRef.current = next;
    setIsAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  // Layer 1 — listen for user scrolls; flip the sticky flag when
  // they leave the bottom band.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setSticky(distance < threshold);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [threshold, setSticky]);

  // Layer 2 — on every render, if the user is near the bottom, snap.
  // useLayoutEffect runs sync after DOM mutations, before paint, so
  // the user never sees an intermediate "scrolled half-way" state.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // Layer 3 — on activeId switch, force-stick and chase the bottom
  // across `chaseFrames` frames. Each frame catches more content as
  // the nested XMarkdown roots commit one by one.
  useEffect(() => {
    if (activeId === prevActiveIdRef.current) return;
    prevActiveIdRef.current = activeId;
    setSticky(true);
    const el = ref.current;
    if (!el) return;
    let frames = 0;
    let raf = 0;
    const chase = () => {
      // Re-read `ref.current` each frame so a node that unmounted
      // mid-chase (rare, e.g. fast convo-switching) doesn't crash
      // the rAF loop.
      const node = ref.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
      frames += 1;
      if (frames < chaseFrames) {
        raf = requestAnimationFrame(chase);
      }
    };
    raf = requestAnimationFrame(chase);
    return () => cancelAnimationFrame(raf);
  }, [activeId, chaseFrames, setSticky]);

  // Imperative action for the scroll-to-bottom FAB: snap to the
  // bottom and re-arm auto-follow so subsequent streaming deltas keep
  // tracking. Layer 2's layout effect picks up the flag on its next
  // pass, so we don't need to fight it here.
  const scrollToBottom = useCallback(() => {
    setSticky(true);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setSticky]);

  return { ref, isAtBottom, scrollToBottom };
}
