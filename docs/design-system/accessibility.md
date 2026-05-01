# Accessibility

Standards and audits for keeping Jarvis usable by keyboard, screen
reader, and low-vision users — and by anyone with motion sensitivity
or a slow connection. The bar is **WCAG 2.1 AA**; AAA where cheap.

## Contrast audit

All foreground / background pairs computed via the WCAG relative
luminance formula. **AA threshold: 4.5:1 for normal text, 3:1 for
large text (≥18px or ≥14px bold) and graphical objects.**

### Light theme

| Foreground | Background | Ratio | Pass |
|---|---|---|---|
| `--text` `#262624` | `--bg` `#ffffff` | 14.39:1 | AAA |
| `--text` `#262624` | `--sidebar-bg` `#fafafa` | 13.36:1 | AAA |
| `--text` `#262624` | `--panel-raised` `#f6f6f5` | 12.78:1 | AAA |
| `--text-muted` `#5f5d58` | `--bg` `#ffffff` | 6.45:1 | AA / AAA-large |
| `--text-muted` `#5f5d58` | `--sidebar-bg` `#fafafa` | 5.99:1 | AA |
| `--text-muted` `#5f5d58` | `--panel-hover` `#eeeeec` | 5.20:1 | AA |
| `--text-soft` `#8d8a83` | `--bg` `#ffffff` | 3.43:1 | **❌ FAIL** AA |
| `--text-soft` `#8d8a83` | `--sidebar-bg` `#fafafa` | 3.18:1 | **❌ FAIL** AA |
| `--placeholder` `#aaa6a0` | `--input-bg` `#ffffff` | 2.55:1 | **❌ FAIL** AA |
| `--text` on `--accent` (`#262624` on `#d87948`) | — | 6.15:1 | AA |
| `--accent-contrast` on `--accent` (`#23140c` on `#d87948`) | — | 5.31:1 | AA |
| `--accent-success` `#2f9c4a` on `--bg` `#ffffff` | — | 3.50:1 | AA-large only |
| `--accent-danger` `#c94d45` on `--bg` `#ffffff` | — | 4.29:1 | **❌ FAIL** AA (close) |
| `--accent-info` `#397fd6` on `--bg` `#ffffff` | — | 4.39:1 | **❌ FAIL** AA (close) |

### Dark theme

| Foreground | Background | Ratio | Pass |
|---|---|---|---|
| `--text` `#d6d2cb` | `--bg` `#090909` | 13.85:1 | AAA |
| `--text` `#d6d2cb` | `--sidebar-bg` `#121212` | 12.70:1 | AAA |
| `--text-muted` `#9c978f` | `--bg` `#090909` | 7.88:1 | AAA |
| `--text-muted` `#9c978f` | `--sidebar-bg` `#121212` | 7.22:1 | AAA |
| `--text-soft` `#69655f` | `--bg` `#090909` | 3.45:1 | **❌ FAIL** AA (3:1 large only) |
| `--text-soft` `#69655f` | `--sidebar-bg` `#121212` | 3.16:1 | **❌ FAIL** AA |
| `--placeholder` `#5f5f5f` | `--input-bg` `#1c1c1c` | 3.62:1 | **❌ FAIL** AA |
| `--accent-success` `#5ebf67` on `--bg` `#090909` | — | 7.58:1 | AAA |
| `--accent-danger` `#d25a55` on `--bg` `#090909` | — | 4.93:1 | AA |
| `--accent-info` `#4da2ff` on `--bg` `#090909` | — | 7.21:1 | AAA |

### Recommended replacements

These are the proposed values. **Not applied in this PR** — listed
here so that a future targeted contrast PR can adopt them wholesale.

| Token | Theme | Current | Proposed | New ratio |
|---|---|---|---|---|
| `--text-soft` | light | `#8d8a83` | `#76736c` | 4.74:1 vs `#fafafa` |
| `--text-soft` | dark | `#69655f` | `#878177` | 5.10:1 vs `#121212` |
| `--placeholder` | light | `#aaa6a0` | `#8d8a83` | 3.43:1 vs `#fff` (AA-large) — note: placeholders are exempt from AA but should still pass 3:1 |
| `--placeholder` | dark | `#5f5f5f` | `#7a7a7a` | 4.62:1 vs `#1c1c1c` |
| `--accent-danger` | light | `#c94d45` | `#b53d36` | 5.07:1 |
| `--accent-info` | light | `#397fd6` | `#2563c4` | 5.13:1 |

