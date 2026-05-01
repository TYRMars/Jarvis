# `harness-cli` — terminal Chat / Work client

**Status:** Proposed
**Touches:** new `apps/jarvis-cli` binary, no library changes (reuses
`harness-core` / `harness-llm` / `harness-tools` / `harness-memory`).

## Motivation

Today the primary way to drive Jarvis is HTTP/WS. For local Chat and
Work, the natural power-user front-end is also a terminal: prompt at
the bottom, streamed output above, tool approvals on tty. A CLI
exercises the `harness-core` traits without touching
`harness-server`, so it doubles as the simplest reference
integration.

This is a product surface for Chat-first and Work-adjacent usage, not
only a coding-agent shell. The Coding capability pack is its first
rich use case because terminals are excellent for repositories,
patches, checks, and approvals. Later the same CLI should also drive
office/research prompts, TODO capture, and Work unit execution. The
CLI talks to the harness directly, in-process — no server required.

## Product alignment

Under the Chat / Work / Doc product design:

- **Chat:** interactive REPL and pipe mode are terminal Chat.
- **Work:** `--root`, approval policy, persistence, and future
  `/work` commands let the CLI start or inspect Work units.
- **Doc:** out of scope for v0, but pipe mode can generate drafts and
  later save them through Doc APIs.
- **Capability layer:** Coding is a capability pack surfaced through
  the CLI, not the CLI's product identity.

## UX target

```
$ jarvis-cli
> read README.md and write a one-paragraph summary to SUMMARY.md
… reading README.md
… writing SUMMARY.md  ⚠ allow fs.edit on SUMMARY.md? (y/n/a/d) y
✓ wrote 312 bytes
done in 2 turns

> what did you change?
…
```

Required:

- Streaming output (token-level, not turn-level).
- tty-driven approval: `y` / `n` / `a` (always-allow this tool for
  this session) / `d` (always-deny this tool for this session) /
  `Esc` (cancel turn).
- Multi-turn within one process; `/reset` slash command clears.
- `Ctrl-C` cancels the current turn cleanly (drops the agent
  stream, lets the next prompt run).
- Sensible defaults: file edits gated on approval; `shell.exec`
  off unless `--allow-shell`.

Nice-to-have (later):

- `/save <id>` / `/load <id>` if `--db` was passed (uses
  `ConversationStore`).
- TUI mode (`ratatui`) with a scrollable history pane.
- Pipe mode: `echo "fix the bug" | jarvis-cli --no-interactive` runs
  one turn, prints final assistant text, exits non-zero on deny.

## Architecture

New binary `apps/jarvis-cli` shares all library deps with `apps/jarvis`.
The composition is:

```
                    ┌────────────────┐
                    │  ratatui / raw │     <-- terminal frontend
                    └───┬────────────┘
                stdin   │   stdout
                        │
              ┌─────────▼──────────┐
              │   CLI run loop     │
              │  (select on:       │
              │    stdin lines,    │
              │    pending_rx,     │
              │    event_rx)       │
              └─────┬──────────┬───┘
            Arc<Agent>          │
                                │
                  ┌─────────────▼─────────────┐
                  │   harness-core::Agent     │
                  │   (run_stream w/ approver)│
                  └───────────────────────────┘
```

The pattern mirrors `harness-server::routes::handle_ws`:
`tokio::select!` over `(stdin reader, ChannelApprover pending_rx,
agent event_rx)`. Stdin lines drive `User` / `Approve` / `Deny` /
slash commands; `pending_rx` registers oneshot responders; the agent
stream's events are rendered to stdout.

## Approval flow

```rust
let (approver, mut pending_rx) = ChannelApprover::new(8);

// session policy: `always_allow` / `always_deny` per tool name,
// updated by the user typing `a` / `d` at the prompt.
let mut policy: HashMap<String, Policy> = HashMap::new();

// inside the select arm for pending_rx:
match policy.get(&pending.request.tool_name) {
    Some(Policy::AlwaysAllow) => { let _ = pending.responder.send(Approve); }
    Some(Policy::AlwaysDeny)  => { let _ = pending.responder.send(deny("session policy")); }
    None => {
        // Stash the responder; render the prompt to stdout; the next
        // stdin line resolves it.
        prompt_buffer.push(pending);
    }
}
```

