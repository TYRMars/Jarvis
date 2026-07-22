// Embedded-server lifecycle for the Electron main process.
//
// This is the Node analogue of apps/jarvis-desktop/src/sidecar.rs — but instead
// of spawning a `jarvis` *binary* as a child process, we EMBED the server in the
// main process (P7.6: "主进程内嵌 server 包"). The Electron main runs Node, so we
// can build the composition root in-process and `serve()` directly:
//
//   loadConfig(env) -> buildProvider -> openStores -> buildAppState -> serve()
//
// `env` is `process.env` with three overrides forced on top:
//   JARVIS_ADDR     = 127.0.0.1:<ephemeral>   (loopback only; never 0.0.0.0)
//   JARVIS_FS_ROOT  = <workspace>             (the pinned workspace)
//   JARVIS_WEB_DIST = <webDist>               (so the server serves the SPA too,
//                                              enabling same-origin once we
//                                              navigate the window to the origin)
//
// Resilience: if `buildProvider` throws (e.g. no API key), we record it as
// `last_error` and leave the server stopped — the window stays on the bundled
// file:// SPA, which surfaces the connection error, and `restart()` re-attempts.
// This mirrors the Tauri shell degrading when the sidecar exits early.
import {
  buildAppState,
  buildProvider,
  loadConfig,
  openStores,
  parseAddr,
} from "@jarvis/jarvis-app";
import { serve } from "@jarvis/server";

/** The running server handle (Fastify instance) — derived without a direct
 * `fastify` dependency, since it is only reachable transitively via @jarvis/server. */
type ServerHandle = Awaited<ReturnType<typeof serve>>;

/** One MCP child-process client — derived from buildAppState's return type so we
 * need no direct `@jarvis/mcp` dependency (it is bundled transitively). */
type McpClient = Awaited<ReturnType<typeof buildAppState>>["mcpClients"][number];

import type { DesktopStatus, ServerKind } from "../shared/ipc.ts";
import { LogBuffer } from "./logs.ts";
import os from "node:os";
import path from "node:path";

import { pickPort, probeHealth } from "./net.ts";
import { type DesktopPrefs, loadPrefs, savePrefs } from "./prefs.ts";

/** The loopback origin an externally-launched `jarvis serve` listens on. */
const DEFAULT_EXTERNAL_ORIGIN = "http://127.0.0.1:7001";

export interface ServerManagerDeps {
  /** Shared log buffer (also drained by the `logs` IPC call). */
  logs: LogBuffer;
  /** Directory for `prefs.json` (the Electron main passes `userData`). */
  prefsDir: string;
  /** Absolute path to the built web SPA (served + loaded by the window). */
  webDist: string;
  /** Base environment to derive the server env from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export class ServerManager {
  private readonly logs: LogBuffer;
  private readonly prefsDir: string;
  private readonly webDist: string;
  private readonly baseEnv: NodeJS.ProcessEnv;

  private app: ServerHandle | null = null;
  /** Live MCP child processes owned by the current embedded server (if any). */
  private mcpClients: McpClient[] = [];
  private apiOrigin: string = DEFAULT_EXTERNAL_ORIGIN;
  private kind: ServerKind = "stopped";
  private workspace: string | null = null;
  private lastError: string | null = null;
  private prefs: DesktopPrefs = {};

  constructor(deps: ServerManagerDeps) {
    this.logs = deps.logs;
    this.prefsDir = deps.prefsDir;
    this.webDist = deps.webDist;
    this.baseEnv = deps.env ?? process.env;
  }

  /** Load persisted prefs and resolve the initial workspace. Call once at startup. */
  async init(): Promise<void> {
    this.prefs = await loadPrefs(this.prefsDir);
    if (this.prefs.workspace !== undefined) {
      this.workspace = this.prefs.workspace;
      this.logs.push(`Loaded workspace from prefs: ${this.prefs.workspace}`);
    } else {
      this.workspace = this.defaultWorkspace();
    }
  }

  /**
   * Reuse a running external server when one is already healthy at the default
   * loopback origin; otherwise start our own embedded instance.
   *
   * `forceEmbedded` skips the external-reuse probe and always starts our own
   * server — used by `restart()` when the user explicitly re-pins a workspace,
   * so an unrelated `jarvis serve` on :7001 can't silently shadow the new path
   * (mirrors the Tauri shell, whose restart calls `start_sidecar` directly).
   */
  async ensureServer(opts: { forceEmbedded?: boolean } = {}): Promise<void> {
    if (!opts.forceEmbedded && (await probeHealth(DEFAULT_EXTERNAL_ORIGIN))) {
      this.apiOrigin = DEFAULT_EXTERNAL_ORIGIN;
      this.kind = "external";
      this.lastError = null;
      this.logs.push(`Using existing Jarvis server at ${this.apiOrigin}`);
      return;
    }
    await this.startEmbedded(this.workspace);
  }

  /** Stop, optionally re-pin the workspace, then ensure a server again. */
  async restart(workspace?: string | null): Promise<DesktopStatus> {
    const explicit = workspace !== undefined && workspace !== null && workspace.length > 0;
    if (explicit) this.workspace = workspace;
    await this.stop();
    this.lastError = null;
    // An explicit workspace must win even if an external server owns :7001.
    await this.ensureServer({ forceEmbedded: explicit });
    return await this.status();
  }

