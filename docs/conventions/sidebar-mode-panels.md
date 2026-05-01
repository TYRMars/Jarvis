# Sidebar-mode page layout conventions

This is the **system-internal layout standard** for top-level pages
under `apps/jarvis-web` (Chat / Projects / Docs / Settings, plus any
new mode added later). Every page should follow these rules so the
app reads as one chrome with mode-specific work surfaces, not as a
stack of bespoke 4-column experiments.

Reference implementations:

- **`AppSidebar.tsx` → `DocSidebarBody`** — scope-rail mode. Renders
  the `+ New doc` button + scope-nav rows (All / Pinned / Kind ×5 /
  Tags / Archive) with live counts. Drives the docs page through a
  shared scope module + a `jarvis:new-doc` CustomEvent.
- **`AppSidebar.tsx` → `WorkSidebarBody`** — list-of-things mode.
  Renders `+ New project` + the project list. Drives the projects
  page through `jarvis:new-project` / `jarvis:open-project`.
- **`AppSidebar.tsx` → `ChatSidebarBody`** — entity-list mode.
  `NewConvoButton` + `ConvoList`.

`DocSidebarBody` is the richest pattern because it owns *navigation
state* (active scope) on top of an action button. Copy its structure
when a new page needs both.

---

## 0. The single rule

> **The AppSidebar is the only navigation chrome.** A page must not
> paint its own scope rail, kind picker, "+ New" button, or
> filter-tab strip when those would visually duplicate the sidebar
> for that mode.

A page rendering its own rail next to the AppSidebar means the user
sees *four* columns where *three* would suffice — and two of them
look the same. If you find yourself building a left rail inside a
page component, move it into the matching `*SidebarBody` instead.

The grid for any mode page is therefore:

```
┌─────────────────┬───────────────────────────────────────┐
│  AppSidebar     │  Page work surface                    │
│  (mode rail)    │  (list, editor, board, …)             │
└─────────────────┴───────────────────────────────────────┘
```

Or, when a page has its own list + detail split:

```
┌─────────────────┬─────────────────┬─────────────────────┐
│  AppSidebar     │  List           │  Detail / Editor    │
└─────────────────┴─────────────────┴─────────────────────┘
```

Three columns total. **Never four.**

---

## 1. Mode resolution

`AppSidebar.tsx` uses `useLocation().pathname` and `modeForPath()` to
pick which `*SidebarBody` to mount:

```ts
function modeForPath(pathname: string): "chat" | "work" | "doc" {
  if (pathname.startsWith("/docs")) return "doc";
  if (pathname.startsWith("/projects")) return "work";
  return "chat";
}

function ModeSidebarBody({ mode }) {
  if (mode === "work") return <WorkSidebarBody />;
  if (mode === "doc") return <DocSidebarBody />;
  return <ChatSidebarBody />;
}
```

When you add a new top-level mode:

1. Add the route in `App.tsx`.
2. Add the tab to `mode-row` (icon + `NavLink to="…"`).
3. Extend `modeForPath()`.
4. Add a new `*SidebarBody` component with the contents below.

Don't add hidden routes that drop the mode-row context — every
top-level page should be reachable from the mode tabs.

---

## 2. `*SidebarBody` anatomy

Each mode body is composed of, in order:

| Slot | Class | Content |
|---|---|---|
| Primary action | `.nav-list > .nav-item` | Single `+ New X` button. At most one. |
| Scope rows | `.sidebar-section.mode-sidebar-section` | Click-to-filter rows: `.docs-scope-row` (active scope) **or** `.mode-sidebar-row` (entity links). |
| Group label | `.section-label` | Optional ALL-CAPS heading above a group. |
| Empty state | `.mode-sidebar-empty` | One-line muted text shown when a section has no rows. |

Compose multiple `.sidebar-section` blocks for distinct groups (e.g.
docs has *Pinned* / *Kind* / *Tags* / *Archive* as four separate
sections). Each section gets its own `.section-label` if non-empty.

**Never** stuff a horizontal toolbar, search input, or sort dropdown
into the AppSidebar. Those belong in the page header — see §4.

---

## 3. Cross-component state

Sidebar bodies and page components both need to read **and** write
the active scope (e.g. clicking a kind in the sidebar must filter
the page; creating a doc on the page may snap the sidebar to that
kind).

Use a **module-local singleton** with `useSyncExternalStore`. Don't
put transient UI state into `appStore.ts` (zustand) — that store is
for chat / approvals / panes state and shouldn't grow per-mode
slices.

Reference: [`services/docScope.ts`](../../apps/jarvis-web/src/services/docScope.ts).

```ts
let scope: DocScope = { type: "all" };
const subs = new Set<() => void>();

export function getDocScope(): DocScope { return scope; }
export function setDocScope(next: DocScope): void {
  if (sameScope(scope, next)) return;
  scope = next;
  for (const s of subs) s();
}
export function subscribeDocScope(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
export function useDocScope(): DocScope {
  return useSyncExternalStore(subscribeDocScope, getDocScope, getDocScope);
}
```