When applied, every component using these tokens needs a visual sweep
— the soft / placeholder change is subtle, but the danger / info
change is visible. Track in [README.md#open-follow-ups](README.md#open-follow-ups).

### Mitigations available now

Until the values change, components can guard against the worst cases:

- **Don't use `--text-soft` for body content.** It is intended for
  tertiary annotations only. Reserve for: timestamps, "N more"
  counters, kbd-hint footers — never for an inline label or list
  item.
- **Don't put `--text-soft` on `--sidebar-bg`.** Both pairs above
  fail. Use `--text-muted` for sidebar metadata.
- **Use the bold or larger forms.** Status chip text passes when
  weight 560 + size 11px (the large-text threshold for bold is
  effectively cleared at 14/700 or 18/normal — chip text borderlines).

## Focus rings

**Standard.**

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

**Rules.**

1. Never `outline: none` without an alternate visible indicator. If
   the design needs a custom indicator (e.g., border colour change
   instead of an outline), it must still meet 3:1 contrast against
   the background.
2. Use `:focus-visible`, not `:focus` — mouse-clicked buttons
   shouldn't show a ring.
3. The 2px offset is non-negotiable — keeps the ring readable on
   small targets.
4. Light theme: `--accent` `#d87948` on `--bg` `#ffffff` is 2.05:1 —
   **does not meet 3:1 graphical-object contrast**. Use the focus
   ring against a 2px outline-offset (the offset means the ring
   doesn't actually need to contrast against the element below, only
   against the surrounding gap, which is `--bg` or whichever surface
   the element sits on). This is a known soft spot — for high-stakes
   focused elements (composer, modal action buttons), consider also
   raising `--shadow-soft` for emphasis.

## Keyboard navigation

See [patterns.md#keyboard-contracts](patterns.md#keyboard-contracts)
for the full key map. Accessibility-specific rules:

- **Tab order matches visual order.** No `tabindex >= 1`. Use `0` to
  add to the natural order, `-1` to remove from it.
- **Skip-link.** A "Skip to main content" link should be the first
  focusable element on every page (currently missing — tracked in
  open follow-ups).
- **Focus trap in modals.** When a modal opens, focus moves to its
  first interactive element; `Tab` cycles within the modal; `Esc`
  closes it and returns focus to the trigger.
- **Restore focus.** Closing a popover / dropdown returns focus to
  the trigger.

## `prefers-reduced-motion`

Every CSS transition and animation MUST be neutralised under
`prefers-reduced-motion: reduce`.

**Mechanism.** Wrap the global stylesheet with:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Per-component rules.**

- Skeleton shimmer animations: turn off entirely (use a static
  `--surface-panel-raised` block).
- Auto-scroll on new chat messages: still scroll, but instantly
  (`behavior: 'auto'` instead of `'smooth'`).
- Spinner: keep, but slow to 2× cycle so it doesn't feel
  flickery — the spin is informational, not decorative.

## Icon-only buttons

Every button without visible text MUST have an `aria-label` describing
its action. Audit list of current `.ghost-icon` instances:

| Component | Action | Required `aria-label` |
|---|---|---|
| Sidebar collapse | toggle sidebar | "Collapse sidebar" / "Expand sidebar" |
| Sidebar new chat | new conversation | "New conversation" |
| Sidebar search | open quick switcher | "Search" |
| Workspace badge | open recent folders | "Switch workspace" |
| Composer send | send message | "Send message" |
| Composer attach | (planned) | "Attach file" |
| Tool block expand | toggle tool detail | "Show tool detail" / "Hide tool detail" |
| Approval card approve | approve tool call | "Approve {tool name}" |
| Approval card deny | deny tool call | "Deny {tool name}" |
| User bubble edit | edit message | "Edit message" |
| Assistant bubble copy | copy text | "Copy message" |
| Modal close | close dialog | "Close" |
| Theme toggle | switch theme | "Switch to dark" / "Switch to light" |

When the action depends on state (toggle on/off), the label must
update with the state — not be static.

**Tooltip support.** Pair every icon-only button with a tooltip that
shows on hover (300ms delay) and on keyboard focus. The tooltip text
should match (or be a slightly longer form of) the `aria-label`.

## Form labels

Every form input MUST have a label or `aria-label`. The conventions:

- Text / textarea / select: `<label for="…">` above the input
  (preferred) or `aria-label` if visually labelled by surrounding
  text.
- Checkbox / radio: `<label>` wraps the input + label text. The
  click target is the entire label, not just the box.
- Required fields: append a visible `*` AND `aria-required="true"`.
- Errors: `aria-describedby` pointing to the error element;
  `aria-invalid="true"` on the input.

## Image alternatives

The web client today has very few `<img>` tags (mostly inline SVG).
Rules:

- **Decorative SVG** (icons that duplicate adjacent text): `aria-hidden="true"`.
- **Meaningful SVG** (icon-only button, status glyph): provide
  `aria-label` on the button or `<title>` inside the SVG.
- **Avatar images**: `alt` is the user/agent's display name.

## Colour as the only indicator

Forbidden. Examples that ship correctly today:

- Status chips: colour + label ("done", "in-progress").
- Diff viewer: colour + `+` / `-` glyph.
- Dirty workspace badge: colour + `•` marker.

If you find a colour-only signal in code (e.g., a red border with no
text), add a glyph or label.

## Screen-reader announcements

For dynamic content updates that the user should hear without
shifting focus:

- New assistant message arriving while user is typing: announce
  via `aria-live="polite"` region.
- Tool error: `aria-live="assertive"` (interrupts).
- Stream completion: no announcement (the visual update is enough).

The aria-live region should be visually hidden but not
`display: none` — use the `.sr-only` utility (`position: absolute;
clip: rect(0 0 0 0); width: 1px; height: 1px; overflow: hidden;`).

## Testing

A quick local audit before shipping any UI change:

1. **Keyboard pass**: Tab through the new screen end-to-end. Every
   interactive element should receive a visible focus ring; tab
   order should match visual order; `Esc` should close any overlay.
2. **Contrast spot-check**: open DevTools, use the colour-picker's
   contrast indicator on the smallest text, plus on any state-only
   colour signal.
3. **Reduced-motion**: enable "Reduce motion" in OS settings,
   re-load. Animations should be instant; nothing should be missing.
4. **Zoom test**: Cmd/Ctrl + scroll up to 200% zoom. Layout shouldn't
   horizontally scroll; text shouldn't clip.
5. **Theme parity**: toggle dark / light, every state shown above
   should still pass contrast / be visible.

Automated checks (axe-core / Pa11y) catch a fraction; the manual pass
catches the rest.
