#!/usr/bin/env node
// main.ts — the `jarvis` binary entry point + subcommand dispatcher.
//
// Mirrors the Rust composition root's clap dispatcher (apps/jarvis/src/main.rs):
//
//   serve        — build everything (config → provider → tools/stores → state)
//                  and start the @jarvis/server HTTP server. Default subcommand.
//   mcp-serve     — expose the local tool registry over MCP stdio. No LLM / HTTP
//                  credentials required (serveRegistryStdio).
//   init          — scaffold a config skeleton (prints the env knobs to set).
//   login         — store an API key (the OAuth device-code flow for `codex` is
//                  a documented deferral; this records key/provider intent).
//   status        — print the resolved config summary (no secrets).
//   workspace     — print the pinned workspace root (+ optional JSON).
//
// This module + config.ts are the SOLE places that read process.env (the lint
// rule is exempted for packages/jarvis-app/**). Everything downstream takes the
// resolved JarvisConfig + injected stores/provider.
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { connect, connectAll, makeMemoryStores, type StoreBundle } from "@jarvis/store";
import { serveRegistryStdio } from "@jarvis/mcp";
import { serve, spawnWorkflowReaper } from "@jarvis/server";
import { ToolRegistry } from "@jarvis/core";
import { registerBuiltins, type BuiltinsConfig } from "@jarvis/tools";

import { loadConfig, parseAddr, type JarvisConfig } from "./config.ts";
import { buildProvider } from "./provider.ts";
import { buildAppState } from "./state.ts";
import { codingMode } from "./tools.ts";

/** A subcommand name; the default (no argv) is `serve`. */
export type Subcommand = "serve" | "mcp-serve" | "init" | "login" | "status" | "workspace";

const SUBCOMMANDS: readonly Subcommand[] = ["serve", "mcp-serve", "init", "login", "status", "workspace"];

/** Parsed argv: the subcommand + a flat flag bag (we read a tiny subset). */
export interface ParsedArgs {
  subcommand: Subcommand;
  /** `--workspace <path>` (alias `--fs-root`) override for serve/workspace. */
  workspace?: string;
  /** `--addr <host:port>` override for serve. */
  addr?: string;
  /** `--provider <name>` override for serve/login. */
  provider?: string;
  /** `--json` for the workspace subcommand. */
  json: boolean;
  /** `--key <KEY>` for login. */
  key?: string;
}

/**
 * Parse argv into a {@link ParsedArgs}. The first positional is the subcommand
 * (default `serve`). Unknown flags are tolerated (`strict:false`) so the future
 * flag surface doesn't break the dispatcher.
 */
export function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      workspace: { type: "string" },
      "fs-root": { type: "string" },
      addr: { type: "string" },
      provider: { type: "string" },
      key: { type: "string" },
      json: { type: "boolean" },
      // Legacy boolean flag — `jarvis --mcp-serve` is the historic invocation
      // that the Rust dispatcher still routes to the `mcp-serve` subcommand
      // (`#[arg(long, hide = true)] mcp_serve`). Kept as a back-compat alias.
      "mcp-serve": { type: "boolean" },
    },
  });

  const first = positionals[0];
  // The historic `--mcp-serve` flag wins over an absent/`serve` positional so
  // `jarvis --mcp-serve` keeps starting the MCP stdio server, not the HTTP one.
  const subcommand: Subcommand =
    first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)
      ? (first as Subcommand)
      : values["mcp-serve"] === true
        ? "mcp-serve"
        : "serve";

  const out: ParsedArgs = { subcommand, json: values.json === true };
  const ws = (values.workspace ?? values["fs-root"]) as string | undefined;
  if (ws !== undefined) out.workspace = ws;
  if (typeof values.addr === "string") out.addr = values.addr;
  if (typeof values.provider === "string") out.provider = values.provider;
  if (typeof values.key === "string") out.key = values.key;
  return out;
}

// ---------------------------------------------------------------------------
// config resolution (flag > env, the JSON config-file layer is deferred)
// ---------------------------------------------------------------------------

/** Apply the few CLI flag overrides onto the env-parsed config. */
export function applyArgs(config: JarvisConfig, args: ParsedArgs): JarvisConfig {
  const next = { ...config };
  if (args.workspace !== undefined) next.fsRoot = args.workspace;
  if (args.addr !== undefined) next.addr = args.addr;
  return next;
}

