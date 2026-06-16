// repl.ts — the interactive REPL.
//
// Mirrors apps/jarvis-cli/src/runner.rs::run_repl + render.rs, scoped to the
// Node @jarvis/core surface. The flow per turn:
//
//   1. readline prompts `> ` and reads a line.
//   2. A slash command (`/help`, `/reset`, `/exit`, `/model`, `/mode`,
//      `/policy`, `/tools`) is handled inline and the loop continues.
//   3. Otherwise the line is pushed as a user message and the agent is driven
//      via Agent.runStream — deltas print inline, tool start/end as bracketed
//      status lines, and an `approval_request` is resolved by a readline y/N
//      prompt (a session policy table lets `a` / `d` auto-(dis)allow a tool for
//      the rest of the session).
//
// Streaming stays on Agent.runStream — we never reimplement the loop.
//
// Design for testability: the slash-command parser (`parseSlashCommand`) and
// the readline-backed Approver (`ReadlineApprover`) are standalone exports so a
// test can exercise them without a live terminal. `ReadlineApprover` takes an
// injected `ask(question) => Promise<string>` instead of touching a real
// readline interface, so the y→approve / else→deny mapping is unit-testable.
import * as readline from "node:readline";

import {
  type Agent,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type Approver,
  type Conversation,
  newConversation,
} from "@jarvis/core";

