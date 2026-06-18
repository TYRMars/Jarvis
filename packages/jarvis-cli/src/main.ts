#!/usr/bin/env node
// main.ts — argv parse + entry point. The composition root for the CLI: this
// and config.ts are the only files allowed to read process.env (the lint rule
// is exempted for packages/jarvis-cli/**).
//
// Mirrors apps/jarvis-cli/src/main.rs + runner.rs. Two modes:
//
//   * Interactive (default): launch the REPL (repl.ts::runRepl) with a
//     readline-backed line reader + a ReadlineApprover for gated tools.
//   * Pipe (`--no-interactive`): read the prompt from `--prompt` or all of
//     stdin, run ONE turn under AlwaysDeny (no human there to approve), print
//     the final assistant text, exit.
//
// Flags: `--no-interactive`, `--prompt <text>`, `--workspace <path>` (alias
// `--fs-root`), `--no-project-context`, `--provider`, `--model`,
// `--permission-mode`, `--allow-fs-write`, `--allow-shell`, `--no-git-read`,
// `--max-iterations <n>`, `--help`.
import * as readline from "node:readline";
import { stdin, stdout, argv, exit } from "node:process";

import {
  AlwaysDeny,
  type Conversation,
  lastAssistantText,
  newConversation,
} from "@jarvis/core";

import { loadCliConfig, type CliConfigOverrides } from "./config.ts";
import { buildAgent, buildProvider } from "./agent.ts";
import {
  PolicyTable,
  ReadlineApprover,
  readlineInput,
  runRepl,
} from "./repl.ts";

/** Parsed argv. Unknown flags are tolerated (forward-compat with the Rust CLI). */
export interface ParsedArgs {
  noInteractive: boolean;
  prompt?: string;
  noProjectContext: boolean;
  help: boolean;
  overrides: CliConfigOverrides;
}

const USAGE = `jarvis-cli — terminal coding-agent (drives @jarvis/core in-process)

usage: jarvis-cli [options]

options:
  --workspace <path>      workspace root for fs.*/git.*/code.grep/shell.exec (alias --fs-root)
  --provider <name>       openai (default) / anthropic / google / ollama / kimi / openai-responses
  --model <id>            override the provider's default model
  --permission-mode <m>   ask (default) / accept-edits / plan / auto / bypass
  --allow-fs-write        enable fs.write (approval-gated; fs.edit/fs.patch are on by default)
  --allow-shell           enable shell.exec (approval-gated)
  --no-git-read           drop the read-only git.* tools
  --no-project-context    don't auto-load AGENTS.md / CLAUDE.md / AGENT.md
  --max-iterations <n>    cap agent-loop iterations per turn (default 30)
  --no-interactive        pipe mode: read prompt from --prompt or stdin, run ONE turn
                          under AlwaysDeny, print the final assistant text, exit
  --prompt <text>         the prompt for --no-interactive (else stdin is read to EOF)
  --help                  show this help`;

/**
 * Parse argv (the slice after `node main.ts`). Pure — takes the args array, no
 * process access — so it's unit-testable. Flags follow the Rust CLI's surface;
 * value flags accept `--flag value` (not `--flag=value`, matching clap's
 * default for long options here).
 */
export function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    noInteractive: false,
    noProjectContext: false,
    help: false,
    overrides: {},
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string | undefined => args[++i];
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--no-interactive":
        out.noInteractive = true;
        break;
      case "--no-project-context":
        out.noProjectContext = true;
        out.overrides.noProjectContext = true;
        break;
      case "--no-git-read":
        out.overrides.noGitRead = true;
        break;
      case "--allow-fs-write":
        out.overrides.allowFsWrite = true;
        break;
      case "--allow-shell":
        out.overrides.allowShell = true;
        break;
      case "--prompt":
        out.prompt = next();
        break;
      case "--workspace":
      case "--fs-root":
        out.overrides.fsRoot = next();
        break;
      case "--provider":
        out.overrides.provider = next();
        break;
      case "--model":
        out.overrides.model = next();
        break;
      case "--permission-mode":
        out.overrides.permissionMode = next();
        break;
      case "--max-iterations": {
        const raw = next();
        const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) out.overrides.maxIterations = n;
        break;
      }
      default:
        // Tolerate unknown flags (and any value swallowed above). A bare
        // positional is treated as part of an inline prompt only in pipe
        // mode, but we keep parsing strict-ish: ignore here.
        break;
    }
  }
  return out;
}

/** Read all of stdin to EOF as a single string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pipe mode: run a single turn under AlwaysDeny (auto-approve only when the
 * permission mode is `auto`/`bypass`, matching the Rust pipe runner) and return
 * the final assistant text. `readPrompt` / `provider` are injectable so a test
 * can feed a fixed prompt + a stub provider without touching stdin or the
 * network.
 */
export async function runPipe(args: {
  parsed: ParsedArgs;
  env?: Record<string, string | undefined>;
  readPrompt?: () => Promise<string>;
  provider?: import("@jarvis/core").LlmProvider;
}): Promise<string> {
  const config = loadCliConfig(args.env, args.parsed.overrides);
  const promptRaw =
    args.parsed.prompt ?? (await (args.readPrompt ?? readStdin)());
  const prompt = promptRaw.trim();
  if (prompt === "") {
    throw new Error("--no-interactive needs a non-empty prompt (via --prompt or stdin)");
  }

  const provider = args.provider ?? buildProvider(config);
  // No human in pipe mode: auto-approve under auto/bypass, else deny so a gated
  // tool surfaces "tool denied: ..." and the model adapts.
  const autoApprove = config.permissionMode === "auto" || config.permissionMode === "bypass";
  const agent = await buildAgent({
    config,
    provider,
    approver: autoApprove ? undefined : new AlwaysDeny(),
  });

  const conv: Conversation = newConversation();
  conv.messages.push({ role: "user", content: prompt });
  await agent.run(conv);
  return lastAssistantText(conv) ?? "";
}

/** Interactive mode: launch the REPL with a readline reader + approver. */
async function runInteractive(parsed: ParsedArgs): Promise<void> {
  const config = loadCliConfig(process.env, parsed.overrides);
  const provider = buildProvider(config);
  const policy = new PolicyTable();

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  const { lines, ask } = readlineInput(rl);
  const approver = new ReadlineApprover(ask, policy);

  try {
    await runRepl({
      config,
      policy,
      buildAgent: (model) => buildAgent({ config: { ...config, model }, provider, approver }),
      input: lines,
    });
  } finally {
    rl.close();
  }
}

/** Process entry. Parses argv, dispatches to pipe or interactive mode. */
export async function main(rawArgv: string[] = argv.slice(2)): Promise<void> {
  const parsed = parseArgs(rawArgv);
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  if (parsed.noInteractive) {
    const text = await runPipe({ parsed, env: process.env });
    stdout.write(`${text}\n`);
    return;
  }
  await runInteractive(parsed);
}

// Run only when invoked as a script (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    exit(1);
  });
}
