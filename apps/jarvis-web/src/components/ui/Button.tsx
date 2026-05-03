// Canonical button — replaces the ad-hoc `settings-btn` /
// `settings-btn-ghost` / `settings-btn-danger` / `projects-new-btn` /
// `modal-btn-primary` zoo with a single component + variant prop.
//
// The legacy class names still exist in styles.css and the old call
// sites still render; this just gives new code a typed entry point
// so we stop reinventing visual tiers per page. Migration of the
// existing 80-or-so callers can happen incrementally — in any
// callsite just swap `<button className="settings-btn ...">` for
// `<Button variant="...">`.
//
// API mirrors `<button>` exactly via prop pass-through (`...rest`)
// so `onClick`, `disabled`, `type`, `aria-*`, etc. all work as
// expected. The `as` prop lets a `<Button>` render as an `<a>` for
// router-style nav buttons that should look like buttons but
// navigate via href.

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/// Visual tier:
///  - `default` — neutral border + transparent background. The most
///    common form chrome (Cancel, Edit, secondary actions).
///  - `primary` — filled accent. Reserved for the *single* primary
///    action in any given surface (Save, Submit, Confirm).
///  - `ghost` — even lighter than `default`; no border, transparent
///    until hover. Use for inline / icon-only / row-tail actions.
///  - `danger` — destructive (Delete, Archive, irreversible).
export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

/// Density:
///  - `md` (default) — 32px tall, the standard form-row height.
///  - `sm` — 26px tall, fits inside dense rows / chip toolbars.
export type ButtonSize = "md" | "sm";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /// Render as an `<a>` instead of `<button>`. Pass `href` via the
  /// rest props in that case. Useful when a control should look like
  /// a button but navigate (e.g. an external doc link styled as
  /// "Learn more"). Default `"button"`.
  as?: "button" | "a";
  children?: ReactNode;
}

type ButtonAsButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { as?: "button" };
type ButtonAsAnchorProps = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { as: "a" };

export type ButtonProps = ButtonAsButtonProps | ButtonAsAnchorProps;

/// Compute the className from variant/size + caller-supplied class.
/// Exported so other components in `ui/` can render their own
/// `<button>`s with the same tokens (e.g. ConfirmDialogHost's footer
/// reuses these exact classes for the cancel/confirm pair).
export function buttonClassName(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}): string {
  const variant = opts.variant ?? "default";
  const size = opts.size ?? "md";
  // Map our canonical variants onto the legacy CSS classes that
  // already exist in styles.css. This keeps the visual contract in
  // one place (styles.css) — `<Button>` is a typed wrapper, not a
  // re-skin.
  const variantClass =
    variant === "primary"
      ? "settings-btn settings-btn-primary"
      : variant === "ghost"
        ? "settings-btn settings-btn-ghost"
        : variant === "danger"
          ? "settings-btn settings-btn-danger"
          : "settings-btn";
  const sizeClass = size === "sm" ? "ui-btn-sm" : "";
  return [variantClass, sizeClass, opts.className].filter(Boolean).join(" ");
}

/// Use this. Forwards refs so callers can attach focus etc., and
/// preserves the underlying HTML element's prop signature so
/// TypeScript catches missing `href` on `as="a"` etc.
export const Button = forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>(function Button({ variant, size, as, className, children, ...rest }, ref) {
  const cls = buttonClassName({ variant, size, className });
  if (as === "a") {
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={cls}
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  }
  // Default: render as a real <button>. `type` defaults to "button"
  // so dropping a Button into a <form> doesn't accidentally submit.
  const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={buttonProps.type ?? "button"}
      className={cls}
      {...buttonProps}
    >
      {children}
    </button>
  );
});
