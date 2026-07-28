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
import { MdnsAdvertiser } from "@jarvis/ddns";
import { serve } from "@jarvis/server";

/** The running server handle (Fastify instance) — derived without a direct
 * `fastify` dependency, since it is only reachable transitively via @jarvis/server. */
type ServerHandle = Awaited<ReturnType<typeof serve>>;

/** One MCP child-process client — derived from buildAppState's return type so we
 * need no direct `@jarvis/mcp` dependency (it is bundled transitively). */
type McpClient = Awaited<ReturnType<typeof buildAppState>>["mcpClients"][number];

/** The optional DDNS runtime buildAppState may create (env-seeded). */
type DdnsRuntimeHandle = Awaited<ReturnType<typeof buildAppState>>["ddnsRuntime"];

import type { DesktopStatus, ServerKind } from "../shared/ipc.ts";
import { LogBuffer } from "./logs.ts";
import crypto from "node:crypto";
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
  /** Reuse an already-running `jarvis serve` on :7001 instead of embedding. */
  reuseExternalServer?: boolean;
}

export class ServerManager {
  private readonly logs: LogBuffer;
  private readonly prefsDir: string;
  private readonly webDist: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly reuseExternalServer: boolean;

  private app: ServerHandle | null = null;
  /** Live MCP child processes owned by the current embedded server (if any). */
  private mcpClients: McpClient[] = [];
  /** Bonjour advertiser, live only while exposed to the LAN. */
  private mdns: MdnsAdvertiser | null = null;
  /** DDNS poll runtime owned by the current embedded server (env-seeded). */
  private ddnsRuntime: DdnsRuntimeHandle = undefined;
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
    this.reuseExternalServer = deps.reuseExternalServer ?? false;
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
   * Reuse a running external server only when the caller explicitly allows it
   * and one is already healthy at the default loopback origin; otherwise start
   * our own embedded instance.
   *
   * `forceEmbedded` skips the external-reuse probe and always starts our own
   * server — used by `restart()` when the user explicitly re-pins a workspace,
   * so an unrelated `jarvis serve` on :7001 can't silently shadow the new path
   * (mirrors the Tauri shell, whose restart calls `start_sidecar` directly).
   */
  async ensureServer(opts: { forceEmbedded?: boolean } = {}): Promise<void> {
    if (
      this.reuseExternalServer &&
      !opts.forceEmbedded &&
      (await probeHealth(DEFAULT_EXTERNAL_ORIGIN))
    ) {
      this.apiOrigin = DEFAULT_EXTERNAL_ORIGIN;
      this.kind = "external";
      this.lastError = null;
      this.logs.push(`Using existing Jarvis server at ${this.apiOrigin}`);
      return;
    }
    await this.startEmbedded(this.workspace);
  }

  /**
   * Persist the LAN-exposure preference and restart the embedded server under
   * the new posture. Always forces an embedded server: only our own instance
   * can honour the bind/token change (an external `jarvis serve` is not ours
   * to reconfigure).
   */
  async setLanExposure(enabled: boolean): Promise<DesktopStatus> {
    if (this.prefs.lanExposure !== enabled) {
      this.prefs = { ...this.prefs, lanExposure: enabled };
      await savePrefs(this.prefsDir, this.prefs);
    }
    this.logs.push(`LAN exposure ${enabled ? "enabled" : "disabled"} — restarting embedded server`);
    await this.stop();
    this.lastError = null;
    await this.ensureServer({ forceEmbedded: true });
    return await this.status();
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
    if (this.mdns !== null) {
      this.mdns.stop();
      this.mdns = null;
    }
    if (this.ddnsRuntime !== undefined) {
      this.ddnsRuntime.stop();
      this.ddnsRuntime = undefined;
    }
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
      lan_exposure: this.prefs.lanExposure === true,
    };
  }

  // -------------------------------------------------------------------------

  private async startEmbedded(workspace: string | null): Promise<void> {
    try {
      const ws = workspace ?? this.defaultWorkspace();
      await this.recordWorkspace(ws);

      // LAN exposure flips three things at once (mobile-ddns proposal 待办):
      //   bind 0.0.0.0 (not loopback), prefer a STABLE port (phones keep a
      //   saved URL across restarts), and REQUIRE a bearer token — generated
      //   once and persisted so pairing links keep working.
      const lan = this.prefs.lanExposure === true;
      const bindHost = lan ? "0.0.0.0" : "127.0.0.1";
      const port = lan
        ? await pickPort(bindHost, this.prefs.lanPort ?? 7001)
        : await pickPort();
      const addr = `${bindHost}:${port}`;
      const env: NodeJS.ProcessEnv = {
        ...this.baseEnv,
        JARVIS_ADDR: addr,
        JARVIS_FS_ROOT: ws,
        JARVIS_WEB_DIST: this.webDist,
      };
      if (lan && env.JARVIS_ACCESS_TOKEN === undefined) {
        env.JARVIS_ACCESS_TOKEN = await this.ensureAccessToken();
      }

      const config = loadConfig(env);
      this.logs.push(
        `Starting embedded Jarvis server: provider=${config.provider} ` +
          `model=${config.model} addr=${addr} workspace=${ws}` +
          (lan ? " (LAN exposure: token required)" : ""),
      );

      const provider = await buildProvider(config);
      const stores = await openStores(config);
      const { state, mcpClients, ddnsRuntime } = await buildAppState(config, { provider, stores });
      this.mcpClients = mcpClients;
      this.ddnsRuntime = ddnsRuntime;
      const { port: listenPort } = parseAddr(config.addr);

      this.app = await serve({ host: bindHost, port: listenPort }, state);
      // The window always talks loopback (0.0.0.0 includes it) — keeps the
      // renderer on the auth-exempt path and `/v1/remote/pairing` unlockable.
      this.apiOrigin = `http://127.0.0.1:${port}`;
      this.kind = "embedded";
      this.lastError = null;
      this.logs.push(`Embedded Jarvis server ready at ${this.apiOrigin} (bound ${addr})`);

      if (lan) {
        // Bonjour advertise for the iOS app's zero-config discovery. The serve
        // subcommand does this in main.ts; embedded servers must do it here.
        this.mdns = new MdnsAdvertiser();
        await this.mdns.start({
          name: config.deviceName,
          port,
          txt: {
            version: state.serverInfo?.version ?? "0.0.0",
            auth: config.accessToken !== undefined ? "1" : "0",
          },
          logger: (m) => this.logs.push(m),
        });
      }
    } catch (e) {
      this.lastError = errMessage(e);
      this.kind = "stopped";
      this.app = null;
      this.logs.push(`Failed to start embedded Jarvis server: ${this.lastError}`);
    }
  }

  /** Return the persisted access token, generating (and persisting) on first use. */
  private async ensureAccessToken(): Promise<string> {
    const existing = this.prefs.accessToken;
    if (existing !== undefined && existing.length > 0) return existing;
    const token = crypto.randomBytes(24).toString("base64url");
    this.prefs = { ...this.prefs, accessToken: token };
    await savePrefs(this.prefsDir, this.prefs);
    this.logs.push("Generated a LAN access token (persisted in prefs.json, mode 0600)");
    return token;
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
