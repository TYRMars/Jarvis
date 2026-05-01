import { useEffect, useRef } from "react";

interface UseAutosaveOpts {
  /** What we're saving — when this id changes the timer is cancelled
   *  and a final flush is forced for the *previous* id. */
  id: string | null;
  /** The latest content. The hook compares to its last-saved snapshot
   *  to decide whether to fire. */
  content: string;
  /** Persist `content` for `id`. Resolved promise → handler can flip
   *  the saved-state pill green; throw → caller surfaces error state. */
  save: (id: string, content: string) => Promise<unknown>;
  /** Idle delay before firing. Default 1200ms. */
  idleMs?: number;
}

/// Autosave: fires when (a) the user stops editing for `idleMs`,
/// (b) the document loses focus / id switches. Skips when content is
/// unchanged from the last successful save. Caller is expected to
/// reflect the in-flight state via a SaveStatePill — this hook is
/// purely the timing layer; it never owns visible UI.
export function useAutosave({ id, content, save, idleMs = 1200 }: UseAutosaveOpts) {
  const timer = useRef<number | null>(null);
  const lastSaved = useRef<{ id: string; content: string } | null>(null);
  // Keep the latest `save` callback in a ref so we don't reset the
  // timer on every render just because the parent re-bound it.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Clear the pending timer when id changes; flush the previous id
  // synchronously so switching docs persists in-flight changes.
  useEffect(() => {
    return () => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const last = lastSaved.current;
      if (last && id && last.id === id && last.content !== content) {
        // best-effort flush; we deliberately don't await
        void saveRef.current(last.id, content).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // (Re)schedule on every content change.
  useEffect(() => {
    if (!id) return;
    const last = lastSaved.current;
    if (last && last.id === id && last.content === content) return;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      timer.current = null;
      try {
        await saveRef.current(id, content);
        lastSaved.current = { id, content };
      } catch {
        // Caller surfaces error state via its own bookkeeping.
      }
    }, idleMs);
    return () => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [id, content, idleMs]);

  /// Force an immediate save (e.g. on textarea blur, on tab close).
  /// Returns the promise so callers can await it if they need the
  /// final state.
  const flush = async (): Promise<void> => {
    if (!id) return;
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const last = lastSaved.current;
    if (last && last.id === id && last.content === content) return;
    await saveRef.current(id, content);
    lastSaved.current = { id, content };
  };

  /// Reset the saved-content snapshot — call after loading a fresh
  /// draft so the hook doesn't immediately fire a redundant save.
  const reset = (initial: string) => {
    if (id) lastSaved.current = { id, content: initial };
  };

  return { flush, reset };
}