The "session policy" semantics matters for ergonomics — Claude Code's
"always allow X for this conversation" is the right default, not
"approve every single call".

## Tool wiring

Reuse `harness_tools::register_builtins` with a CLI-specific config:

```rust
BuiltinsConfig {
    fs_root: cwd,                                  // default = current dir
    enable_fs_write: true,                         // gated by approver
    enable_fs_edit:  true,                         //   "
    enable_shell_exec: cli_args.allow_shell,       // off by default
    ..Default::default()
}
```

`fs_root = cwd` is intentional for local Work and Coding capability
use: users invoke the CLI from the project they want Jarvis to see.
`--root <path>` overrides.

## Slash commands

Parsed before the line is sent to the LLM:

| Command | Action |
|---|---|
| `/reset` | Clear conversation, keep policy. |
| `/quit` / `/exit` | Drop conversation, exit cleanly. |
| `/policy` | Print current always-allow / always-deny entries. |
| `/save <id>` | (if `--db`) Save to `ConversationStore`. |
| `/load <id>` | (if `--db`) Load from `ConversationStore`. |
| `/model <name>` | Swap `JARVIS_MODEL` for the rest of the session. |

## Args

```
jarvis-cli [--root PATH] [--model NAME] [--provider openai|anthropic|google]
           [--allow-shell] [--no-fs-write] [--db URL]
           [--memory-tokens N [--memory-mode window|summary]]
           [--no-interactive [--prompt TEXT]]
```

`--no-interactive` bypasses tty entirely: read prompt from `--prompt`
or stdin, run one turn with `AlwaysDeny` (no human there to approve),
print the final assistant text, exit. Suitable for shell pipelines.

## Implementation cuts

PR-sized increments:

1. **Skeleton.** `apps/jarvis-cli/src/main.rs`: provider selection,
   tool registry, agent construction. Reads a single line from stdin,
   runs the agent, prints the final assistant text. No streaming, no
   approval. ~150 LOC.
2. **Streaming output.** Forward `AgentEvent::Delta` / `ToolStart` /
   `ToolEnd` to stdout with light formatting. ~50 LOC.
3. **Interactive approval.** Wire `ChannelApprover`; handle `y`/`n`
   on stdin; session policy table for `a`/`d`. ~150 LOC.
4. **Slash commands + multi-turn.** `/reset`, `/policy`, prompt loop.
   ~80 LOC.
5. **Persistence.** `--db` plumbing, `/save` / `/load`. ~60 LOC.
6. **Pipe mode.** `--no-interactive` with `AlwaysDeny`. ~30 LOC.
7. *(Optional)* **TUI.** Bring in `ratatui`; render scrollback +
   prompt + approval banner. Separate proposal if it grows.

## Risks / open questions

- **`Ctrl-C` semantics.** Cancelling mid-stream means dropping the
  `AgentStream`; the LLM provider will keep billing for completed
  tokens but stop streaming. Acceptable. For provider-side abort
  (sending an actual cancellation request) — out of scope.
- **Long output.** A 5k-token assistant message scrolls off screen.
  Pipe through `less` or land the TUI proposal.
- **Process-level isolation for `shell.exec`.** Out of scope here;
  see [sandboxing.md](sandboxing.md). For CLI, the user is already on
  their own machine — the approval gate is the safety net.
- **Windows.** First pass is Unix-only (raw mode + tty). Windows tty
  handling differs enough to be a follow-up.

## Out of scope

- Multi-pane TUI with file tree / diff view (separate, larger
  proposal).
- "Plan mode" / read-only mode toggling — approval gate already
  covers this.
- Remote execution via SSH — use the HTTP/WS server for that.
