# Permission modes & rule engine

**Status:** Adopted. Backend (PRs 1-6) plus the Web UI follow-ups
(ModeBadge, PlanProposedCard, ApprovalCard always-allow, Settings
→ Permissions section, BypassBanner) all landed. Bypass mode is
now reachable from the UI with a confirm-dialog gate; the boot-time
`--dangerously-skip-permissions` flag is reserved for unattended
/ CI use.

**Touches:** `harness-core` (new `permission` module + `Tool::category`
/ `is_terminal` / `summary_for_audit` + `RuleApprover` +
`AgentEvent::PlanProposed`), `harness-store` (`JsonFilePermissionStore`),
`harness-tools` (`ExitPlanTool` + `category()` overrides on every
built-in), `harness-server` (REST `/v1/permissions` + WS frames
`set_mode` / `accept_plan` / `refine_plan` + `permission_mode` /
`permission_rules_changed` / `plan_proposed` events), `apps/jarvis`
(`--permission-mode` / `--dangerously-skip-permissions` /
`--bypass-on-network` flags + `pick_permission_mode`),
`apps/jarvis-cli` (matching CLI flags + `/mode` slash command).

## Motivation

Pre-existing approval surface was binary: every `fs.write` /
`shell.exec` etc. popped an Approve/Deny prompt, every time, and the
user couldn't say "always allow this command". Nothing persisted.
Claude Code's modern surface — five named modes (`ask` /
`accept-edits` / `plan` / `auto` / `bypass`) plus a deny-ask-allow
rule table — is the obvious target.

Two places we go further than Claude Code:

- **Plan Mode is structural, not policed.** Write/exec/network tools
  are filtered out of the LLM's tool catalogue entirely (via a new
  `AgentConfig::tool_filter` hook), so the model can't even attempt
  them. Compare Claude Code, which lets the model call the tool and
  then denies — wastes turns and confuses well-aligned models that
  trust the tool list.
- **Every auto-decision carries audit metadata.** The
  `AgentEvent::ApprovalDecision { source }` field tags every outcome
  with the rule that fired (or `mode_default` / `user_prompt`) so the
  audit timeline can show "auto-allowed by user-scope rule
  `fs.edit`" instead of silently running tools.

## Mode semantics

| Mode | Default decision for gated tools | Plan Mode tool filter? |
|---|---|---|
| `ask` | Prompt every time | no |
| `accept-edits` | Allow `fs.{edit,patch,write}`; prompt other gated | no |
| `plan` | Prompt — but read/exec/network tools never reach the approver because they're filtered out of the LLM catalogue | **yes** |
| `auto` | Auto-allow everything gated | no |
| `bypass` | Auto-allow everything; gated by `--dangerously-skip-permissions` + (on network) `--bypass-on-network` | no |

