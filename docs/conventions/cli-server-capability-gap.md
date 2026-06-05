# CLI ↔ server capability gap

`jarvis-cli` and `harness-server` are **two independent front-ends over the
same agent core**, not one stacked on the other. They share `harness-core`
(the `Agent` loop, `AgentEvent`, the `Approver` / `Tool` / `Memory` traits)
and the builtin tool set — and nothing above that line. The CLI drives
`harness_core::Agent` in-process; the server wraps the same `Agent` in a
run registry, a WebSocket frame protocol, and a REST run API.

This file exists because the divergence is **deliberate and load-bearing**,
and because it is the single most common source of "why doesn't the CLI do
X?" confusion. Read it before you assume a server feature is missing from
the CLI by accident — it almost certainly isn't.

Related:
- [proposals/cli.md](../proposals/cli.md) — the CLI's own design + status.
- [proposals/web-multi-session-runs.zh-CN.md](../proposals/web-multi-session-runs.zh-CN.md) — the run-registry / async-run spec the server+web path implements.
- [proposals/tauri-desktop-client.zh-CN.md](../proposals/tauri-desktop-client.zh-CN.md) — the desktop shell, which is the server+web path repackaged (it inherits everything in the server column for free).

---

## Where the fork is

```
                    ┌──────────────────────────┐
   jarvis-cli  ───► │  harness-core::Agent      │ ◄─── harness-server
   (in-process)     │  run / run_stream         │      (ChatRunRegistry +
                    │  AgentEvent · Approver ·  │       WS frames + REST)
                    │  Tool · Memory · streaming│
                    └──────────────────────────┘
                         shared substrate
```

Everything **at or below** the box is shared. Everything **above** it —
session lifecycle, multi-run orchestration, the wire protocol, persistence
policy — is implemented separately on each side. A change to `harness-core`
reaches both; a change to `chat_runs.rs` / `routes.rs` reaches only the
server+web+desktop path.

Concretely:

- **CLI entry points** — [`apps/jarvis-cli/src/runner.rs`](../../apps/jarvis-cli/src/runner.rs):
  `run_repl` → `run_one_turn` (a `tokio::select!` over stdin / `pending_rx` /
  the agent event stream, rendering to stdout) and `run_pipe`
  (`agent.run(&mut conv)`, one turn under `AlwaysDeny`).
- **Server entry points** — [`crates/harness-server/src/routes.rs`](../../crates/harness-server/src/routes.rs)
  `handle_ws` (the `start_turn` / `resume` / `approve` / … frame loop) plus
  the run ledger in [`crates/harness-server/src/chat_runs.rs`](../../crates/harness-server/src/chat_runs.rs).

The `tokio::select!` shape is intentionally *mirrored* between the two —
[proposals/cli.md](../proposals/cli.md) calls this out — but the two loops do
not share code, so they drift independently unless a change is ported by hand.

---

## Capability matrix

