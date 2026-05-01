# Tokens

This document is the human-readable index of every design token shipped
in [styles.css](../../apps/jarvis-web/src/styles.css). For each token it
shows the runtime variable name, the value in light and dark theme, and
whether it is exposed to Tailwind via the `@theme` block.

> **Reading guide.** The file `styles.css` declares two parallel sets of
> values: `:root` for light mode, `:root[data-theme="dark"]` for dark
> mode. Every token in this document exists in both unless explicitly
> noted. Semantic alias tokens (added 2026-05) live only in `:root` and
> resolve to legacy tokens via `var()`; they need no dark-mode override
> because resolution happens at consumption time.

## Conventions

- **Legacy tokens** are the original position-named variables
  (`--user-bubble-bg`, `--tool-header-bg`, …). They still work and
  every existing component consumes them.
- **Semantic aliases** are the new layer (`--surface-panel`,
  `--text-default`, `--accent-primary`, …). Prefer these in new
  components. Each alias is defined as `var(--legacy-name)`.
- **Tailwind-exposed** means the token has a matching entry in the
  `@theme` block (lines 13–55 of `styles.css`) and can be used as a
  utility class such as `bg-panel`, `text-soft`, `border-input-border`.

## Colours — semantic layer

The recommended layer for new code. Each row references the live
legacy token via `var()`.

### Surfaces

| Semantic alias | Legacy token | Light hex | Dark hex | Tailwind |
|---|---|---|---|---|
| `--surface-bg` | `--bg` | `#ffffff` | `#090909` | `bg-bg` |
| `--surface-sidebar` | `--sidebar-bg` | `#fafafa` | `#121212` | `bg-sidebar` |
| `--surface-panel` | `--panel` | `#ffffff` | `#101010` | `bg-panel` |
| `--surface-panel-raised` | `--panel-raised` | `#f6f6f5` | `#171717` | `bg-panel-raised` |
| `--surface-panel-hover` | `--panel-hover` | `#eeeeec` | `#202020` | `bg-panel-hover` |
| `--surface-panel-active` | `--panel-active` | `#e9e8e5` | `#2d2d2d` | `bg-panel-active` |
| `--surface-input` | `--input-bg` | `#ffffff` | `#1c1c1c` | `bg-input` |
| `--surface-tool` | `--tool-bg` | `#fbfaf8` | `#151515` | `bg-tool` |

> Both `--bg` and `--panel` are pure white in light theme but diverge in
> dark theme. Use `--surface-bg` for the root canvas only; everything
> framed (chat pane, projects pane, settings card) sits on
> `--surface-panel`.

### Text

| Semantic alias | Legacy token | Light hex | Dark hex | Tailwind |
|---|---|---|---|---|
| `--text-default` | `--text` | `#262624` | `#d6d2cb` | `text-text` |
| `--text-muted` | `--text-muted` | `#5f5d58` | `#9c978f` | `text-muted` |
| `--text-soft` | `--text-soft` | `#8d8a83` | `#69655f` | `text-soft` |
| `--text-on-accent` | `--accent-contrast` | `#23140c` | `#1b130e` | `text-on-accent` |
| `--text-placeholder` | `--placeholder` | `#aaa6a0` | `#5f5f5f` | `text-placeholder` |
| `--text-disabled` | `--disabled-text` | `#9e9a93` | `#767676` | — |

Hierarchy rule: **default → muted → soft**, getting progressively
quieter. Use `default` for primary content, `muted` for labels and
secondary metadata, `soft` only for tertiary annotations (timestamps,
helper text under inputs). See [accessibility.md](accessibility.md) for
contrast caveats — `--text-soft` on `--surface-sidebar` in light mode
fails WCAG AA.

### Borders

| Semantic alias | Legacy token | Light hex | Dark hex | Tailwind |
|---|---|---|---|---|
| `--border-default` | `--border` | `#e4e2dd` | `#262626` | `border-border` |
| (—) | `--border-soft` | `#efede8` | `#1b1b1b` | `border-border-soft` |
| `--border-input` | `--input-border` | `#dedcd5` | `#303030` | `border-input-border` |
| `--border-input-focus` | `--input-focus` | `#c9c5ba` | `#4a4a4a` | — |

### Accents (semantic)

The five "this means X" colours. Brand vs functional:

| Semantic alias | Legacy token | Light hex | Dark hex | Tailwind | Use for |
|---|---|---|---|---|---|
| `--accent-primary` | `--accent` | `#d87948` | `#d88a52` | `bg-accent` | brand, primary CTA, focus ring, assistant avatar, active selection |
| `--accent-success` | `--accent-green` | `#2f9c4a` | `#5ebf67` | `bg-success` | approve action, completed states, additive diff lines |
| `--accent-danger` | `--accent-red` | `#c94d45` | `#d25a55` | `bg-danger` | deny / destructive actions, errors, removed diff lines |
| `--accent-info` | `--accent-blue` | `#397fd6` | `#4da2ff` | `bg-info` | informational chips, links, neutral status |
| `--accent-purple` | `--purple` | `#7b61d7` | `#a783ff` | — | tagging / categorisation only — never as a CTA |

