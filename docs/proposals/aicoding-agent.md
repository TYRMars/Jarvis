# AI coding-agent workflow

**Status:** Proposed
**Touches:** `harness-tools`, `harness-core` event surface,
`harness-server` WS/SSE transport, `apps/jarvis-web`, docs.

## Motivation

Jarvis already has the hard primitives for a coding assistant:
streaming agent loop, providers, file tools, regex search,
`shell.exec`, approvals, memory, persistence, and a web client.
The next useful increment is not "more chat". It is a coherent
coding-agent workflow closer to Codex / Claude Code:

- understand the current workspace before editing;
- inspect Git state and diffs without opening arbitrary shell access;
- keep an explicit plan visible while working;
- apply small, reviewable edits;
- run focused checks and stream command output;
- ask for approval only when mutation or command execution matters;
- summarise what changed at the end.

This proposal turns the existing primitives into an opinionated
AI-coding layer while preserving the core design rule:
`harness-core` owns the loop and traits, not Git, HTTP, storage, or UI
policy.

## Goals

1. **Workspace awareness by default.** The model can cheaply discover
   files, repo status, project instructions, and relevant symbols.
2. **Safer coding tools than shell-first.** Read-only Git and code
   inspection tools are registered by default; mutation stays gated.
3. **Planful execution.** Transports can show "what the agent is
   doing" as first-class events rather than inferring it from prose.
4. **Tight edit-test-review loop.** The agent can modify files, run
   targeted checks, inspect diff, and report a concise change summary.
5. **User-control moments match coding tools.** Approvals are attached
   to risky calls (`fs.edit`, `fs.write`, `shell.exec`) and rendered
   with enough context to decide quickly.

Non-goals:

- Replacing `shell.exec` with a full terminal emulator.
- Building a complete IDE.
- Introducing a second agent loop just for coding.
- Making autonomous commits / pushes by default.

## UX target

In the web UI or future CLI:

```
User: fix the failing message serialization test

Jarvis
  plan
    ✓ inspect repo status
    ✓ find the failing test path
    • patch serializer handling
    • run targeted cargo test
    • show diff summary

  tool: git.status
    ## codex/intelligent
     M crates/harness-core/src/message.rs

  tool: code.grep
    crates/harness-core/src/message.rs:...

  approval: allow fs.edit on crates/harness-core/src/message.rs?
    [Approve] [Deny]

  tool: shell.exec
    cargo test -p harness-core message::

  summary
    Changed tool-call argument serialization to preserve object args.
    Verified with cargo test -p harness-core message::.
```

The agent should feel like it is working inside the repo, not merely
answering about a repo.

## Capability set

### 1. Workspace context pack

Add a read-only `workspace.context` tool that returns a compact JSON
summary:

```json
{
  "root": "/repo",
  "vcs": "git",
  "branch": "codex/intelligent",
  "instructions": ["AGENTS.md", "CLAUDE.md"],
  "manifest": ["Cargo.toml", "apps/jarvis-web/package.json"],
  "dirty": true
}
```

Implementation:

- `harness-tools/src/workspace.rs`
- uses existing `resolve_under` logic for path scoping;
- reads at most a small allowlist of well-known instruction /
  manifest filenames;
- does not recursively read source files.

Why: this gives the LLM a cheap first move and lets the UI display
"workspace loaded" without spending a shell call.

### 2. Read-only Git tools

Add fixed-argv Git wrappers, registered by default:

| Tool | Shape | Notes |
|---|---|---|
| `git.status` | `git --no-pager -C <root> status --short --branch [-- path]` | Includes untracked by default. |
| `git.diff` | `git --no-pager -C <root> diff [--cached] [--stat] [-- path]` | Output capped; supports context lines. |
| `git.show` | `git --no-pager -C <root> show --stat --summary <rev>` | Optional later; no arbitrary rev shelling. |

No shell, no writes, no approval. Path arguments stay relative under
`JARVIS_FS_ROOT`; output is truncated. These tools let the agent
behave like Codex before and after edits: always inspect status, do
not overwrite user changes blindly, show final diff.

### 3. Structured plan events

Add an optional planning event surface to `harness-core`:

```rust
pub enum AgentEvent {
    ...
    PlanUpdate { items: Vec<PlanItem> },
}

pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanStatus, // pending | in_progress | completed
}
```

The simplest implementation is a tool:

```text
plan.update({ items: [...] })
```

`plan.update` does not call the OS. It records the latest plan in the
agent stream and returns `"ok"` to the model. This keeps the agent loop
generic while giving transports a stable UI primitive.

Why a tool instead of parsing assistant prose:

- providers already understand tool calls;
- the UI gets a typed event;
- models can revise the plan during execution;
- no provider-specific reasoning parsing is needed.

### 4. Patch-oriented editing

Current `fs.edit` is a good minimal primitive, but coding agents need
multi-hunk edits without rewriting whole files. Add one gated tool:

| Tool | Purpose |
|---|---|
| `fs.patch` | Apply a unified diff under the workspace root. |

Rules:

- `requires_approval() = true`;
- reject absolute paths and `..`;
- reject patches that touch paths outside root;
- reject binary patches;
- fail if hunks do not apply cleanly;
- return per-file summary and line counts;
- do not auto-stage.

This preserves the "small reviewable changes" behavior that makes
Codex-style workflows usable. `fs.write` remains available for new
files but should be less prominent in prompts and docs.

