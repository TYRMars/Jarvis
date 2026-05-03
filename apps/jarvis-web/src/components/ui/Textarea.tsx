// Multi-line text input. Same chrome contract as `<TextField>` —
// label slot, hint, error state — but renders a `<textarea>` and
// supports an optional `autoGrow` mode that resizes to fit the
// content (capped by `maxRows`).
//
// Auto-grow is opt-in because most form areas are happier with a
// fixed-height field that scrolls (commit message, requirement
// description). The composer uses its own bespoke autosize logic
// elsewhere; this helper is for settings / detail-panel forms.

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: boolean;
  /// Resize to fit content as the user types. Capped by `maxRows`.
  autoGrow?: boolean;
  /// Lower bound for auto-grow (and a sensible static height when
  /// auto-grow is off). Defaults to `rows` if set, else 3.
  minRows?: number;
  /// Upper bound for auto-grow. Past this, `overflow-y: auto`
  /// kicks in and the user scrolls. Defaults to 10.
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      label,
      hint,
      error,
      autoGrow = false,
      minRows,
      maxRows = 10,
      className,
      id: idProp,
      value,
      onInput,
      ...rest
    },
    ref,
  ) {
    const reactId = useId();
    const id = idProp ?? `${reactId}-textarea`;
    const hintId = hint ? `${id}-hint` : undefined;
    const localRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => localRef.current as HTMLTextAreaElement);

    // Auto-resize: measure scrollHeight on every value change. We
    // compute line-height once + clamp to [minRows, maxRows] so the
    // box doesn't grow unboundedly.
    useLayoutEffect(() => {
      if (!autoGrow) return;
      const el = localRef.current;
      if (!el) return;
      el.style.height = "auto";
      const cs = window.getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || 20;
      const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const min = (minRows ?? rest.rows ?? 3) * lh + padding;
      const max = maxRows * lh + padding;
      const next = Math.min(max, Math.max(min, el.scrollHeight));
      el.style.height = `${next}px`;
    }, [autoGrow, value, maxRows, minRows, rest.rows]);

    // Re-run sizing once on mount so SSR-rehydrated textareas with
    // an initial value snap to the right height immediately.
    useEffect(() => {
      if (!autoGrow) return;
      const el = localRef.current;
      if (!el) return;
      el.dispatchEvent(new Event("input"));
    }, [autoGrow]);

    return (
      <div className={"ui-field" + (error ? " is-error" : "")}>
        {label != null && (
          <label htmlFor={id} className="ui-field-label">
            {label}
          </label>
        )}
        <div className={"ui-field-control" + (className ? " " + className : "")}>
          <textarea
            ref={localRef}
            id={id}
            rows={rest.rows ?? minRows ?? 3}
            value={value}
            onInput={onInput}
            aria-invalid={error || undefined}
            aria-describedby={hintId}
            {...rest}
          />
        </div>
        {hint != null && (
          <p id={hintId} className="ui-field-hint">
            {hint}
          </p>
        )}
      </div>
    );
  },
);
