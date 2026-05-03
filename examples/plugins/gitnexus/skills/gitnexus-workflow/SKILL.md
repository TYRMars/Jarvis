---
name: gitnexus-workflow
description: How to use the GitNexus knowledge-graph tools (`gitnexus.*`) effectively — index first, then prefer graph queries over multi-step grep walks for call-chain / dependency / blast-radius questions.
activation: both
keywords: [gitnexus, knowledge graph, call chain, dependency, blast radius, impact, refactor, code intelligence]
version: "0.1.0"
---

You have the `gitnexus.*` tool family available, backed by a local
GitNexus MCP server. GitNexus indexes the repository into a graph
(symbols, calls, imports, type relations, communities) and answers
structural questions in one call instead of a chain of greps.

## Step 1 — make sure the repo is indexed

GitNexus stores its index in `.gitnexus/` at the repo root. Before
the first `gitnexus.*` call on a workspace:

- Use `fs.list` (or `gitnexus.query` and read the error) to check
  whether `.gitnexus/` exists.
- If it does **not** exist, the repo has never been indexed. Tell
  the user, and — when `shell.exec` is enabled — offer to run
  `gitnexus analyze` (one-shot, ~30s–few minutes depending on repo
  size). Wait for approval; do not run it silently.
- After a large refactor or branch switch, suggest re-running
  `gitnexus analyze` so the graph isn't stale. GitNexus's
  incremental mode skips unchanged files, so the re-index is fast.

## Step 2 — pick the right tool

Reach for the highest-level tool that answers the question. Drop to
lower-level tools only if it doesn't.

- `gitnexus.context` — 360° view of one symbol (definition,
  callers, callees, related types). Best for "what is X" /
  "who uses X" questions.
- `gitnexus.impact` — blast-radius analysis. **Run this before any
  non-trivial edit** to a function / type / module: it returns the
  affected surface with confidence scores, so you can warn the user
  if the change reaches farther than they expect.
- `gitnexus.query` — hybrid BM25 + semantic + RRF search across the
  whole graph. Good for "find code that does X" when you don't know
  the symbol name yet.
- `gitnexus.detect_changes` — given a git diff, returns the
  processes / call chains touched. Pairs well with `git.diff`
  before opening a PR.
- `gitnexus.rename` — coordinated multi-file rename. Prefer this
  over `fs.edit` loops when renaming a public symbol.
- `gitnexus.cypher` — raw graph query. Use only when the
  higher-level tools genuinely don't fit; it's powerful but easy to
  write wrong.

## Step 3 — prefer graph over grep

When the question is structural — "what calls this", "what does
this call", "which files import X", "where does this symbol cross
a module boundary" — `gitnexus.context` / `query` is dramatically
faster and more accurate than a series of `code.grep` walks. Use
`code.grep` only for textual / non-structural matches (TODO
comments, log strings, config keys).

## After editing

If you mutated source files, mention to the user that the
GitNexus index is now stale for those files. The next
`gitnexus.*` call may still be accurate (incremental mode catches
most changes) but recommending an explicit `gitnexus analyze` is
the safe answer for anything beyond a one-line tweak.
