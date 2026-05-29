# `.jarvis/worktrees/` convention

Jarvis uses isolated per-task **git worktrees** so that parallel or automated
work (the auto-mode scheduler, subagents, automated issue fixers) never mutates
the main checkout. Each task gets its own working directory on its own branch,
checked out under `.jarvis/worktrees/`.

The root is configurable via `JARVIS_WORKTREE_ROOT` (default
`.jarvis/worktrees` under the workspace) and the mode via `JARVIS_WORKTREE_MODE`
(`off` / `per_run` / `per_unit`). Auto mode upgrades `off` → `per_run`
automatically so the scheduler always works on an isolated copy.

## Gitignored

The entire `.jarvis` directory is gitignored (see `.jarvis` in `.gitignore`), so
worktrees, scratch state, and other runtime artifacts never get committed.

## Branch naming

Automated fixers create branches named `fix/issue-<number>` (for example,
`fix/issue-43`) so the branch maps back to the issue it resolves.

## Listing and cleaning up

```bash
# List all worktrees and their branches
git worktree list

# Remove a finished worktree
git worktree remove .jarvis/worktrees/<name>

# Prune stale worktree metadata (e.g. after a directory was deleted manually)
git worktree prune
```

Stale worktrees are usually cleaned up automatically when a task finishes, but
the commands above let you inspect and remove them by hand.
