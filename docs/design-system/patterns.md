# Patterns

Cross-cutting layout and interaction patterns. Each pattern shows up
in multiple components — codifying it here is what makes new screens
feel consistent without re-deriving the rules.

## Three-column grid

The app shell is a CSS Grid with three named areas:

```css
#app {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--rail-width);
  grid-template-areas: "sidebar chat rail";
  height: 100vh;
}
```

Live in [styles.css:217–253](../../apps/jarvis-web/src/styles.css).

**Why named areas.** Without them, hiding the sidebar (`display: none`)
shuffles the remaining children leftward through the auto-placement
algorithm — chat ends up in the (zero-width) sidebar slot. Naming
each grid area pins it to a column even when a sibling is hidden.

**Modifiers.**

| Class on `body` | Effect |
|---|---|
| `.workspace-rail-closed` | rail column shrinks to `0` (chat expands) |
| `.sidebar-closed` | sidebar column shrinks to `0` (chat expands left) |

| Class on `#app` | Effect |
|---|---|
| `.page-app` | drops the rail entirely (used by Settings, Docs) |

**Composition rules.**

- The sidebar is **always** mounted unless the route is in the
  page-app set; closing it animates width to 0, doesn't unmount.
- The rail is **per-route** — Chat opens it by default, Projects
  hides it, Settings drops it (`.page-app`).
- Width changes use `transition: grid-template-columns 200ms ease-out`
  on `#app`; the resize handle drag bypasses the transition for
  responsive feel.

## Resize handles

Both the sidebar (right edge) and the approvals rail (left edge) are
resizable by dragging.

**Geometry.**

| Property | Value |
|---|---|
| width | 4px |
| hit-area width | 12px (achieved via negative `margin-left` / `padding`) |
| cursor | `col-resize` |
| background | transparent |
| hover background | `--accent-primary` at `0.4` alpha |
| active (dragging) background | `--accent-primary` at `0.6` alpha |
| transition | `background 120ms ease` |

**Drag bounds.**

| Pane | min | max | persisted as |
|---|---|---|---|
| Sidebar | 240px | 500px | `--sidebar-width` (also localStorage) |
| Rail | 320px | 800px | `--rail-width` (also localStorage) |

**Reset.** Double-click the handle to reset to the default (328 / 540).

## Empty states

When a list / board / search has no content, render an **empty state
card**, not a bare "No items" string.

**Shape.**

| Property | Value |
|---|---|
| centring | absolutely centered in the parent (flex column, justify-center, align-center) |
| max-width | 360px |
| gap | 12px between elements |

**Order (top to bottom).**

1. Optional 32×32 monochrome SVG icon, `--text-soft`.
2. Title — `--fs-15`, weight 560, `--text-default`. One line.
3. Hint — `--fs-13`, `--text-muted`, line-height 1.5. One sentence.
4. Optional CTA — primary button, `--accent-primary`. Use only when
   there's a single obvious next action (e.g., "New conversation").

**Don't.** Don't show illustrations. Don't say "Oops!" / "Looks like
…". Don't show empty state for a 200ms loading flash — wait at least
500ms before flipping from skeleton to empty.

## Loading states

Three patterns, in order of preference:

1. **In-place spinner** — for actions that complete in &lt; 2s
   (sending a message, saving settings). Replace the button label
   with a 14px spinner; preserve button width to avoid layout shift.
2. **Skeleton row** — for lists that may take longer. Use
   `--surface-panel-raised` background with a shimmer animation
   (forbidden under `prefers-reduced-motion`).
3. **Inline progress text** — for streaming agent output. The
   existing token-by-token render is the pattern; do not stack a
   spinner on top.

