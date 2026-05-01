# Components

Each section below is a **visual contract** for one shipped component
or family. The structure is fixed:

- **Purpose** — one sentence, what it is for.
- **Container** — outer geometry (padding / radius / border / bg).
- **Typography** — size, weight, family.
- **States** — `default`, `hover`, `focus`, `active`, `selected`,
  `disabled`, `error` — only the ones that apply.
- **Don't** — anti-patterns specific to this component.

When a contract conflicts with the live code, the contract is the
target — open an issue and align the code, not the doc.

---

## Sidebar — `.nav-item`

**Purpose.** Top-level navigation row in the sidebar
(`Chat`, `Projects`, `Docs`, `Settings`).

| Property | Value |
|---|---|
| height | 32px |
| padding | 0 |
| gap (icon → label) | 12px |
| border-radius | 6px (`--radius-sm`) |
| font-size | `--fs-14` |
| font-weight | 450 |
| icon | 18px stroke SVG, `currentColor` |

**States.**

| State | Background | Text |
|---|---|---|
| default | transparent | `--text-muted` |
| hover | transparent | `--text-default` |
| active (current route) | `--surface-panel-active` | `--text-default` |

**Don't.** Don't add a left-border accent stripe to mark "active" —
the project's selection signal is background fill, not chrome.

---

## Sidebar — `.mode-tab`

**Purpose.** The 3-up tab row right under the sidebar topbar (Chat /
Work / Doc).

| Property | Value |
|---|---|
| height | 34px |
| padding-x | 8px |
| gap (icon → label) | 6px |
| border-radius | `--radius` (8px) |
| font-size | `--fs-14` |
| font-weight | **660** |

**States.**

| State | Background | Text |
|---|---|---|
| default | transparent | `--text-soft` |
| hover | `--surface-panel-hover` | `--text-default` |
| active | `--mode-bg` | `--mode-text` |

The 660 weight is unusual but intentional — mode tabs are a primary
navigation control and read more authoritative than a regular nav-item.

---

## Sidebar — `.ghost-icon`

**Purpose.** Square icon-only buttons used in topbars (collapse, new
chat, search trigger).

| Property | Value |
|---|---|
| size | 28×28 |
| border-radius | 6px |
| icon | 16–18px, stroke 1.5–2 |
| color | `--text-soft` |

**States.**

| State | Background | Color |
|---|---|---|
| default | transparent | `--text-soft` |
| hover | `--surface-panel-hover` | `--text-default` |
| active (toggle on) | `--surface-panel-active` | `--text-default` |
| disabled | transparent | `--text-disabled` |

