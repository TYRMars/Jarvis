# Docs block editor

Outline-style WYSIWYG block editor used by `/docs`. Built on Tiptap
(@tiptap/react 2.x) with markdown as the on-disk wire format so it
plugs into the existing `useAutosave` / draft-cache pipeline without
any backend change.

## Layout

```
Editor/
├── BlockEditor.tsx          — top-level mount; wires every extension
├── editor.css               — scoped styles (.block-editor-host / .block-editor-surface)
├── markdown/                — md ↔ ProseMirror JSON
│   ├── parse.ts             — fromMarkdown(md) → PmNode  (mdast walker)
│   ├── stringify.ts         — toMarkdown(pm)   → string  (mdast emitter)
│   ├── registry.ts          — runtime BlockHandler registry
│   ├── types.ts             — BlockHandler / PmNode / context types
│   └── index.ts             — public API
├── extensions/
│   ├── slashMenu/           — `/` candidate menu (floating-ui popover)
│   ├── callout/             — Callout node (4 variants; GFM admonition)
│   ├── toggle/              — Toggle node (<details>/<summary>)
│   └── imageUpload/         — image NodeView + ImageUploadAdapter
└── index.ts                 — barrel export (also imports editor.css)
```

Dependency direction: `BlockEditor` → `extensions/*` → `markdown/*`.
Extensions self-register their markdown handlers via a side effect
in their `index.ts`, so importing the barrel is enough.

## Wire format

The editor's input/output is **markdown** (via the serializer).
Tiptap's ProseMirror JSON is an internal detail; we re-derive it on
mount with `fromMarkdown` and emit a fresh markdown string from
`toMarkdown` on every transaction. Round-trip equivalence is
exercised by `__tests__/markdown-roundtrip.test.ts` (18 standard
fixtures), `callout.test.ts` (4 variants + nested) and
`toggle.test.ts` (open / closed / list body / non-toggle html).

## Adding a custom block

1. Create `extensions/<name>/<Name>.ts` — Tiptap `Node.create({...})`.
2. Add the React NodeView in `<Name>View.tsx`.
3. Implement a `BlockHandler` in `markdown.ts`. Register it from
   `index.ts` via `registerHandler(...)`.
4. (Optional) Export a `slash-menu` candidate factory; mount it via
   the `extraCandidates` prop or by appending to `BlockEditor.tsx`.

The `BlockHandler` contract:

```ts
{
  pmType: "<name>",                // PM node type owned on serialise
  mdastTypes: ["<mdast-type>"],    // mdast types claimed on parse
  parse(node, ctx): PmNode | null, // null = defer to fallback
  serialize(node, ctx): MdastBlock | MdastBlock[],
}
```

## Image upload

Drag/paste calls into `ImageUploadAdapter.upload(file)` and inserts
a placeholder image with `attrs.uploadingId = <uuid>`. On success
the adapter returns `{ url, width?, height? }` and we swap the
attrs in. On failure the error tile shows a Retry button which
re-issues the same `File` via `editor.commands.retryImageUpload(id)`.

The DocsPage wires up `createMockUploadAdapter()` for now —
ObjectURL-based, no backend. Replace with a real adapter once
`/docs` gets server-side image hosting.