Both `DocSidebarBody` and `DocsPage` import `useDocScope()` /
`setDocScope()` and stay in sync without prop drilling.

---

## 4. Action plumbing — sidebar → page

For one-shot actions (e.g. "open a Create form"), don't cross
components through state. Use a `window` CustomEvent. Established
event names:

| Event | Source | Listener |
|---|---|---|
| `jarvis:new-doc` | sidebar `+ New page` | `DocsPage` opens the create form |
| `jarvis:new-project` | sidebar `+ New project` | `ProjectsPage` opens create panel |
| `jarvis:open-project` | sidebar project list row | `ProjectsPage` selects + scrolls |

Pattern:

```ts
// Sidebar
const onClick = () => {
  void navigate("/docs");
  window.setTimeout(() => {
    window.dispatchEvent(new Event("jarvis:new-doc"));
  }, 0);
};

// Page
useEffect(() => {
  const onNew = () => setCreating(true);
  window.addEventListener("jarvis:new-doc", onNew);
  return () => window.removeEventListener("jarvis:new-doc", onNew);
}, []);
```

The 0-tick `setTimeout` is load-bearing: it lets `navigate()` finish
mounting the target page before the event fires, otherwise the
listener doesn't exist yet.

Use CustomEvents for **side-effecting verbs** ("create", "open",
"focus"). Use shared state (§3) for **persistent selections**
("which scope is active", "which project is selected").

---

## 5. Page header lives in the page

Search box, sort dropdown, view-mode toggle, breadcrumb — all of
these belong in the page itself, not in the AppSidebar. The sidebar
already used 220–280px; pushing toolbar widgets into it just makes
the rail wide and the page narrow.

`DocsListColumn` (`DocsPage.tsx`) is the reference: list column
header carries the page title (`"All docs"` / `"Pinned"` / etc.,
derived from active scope) + search input + sort `<select>`. The
editor column has its own header for title / save-state /
metadata.

---

## 6. CSS scoping

Sidebar rows reuse the existing `.sidebar-section` / `.nav-list` /
`.nav-item` chrome. New row variants get a mode-prefixed class so
they don't bleed across modes:

| Class | Used in |
|---|---|
| `.docs-scope-row` | doc mode (filterable scope rows) |
| `.mode-sidebar-row` | work mode (project list entries) |

Both must consume the token vocabulary from
[`rail-panels.md`](rail-panels.md) — `--text`, `--panel-active`,
`--accent`, etc. **Never** hard-code colours or font sizes; light
and dark themes both pivot on those tokens and any literal will
break one of them.

Active state convention:

```css
.docs-scope-row.is-active {
  background: var(--panel-active);
  border-color: var(--border);
  font-weight: 600;
}
```

`is-active` is the agreed selector — match it for any new variant
so theme + state styles compose.

---

## 7. Responsive collapse

Below `768px` the page work surface goes single-column (list and
editor stack). The sidebar follows the existing
`.sidebar-closed` / `.workspace-rail-closed` toggle convention from
chat mode — don't invent a new collapse mechanism per page.

If a sidebar mode has many sections (docs has up to ~20 rows
between kinds + tags + archive), make the body scrollable inside
the existing `aside#sidebar` — don't fight the chrome.

---

## 8. Anti-patterns

These have been tried and rejected:

- **A second left rail inside the page**, next to the AppSidebar.
  Visual duplication, wastes a column. → Move into `*SidebarBody`.
- **Putting scope state in `appStore.ts`**. Bloats the global
  store with per-mode UI state, couples unrelated subscribers. →
  Module-local singleton (§3).
- **Passing scope down through multiple component layers as
  props**. Defeats the point of having a global sidebar. → Shared
  hook (§3).
- **Using zustand subscribe just to fan out CustomEvent-shaped
  side effects** (e.g. "open create form"). → Plain CustomEvent
  (§4).
- **Hard-coding "+ New" in both the sidebar and the page**. Two
  buttons that do the same thing, divergent labels over time. →
  One button, in the sidebar.
- **Empty placeholder nav links** ("LLM Wiki", "Pages", "No wiki
  pages yet") shipped as if they were real features. → Either
  build the feature or delete the link.

---

## 9. Checklist for a new mode

Before merging a new top-level page:

- [ ] Route added in `App.tsx`.
- [ ] Mode tab added to `mode-row` (icon + `NavLink`).
- [ ] `modeForPath()` updated.
- [ ] New `*SidebarBody` component matches §2 anatomy.
- [ ] Shared state module under `services/` if the page has
      cross-component selections (§3).
- [ ] Action verbs use `jarvis:<mode>-<verb>` CustomEvent (§4).
- [ ] No second left rail rendered inside the page (§0, §8).
- [ ] All colours / sizes via tokens (`rail-panels.md` §1).
- [ ] Light and dark themes both pass 4.5:1 text contrast (small
      text) and 3:1 for icons.
- [ ] At least 1024 / 768 / 375px viewport breakpoints visually
      sane (§7).