`dontAsk` (Claude Code's CI mode) is not implemented — the
`POST /v1/chat/completions` HTTP path runs without an approver,
which is the same behaviour and needs no special mode.

## Rule engine

Rules form a three-tier table evaluated `deny → ask → allow → mode-default`:

```json
{
  "default_mode": "ask",
  "deny":  [{ "tool": "shell.exec", "matchers": { "/command": "rm -rf *" } }],
  "ask":   [],
  "allow": [
    { "tool": "fs.edit" },
    { "tool": "shell.exec", "matchers": { "/command": "npm test" } }
  ]
}
```

`matchers` keys are JSON Pointers into the tool's argument object;
values are token-aware glob patterns. **Whitespace tokenises**, so
`shell.exec(npm test *)` matches `npm test src/foo` but not
`npm test; rm -rf ~` — Claude Code's "greedy `*`" footgun.

Three scopes:

| Scope | Where | Committed to git? |
|---|---|---|
| `session` | in-memory | no |
| `project` | `<workspace_root>/.jarvis/permissions.json` | **yes** |
| `user` | `~/.config/jarvis/permissions.json` | no |

Priority: `user > project > session` for `default_mode` (the highest
scope that has it set wins). Within a bucket the first matching rule
wins; user-scope rules sort first so they effectively override.

## Wire surface

REST (under `/v1/permissions`):

| Method | Path | |
|---|---|---|
| GET | `/v1/permissions` | merged snapshot |
| POST | `/v1/permissions/rules` | append rule (body: `{scope, bucket, rule}`) |
| DELETE | `/v1/permissions/rules?scope=&bucket=&index=` | delete by index |
| PUT | `/v1/permissions/mode` | set default mode of a scope (refuses bypass on project) |

WebSocket (additive — old frames keep working):

- Server → client (new event types):
  - `{ type: "permission_mode", mode }` — sent on connect + after each
    `set_mode` / `accept_plan`
  - `{ type: "permission_rules_changed" }` — fired by the
    `PermissionStore` broadcast (any socket's mutation, or future
    external file edit)
  - `{ type: "plan_proposed", plan }` — emitted when the agent calls
    the terminal `exit_plan` tool while in Plan Mode
- Server → client (extended event):
  - `approval_decision` now carries an optional `source` field:
    `{ kind: "rule" | "mode_default" | "user_prompt", … }`
- Client → server (new frames):
  - `{ type: "set_mode", mode }`
  - `{ type: "accept_plan", post_mode }`
  - `{ type: "refine_plan", feedback }`

## Bypass mode three-layer guard

1. **CLI**: `--permission-mode bypass` requires
   `--dangerously-skip-permissions`. Without it the binary refuses
   to start with a clear error.
2. **Server bind**: bypass + non-loopback `--addr` requires an
   additional `--bypass-on-network` flag. Without it the binary
   refuses to start. Loopback (`127.0.0.1`, `[::1]`, `localhost:`)
   is exempt — only the local user can reach the socket.
3. **Settings**: `PUT /v1/permissions/mode` rejects `mode=bypass +
   scope=project` with `400 Bad Request`. A committed file can't
   silently disable approval for everyone who pulls the repo.

## Plan Mode contract

1. User starts session with `--permission-mode plan` (or runtime
   `set_mode` / `/mode plan`).
2. The agent's tool catalogue is filtered to `ToolCategory::Read` +
   `exit_plan` (the latter is also `Read`-categorised so it survives
   the filter).
3. Agent explores, drafts a plan, calls `exit_plan({plan: "..."})`.
4. The agent loop sees `Tool::is_terminal() == true`, emits
   `AgentEvent::ToolEnd` then `AgentEvent::PlanProposed { plan }`,
   and **stops the turn** — even if the model emitted more tool
   calls in the same response.
5. Mode does **not** auto-flip. The user's transport (web button /
   `/mode` slash / WS `accept_plan`) chooses the post-mode. Until
   then the agent stays in Plan Mode (read-only).
6. `refine_plan { feedback }` is equivalent to a `User` frame with
   the feedback as content — agent re-explores, possibly emits
   another `exit_plan`. Mode stays `plan` throughout.

This makes prompt injection harder: a model that fabricates an
`exit_plan` call can't unilaterally enable write tools, because the
mode flip is user-driven.

## Migration

- `JARVIS_APPROVAL_MODE=auto` → `JARVIS_PERMISSION_MODE=auto` (legacy
  env still parsed, with a `warn!` in the startup log).
- `JARVIS_APPROVAL_MODE=deny` → maps to nothing clean; the warn
  recommends `permissions.deny: [{ tool: "*" }]` instead. The legacy
  `AlwaysDeny` is still constructible from `[approval] mode = "deny"`
  in config.
- WS clients sending the old `{type:"approve",tool_call_id}` keep
  working — the new optional `remember` field is ignored when absent.
- jarvis-cli's session `PolicyTable` was retired in favour of
  scope-based `PermissionTable` snapshots. The session scope replaces
  it almost line-for-line.

## Out of scope (v1)

- Claude Code's `auto` classifier (LLM-driven safety check). v1's
  `auto` is unconditional approve.
- `notify`-based external file watching. v1 broadcast covers
  in-process mutations; external edits require a refresh.
- Web UI mode badge / accept-plan card / inline always-allow checkbox
  / Settings Permissions section. Wire plumbing is in place; the
  visual surfaces ship in a follow-up PR.
- Per-MCP-server pattern dialect tweaks. Today's
  `<prefix>.<remote-name>` namespace works with the standard
  pointer-glob matcher.
- Managed/MDM scope.
- PreToolUse / PostToolUse hooks.

## Risks

- **MCP tool category default**: remote tools register through
  `harness-mcp::McpClient` and don't know if they're read or write.
  We default `Tool::category()` to `Write`, which is conservatively
  correct — Plan Mode hides them. A follow-up could let users tag MCP
  tools individually via Settings.
- **Permission file corruption**: `JsonFilePermissionStore::open` falls
  through to `OnDiskScope::default()` on parse error, but doesn't
  loudly warn. Worth surfacing in a UI banner.
- **Bypass + production**: `--bypass-on-network` is the last guard,
  but anyone who passes both flags is responsible for their VM /
  container isolation. Document and red-flag in startup logs.
