# Jarvis Visual Design System

Jarvis is a Rust agent runtime with a developer-focused web client at
`apps/jarvis-web/`. This directory documents the visual language of that
client: the tokens, components, patterns, and accessibility rules that any
new UI work should adhere to.

## Positioning

Three references shape the look and feel:

- **Minimalism / Swiss style** — grid-based, generous negative space, sharp
  type hierarchy, almost no decorative shadow.
- **Dark mode (OLED) as a first-class citizen** — every token is defined
  symmetrically for both themes; we do not "design light first".
- **Developer Mono typography** — Inter for prose, SF Mono / JetBrains
  Mono for code, both in `var(--font-sans)` / `var(--font-mono)`.

The product personality on top of that baseline:

- **One brand colour: warm orange** — `#d87948` light / `#d88a52` dark.
  All other accents (green, red, blue, purple) are functional state
  signals, not brand colour expansion.
- **Dense IDE chrome** — three-column grid (sidebar / main / rail), 14px
  body text, 32–34px row heights. We mirror Cursor / Linear / Claude
  Code, not consumer chat.

We deliberately do **not** use: glassmorphism, neumorphism, gradients
above 2 stops, drop-shadow stacks, animated backgrounds, emoji as icons.

## Five decisions to remember

1. **Warm orange is the only brand colour.** Use `--accent` / the
   semantic alias `--accent-primary` for primary CTAs, focus rings,
   active selection, and the assistant avatar — and nothing else. Green
   means success, red means danger, blue means info, purple is reserved
   for tagging / categorisation. Don't introduce a sixth.
2. **Both themes are first-class.** Any new colour token MUST be
   defined in both `:root` and `:root[data-theme="dark"]`. PRs that
   add a hex literal in component CSS without going through a token are
   rejected.
3. **The type scale is closed.** Seven sizes (`--fs-11` through
   `--fs-22`) cover every existing surface. New requirements pick from
   the existing ladder; we don't add `--fs-17`.
4. **Four corner radii.** `--radius-sm` (6) for icon buttons,
   `--radius-md` (8, the default `--radius`) for controls, `--radius-lg`
   (10) for containers (sidebar, rail, cards), `--radius-xl` (12) for
   modals. Plus `--radius-pill` (999) for badges. Avatars use `50%`.
5. **Motion is calm.** 120ms for hover micro-states, 200ms for
   selection / panel changes, 300ms for modal enter; all `ease-out`
   entering, `ease-in` leaving. Wrap every transition in
   `@media (prefers-reduced-motion: reduce)` to nullify it.

## Files

| File | Answers |
|---|---|
| [tokens.md](tokens.md) | What colour / size / spacing / radius / shadow / motion values exist, what they're called, what they evaluate to in each theme |
| [components.md](components.md) | Visual contract for each shipped component (chat bubbles, tool blocks, sidebar items, cards, modals, composer) |
| [patterns.md](patterns.md) | Cross-cutting layout patterns (3-column grid, resize handles, empty states, markdown, diff viewer) |
| [accessibility.md](accessibility.md) | Contrast audit, focus ring standard, `prefers-reduced-motion`, keyboard contracts, icon-button labelling |

## Source of truth

The runtime tokens live in
[apps/jarvis-web/src/styles.css](../../apps/jarvis-web/src/styles.css)
(`:root` and `:root[data-theme="dark"]`). This documentation describes
that file — when they disagree, the file wins and the docs need
updating.

## Open follow-ups (not in scope here)

These were identified during the audit and intentionally left untouched
to keep this change visually inert:

- `--fs-15: 14px` / `--fs-16: 15px` / `--fs-18: 16px` — number labels
  don't match values. Either rename the tokens or consolidate to a
  proper 7-step ladder.
- Light-mode `--text-soft` (`#8d8a83`) on `--sidebar-bg` (`#fafafa`)
  measures ~3.0:1, below WCAG AA 4.5:1. See
  [accessibility.md](accessibility.md) for the full audit and
  recommended replacements.
- Position-named tokens (`--user-bubble-bg`, `--tool-header-bg`,
  `--branch-bg`, `--model-menu-*`, `--kbd-*`) should eventually
  inherit from semantic ones rather than carrying their own hex
  literals. Today they're documented as "derived" tokens in
  [tokens.md](tokens.md).

## Bilingual companion

Each file ships in English (`*.md`) and Chinese (`*.zh-CN.md`), with
identical heading anchors. Start: [README.zh-CN.md](README.zh-CN.md).
