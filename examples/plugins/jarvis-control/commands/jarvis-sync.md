---
name: jarvis-sync
description: Pull the live Project list from the configured Jarvis server and regenerate per-project skills under `skills/projects/<slug>/`. Idempotent; pinned skills (`jarvis_autogen: false`) are preserved.
allowed-tools: Bash, Read
---

Use the `jarvis-project-sync` skill to run the sync script and
summarise its output.

Steps:

1. Confirm the server is reachable (`jarvis_health` from
   `scripts/jarvis_api.sh`). If not, surface the error and stop.
2. Run `bash examples/plugins/jarvis-control/scripts/sync_projects.sh`.
3. Read the resulting `skills/projects/` tree and tell the user
   how many skills were written / pinned / removed.
4. Suggest reloading the plugin's skill catalog if Claude Code
   doesn't pick up the new skills automatically.

If the user passed `--dry-run`, forward it to the script verbatim
and skip step 3 (no files were written).
