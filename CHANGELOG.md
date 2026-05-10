# Changelog

All notable product changes are tracked here.

## Unreleased

_No changes yet._

## 0.2.0 - 2026-05-10

First minor release after the harness-core / workspace split. Aggregates
the work that landed across PRs #28 (OTel + model registry), #29 (model
routing + session-switch race), #30 (channel adapters + sidebar +
auto-mode refactor), and #31 (Makefile + docs CI alignment), plus the
web composer / workspace-probe work that introduced this `CHANGELOG.md`.

### Added

- Added a Claude Code-style composer context row in the web app. New sessions can now pick workspace and optional project context from chips above the input box instead of a blocking sidebar popover.
- Added workspace probing for arbitrary folders through `GET /v1/workspace/probe`, allowing the UI to show the selected workspace's git branch before or while it is bound to a session.
- Added workspace metadata to WebSocket `started` and `workspace_changed` frames so the client can keep workspace path, git branch, and dirty state in sync.
- Added the channels subsystem: `ChannelBinding` / `ChannelInstance` core types, JSON-file channel store, `/v1/channels` REST routes, a WeCom WebSocket gateway adapter, and a Channels section in web Settings. Lays groundwork for Feishu / DingTalk / Slack adapters per `docs/proposals/channel-plugins.md`.
- Added a Codex-style chat sidebar with project groups in `ConvoList` and a denser `ConvoRow` carrying run / unread state.
- Added subagent batch dispatch (`subagents/batch`), an internal subagent module, and richer tool-adapter plumbing in `harness-subagents`.
- Added an OTel observability stack: `infra/otel/collector.yaml` + `infra/otel/docker-compose.yml`, `docs/observability/local-stack.md`, server `observability_routes`, and `HarnessObservabilityPanel` / `HealthCenter` / `KpiStrip` UI surfaces.
- Added a model registry with capability-validating provider profiles, a routing-policy engine, fallback events with a UI banner, a model Market panel, and a Routing section in Settings.
- Added `harness-tools` extensions: `harness_health` tool, expanded `doc.rs`, and a default doc skill bundled with `harness-skill`.
- Added `jarvis-cli` `telemetry` and `web` subcommands.
- Added a `Customize` page and an extension-builder default skill.
- Added the `WorkOverview` agent runtime strip and a rewritten `RequirementDetail` page.
- Added an English-first `README.md` product overview and a `README.zh-CN.md` translation.
- Added this `CHANGELOG.md` file.

### Changed

- Changed the sidebar "New session" action to open a blank draft and focus the composer. Context is now applied lazily when the first message creates the persisted conversation.
- Changed project selection in the web app to behave as light new-session context, with `Free chat` as the default.
- Replaced the composer shoulder PR/diff row with a broader session context row for runtime, workspace, git branch, project, model, and permission-mode adjacency.
- Refactored `auto_mode.rs` (~700 LOC trimmed); `JARVIS_WORK_RUN_TIMEOUT_MS` default raised from 5 minutes to 10 minutes; `auto_mode_routes` expanded for richer status surfaces.
- Replaced the Lottie mascot in `AgentLoadingFooter` with three breathing dots — quieter feedback during silent moments.
- Rewrote `McpSection` / `PluginsSection` / `SkillsSection` / `RoutingSection` in web Settings.
- Aligned local cargo commands in `Makefile`, `CLAUDE.md`, and `AGENTS.md` with Linux CI by threading `--exclude jarvis-desktop` through `lint` / `test` / `check`. Override with `WORKSPACE_EXCLUDE=` on a machine with the GTK toolchain installed.

### Fixed

- Fixed the session-switch race that surfaced as `conversation <uuid> not found` in the web UI: the backend now persists newly-`New`'d conversations immediately, normalises Resume load errors to a not-found signal, and the frontend reorders `setActiveId` to close the race window. Scoped streaming frames no longer toggle `activeId`. Locked in by 4 new vitest cases against the not-found cleanup + scoped-frame invariant.
- Prevented a newly-created conversation from flashing an empty hint over a user message when the first send creates the session and immediately sends content.
- Cleared stale workspace diff state when the active socket workspace changes.

### Verified

- `cargo check --workspace --exclude jarvis-desktop`.
- `cargo clippy --workspace --all-targets --exclude jarvis-desktop -- -D warnings`.
- `cargo test -p harness-server` (268/268 at PR #28-#29 merge time).
- `npm test` and `npm run build` in `apps/jarvis-web` (310/310 vitest).