Anti-pattern: do **not** mix `--accent-primary` with `--accent-blue` for
"links vs buttons". Links inside running prose are unstyled (inherit
`--text-default` with underline on hover); blue is reserved for
informational chips and external-resource indicators.

### Status — danger panel

For toast / banner / inline error blocks:

| Semantic alias | Legacy token | Light value | Dark value |
|---|---|---|---|
| `--state-danger-bg` | `--danger-bg` | `rgba(201, 77, 69, 0.10)` | `rgba(210, 90, 85, 0.12)` |
| `--state-danger-border` | `--danger-border` | `rgba(201, 77, 69, 0.24)` | `rgba(210, 90, 85, 0.24)` |
| `--state-danger-text` | `--danger-text` | `#9f3833` | `#f0c4c1` |

A success / info equivalent does not exist yet — when a need arises,
add `--state-success-*` / `--state-info-*` triplets following the same
shape (alpha bg, alpha border, solid text).

## Colours — derived (position-named) tokens

These predate the semantic layer. They still ship and keep working;
treat them as **derived**: each one logically inherits from a semantic
token, listed in the "Inherits from" column. Future cleanup should
collapse them into `var()` references — out of scope here.

| Token | Inherits from | Light hex | Dark hex |
|---|---|---|---|
| `--user-bubble-bg` | `surface-panel-raised` | `#f6f5f2` | `#1d1d1d` |
| `--user-bubble-text` | `text-default` | `#2a2926` | `#f5f1ea` |
| `--avatar-bg` | (one-off) | `#d8d1c7` | `#c9c0b4` |
| `--avatar-text` | `text-default` | `#29231c` | `#151515` |
| `--assistant-avatar-bg` | `accent-primary` | `#d87948` | `#d88a52` |
| `--assistant-avatar-text` | `text-on-accent` | `#2b160b` | `#241308` |
| `--system-avatar-bg` | `surface-panel-hover` | `#ecebe7` | `#202020` |
| `--tool-header-bg` | (one-off) | `#f2f1ed` | `#1c1c1c` |
| `--tool-header-hover` | (one-off) | `#ebe9e4` | `#232323` |
| `--pre-bg` | `surface-panel-raised` | `#f7f6f2` | `#101010` |
| `--branch-bg` | `surface-panel` | `#ffffff` | `#171717` |
| `--branch-icon-bg` | `surface-panel-hover` | `#f2f1ed` | `#222222` |
| `--mode-bg` | (one-off) | `#ededeb` | `#4a4a4a` |
| `--mode-text` | `text-default` | `#242424` | `#f0ede8` |
| `--control-bg` | (one-off) | `#f7f7f5` | `#151515` |
| `--control-active-bg` | `surface-panel-active` | `#e8e8e4` | `#4b4b4b` |
| `--control-active-text` | `text-default` | `#1f1f1e` | `#f8f3ee` |
| `--model-trigger-bg` | (one-off) | `#e2e0da` | `#303030` |
| `--model-trigger-hover` | `surface-panel-hover` | `#efede8` | `#3a3a3a` |
| `--model-menu-bg` | `surface-panel-raised` | `#fbfbfa` | `#171717` |
| `--model-menu-border` | `border-default` | `#deddda` | `#303030` |
| `--model-menu-text` | `text-default` | `#262626` | `#e7e2da` |
| `--model-menu-muted` | `text-muted` | `#858585` | `#9c978f` |
| `--model-menu-hover` | `surface-panel-hover` | `#eeeeec` | `#242424` |
| `--kbd-bg` | (one-off) | `#f1f1f1` | `#242424` |
| `--kbd-border` | `border-default` | `#dddddd` | `#3a3a3a` |
| `--scroll-thumb` | (one-off) | `#d0cdc7` | `#2d2d2d` |
| `--scroll-thumb-hover` | (one-off) | `#b8b3aa` | `#444444` |
| `--disabled-bg` | `surface-panel-hover` | `#ecebe7` | `#303030` |

## Typography

### Font families

| Token | Stack |
|---|---|
| `--font-sans` | Inter, "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif |
| `--font-mono` | "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace |

Inter is the brand sans for both Latin and CJK fall-throughs; PingFang
SC / Microsoft YaHei provide CJK rendering on macOS / Windows. We do
not webfont-load Inter today — relying on system installations is
intentional (Inter ships with macOS 13+ and is widely available on
Linux / Windows; fall-back to SF Pro / system-ui is fine).

### Type scale

| Token | Value | Used for |
|---|---|---|
| `--fs-11` | 11px | Footnote chips, kbd glyphs |
| `--fs-12` | 12px | Sidebar metadata, message timestamps |
| `--fs-13` | 13px | Dense controls, tool block status, list rows |
| `--fs-14` | 14px | Body text in chat / settings; the default |
| `--fs-15` | 14px | **⚠ KNOWN OFFENDER** — name says 15, value is 14. Used in some sidebar labels. |
| `--fs-16` | 15px | **⚠ KNOWN OFFENDER** — name says 16, value is 15. Used in chat composer. |
| `--fs-18` | 16px | **⚠ KNOWN OFFENDER** — name says 18, value is 16. Used in section headers. |
| `--fs-22` | 20px | **⚠ KNOWN OFFENDER** — name says 22, value is 20. Used as H1 / page title. |
| `--fs-menu` | 14px | Dropdown / context menu items |

