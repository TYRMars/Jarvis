---
name: jarvis-runs
description: Operate a Jarvis server — start fresh Requirement runs, approve/reject triage candidates, dispatch the reviewer subagent, and patch run verification state. Use when the user asks to "start", "run", "approve", "reject", "kick off", "verify", or "dispatch reviewer" on a Jarvis Requirement. Pair with `jarvis-projects` to look up ids before mutating.
activation: both
keywords: [jarvis, run, start, approve, reject, review, verify, dispatch, requirement, triage]
version: "0.1.0"
---

# Operate Jarvis Runs

Write-side companion to `jarvis-projects`. Every action here mutates
server state (starts an agent loop, flips a Requirement's
`triage_state`, writes to the activity timeline) so the discipline
is: **resolve the id first, echo what you're about to do, then
fire**.

## Always look before you mutate

Before any of these calls, do at least one of:

1. `GET /v1/requirements/:id` (or filter the project's
   `/v1/projects/:id/requirements` list) and read back the title,
   `status`, `triage_state`, `acceptance_policy`.
2. Show the row to the user. Say what you're about to do. Wait for a
   "yes" if the action is non-trivial.

A "non-trivial" action here means anything that costs LLM tokens
(start a run, dispatch the reviewer) or any triage decision
(`approve`, `reject`). Listing / re-reading state is free — don't
ask for permission to read.

## Verb table

| User intent                                        | Endpoint                                                  | Body                                                |
|----------------------------------------------------|-----------------------------------------------------------|-----------------------------------------------------|
| Start a fresh run for one Requirement              | `POST /v1/requirements/:id/runs`                          | none required; optional `{ "reason": "..." }`       |
| Approve a triage row                               | `POST /v1/requirements/:id/approve`                       | none                                                |
| Reject a triage row (reason required)              | `POST /v1/requirements/:id/reject`                        | `{ "reason": "must be non-blank" }`                 |
| Ask the reviewer subagent to verify a Review row   | `POST /v1/requirements/:id/review`                        | none                                                |
| Patch a Run (e.g. mark verification pass / fail)   | `PATCH /v1/runs/:id`                                      | partial Run fields                                  |
| Set a Run's structured verification result         | `POST  /v1/runs/:id/verification`                         | verification plan / verdict                         |
| Trigger the built-in verification plan for a Run   | `POST  /v1/runs/:id/verify`                               | none                                                |

Use the helpers in `scripts/jarvis_api.sh`:

```bash
source examples/plugins/jarvis-control/scripts/jarvis_api.sh
jarvis_post "/v1/requirements/$REQ_ID/runs"
jarvis_post "/v1/requirements/$REQ_ID/approve"
jarvis_post "/v1/requirements/$REQ_ID/reject" '{"reason":"out of scope for this milestone"}'
jarvis_post "/v1/requirements/$REQ_ID/review"
```

## "Start the next one" recipe

When the user says "start the next one" on a project:

1. `GET /v1/projects/<slug>/requirements?triage_state=approved`.
2. Sort: status `backlog` first (ready to start), then
   `in_progress`, then `review`. Prefer rows where `assignee_id`
   is set and `depends_on` is either empty or all deps are
   `done` — the auto-loop's own pickup rule.
3. If multiple rows tie, show them and ask which one.
4. `POST /v1/requirements/<id>/runs`. The response carries
   `{run, conversation_id, manifest_summary, requirement}`. Pass
   the new `run.id` back to the user so they can follow it.

A run is **not** automatically kicked into the agent loop — that
happens either when the auto-loop's tick picks it up (if
`automation.auto_mode_enabled` is true and policy allows), or when
a human drops the first user message into the new conversation.
Tell the user which mode applies.

## Reviewer auto-accept gotcha

`POST /v1/requirements/:id/review` only works when the row's
`acceptance_policy == "subagent"` AND the row is at `status:
"review"`. The server returns **409** in any other state. If the
user wants a Human-policy row verified by the subagent, they need
to flip the policy first (PATCH on the requirement) — say that
rather than retrying.

Also: when the server has `JARVIS_REVIEWER_AUTO_ACCEPT=1` set, the
auto-loop dispatches the reviewer on its own once a Completed run
hits Review. Mention that to the user when they ask "why didn't I
have to dispatch the reviewer?" — it's not magic.

## Rejecting

Reason is mandatory and must be non-blank — the server enforces
this. Be specific: "out of scope for milestone X" is better than
"no". The reason is written to the project's audit timeline and is
visible after the soft-delete.

## What this skill will NOT do

- Approve / reject without the user's explicit go-ahead. Those are
  human-judgement gates and the rejection in particular is
  effectively destructive (soft-deletes the row).
- Hard-delete a Requirement. The Jarvis web UI exposes that; this
  skill deliberately doesn't.
- Edit a Project's instructions or workspaces — that's a separate
  workflow that should go through the web UI's confirmation
  dialogs.