**Don't.** Every `.ghost-icon` MUST have an `aria-label` — it has no
text. See [accessibility.md](accessibility.md#icon-only-buttons).

---

## Chat — `UserBubble`

**Purpose.** A user-typed message in the chat pane.

| Property | Value |
|---|---|
| max-width | (matches `--content-width`, 860px) |
| padding | 12px 16px |
| border-radius | 12px (`--radius-xl`) |
| background | `--user-bubble-bg` (alias `--surface-panel-raised`) |
| color | `--user-bubble-text` (alias `--text-default`) |
| font-size | `--fs-14` |
| line-height | 1.5 |
| avatar | 28×28, `--avatar-bg` / `--avatar-text`, "U" glyph |

**States.**

| State | Treatment |
|---|---|
| default | as above |
| hover | edit-pencil and rerun affordances fade in (opacity 0 → 1, 120ms) |
| editing | bubble morphs into a textarea on `--surface-input` with `--border-input-focus`, send button uses `--accent-primary` |

**Don't.** Don't right-align user bubbles. Jarvis is a working surface,
not a messaging app — alignment is left for both roles.

---

## Chat — `AssistantBubble`

**Purpose.** Agent response in the chat pane. Includes optional
thinking disclosure, markdown body, and collapsed tool-call summary.

| Property | Value |
|---|---|
| max-width | 860px |
| padding | 0 (transparent — content sits directly on the chat surface) |
| background | none |
| color | `--text-default` |
| font-size | `--fs-14` |
| line-height | 1.5 |
| avatar | 28×28, `--assistant-avatar-bg` / `--assistant-avatar-text`, "J" glyph |

The assistant bubble has **no container chrome** — visual separation
from the user bubble comes from the avatar colour (orange) and the
absence of a card. This is the deliberate "Claude / Cursor" pattern.

**Sub-components.**

- `ThinkingDisclosure` — collapsed: 13px italic text "Thought for Ns",
  `--text-muted`, with a chevron. Expanded: same tone, indented 16px,
  monospace.
- `ToolStepRow` — single-line summary of all tool calls in this turn.
  Click to expand into full ToolBlocks.
- Copy button — hover-only, 14px ghost-icon, top-right of the bubble.

**Don't.** Don't introduce streaming-skeleton placeholders (grey blocks
that morph into text) — the existing token-by-token render is the
streaming UX. A skeleton on top adds visual noise without information.

---

## Chat — `ToolBlock`

**Purpose.** Renders a single tool call (`fs.read`, `shell.exec`,
`code.grep`, etc.) inline in the chat. Collapsible.

| Property | Value |
|---|---|
| width | full bleed of bubble (max 860px) |
| border | 1px solid `--border-default` |
| border-radius | 8px (`--radius-md`) |
| background | `--surface-tool` |
| header padding | 8px 12px |
| header background | `--tool-header-bg` |
| header hover | `--tool-header-hover` |
| body padding | 12px |
| body font | `--font-mono`, `--fs-13`, line-height 1.5 |

**Status badge** (right side of header):

| Status | Background | Text |
|---|---|---|
| running | `rgba(57, 127, 214, 0.10)` (info bg) | `--accent-info` |
| ok | `rgba(47, 156, 74, 0.10)` (success bg) | `--accent-success` |
| error | `--state-danger-bg` | `--state-danger-text` |
| denied | `--surface-panel-active` | `--text-muted` |

**States.**

- **Default** — collapsed, 1-line summary visible (tool name + arg
  preview).
- **Open** — auto-expanded on `error` or `denied`. User can manually
  expand any block.
- **Approval-pending** (gated tools) — yellow-tinted left border (4px,
  `--accent-primary`) until decision arrives.

**Don't.** Don't auto-collapse a block once the user has manually
expanded it, even if status changes.

---

## Chat — `ToolStepRow`

**Purpose.** One-line summary of all tool calls in a turn. Lives at
the top of the assistant bubble; clicking expands to full ToolBlocks.

| Property | Value |
|---|---|
| height | 28px |
| padding | 0 12px |
| border-radius | 6px |
| background | `--surface-panel-raised` |
| font-size | `--fs-13` |
| color | `--text-muted` |
| icon | spinner (running) or check (done), 14px |

**States.** `running` shows the spinner; `done` shows the count
(`5 tool calls`); `error` shows the badge from any failed step.

---

## Composer

**Purpose.** Multi-line input at the bottom of the chat pane with
model picker, send button, and slash-command suggestions.

**Container.**

| Property | Value |
|---|---|
| max-width | `--composer-width` (860px) |
| padding | 12px |
| border | 1px solid `--border-input` |
| border-radius | 12px |
| background | `--surface-input` |
| focus border | `--border-input-focus` |
| shadow (focused) | `--shadow-soft` |

**Textarea.**

| Property | Value |
|---|---|
| font-size | `--fs-15` (= 14px, see [tokens.md](tokens.md#type-scale)) |
| line-height | 1.5 |
| min-height | 44px |
| max-height | 50vh |
| placeholder | `--text-placeholder` |

**Send button.** 36×36, `--radius` (8px), `--accent-primary`
background, `--text-on-accent` color. Disabled when input is empty —
`--surface-panel-active` background, `--text-disabled` color, no
hover.

**Model picker** (top-left of composer or in chat header). Trigger:
`--model-trigger-bg`, hover `--model-trigger-hover`, 8px radius,
`--fs-13`. Menu uses `--shadow-popover` and `--surface-panel-raised`.

---

## Approvals rail card

**Purpose.** A queued tool call awaiting human approve/deny in the
right rail.

| Property | Value |
|---|---|
| padding | 16px |
| gap | 12px |
| border | 1px solid `--border-default` |
| border-radius | 10px (`--radius-lg`) |
| background | `--surface-panel` |

**Header.** Tool name (mono, `--fs-13`, `--text-default`) + status
chip (`pending` uses `--accent-info`).

**Body.** JSON args in a `<pre>` block — `--font-mono`, `--fs-13`,
`--surface-panel-raised`, padding 8px, max-height 200px with scroll.

**Actions.** Two buttons, equal width:

| Button | Background | Color | Border |
|---|---|---|---|
| Approve | `--accent-success` | white | none |
| Deny | transparent | `--accent-danger` | 1px `--accent-danger` |

Approve is filled (commit), Deny is outline (caution). Don't reverse
the polarity — the visual weight communicates which is the irreversible
choice.

---

## Project — `RequirementCard`

**Purpose.** A single requirement on the kanban / list views.

| Property | Value |
|---|---|
| padding | 12px |
| gap (between rows) | 8px |
| border | 1px solid `--border-default` |
| border-radius | 8px |
| background | `--surface-panel` |
| hover | `--surface-panel-hover` |
| font-size | `--fs-14` |
| title weight | 560 |

**Status chip** (top-right):

| Status | Background | Text |
|---|---|---|
| backlog | `--surface-panel-hover` | `--text-muted` |
| in-progress | `rgba(57, 127, 214, 0.10)` | `--accent-info` |
| review | `rgba(123, 97, 215, 0.10)` | `--accent-purple` |
| done | `rgba(47, 156, 74, 0.10)` | `--accent-success` |
| cancelled | `--state-danger-bg` | `--state-danger-text` |

Chip geometry: 18px height, padding 0 8px, `--radius-pill`, `--fs-11`,
weight 560, all-caps.

**Drag-handle.** Visible only on hover (opacity 0 → 1, 120ms). Cursor
becomes `grab`, on drag `grabbing`.

---

## Workspace badge (chat header)

**Purpose.** Shows the active workspace folder + git state. Click to
open the recent-folders dropdown.

| Property | Value |
|---|---|
| height | 28px |
| padding | 0 10px |
| gap | 8px |
| border | 1px solid `--border-default` |
| border-radius | 6px |
| background | `--branch-bg` |
| font-size | `--fs-13` |

**Inner glyphs** (left to right): folder icon (14px, `--text-muted`),
folder name (`--text-default`, weight 560), branch icon (12px) +
branch name when git is available, dirty marker (`•` in
`--accent-info`) when uncommitted.

**Hover.** Background `--surface-panel-hover`. **Open dropdown.**
`--shadow-popover`, `--surface-panel-raised`.

---

## Quick switcher

**Purpose.** Cmd+P unified search modal.

| Property | Value |
|---|---|
| width | 600px |
| max-height | 480px |
| padding | 0 |
| border | 1px solid `--border-default` |
| border-radius | 12px (`--radius-xl`) |
| background | `--surface-panel` |
| shadow | `--shadow-popover` |

**Search input.** 48px tall, `--fs-15`, padded 0 16px, no internal
border (the modal frame is the only border).

**Result row.** 36px tall, padding 0 16px, gap 12px between icon and
label. Selected row uses `--surface-panel-active` background — never
`--accent-primary`. The accent is reserved for action commit, not
selection.

**Footer.** 36px tall, `--surface-panel-raised`, kbd hints
(`↑ ↓ to navigate`, `↵ to select`, `esc to close`) in `--text-soft`,
`--fs-12`.

---

## Settings tab nav

**Purpose.** Vertical tab strip on the settings page (Appearance,
Providers, Permissions, Skills, MCP, …).

| Property | Value |
|---|---|
| width | 220px |
| item height | 32px |
| item padding | 0 12px |
| item radius | 6px |
| font-size | `--fs-14` |

**States.**

| State | Background | Text |
|---|---|---|
| default | transparent | `--text-muted` |
| hover | `--surface-panel-hover` | `--text-default` |
| active | `--surface-panel-active` | `--text-default` |

The active tab gets a 2px left bar in `--accent-primary` (this is the
ONE place a left-bar accent is correct — settings tabs read like a
navigation index, not a list selection).

---

## Modal / Dialog

**Purpose.** Centered overlay for confirmations, settings dialogs,
commit messages.

| Property | Value |
|---|---|
| width | min(560px, 90vw) |
| max-height | 80vh |
| padding | 24px |
| border-radius | 12px (`--radius-xl`) |
| background | `--surface-panel` |
| border | 1px solid `--border-default` |
| shadow | `--shadow-popover` |
| backdrop | `rgba(0, 0, 0, 0.4)` |

**Title.** `--fs-18` (= 16px), weight 700, `--text-default`.

**Body.** `--fs-14`, line-height 1.5, `--text-default`. Spacing
between groups: 16px.

**Action footer.** Right-aligned, gap 8px between buttons. Primary
action on the right (most-recent convention).

---

## Toast / Status banner

> **Status: not yet implemented.** When introducing one, follow this
> spec.

**Container.**

| Property | Value |
|---|---|
| width | 360px |
| padding | 12px 16px |
| border | 1px solid (semantic) |
| border-radius | 8px |
| shadow | `--shadow-soft` |
| position | fixed bottom-right, 24px from each edge |

**Variants.**

| Variant | Background | Border | Text |
|---|---|---|---|
| info | `--surface-panel-raised` | `--border-default` | `--text-default` |
| success | `rgba(47, 156, 74, 0.10)` | `rgba(47, 156, 74, 0.24)` | `--accent-success` |
| danger | `--state-danger-bg` | `--state-danger-border` | `--state-danger-text` |

**Auto-dismiss.** Info / success: 4s. Danger: never auto-dismiss
(user must close).

---

## Component anti-patterns (project-wide)

These are not specific to one component — they apply everywhere.

- **No emoji as icons.** Use SVGs (the project ships its own inline
  SVG components; do not pull in an icon library mid-component).
- **No box-shadows on every card.** Reserve shadows for elevated
  / detached surfaces (composer, modal, dropdown). Cards inside the
  chat / projects pane are flat by design.
- **No gradient text or background gradients above 2 stops.**
- **No hover scale transforms.** They cause layout shift in dense
  lists. Use background / colour transitions instead.
- **No left-border accent stripe** to mark selection (except settings
  tab, called out above).
- **No icon-only button without `aria-label`.**
- **No transition without an `ease-out` / `ease-in` easing.** Linear
  motion feels mechanical.