> The `⚠ KNOWN OFFENDER` rows are tracked in
> [README.md#open-follow-ups](README.md#open-follow-ups). Don't fix
> them ad-hoc — a coordinated rename PR is the correct path.

### Weights

| Weight | Used for |
|---|---|
| 450 | body text (set on `body`) |
| 500 | section labels (default for `.section-label`) |
| 560 | `.section-label` heading variant |
| 660 | mode tabs, sidebar mode selector |
| 700 | `<strong>`, `<b>`, primary buttons |

### Line height

| Context | Value |
|---|---|
| Body text | 1.5 |
| Tight controls (mode tabs, badges) | 1 |
| Code blocks | 1.5 |

## Spacing

There is no `--space-*` token today; spacing is hard-coded in component
CSS. Auditing actual usage yields this scale:

| Step | px | Used for |
|---|---|---|
| 1 | 4 | icon-text gap, tight chip padding |
| 2 | 6 | nav-list inner gap, tab padding-x |
| 3 | 8 | default control padding-y, sidebar topbar padding-y |
| 4 | 10 | sidebar margin (10px outset from screen) |
| 5 | 12 | bubble inner gap, list-item padding |
| 6 | 14 | sidebar-topbar padding-x |
| 7 | 16 | sidebar-section padding-x, mode-row padding-x |
| 8 | 24 | section vertical rhythm |
| 9 | 32 | rail-card padding, dialog gutter |

**Rule.** New components: prefer multiples of 4. Use 6 / 10 / 14 only
when they preserve an existing rhythm.

## Radii

The `@theme` block now exposes the full ladder; all five are reachable
as Tailwind `rounded-{sm,md,lg,xl,pill}` utilities.

| Token | Value | Used for |
|---|---|---|
| `--radius-sm` | 6px | icon buttons (`.ghost-icon`), small chips |
| `--radius-md` (= `--radius`) | 8px | default control radius — most buttons, inputs, tool blocks |
| `--radius-lg` | 10px | container shells — sidebar, rail, large cards |
| `--radius-xl` | 12px | modals, quick switcher, settings cards |
| `--radius-pill` | 999px | status badges, tag chips |

Avatars use a separate `border-radius: 50%`. The "13px" / "7px" / "5px"
values that exist in some legacy CSS rules are tracked as drift and
should be normalised to the ladder above on next touch.

## Shadows

| Token | Light value | Dark value | Used for |
|---|---|---|---|
| `--shadow-soft` | `0 10px 24px rgba(27, 26, 24, 0.08)` | `0 10px 24px rgba(0, 0, 0, 0.24)` | hover-elevated cards, raised composer |
| `--shadow-popover` | `0 18px 42px rgba(27, 26, 24, 0.16)` | `0 18px 42px rgba(0, 0, 0, 0.28)` | dropdowns, modals, quick switcher |

These are not exposed as Tailwind utilities yet — use them via inline
`style={{ boxShadow: 'var(--shadow-soft)' }}` or in component CSS.

## Motion

There are no motion tokens today; durations are hard-coded in
component transitions. The standard:

| Class | Duration | Easing | Use for |
|---|---|---|---|
| Hover micro-states | 120ms | `ease` (default) | colour / background swaps on hover |
| Selection / panel changes | 200ms | `ease-out` | tab switches, panel reveals |
| Modal enter | 300ms | `ease-out` | dialog / quick switcher mount |
| Modal exit | 200ms | `ease-in` | dialog dismissal |

Every transition declaration MUST be neutralised under
`prefers-reduced-motion: reduce` — see
[accessibility.md](accessibility.md#prefers-reduced-motion).

Linear easing is forbidden (it feels mechanical for UI). For multi-step
choreography (composer expand → suggestions reveal), stagger by 60ms.

## Layout constants

| Token | Value | Meaning |
|---|---|---|
| `--sidebar-width` | 328px | left navigation column width |
| `--rail-width` | 540px | right approvals / workspace rail width |
| `--content-width` | 860px | max chat conversation width |
| `--composer-width` | 860px | max composer width (matches content) |

These collapse to `0px` on narrow viewports (`@media (max-width: …)`,
specific breakpoint defined in `styles.css`). The grid named
`grid-template-areas: "sidebar chat rail"` is the only correct way to
arrange the three panes — see [patterns.md](patterns.md#three-column-grid).

## Reconciliation

A token table without reconciliation drifts. To verify this document
matches the source:

```bash
# Every declared token in styles.css should appear here
grep -oE '\-\-[a-z][a-z0-9-]+:' apps/jarvis-web/src/styles.css \
  | tr -d ':' | sort -u

# Every Tailwind-exposed token should appear in @theme
awk '/^@theme \{/,/^\}/' apps/jarvis-web/src/styles.css \
  | grep -oE '\-\-(color|radius)-[a-z-]+'
```

Any difference between those outputs and the tables above is documentation
drift — fix the doc.
