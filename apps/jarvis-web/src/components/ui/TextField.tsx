// Form text input. Wraps `<input>` with consistent chrome:
//
//   - Optional label slot (rendered as a real `<label>` so clicking
//     the text focuses the input — the screen-reader contract).
//   - Optional error / help text below the input.
//   - Optional prefix / suffix slot (icon, currency symbol, suffix
//     unit) inline with the input value.
//   - Mirrors `<input>` props via spread, so `value`, `onChange`,
//     `placeholder`, `autoFocus`, `disabled` etc. all work.
//
// Visuals reuse the existing `--input-bg / --input-border /
// --input-focus` tokens so dark-mode + theme rules carry over with
// zero CSS churn.

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

export interface TextFieldProps
  // `size` collides with `<input size="">`; `prefix`/`suffix` collide
  // with the (rarely-used) HTML attributes on number-typed inputs.
  // We remove all three so callers' typed slots are unambiguous.
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  /// Visible label. Renders as `<label htmlFor=...>` so clicking it
  /// focuses the input. Pass `null` / undefined for label-less
  /// surfaces; in that case set `aria-label` via the rest props.
  label?: ReactNode;
  /// Inline help / error text below the input. When `error` is true,
  /// rendered with the danger colour; otherwise muted.
  hint?: ReactNode;
  /// Marks the field as in error — paints the border + hint in the
  /// danger tint and sets `aria-invalid`.
  error?: boolean;
  /// Optional content rendered inside the input frame, before the
  /// value (e.g. a search magnifier). Click-through goes to the
  /// input.
  prefix?: ReactNode;
  /// Same as `prefix` but at the end (e.g. clear button, unit).
  suffix?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    { label, hint, error, prefix, suffix, className, id: idProp, ...rest },
    ref,
  ) {
    const reactId = useId();
    const id = idProp ?? `${reactId}-input`;
    const hintId = hint ? `${id}-hint` : undefined;
    return (
      <div className={"ui-field" + (error ? " is-error" : "")}>
        {label != null && (
          <label htmlFor={id} className="ui-field-label">
            {label}
          </label>
        )}
        <div className={"ui-field-control" + (className ? " " + className : "")}>
          {prefix != null && <span className="ui-field-prefix">{prefix}</span>}
          <input
            ref={ref}
            id={id}
            aria-invalid={error || undefined}
            aria-describedby={hintId}
            {...rest}
          />
          {suffix != null && <span className="ui-field-suffix">{suffix}</span>}
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