  /** Close the embedded server + its MCP children (no-op for an external one). */
  async stop(): Promise<void> {
    if (this.app !== null) {
      this.logs.push("Stopping embedded Jarvis server");
      try {
        await this.app.close();
      } catch (e) {
        this.logs.push(`Error closing embedded server: ${errMessage(e)}`);
      }
      this.app = null;
    }
    // Kill any MCP child processes the embedded server spawned, so a restart
    // doesn't leak them (buildAppState hands ownership back to us).
    if (this.mcpClients.length > 0) {
      await Promise.all(
        this.mcpClients.map((c) =>
          c.shutdown().catch((e) => this.logs.push(`Error closing MCP client: ${errMessage(e)}`)),
        ),
      );
      this.mcpClients = [];
    }
    if (this.kind !== "stopped") this.kind = "stopped";
  }

  /**
   * Current snapshot for the `status` IPC call / window navigation.
   *
   * `server_running` is a LIVE health probe, not a cached enum, so a backend that
   * has crashed or been killed (an embedded Fastify that errored after listen, or
   * an external `jarvis serve` the user stopped) reports `false` and the
   * renderer's poll surfaces the recovery overlay instead of trusting a dead
   * origin. This mirrors the Tauri shell's `health_ok` in `status()` — and is
   * deliberately NON-DESTRUCTIVE: a transient probe miss must not tear down a
   * server that is merely slow, so `kind`/`app` are left intact and the next
   * poll re-checks (the Tauri shell likewise only reaps on real process exit).
   */
  async status(): Promise<DesktopStatus> {
    const running = this.kind !== "stopped" && (await probeHealth(this.apiOrigin));
    return {
      api_origin: this.apiOrigin,
      server_kind: this.kind,
      server_running: running,
      workspace: this.workspace,
      logs: this.logs.tail(120),
      last_error: this.lastError,
    };
  }

  // -------------------------------------------------------------------------

  private async startEmbedded(workspace: string | null): Promise<void> {
    const ws = workspace ?? this.defaultWorkspace();

    // Idempotency guard: a successful embedded start must NOT be silently
    // replaced by a second one. On macOS the app stays resident after the last
    // window closes (`window-all-closed` doesn't quit on darwin), so clicking
    // the dock icon re-enters createWindow() -> ensureServer() -> startEmbedded()
    // with the server still running. Without this check we would build a second
    // Fastify server + AppState + MCP children on a fresh ephemeral port and
    // overwrite `this.app` / `this.mcpClients`, orphaning the first set (its
    // listener, MCP child processes, and store handles) until Cmd-Q — which only
    // ever reaps the newest generation (#493). `restart()` already calls stop()
    // before reaching here, so this never blocks an intentional re-pin.
    if (this.app !== null && this.kind === "embedded") {
      if (ws === this.workspace) {
        this.logs.push(`Embedded Jarvis server already running at ${this.apiOrigin}; reusing`);
        return;
      }
      // Workspace changed out from under a running server: tear the old one down
      // first (its handles would otherwise leak), then start fresh below.
      this.logs.push(`Workspace changed (${this.workspace} -> ${ws}); restarting embedded server`);
      await this.stop();
    }

    try {
      await this.recordWorkspace(ws);

      const port = await pickPort();
      const addr = `127.0.0.1:${port}`;
      const env: NodeJS.ProcessEnv = {
        ...this.baseEnv,
        JARVIS_ADDR: addr,
        JARVIS_FS_ROOT: ws,
        JARVIS_WEB_DIST: this.webDist,
      };

      const config = loadConfig(env);
      this.logs.push(
        `Starting embedded Jarvis server: provider=${config.provider} ` +
          `model=${config.model} addr=${addr} workspace=${ws}`,
      );

      const provider = await buildProvider(config);
      const stores = await openStores(config);
      const { state, mcpClients } = await buildAppState(config, { provider, stores });
      this.mcpClients = mcpClients;
      const { host, port: listenPort } = parseAddr(config.addr);

      this.app = await serve({ host, port: listenPort }, state);
      this.apiOrigin = `http://${addr}`;
      this.kind = "embedded";
      this.lastError = null;
      this.logs.push(`Embedded Jarvis server ready at ${this.apiOrigin}`);
    } catch (e) {
      this.lastError = errMessage(e);
      this.kind = "stopped";
      this.app = null;
      this.logs.push(`Failed to start embedded Jarvis server: ${this.lastError}`);
    }
  }

  private defaultWorkspace(): string {
    const fromEnv = this.baseEnv.JARVIS_DESKTOP_WORKSPACE;
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    // A double-clicked packaged macOS .app launches with cwd "/", which would
    // sandbox fs.*/git.*/shell.exec at the filesystem root. Reject it and fall
    // back to the home dir (mirrors sidecar.rs::default_workspace).
    const cwd = process.cwd();
    if (path.resolve(cwd) !== path.parse(cwd).root) return cwd;
    return os.homedir();
  }

  private async recordWorkspace(ws: string): Promise<void> {
    this.workspace = ws;
    if (this.prefs.workspace === ws) return;
    this.prefs = { ...this.prefs, workspace: ws };
    await savePrefs(this.prefsDir, this.prefs);
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
