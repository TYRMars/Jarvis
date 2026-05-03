# `components/ui/` — Basic component library

The few components in this folder replace browser-native primitives
(`window.confirm` / `<select>` / ad-hoc `<div role="dialog">`) with a
small, typed, styled set the rest of the app can lean on.

**Design tenets**

1. **One canonical entry per primitive.** No more page-local
   `settings-btn`, `modal-btn-primary`, `projects-new-btn` zoo —
   `<Button variant="...">` is the answer. Same for `<Modal>`,
   `<Select>`, `<TextField>`, etc.
2. **API hugs the platform.** Props mirror their HTML element where
   possible (`onChange`, `placeholder`, `disabled`, `aria-*`, …) and
   `forwardRef` lets callers attach refs. The component is a typed,
   styled wrapper — not a redesign.
3. **Visuals reuse existing tokens.** The CSS rules live in
   `apps/jarvis-web/src/styles.css` keyed on `.ui-*` classes that hook
   into `--input-bg`, `--accent`, `--text-soft`, etc. Dark mode and
   theme overrides keep working with zero churn.
4. **Imperative escape hatches when promise semantics map cleanly.**
   `confirm()` is the obvious case: a Promise-based imperative API
   that any module (services, store actions, event handlers) can call.
5. **Zero new dependencies.** Built on React + the existing CSS
   tokens. We're not adding a Radix / shadcn / chakra layer — the
   surface area is small enough to own outright.

---

## Inventory

| Component | Replaces | Status |
|---|---|---|
| `<Modal>` | hand-rolled `<div role="dialog">` overlays | shipped |
| `<ConfirmDialogHost>` + `confirm()` | `window.confirm()` | shipped, 11/11 callsites migrated |
| `<Select>` | `<select>` + `<option>` | shipped |
| `<Button>` | `settings-btn`, `projects-new-btn`, `modal-btn-primary`, … | shipped |
| `<TextField>` | bare `<input type="text">` | shipped |
| `<Textarea>` | bare `<textarea>` | shipped |
| `<Checkbox>` | bare `<input type="checkbox">` | shipped |

Roadmap (not yet built):

| Component | Replaces | Why later |
|---|---|---|
| `<Tooltip>` | `title="..."` | 12 callsites; medium urgency |
| `<Disclosure>` (Collapsible) | `<details>/<summary>` | 1 callsite |
| `<Toast>` | (none yet) | Banner exists; toast is additive |
| `<Menu>` (dropdown menu) | (none yet) | Add when first row-action context menu lands |
| `<Popover>` | `WorkspaceBadge` ad-hoc popover | Tooltip first, then factor out |

---

## Usage

### `<Modal>`

Generic modal shell with portal + scrim + ESC + initial focus. The
existing `.docs-modal-overlay` / `.docs-modal-dialog` CSS does the
visual work; the React component owns the lifecycle.

```tsx
import { Modal } from "@/components/ui";

function MyDialog({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Edit columns">
      <p>...</p>
      <footer className="ui-modal-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save}>Save</Button>
      </footer>
    </Modal>
  );
}
```

Props worth knowing:

- `open` — render gate. `false` means nothing in the DOM (no hidden
  modal hanging around).
- `onClose` — fires on backdrop click + ESC. Pass `undefined` for
  non-dismissable modals (rare).
- `busy` — set to true while a save is in flight to suppress ESC and
  backdrop dismissal so the user can't bail mid-request.
- `dialogClassName` — extra class for sizing overrides
  (`column-editor-dialog` declares `width: min(720px, 92vw)`).
- `role` — `"dialog"` (default) or `"alertdialog"` for irreversible
  prompts.

### `confirm()` — promise-based confirm dialog

Drop-in replacement for `window.confirm()` that **must be awaited**.

```ts
import { confirm } from "@/components/ui";

const ok = await confirm({
  title: t("deleteConfirm", row.id.slice(0, 8)),
  detail: "It will be gone forever.",  // optional
  danger: true,
  confirmLabel: t("uiConfirmDeleteOk"),
  cancelLabel: t("docsCreateCancel"),  // optional
});
if (!ok) return;
```

Call from anywhere — service modules, event handlers, store actions.
Multiple calls queue FIFO. The host (`<ConfirmDialogHost />`) is
mounted once in `App.tsx`; do not mount it again.

When migrating an existing `if (!confirm(...))` callsite:

1. Make the surrounding function `async` (or wrap the body in an
   `async () => {...}` IIFE for tight inline handlers).
2. `confirm(msg)` → `await confirm({ title: msg })`.
3. Add `danger: true` if it's a destructive action.
4. If it was `confirm(...)` inside an event handler that React passes
   directly as `onClick`, swap the handler to `async`.

Test mocking pattern (see `ModeBadge.test.tsx` for the canonical
example):