/**
 * Resolve the persistence URL: the explicit `JARVIS_DB_URL` (already on the
 * config) else the default JSON path under the user data dir. Returns undefined
 * only when no home dir is resolvable (→ in-memory fallback).
 */
export function resolveDbUrl(config: JarvisConfig): string | undefined {
  if (config.dbUrl !== undefined) return config.dbUrl;
  const home = os.homedir();
  if (home === "" || home === undefined) return undefined;
  // Mirrors the Rust default `json:///<data>/jarvis/conversations`.
  const dir = path.join(home, ".local", "share", "jarvis", "conversations");
  return `json://${dir}`;
}

/** Open the full store bundle for the config, falling back to in-memory. */
export async function openStores(config: JarvisConfig): Promise<StoreBundle> {
  const url = resolveDbUrl(config);
  if (url === undefined) {
    process.stderr.write("[jarvis] no data dir resolved; running with in-memory stores\n");
    return makeMemoryStores();
  }
  try {
    const bundle = await connectAll(url);
    process.stderr.write(`[jarvis] persistence connected: ${url}\n`);
    return bundle;
  } catch (e) {
    process.stderr.write(`[jarvis] persistence unavailable (${String(e)}); using in-memory stores\n`);
    return makeMemoryStores();
  }
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

/** `jarvis serve` — build everything and start the HTTP server. */
export async function runServe(config: JarvisConfig): Promise<void> {
  const provider = await buildProvider(config);
  const stores = await openStores(config);
  const { state, systemPrompt } = await buildAppState(config, { provider, stores });
  const { host, port } = parseAddr(config.addr);

  // Spawn the stale-workflow-run reaper (no-op without a workflow store). It
  // sweeps immediately to reclaim runs orphaned by a prior crash, then on an
  // interval; the timer is unref'd so it never keeps the process alive alone.
  spawnWorkflowReaper(state, config.workflowReapSeconds, config.workflowRunTimeoutMs);

  process.stderr.write(
    `[jarvis] serve: provider=${config.provider} model=${config.model} ` +
      `addr=${config.addr} fsRoot=${config.fsRoot} coding=${codingMode(config)} ` +
      `promptBytes=${systemPrompt.length}\n`,
  );
  await serve({ host, port }, state);
  process.stderr.write(`[jarvis] listening on http://${host}:${port}\n`);
}

/**
 * `jarvis mcp-serve` — expose the local ToolRegistry over MCP stdio. No LLM /
 * HTTP setup: we build only the builtin tool registry (no provider, no server).
 */
export async function runMcpServe(config: JarvisConfig): Promise<void> {
  const registry = new ToolRegistry();
  const builtins: BuiltinsConfig = {
    fsRoot: config.fsRoot,
    httpMaxBytes: config.gating.httpMaxBytes,
    enableFsWrite: config.gating.enableFsWrite,
    enableFsEdit: config.gating.enableFsEdit,
    enableFsPatch: config.gating.enableFsPatch,
    enableShellExec: config.gating.enableShellExec,
    shellDefaultTimeoutMs: config.gating.shellTimeoutMs,
    enableGitRead: config.gating.enableGitRead,
  };
  registerBuiltins(registry, builtins);
  await serveRegistryStdio(registry);
}

/** `jarvis init` — scaffold the data dir + print the env knobs to set. */
export async function runInit(config: JarvisConfig): Promise<void> {
  const url = resolveDbUrl(config);
  if (url !== undefined && url.startsWith("json://")) {
    const dir = url.slice("json://".length);
    await mkdir(dir, { recursive: true });
    process.stdout.write(`Created data directory: ${dir}\n`);
  }
  process.stdout.write(
    [
      "Jarvis is configured entirely via environment variables (the JSON config-file",
      "layer is a documented deferral). Set the load-bearing ones, then `jarvis serve`:",
      "",
      "  JARVIS_PROVIDER       openai | openai-responses | anthropic | google | codex | kimi | ollama",
      "  JARVIS_MODEL          per-provider default model override",
      "  OPENAI_API_KEY        (or ANTHROPIC_API_KEY / GOOGLE_API_KEY / KIMI_API_KEY)",
      "  JARVIS_ADDR           listen address (default 0.0.0.0:7001)",
      "  JARVIS_FS_ROOT        workspace root for fs.* / git.* / shell.exec",
      "  JARVIS_ENABLE_FS_WRITE / _FS_EDIT / _FS_PATCH / _SHELL_EXEC  (opt-in write/exec tools)",
      "  JARVIS_DB_URL         persistence URL (default json:// under ~/.local/share)",
      "",
    ].join("\n"),
  );
}

/**
 * `jarvis login` — record an API key for a provider. The OAuth device-code flow
 * for `codex` is a documented deferral; this prints guidance for setting the
 * matching env var (we don't persist secrets to disk in the P1 cut).
 */
export function runLogin(args: ParsedArgs, config: JarvisConfig): void {
  const provider = args.provider ?? config.provider;
  if (provider === "codex") {
    process.stdout.write(
      "Codex uses ChatGPT OAuth. The device-code flow is not yet ported (deferred);\n" +
        "set CODEX_ACCESS_TOKEN (+ optional CODEX_ACCOUNT_ID), or run the Codex CLI login\n" +
        "and point CODEX_HOME at its auth.json.\n",
    );
    return;
  }
  const envName =
    provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : provider === "google"
        ? "GOOGLE_API_KEY"
        : provider === "kimi"
          ? "KIMI_API_KEY"
          : "OPENAI_API_KEY";
  if (args.key !== undefined) {
    process.stdout.write(`Export the key into your shell: export ${envName}=<your key>\n`);
  } else {
    process.stdout.write(`Set ${envName} in the environment for provider \`${provider}\`.\n`);
  }
}

/** `jarvis status` — print the resolved config summary (no secrets). */
export function runStatus(config: JarvisConfig): void {
  const dbUrl = resolveDbUrl(config);
  const lines = [
    "Jarvis configuration (resolved from environment):",
    `  provider          ${config.provider}`,
    `  model             ${config.model}`,
    `  addr              ${config.addr}`,
    `  fsRoot            ${config.fsRoot}`,
    `  coding mode       ${codingMode(config)}`,
    `  permission mode   ${config.permissionMode}`,
    `  persistence       ${dbUrl ?? "(in-memory)"}`,
    `  todos             ${config.disableTodos ? "disabled" : "enabled"}`,
    `  memory            ${config.memoryTokens === undefined ? "unbounded" : `${config.memoryMode} @ ${config.memoryTokens} tokens`}`,
    `  router            ${config.router.enabled ? "enabled" : "off"}`,
    `  work mode         ${config.workMode}`,
    `  mcp servers       ${config.mcpServers.length}`,
    "  credentials:",
    `    OPENAI_API_KEY     ${present(config.openaiApiKey)}`,
    `    ANTHROPIC_API_KEY  ${present(config.anthropicApiKey)}`,
    `    GOOGLE_API_KEY     ${present(config.googleApiKey)}`,
    `    KIMI_API_KEY       ${present(config.kimiApiKey)}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/** `jarvis workspace` — print the pinned workspace root. */
export function runWorkspace(config: JarvisConfig, args: ParsedArgs): void {
  const root = path.resolve(config.fsRoot);
  if (args.json) {
    process.stdout.write(JSON.stringify({ root }) + "\n");
  } else {
    process.stdout.write(`workspace root: ${root}\n`);
  }
}

function present(v: string | undefined): string {
  return v !== undefined && v !== "" ? "set" : "(unset)";
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Dispatch a parsed argv against the resolved config. */
export async function main(argv: string[] = process.argv.slice(2), env = process.env): Promise<void> {
  const args = parseCliArgs(argv);
  const config = applyArgs(loadConfig(env), args);

  switch (args.subcommand) {
    case "serve":
      await runServe(config);
      return;
    case "mcp-serve":
      await runMcpServe(config);
      return;
    case "init":
      await runInit(config);
      return;
    case "login":
      runLogin(args, config);
      return;
    case "status":
      runStatus(config);
      return;
    case "workspace":
      runWorkspace(config, args);
      return;
  }
}

// Run when invoked as the bin entry (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`[jarvis] fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
