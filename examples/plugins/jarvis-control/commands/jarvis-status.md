---
name: jarvis-status
description: One-shot overview of the configured Jarvis server — workspace info, project count, requirements-in-flight count, recent activity. Read-only.
allowed-tools: Bash, Read
---

Use the `jarvis-projects` skill to produce a compact status
summary. No mutations.

Steps:

1. `jarvis_get /v1/workspace` — print the pinned workspace root,
   VCS state, current branch.
2. `jarvis_get /v1/projects` — show project count (non-archived);
   list slug + name + tag for each.
3. For each project, fetch
   `/v1/projects/<slug>/requirements?triage_state=approved` and
   bucket by `status` (backlog / in_progress / review / done). Print
   the counts.
4. `jarvis_get /v1/chat/runs?limit=5` if available — show the 5
   most recent runs (id, status, started_at).

Render as a single compact block. Do not call any write endpoints.