### 5. Check runner profile

Keep `shell.exec` as the execution primitive, but add better guidance
and UI metadata for common check commands:

- command is shown before approval;
- cwd and timeout are visible;
- stdout / stderr stream live using existing `ToolProgress`;
- final tool result includes exit code and truncated buffers.

Later, add a read-only `project.checks` tool that suggests likely
commands from manifests:

| Manifest | Suggested checks |
|---|---|
| `Cargo.toml` | `cargo check --workspace`, `cargo test --workspace`, clippy gate |
| `package.json` | `npm test`, `npm run lint`, `npm run build` |
| `pyproject.toml` | `pytest`, `ruff check`, `mypy` when configured |

This tool only suggests; it does not execute.

### 6. Final change report

At turn completion, the agent should produce a compact coding report:

- files changed;
- tests/checks run;
- checks not run and why;
- remaining risks.

Do not enforce this in `harness-core`. Instead:

- update the default system prompt in `apps/jarvis`;
- expose `git.status` / `git.diff` so the model can inspect facts;
- have the UI render final assistant text normally.

## Prompt contract

Update the default coding system prompt used by `apps/jarvis` when
file-edit or shell tools are enabled:

```text
You are Jarvis, a coding agent working in the user's repository.
Before editing, inspect workspace context and git status. Do not
overwrite user changes you did not make. Prefer code.grep, fs.read,
git.status, and git.diff before shell.exec. Use fs.patch or fs.edit
for small reviewable edits. Run focused checks when practical. End
with changed files, checks run, and residual risk.
```

The exact prompt lives in `apps/jarvis`; library crates stay prompt
agnostic.

## Architecture

```
apps/jarvis
  builds ToolRegistry
  registers coding tools by default
  chooses coding system prompt when edit/shell tools are enabled

harness-tools
  workspace.context
  git.status / git.diff
  fs.patch
  project.checks

harness-core
  existing Tool trait
  optional PlanUpdate AgentEvent if plan.update lands as first-class

harness-server
  serialises new AgentEvent variants unchanged
  WS approval path remains the mutation gate

apps/jarvis-web
  renders plan card from PlanUpdate
  renders Git/diff/check tool cards compactly
```

The key point: Git, patches, and project detection stay in
`harness-tools`; transports only render events; the core loop remains
tool-agnostic.

## Implementation cuts

1. **Read-only context and Git tools.**
   Add `workspace.context`, `git.status`, `git.diff`; register them
   by default. Tests cover non-Git directories, dirty worktrees,
   path scoping, and output truncation.

2. **Coding prompt.**
   Replace the generic system prompt in `apps/jarvis` with a
   coding-aware prompt when `JARVIS_FS_ROOT` points at a repo or when
   edit/shell tools are enabled. Keep a concise fallback for pure chat.

3. **Plan tool and UI render.**
   Add `plan.update`; map it to a typed stream event; render it in
   the existing workspace rail. No provider changes required.

4. **Patch tool.**
   Add gated `fs.patch`. Start with unified diff support using a small
   parser or a focused crate added through `[workspace.dependencies]`.
   Tests must cover clean apply, stale hunks, outside-root paths, and
   approval denial.

5. **Project checks suggestion.**
   Add read-only `project.checks` based on manifests. The first pass
   can be heuristic and conservative.

6. **Tool cards polish.**
   In `apps/jarvis-web`, make `git.diff` / `fs.patch` render with
   diff highlighting, and make `shell.exec` progress keep a stable
   terminal-like surface.

7. **Docs and examples.**
   Update README, user guide, and web guide with a coding-agent
   walkthrough: inspect, edit, approve, test, final diff.

## Safety model

Default-safe:

- `workspace.context`, `git.status`, `git.diff`, `project.checks`,
  `code.grep`, `fs.read`, `fs.list` are read-only.
- `fs.patch`, `fs.edit`, `fs.write`, `shell.exec` require approval.
- `shell.exec` remains opt-in.
- no commits, pushes, dependency installs, or network operations are
  automatic.

Recommended policy:

- web/CLI interactive mode: `ChannelApprover`;
- non-interactive mode: `AlwaysDeny`;
- trusted local demos: `AlwaysApprove`, but with visible audit events.

## Risks / open questions

- **Patch parser choice.** A dependency avoids buggy hand parsing, but
  a too-general patch engine may allow surprising file operations.
  The first version should support only text hunks for existing or new
  files under root.
- **Prompt reliance.** "Always inspect git status" is a behavioral
  contract, not a hard guarantee. For stricter policy, the transport
  can prepend a hidden first turn or a future planner can enforce
  required tools.
- **Large diffs.** Truncation is necessary. The agent should use path
  filters and `stat = true` first when the repo is very dirty.
- **Non-Git projects.** Workspace tools should degrade cleanly:
  `workspace.context` still works; `git.*` returns a clear tool error.
- **UI overload.** Too many tool cards can make coding turns noisy.
  The web UI should collapse read-only inspection tools by default and
  keep approvals prominent.

## Success criteria

- A user can ask Jarvis to fix a small bug in a repo and see:
  plan, repo status, file inspection, approved edit, test command,
  final diff summary.
- The same flow works over WS and the web UI without special casing
  the provider.
- `cargo clippy --workspace --all-targets -- -D warnings` remains the
  gate for Rust changes.
- Sensitive operations are never enabled silently.
