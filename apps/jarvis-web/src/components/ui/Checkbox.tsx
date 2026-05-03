// Styled checkbox. Wraps the native `<input type="checkbox">` so the
// click-target / form-data semantics stay first-class, but paints a
// custom box that respects dark-mode tokens and the brand accent.
//
// Indeterminate state is supported via the `indeterminate` prop
// (DOM property only; not reflected in HTML). Useful for "select-all"
// rows where some children are checked and some aren't.

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /// Inline label rendered to the right of the box. Click-through
  /// goes to the input via the wrapping `<label>`.
  label?: ReactNode;
  /// Optional secondary line below the label, muted. Useful for
  /// "remember choice" / form-help affordances.
  hint?: ReactNode;
  /// Tri-state visual — partial selection (some children on, some
  /// off). Mutually exclusive with `checked` semantically: when
  /// `indeterminate` is true, the visual box ignores `checked` and
  /// shows the "−" glyph.
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    { label, hint, indeterminate, className, id: idProp, ...rest },
    ref,
  ) {
    const reactId = useId();
    const id = idProp ?? `${reactId}-checkbox`;
    const inner = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLInputElement);

    // `indeterminate` is a DOM-only property; toggle it imperatively
    // whenever the prop or the underlying `checked` flips.
    useEffect(() => {
      if (inner.current) inner.current.indeterminate = !!indeterminate;
    }, [indeterminate, rest.checked]);

    return (
      <label
        htmlFor={id}
        className={
          "ui-checkbox" +
          (rest.disabled ? " disabled" : "") +
          (className ? " " + className : "")
        }
      >
        <input
          ref={inner}
          id={id}
          type="checkbox"
          className="ui-checkbox-input"
          {...rest}
        />
        <span className="ui-checkbox-box" aria-hidden="true">
          {/* The check / minus glyph; CSS controls when it shows
              via the input's `:checked` / `:indeterminate` siblings. */}
          <svg
            className="ui-checkbox-check"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <svg
            className="ui-checkbox-dash"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M5 12h14" />
          </svg>
        </span>
        {label != null && (
          <span className="ui-checkbox-text">
            <span className="ui-checkbox-label">{label}</span>
            {hint != null && <span className="ui-checkbox-hint">{hint}</span>}
          </span>
        )}
      </label>
    );
  },
);