Every loading state must reserve the eventual content's space — see
[accessibility.md](accessibility.md#content-jumping).

## Markdown rendering

The chat and requirement detail views render markdown via
`@ant-design/x-markdown` (chat) and a custom `MarkdownLite` (project
descriptions).

**Block-level rules.**

| Element | Treatment |
|---|---|
| `h1` | `--fs-22` (= 20px), weight 700, top margin 24px, bottom 12px |
| `h2` | `--fs-18` (= 16px), weight 660, top 20px, bottom 8px |
| `h3` | `--fs-16` (= 15px), weight 660, top 16px, bottom 4px |
| `p` | `--fs-14`, line-height 1.6, margin 0 0 12px |
| `ul` / `ol` | indent 24px, item gap 4px |
| `blockquote` | left border 3px `--border-default`, padding-left 12px, color `--text-muted` |
| `code` (inline) | `--font-mono`, `--fs-13`, padding 1px 6px, background `--surface-panel-raised`, radius 4px |
| `pre` | `--font-mono`, `--fs-13`, padding 12px, background `--pre-bg`, radius 8px, line-height 1.5, scrollable when overflowing |
| `a` | `--text-default`, underline on hover; visited unstyled |
| `hr` | 1px `--border-soft`, margin 24px 0 |
| `table` | thin `--border-default`, header background `--surface-panel-raised` |

**Don't.** Don't render image tags inline at full width — clamp to
360px max and let users click to expand. Don't auto-link bare URLs in
prose; only `<URL>` and `[label](URL)` forms are styled as links.

## Diff viewer

Used by `FsEditDiff`, `UnifiedDiffViewer`, and the workspace commit
dialog.

**Container.** Same shape as `ToolBlock` body — `--font-mono`,
`--fs-13`, line-height 1.5.

**Line classes.**

| Class | Background | Marker |
|---|---|---|
| addition | `rgba(47, 156, 74, 0.10)` | `+` in `--accent-success`, mono |
| deletion | `rgba(201, 77, 69, 0.10)` | `-` in `--accent-danger`, mono |
| context | none | none |
| hunk header | `--surface-panel-raised` | `@@ … @@` in `--text-muted` |

**Word-level highlight** (when computed): nested span with
`rgba(47, 156, 74, 0.20)` / `rgba(201, 77, 69, 0.20)`. Don't go
darker — line-level + word-level layered hits ~30% alpha which still
respects reading.

**Don't.** Don't show byte-level diffs (`a` → `b` character flicker).
Don't render >5000 lines inline — virtualise or paginate.

## Keyboard contracts

Project-wide bindings. Document any new ones here.

| Key | Action | Scope |
|---|---|---|
| `⌘K` | open quick switcher | global |
| `⌘P` | model picker | when chat pane focused |
| `⌘\` | toggle sidebar | global |
| `⌘.` | toggle rail | global |
| `Esc` | close modal / quick switcher / context menu | overlays |
| `Tab` / `Shift+Tab` | move focus through interactive elements | global |
| `↑` / `↓` | navigate list items in quick switcher / model picker | overlays |
| `Enter` | activate focused item / send composer | context-sensitive |
| `Shift+Enter` | newline in composer | composer only |
| `⌘↵` | send composer (alt to Enter) | composer only |
| `⌘E` | edit last user message | chat |
| `⌘R` | rerun last assistant turn | chat |

**Rule.** Every overlay (modal, popover, quick switcher) MUST close on
`Esc`. Every list MUST be arrow-navigable when keyboard-focused.

## Persistence patterns

When a UI affordance has state that should survive reload (sidebar
width, theme, last route, sidebar/rail visibility), persist via
`localStorage` with the prefix `jarvis.`:

| Key | Value | Used by |
|---|---|---|
| `jarvis.theme` | `"light"` \| `"dark"` \| `"system"` | theme switcher |
| `jarvis.sidebar.width` | px integer | sidebar resize handle |
| `jarvis.rail.width` | px integer | rail resize handle |
| `jarvis.sidebar.closed` | `"1"` \| absent | sidebar toggle |
| `jarvis.rail.closed` | `"1"` \| absent | rail toggle |

`zustand` with the persist middleware handles most app-level state
(see `apps/jarvis-web/src/store/`); reach for raw `localStorage` only
for layout / preference state that doesn't need React reactivity.

## Theme switching

Themes flip via the `data-theme` attribute on the `<html>` element.
The runtime ladder:

1. Component reads `localStorage.getItem('jarvis.theme')`. If absent,
   resolves to "system".
2. "system" → consults `prefers-color-scheme` and listens for changes.
3. Applies `<html data-theme="dark">` or removes the attribute.
4. CSS variables in `:root[data-theme="dark"]` cascade in.

**Rule.** Never gate behaviour on the theme value at the JS layer
("if dark, show X"). Theme is a presentation concern; logic is the
same for both. If a feature literally needs different content per
theme (rare — only for full-art surfaces), use a single `<picture>` or
CSS `prefers-color-scheme` media query.

## Density

Jarvis is dense by design. Maintain it:

- 14px body text (not 16).
- 32–34px row height for list items / nav (not 40+).
- 12px gutter between cards (not 16+).
- No "padding 24px" inside a list row.

If a screen feels too cramped, fix the typography hierarchy (size /
weight contrast), not the spacing — adding gutter dilutes the
working-surface feel.

## Responsive breakpoints

Today: not heavily responsive. The web client targets desktop
(≥1024px). Below that, the layout collapses ungracefully — known
limitation, tracked separately.

For new screens that genuinely need to work on tablet:

| Breakpoint | Behaviour |
|---|---|
| ≥1280px | full three-column with both rails |
| 1024–1279px | hide rail by default, sidebar at 280px |
| 768–1023px | sidebar overlay (push-out drawer), rail closed |
| <768px | mobile sentinel — link to "open in desktop" |

Don't ship anything mobile-specific without UX review.