import type { CliConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Session approval policy (mirrors policy.rs::PolicyTable)
// ---------------------------------------------------------------------------

/** Per-tool session policy: skip the prompt and auto-(dis)allow this tool. */
export type SessionPolicy = "always-allow" | "always-deny";

/**
 * In-memory, per-process policy table. "Always allow `fs.edit` for this
 * session" beats "ask every single time" — the user types `a` once and every
 * subsequent gated call to that tool goes through silently. Resetting the
 * conversation (`/reset`) keeps the policy; quitting drops it.
 */
export class PolicyTable {
  #inner = new Map<string, SessionPolicy>();

  lookup(toolName: string): SessionPolicy | undefined {
    return this.#inner.get(toolName);
  }

  set(toolName: string, policy: SessionPolicy): void {
    this.#inner.set(toolName, policy);
  }

  entries(): [string, SessionPolicy][] {
    return [...this.#inner.entries()];
  }
}

// ---------------------------------------------------------------------------
// Readline-backed Approver
// ---------------------------------------------------------------------------

/**
 * Map a raw approval reply to a decision. `y` / `yes` / empty → approve;
 * `a` / `always` → approve + remember always-allow; `d` / `deny-always` →
 * deny + remember always-deny; anything else → a one-off deny. Mirrors the
 * Rust runner's match table (run_one_turn's stdin → approval reply arm).
 */
export function decisionForReply(
  reply: string,
  toolName: string,
  policy?: PolicyTable,
): { decision: ApprovalDecision; note: string } {
  const trimmed = reply.trim().toLowerCase();
  switch (trimmed) {
    case "y":
    case "yes":
    case "":
      return { decision: { decision: "approve" }, note: "approved" };
    case "a":
    case "always":
      policy?.set(toolName, "always-allow");
      return {
        decision: { decision: "approve" },
        note: `approved (and always-allow ${toolName} for this session)`,
      };
    case "d":
    case "deny-always":
      policy?.set(toolName, "always-deny");
      return {
        decision: { decision: "deny", reason: "session policy" },
        note: `denied (and always-deny ${toolName} for this session)`,
      };
    default:
      return { decision: { decision: "deny", reason: "user denied" }, note: "denied" };
  }
}

/**
 * Approver that prompts the operator (`[y]es / [n]o / [a]lways / [d]eny-always`)
 * for each gated tool call and maps the answer via {@link decisionForReply}. A
 * session {@link PolicyTable} short-circuits the prompt once a tool has been
 * `a`/`d`-marked.
 *
 * The prompt function (`ask`) is injected so the production REPL passes a
 * readline-backed reader while tests pass a canned-answer stub. The agent loop
 * only consults this Approver for tools whose `requiresApproval` is true.
 */
export class ReadlineApprover implements Approver {
  #ask: (question: string) => Promise<string>;
  #policy: PolicyTable;

  constructor(ask: (question: string) => Promise<string>, policy: PolicyTable = new PolicyTable()) {
    this.#ask = ask;
    this.#policy = policy;
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const existing = this.#policy.lookup(request.tool_name);
    if (existing === "always-allow") {
      process.stdout.write(dim("  (auto-approved by session policy)\n"));
      return { decision: "approve" };
    }
    if (existing === "always-deny") {
      process.stdout.write(dim("  (auto-denied by session policy)\n"));
      return { decision: "deny", reason: "session policy" };
    }

    const args = shortArgs(request.arguments);
    const question =
      `${yellow("⚠")} ${yellow(`approve ${request.tool_name}?`)} ${dim(args)}\n` +
      `${bold("  [y]es / [n]o / [a]lways / [d]eny-always > ")}`;
    const reply = await this.#ask(question);
    const { decision, note } = decisionForReply(reply, request.tool_name, this.#policy);
    process.stdout.write(`  ${dim("→")} ${dim(note)}\n`);
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/** A parsed REPL slash command. `prompt` = "not a slash command, run it". */
export type SlashCommand =
  | { kind: "prompt"; text: string }
  | { kind: "empty" }
  | { kind: "help" }
  | { kind: "reset" }
  | { kind: "exit" }
  | { kind: "tools" }
  | { kind: "policy" }
  | { kind: "model"; model?: string }
  | { kind: "mode"; mode?: string }
  | { kind: "unknown"; name: string };

/**
 * Parse one input line into a {@link SlashCommand}. A leading `/` is a command;
 * everything else is a prompt. The argument (model id, mode name) is the
 * whitespace-trimmed remainder. Pure — no I/O — so it's trivially unit-tested.
 */
export function parseSlashCommand(line: string): SlashCommand {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };

  const spaceIdx = trimmed.search(/\s/);
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (name) {
    case "/help":
    case "/?":
      return { kind: "help" };
    case "/reset":
    case "/clear":
      return { kind: "reset" };
    case "/exit":
    case "/quit":
    case "/q":
      return { kind: "exit" };
    case "/tools":
      return { kind: "tools" };
    case "/policy":
      return { kind: "policy" };
    case "/model":
      return rest === "" ? { kind: "model" } : { kind: "model", model: rest };
    case "/mode":
      return rest === "" ? { kind: "mode" } : { kind: "mode", mode: rest };
    default:
      return { kind: "unknown", name };
  }
}

const HELP_TEXT = [
  "commands:",
  "  /help            show this help",
  "  /reset           clear the conversation (session policy preserved)",
  "  /model [id]      show or set the model for the next turn",
  "  /mode [name]     show or set the permission mode (ask/accept-edits/plan/auto)",
  "  /tools           list the registered tools",
  "  /policy          explain the session approval policy",
  "  /exit            quit",
  "type a prompt and Enter; answer y/n/a/d at an approval prompt.",
].join("\n");

// ---------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------

/** Render a single AgentEvent to stdout. Returns the updated `deltaOpen` flag. */
export function renderEvent(
  ev: AgentEvent,
  deltaOpen: boolean,
  out: (s: string) => void,
): boolean {
  switch (ev.type) {
    case "delta": {
      if (!deltaOpen) {
        out(`${green("●")} `);
        deltaOpen = true;
      }
      out(ev.content);
      return deltaOpen;
    }
    case "assistant_message":
      if (deltaOpen) out("\n");
      return false;
    case "tool_start":
      if (deltaOpen) out("\n");
      out(`${cyan("⚙")} ${cyan(ev.name)}${dim(` ${shortArgs(ev.arguments)}`)}\n`);
      return false;
    case "tool_progress": {
      const prefix = ev.stream === "stderr" ? red("│ ") : dim("│ ");
      out(ev.chunk.split(/(?<=\n)/).map((l) => `${prefix}${l}`).join(""));
      return deltaOpen;
    }
    case "tool_end": {
      const oneLine = (ev.content.split("\n")[0] ?? "").trim();
      const trimmed = oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
      out(`  ${dim("→")} ${dim(trimmed)}\n`);
      return deltaOpen;
    }
    case "plan_update": {
      if (deltaOpen) out("\n");
      const n = ev.items.length;
      out(`${cyan("☰")} ${cyan(`plan (${n} step${n === 1 ? "" : "s"})`)}\n`);
      for (const item of ev.items) {
        const marker =
          item.status === "completed"
            ? "●"
            : item.status === "in_progress"
              ? "◐"
              : item.status === "cancelled"
                ? "✕"
                : "○";
        out(`    ${marker} ${item.title}\n`);
      }
      return false;
    }
    case "error":
      if (deltaOpen) out("\n");
      out(`${red("✗")} ${ev.message}\n`);
      return false;
    // approval_request / approval_decision are surfaced by the Approver's own
    // prompt; usage / done are handled by the driver. No-op render.
    default:
      return deltaOpen;
  }
}

// ---------------------------------------------------------------------------
// Turn driver
// ---------------------------------------------------------------------------

/**
 * Drive one turn: stream the agent over `conversation`, render events, and
 * return the final Conversation (from the terminal `done` event) so the caller
 * can carry it into the next turn. The Approver is wired into the Agent at
 * build time, so approval prompts happen inside `runStream`.
 */
export async function runTurn(
  agent: Agent,
  conversation: Conversation,
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<Conversation> {
  let deltaOpen = false;
  let final = conversation;
  for await (const ev of agent.runStream(conversation)) {
    if (ev.type === "done") {
      if (deltaOpen) out("\n");
      final = ev.conversation;
      break;
    }
    deltaOpen = renderEvent(ev, deltaOpen, out);
  }
  return final;
}

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------

/** Dependencies the REPL needs, injected so the loop has no hidden globals. */
export interface ReplDeps {
  config: CliConfig;
  policy: PolicyTable;
  /** Build a fresh Agent for the current model + approver. */
  buildAgent(model: string): Promise<Agent>;
  /** A line reader (readline-backed in production). */
  input: AsyncIterable<string>;
  out?: (s: string) => void;
}

/**
 * Run the interactive REPL until `/exit` or EOF (Ctrl-D). The agent is rebuilt
 * per turn (so a `/model` switch takes effect) off the injected `buildAgent`.
 */
export async function runRepl(deps: ReplDeps): Promise<void> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  let conversation = newConversation();
  let model = deps.config.model;
  let mode = deps.config.permissionMode;

  out(
    `${bold("jarvis-cli")} ${dim("·")} ${cyan(deps.config.provider)} ${dim("·")} ${dim(model)} ${dim(`· ${deps.config.fsRoot}`)}\n`,
  );
  out(`${dim("type /help for commands. Ctrl-D to quit.")}\n`);
  out(`${dim(`(permission mode: ${mode})`)}\n`);

  out(bold("> "));
  for await (const line of deps.input) {
    const cmd = parseSlashCommand(line);
    switch (cmd.kind) {
      case "empty":
        break;
      case "exit":
        return;
      case "help":
        out(`${dim(HELP_TEXT)}\n`);
        break;
      case "reset":
        conversation = newConversation();
        out(`${dim("(conversation reset; session policy preserved)")}\n`);
        break;
      case "tools": {
        const agent = await deps.buildAgent(model);
        out(`${dim(`tools: ${agent.config.tools.names().sort().join(", ")}`)}\n`);
        break;
      }
      case "policy": {
        const entries = deps.policy.entries();
        out(
          `${dim(
            entries.length === 0
              ? "session policy: type `a` at an approval prompt to always-allow a tool; `d` to always-deny."
              : `session policy: ${entries.map(([t, p]) => `${t}=${p}`).join(", ")}`,
          )}\n`,
        );
        break;
      }
      case "model":
        if (cmd.model === undefined) {
          out(`${dim(`current model: ${model}`)}\n`);
        } else {
          model = cmd.model;
          out(`${dim(`(model set to \`${model}\` for the next turn)`)}\n`);
        }
        break;
      case "mode":
        if (cmd.mode === undefined) {
          out(`${dim(`current mode: ${mode}; usage: /mode <ask|accept-edits|plan|auto>`)}\n`);
        } else {
          const v = cmd.mode.trim().toLowerCase();
          if (["ask", "accept-edits", "plan", "auto"].includes(v)) {
            mode = v as typeof mode;
            out(`${dim(`(permission mode: ${mode})`)}\n`);
          } else if (v === "bypass") {
            out(`${red("✗")} bypass mode is not supported from the REPL\n`);
          } else {
            out(`${red("✗")} unknown mode \`${cmd.mode}\` — use ask / accept-edits / plan / auto\n`);
          }
        }
        break;
      case "unknown":
        out(`${red("✗")} unknown command \`${cmd.name}\` — try /help\n`);
        break;
      case "prompt": {
        conversation.messages.push({ role: "user", content: cmd.text });
        let agent: Agent;
        try {
          agent = await deps.buildAgent(model);
        } catch (e) {
          out(`${red("✗")} ${e instanceof Error ? e.message : String(e)}\n`);
          break;
        }
        conversation = await runTurn(agent, conversation, out);
        break;
      }
    }
    out(bold("> "));
  }
  out("\n");
}

/**
 * Wrap a Node readline interface as an async line iterator + a one-shot
 * `question` for the approver. The REPL and the approver share the same
 * interface so they don't fight over stdin.
 */
export function readlineInput(rl: readline.Interface): {
  lines: AsyncIterable<string>;
  ask(question: string): Promise<string>;
} {
  return {
    lines: rl[Symbol.asyncIterator](),
    ask: (question: string) =>
      new Promise<string>((resolve) => {
        rl.question(question, (answer) => resolve(answer));
      }),
  };
}

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (mirrors render.rs). NO_COLOR / non-TTY → plain text.
// ---------------------------------------------------------------------------

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function wrap(code: string, text: string): string {
  return useColor() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const dim = (s: string): string => wrap("2", s);
export const bold = (s: string): string => wrap("1", s);
export const cyan = (s: string): string => wrap("36", s);
export const green = (s: string): string => wrap("32", s);
export const yellow = (s: string): string => wrap("33", s);
export const red = (s: string): string => wrap("31", s);

/** Compact a JSON args value to a single short line for status output. */
export function shortArgs(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length <= 80 ? s : `${s.slice(0, 80)}…`;
}
