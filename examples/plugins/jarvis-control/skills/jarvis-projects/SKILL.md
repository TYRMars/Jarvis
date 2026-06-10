---
name: jarvis-projects
description: Read-only inspection of a running Jarvis server's Projects, Requirements, Runs, and Activities. Use when the user asks "what projects exist", "what's on the board", "what's in triage", "what's the status of <thing>", or wants to inspect a specific Requirement / Run before acting. Pair with `jarvis-runs` for any write operation.
activation: both
keywords: [jarvis, project, requirement, kanban, triage, run, activity, board, status, list]
version: "0.1.0"
---

# Read Jarvis Projects

This skill gives you a read-only view of a running Jarvis server.
For write actions (start runs, approve/reject, dispatch reviewer)
hand off to the `jarvis-runs` skill instead — the split is
deliberate so you can confirm an `id` before mutating anything.

## Server discovery

The skill talks to `$JARVIS_BASE_URL` (default `http://localhost:7001`).
If the user hasn't said otherwise, assume the default. If
`$JARVIS_TOKEN` is set, include it as a bearer token. Both are read
automatically by the helper in `scripts/jarvis_api.sh`.

First call on a fresh session — confirm the server is reachable:

```bash
source examples/plugins/jarvis-control/scripts/jarvis_api.sh
jarvis_health    # prints workspace info, fails if not reachable
```

If `jarvis_health` returns 503, the binary is up but no
`ProjectStore` is configured (the user needs `JARVIS_DB_URL` — see
[CLAUDE.md](../../../../CLAUDE.md)). Tell the user, don't keep
retrying.

## Tour of the read-only surface

| Question                                      | Route                                                                |
|-----------------------------------------------|----------------------------------------------------------------------|
| Which projects exist?                         | `GET /v1/projects`                                                   |
| Detail of one project (by id **or** slug)     | `GET /v1/projects/:id_or_slug`                                       |
| Workspace folders + VCS state for a project   | `GET /v1/projects/:id_or_slug/workspaces/status`                     |
| Project's persistent memory                   | `GET /v1/projects/:id_or_slug/memory`                                |
| Recent runs across the whole project          | `GET /v1/projects/:id_or_slug/runs`                                  |
| Approved requirements (the kanban board)      | `GET /v1/projects/:id/requirements?triage_state=approved`            |
| Triage queue (proposed by agent + by scan)    | `GET /v1/projects/:id/requirements?triage_state=proposed`            |
| One Requirement's run history                 | `GET /v1/requirements/:id/runs`                                      |
| One Requirement's audit timeline              | `GET /v1/requirements/:id/activities`                                |
| One Run's detail / final manifest             | `GET /v1/runs/:id`                                                   |
| Pinned workspace root + git state             | `GET /v1/workspace`                                                  |

`:id` accepts a UUID; `:id_or_slug` accepts either form. Some routes
(`/v1/requirements?project_id=...`) require the UUID — resolve a slug
with `jarvis_resolve_project <slug>` from `scripts/jarvis_api.sh` if
the user gave you a slug only.

## Reading the board

The board is a kanban projection over Requirements. Columns are
`backlog` / `in_progress` / `review` / `done` by default, but a
project may have customised columns — read `project.columns` from
`/v1/projects/:id_or_slug` before assuming the four defaults.

A Requirement also carries a **`triage_state`**:

- `approved` — eligible for the auto-loop (if it also has an
  assignee + dependencies clear).
- `proposed_by_agent` — the agent suggested it via
  `requirement.create`; needs a human to `/approve`.
- `proposed_by_scan` — surfaced from `TODO|FIXME` comments by
  `triage.scan_candidates`; same human gate.

When the user asks "what's on the board" they almost always mean
`triage_state=approved`. When they ask "what's pending" they mean
`triage_state=proposed`.

## Reading project memory

`GET /v1/projects/:id_or_slug/memory` returns the bundle of memory
files attached to the project. Each file has `name`, `body`, and
timestamps. The body is markdown — render it inline; don't summarise
unless asked.

## Activity timeline

Every meaningful event on a Requirement (status flip, run start /
end, comment, approve / reject) writes a row to its activity
timeline. `GET /v1/requirements/:id/activities` returns them
newest-first. Useful kinds to recognise:

- `approved` / `rejected` — triage decisions.
- `run_started` / `run_completed` / `run_failed` — agent loop boundaries.
- `reviewer_dispatched_manually` — operator hit `POST /review`.
- `blocked` — the agent surfaced a structured blocker via
  `requirement.block`.

## When to switch skills

If the user follows up with "now start it" / "approve" / "reject" /
"verify" — switch to the **`jarvis-runs`** skill. If the user
mentions a specific project by name and you'll be doing several
operations against it in a row, suggest running
`/jarvis-sync` (the `jarvis-project-sync` skill) so a dedicated
`jarvis-project-<slug>` skill is available with the id pre-baked.
