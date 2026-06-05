// Slash-menu popover. Positioning is delegated to floating-ui so
// we never hand-compute coordinates (spec §6.3 hard rule).
//
// The Tiptap suggestion plugin drives this component imperatively:
// it passes the current candidate list, mounts/unmounts the
// popover, and forwards keyboard events to `onKeyDown` via the
// imperative ref.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import type { SlashCandidate } from "./candidates";
import { t } from "../../../../../utils/i18n";

export interface SlashMenuListProps {
  items: readonly SlashCandidate[];
  /** Called when the user picks an item via mouse or Enter. */
  onPick: (index: number) => void;
  /** Function returning the cursor's DOMRect. Tiptap's suggestion
   *  plugin produces this. We turn it into a virtual reference for
   *  floating-ui. May return null briefly during teardown. */
  getReferenceRect: () => DOMRect | null;
}

export interface SlashMenuListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** Minimum and maximum menu dimensions — kept in sync with editor.css. */
const MIN_WIDTH = 240;
const MAX_HEIGHT = 320;

export const SlashMenuList = forwardRef<SlashMenuListHandle, SlashMenuListProps>(
  function SlashMenuList({ items, onPick, getReferenceRect }, ref) {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // Keep selection in range when items change.
    useEffect(() => {
      setSelected(0);
    }, [items]);

    // Expose imperative onKeyDown so the Tiptap plugin can route
    // keys here while the popover is open.
    useImperativeHandle(
      ref,
      () => ({
        onKeyDown(event: KeyboardEvent) {
          if (items.length === 0) return false;
          if (event.key === "ArrowUp") {
            setSelected((s) => (s - 1 + items.length) % items.length);
            return true;
          }
          if (event.key === "ArrowDown") {
            setSelected((s) => (s + 1) % items.length);
            return true;
          }
          if (event.key === "Enter") {
            onPick(selected);
            return true;
          }
          return false;
        },
      }),
      [items, selected, onPick],
    );

    // Floating-ui virtual reference built from getReferenceRect().
    const virtualRef = useMemo(
      () => ({
        getBoundingClientRect: () => {
          const rect = getReferenceRect();
          if (rect) return rect;
          // Off-screen fallback — keeps the popover hidden if the
          // cursor briefly goes away (paste / unmount race).
          return new DOMRect(-9999, -9999, 0, 0);
        },
      }),
      [getReferenceRect],
    );

    const { refs, floatingStyles } = useFloating({
      placement: "bottom-start",
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      whileElementsMounted: autoUpdate,
    });

    useLayoutEffect(() => {
      refs.setReference(virtualRef);
    }, [refs, virtualRef]);

    // Scroll the selected item into view when nav happens.
    useEffect(() => {
      const el = itemRefs.current[selected];
      if (el && listRef.current) {
        const parentRect = listRef.current.getBoundingClientRect();
        const childRect = el.getBoundingClientRect();
        if (childRect.top < parentRect.top) {
          listRef.current.scrollTop -= parentRect.top - childRect.top;
        } else if (childRect.bottom > parentRect.bottom) {
          listRef.current.scrollTop += childRect.bottom - parentRect.bottom;
        }
      }
    }, [selected]);

    if (items.length === 0) {
      return (
        <div
          ref={refs.setFloating}
          style={{ ...floatingStyles, minWidth: MIN_WIDTH }}
          className="slash-menu slash-menu-empty"
          role="listbox"
        >
          {t("noMatches")}
        </div>
      );
    }

    return (
      <div
        ref={(el) => {
          refs.setFloating(el);
          listRef.current = el;
        }}
        style={{ ...floatingStyles, minWidth: MIN_WIDTH, maxHeight: MAX_HEIGHT }}
        className="slash-menu"
        role="listbox"
        aria-label={t("docsEdSlashMenuLabel")}
      >
        {items.map((item, idx) => (
          <button
            key={item.id}
            type="button"
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            role="option"
            aria-selected={idx === selected}
            className={
              "slash-menu-item" + (idx === selected ? " is-selected" : "")
            }
            onMouseEnter={() => setSelected(idx)}
            onMouseDown={(e) => {
              // Use mousedown so the contenteditable doesn't lose
              // focus before our click registers.
              e.preventDefault();
              onPick(idx);
            }}
            data-testid={`slash-${item.id}`}
          >
            <span className="slash-menu-icon" aria-hidden>
              {item.icon ?? "·"}
            </span>
            <span className="slash-menu-text">
              <span className="slash-menu-title">{item.title}</span>
              {item.description ? (
                <span className="slash-menu-desc">{item.description}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    );
  },
);