| Capability | CLI | server + web/desktop | Notes |
|---|:---:|:---:|---|
| `harness-core` agent loop, streaming `AgentEvent` | ✅ | ✅ | the shared substrate |
| Builtin tools (`fs.*`, `shell.exec`, `code.grep`, `git.*`, …) | ✅ | ✅ | both call `register_builtins` |
| Tool approval gate | ✅ tty `y`/`n`/`a`/`d` session policy | ✅ per-socket `ChannelApprover` | CLI policy table is local to the process; server routes verdicts by `tool_call_id` |
| Short-term memory (`window` / `summary`) | ✅ `--memory-tokens` | ✅ env-driven | same `harness-memory` backends |
| Project-context preamble (`AGENTS.md`/`CLAUDE.md`) | ✅ `load_instructions` | ✅ | both inject the workspace prelude |
| Conversation persistence | ⚠️ **manual only** — `--db` + `/save <id>` / `/load <id>` | ✅ **auto-save per turn** in persisted mode | CLI never auto-persists and has no per-turn envelope save |
| **Run registry / multi-session** | ❌ | ✅ `ChatRunRegistry` | one process = one foreground turn at a time |
| **Run status ledger** (`GET /v1/chat/runs`) | ❌ | ✅ | no "what's running" surface in the CLI |
| **Background / detached run survival** | ❌ | ✅ detached turn task | CLI turn dies with the process / `Ctrl-C` |
| **Reconnect + seq backfill** (`?after=`, `tail_replay`, `resume_error`) | ❌ | ✅ ring buffer + `ReplayWindow` | nothing to reconnect to — the CLI is the only consumer |
| **Approval survival across reconnect** | ❌ | ✅ per-conversation `pending_approvals` | CLI approvals live in the in-process select loop |
| Typed wire frame protocol | ❌ (renders `AgentEvent` to stdout) | ✅ `WsClientMessage` / JSON frames | the protocol is the server's, not the core's |
| Project binding (`project_id` → instructions) | ❌ | ✅ `project_binder` | CLI has no project store wiring |
| TODO injection per turn | ❌ | ✅ `todo_binder` | |
| Skill catalog auto-activation | ❌ | ✅ `merged_skills_for_turn` | CLI ships builtin tools only, no skill injection |
| User long-term memory injection | ❌ | ✅ `learning_emit` | |
| Soul prompt, Fork/edit-rerun, AcceptPlan/RefinePlan, SetWorkspace, HITL frames | ❌ | ✅ | all live in the frame loop |
| Channels / automations / workflows | ❌ | ✅ | server-only domains |
| Zero network hops, env-only provider construction | ✅ | — | the CLI's whole point |
| Spawn the full server on demand | ✅ `--web` → child `jarvis serve` | n/a | see [`apps/jarvis-cli/src/web.rs`](../../apps/jarvis-cli/src/web.rs) |

Legend: ✅ present · ⚠️ present but reduced · ❌ not implemented (by design).

---

## Why the gap is deliberate

The CLI is a **single-operator, single-turn-at-a-time, local** surface. The
machinery in the server column exists to solve problems the CLI does not
have:

- **Multi-session orchestration** matters when many clients (browser tabs,
  desktop, IM gateways) share one backend. A terminal runs one turn at the
  prompt; there is nothing to multiplex.
- **Reconnect / backfill / detached survival** matter when the *client* can
  disappear while the *run* should continue (close a tab, lose wifi). The CLI
  process **is** the run — if it dies, the run is gone, and that is the
  expected terminal-tool contract (`Ctrl-C` aborts).
- **The frame protocol** is a transport concern. The CLI consumes
  `AgentEvent` directly and writes to a tty; wrapping that in JSON frames
  would buy it nothing.
- **Project/TODO/skill/memory injection** are product features layered in
  the server's `begin_user_turn`. The CLI deliberately stays a thin coding
  REPL (per [proposals/cli.md](../proposals/cli.md)); pulling those in would
  re-grow the ~1k lines of composition the CLI exists to avoid.

Keeping the CLI thin is the feature, not a shortfall. It doubles as the
simplest reference integration of the `harness-core` traits.

---

## Implications for contributors

1. **New run-protocol capabilities land server-side only.** Anything added to
   `chat_runs.rs` / the `handle_ws` frame loop (a new frame, a new run-status
   transition, reconnect semantics) does **not** reach the CLI unless someone
   ports the equivalent into `runner.rs` by hand. Assume drift; do not assume
   parity.

2. **Don't "fix" the CLI by giving it a run registry.** If a request needs
   multi-session, background survival, or reconnect, the answer is the
   server (`jarvis serve`, optionally launched by the CLI's `--web` flag),
   not bolting a registry onto the terminal path.

3. **Shared behaviour belongs in `harness-core` or `harness-tools`.** If a
   change must reach both surfaces (a tool fix, an agent-loop fix, a memory
   policy), make it below the fork line so both inherit it. Putting it in the
   server is how the gap widens.

4. **The desktop app is not a third implementation.** It is the server+web
   path in a Tauri shell ([proposals/tauri-desktop-client.zh-CN.md](../proposals/tauri-desktop-client.zh-CN.md)),
   so it inherits the entire server column automatically. There is no
   separate desktop chat code path to keep in sync.

## Quick rule of thumb

> If a feature is about **how a turn runs** (tools, prompt, memory, the agent
> loop), it should live below the fork and reach both. If it is about
> **managing runs** (who's running what, reconnecting, surviving a client
> drop, multiplexing sessions), it is server-only by design — and the CLI is
> expected not to have it.