```ts
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("../ui", () => ({ confirm: (opts: any) => confirmMock(opts) }));
beforeEach(() => {
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});
// Per-test override of the next call:
confirmMock.mockResolvedValueOnce(false);
```

### `<Select>`

Custom dropdown with optional inline search, `aria-activedescendant`
keyboard nav, and group headings.

```tsx
import { Select } from "@/components/ui";

<Select<"low" | "medium" | "high">
  value={effort}
  onChange={setEffort}
  ariaLabel="Effort"
  searchable={false}
  options={[
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ]}
/>
```

For long lists (Providers, Models) set `searchable`. Group headings
come from the `group` field on each option — consecutive options with
the same group share one heading row.

Keyboard:
- `Enter` / `Space` / `↓` on the trigger opens.
- `↑` / `↓` / `Home` / `End` move the active row.
- `Enter` picks. `Escape` closes.
- Type-ahead works through the search input when `searchable`.

### `<Button>`

Typed `<button>` with variant + size. The default `<button>` props
all work via prop pass-through.

```tsx
<Button onClick={save}>Save</Button>                            // default
<Button variant="primary" onClick={save}>Save</Button>          // filled accent
<Button variant="danger" onClick={archive}>Archive</Button>     // destructive
<Button variant="ghost" size="sm" aria-label="Edit">…</Button>  // dense, icon-ish

// Render as <a> when the control should look like a button but navigate.
<Button as="a" href="https://...">Docs</Button>
```

For a manual `<button>` that wants the same classes (e.g.
`<ConfirmDialogHost>` rolls its own footer for queue control),
import `buttonClassName({...})`.

### `<TextField>` / `<Textarea>`

Wraps `<input>` / `<textarea>` with label / hint / error chrome.

```tsx
<TextField
  label="Slug"
  value={slug}
  onChange={(e) => setSlug(e.target.value)}
  placeholder="my-project"
  hint={error}
  error={!!error}
  prefix={<SearchGlyph />}     // optional
/>

<Textarea
  label="Description"
  rows={4}
  autoGrow                     // grows up to maxRows (default 10)
  value={desc}
  onChange={(e) => setDesc(e.target.value)}
/>
```

Don't pass a label and *also* a separate `<label>` — the wrapper
renders one for you and ties it to the input via a generated id.

### `<Checkbox>`

```tsx
<Checkbox
  checked={remember}
  onChange={(e) => setRemember(e.target.checked)}
  label="Remember this decision"
  hint="Add to project rules"
  indeterminate={someChildrenChecked}   // tri-state
/>
```

`indeterminate` is a DOM-only property; we toggle it imperatively on
the underlying `<input>`. The visual box shows a `−` glyph in that
state regardless of `checked`.

---

## Adding a new component

1. **Confirm it's actually missing.** Most surfaces already work with
   the existing primitives + a class tweak. Don't add `<Stack>` /
   `<Card>` etc unless 5+ callsites would benefit.
2. **Match the existing API shape.** Forward refs, spread the
   underlying element's props, accept `className` for caller-side
   sizing, expose typed enums for variants.
3. **CSS lives in `styles.css`** under a `/* ===== <name> ===== */`
   block, classnames prefixed `ui-<name>-*`. Reuse tokens
   (`--input-bg`, `--accent`, etc); don't hard-code colours.
4. **Export from `index.ts`** — both the component and its types.
5. **Document here.** Add a row to the inventory table + a usage
   block matching the existing tone.
6. **Prefer additive migration.** New components don't have to
   replace every old callsite at landing; replace as you touch the
   files for other reasons.

---

## Migration progress

| From | To | Done | Remaining |
|---|---|---|---|
| `confirm()` (browser) | `confirm()` (ours) | 11 | 0 ✅ |
| `<select>` | `<Select>` | 10 | 6 (`AskTextCard`, `ApprovalCard`, `DocsPage` × 3, `RequirementDetail` ghost-fallback already covered) |
| Hand-rolled modal `<div role="dialog">` | `<Modal>` | 2 (`ColumnEditor`, `ConfirmDeleteDialog`) | `CreatePrDialog`, `CommitDialog`, `WorkspaceBadge` popover (different pattern), `RequirementDetail` (side panel — keep as-is) |
| `settings-btn` etc. | `<Button>` | 4 (in `ColumnEditor`, `ConfirmDeleteDialog`) | ~80 callsites (low urgency — visual is identical) |
| Bare `<input>` | `<TextField>` | 0 | ~66 callsites |
| Bare `<textarea>` | `<Textarea>` | 0 | 13 callsites |
| Bare `<input type="checkbox">` | `<Checkbox>` | 0 | 4 callsites |
| `title="..."` | `<Tooltip>` | — (not built) | 12 callsites |

Migration is meant to be incremental — touch a file for an unrelated
reason, swap its native primitives for the wrapper while you're
there. Don't open a 50-file PR just to swap classnames.
