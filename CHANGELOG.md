# Changelog

All notable product changes are tracked here.

## Unreleased

### Added

- Added a Claude Code-style composer context row in the web app. New sessions can now pick workspace and optional project context from chips above the input box instead of a blocking sidebar popover.
- Added workspace probing for arbitrary folders through `GET /v1/workspace/probe`, allowing the UI to show the selected workspace's git branch before or while it is bound to a session.
- Added workspace metadata to WebSocket `started` and `workspace_changed` frames so the client can keep workspace path, git branch, and dirty state in sync.
- Added an English-first `README.md` product overview.
- Added `README.zh-CN.md` as the Chinese translation of the README.
- Added this `CHANGELOG.md` file.

### Changed

- Changed the sidebar "New session" action to open a blank draft and focus the composer. Context is now applied lazily when the first message creates the persisted conversation.
- Changed project selection in the web app to behave as light new-session context, with `Free chat` as the default.
- Replaced the composer shoulder PR/diff row with a broader session context row for runtime, workspace, git branch, project, model, and permission-mode adjacency.
- Rebuilt the release web bundle and restarted the local server on `http://127.0.0.1:7001/` during development verification.

### Fixed

- Prevented a newly-created conversation from flashing an empty hint over a user message when the first send creates the session and immediately sends content.
- Cleared stale workspace diff state when the active socket workspace changes.

### Verified

- `npm run build` in `apps/jarvis-web`.
- `cargo check -p harness-server`.
- `cargo build --release -p jarvis`.
- Manual HTTP check for `http://127.0.0.1:7001/`.
