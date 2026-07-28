// DdnsRuntime — the stateful orchestrator behind the `ddns.*` tools + the
// `/v1/ddns/*` routes. Owns the persisted config (0600 on disk, secrets never
// returned), the periodic update loop, and the live status snapshot.
//
// One update cycle: detect public IP → push to the provider → (optional)
// refresh the UPnP mapping → probe external reachability. Each step is
// independently fault-tolerant so a transient failure in one never aborts the
// rest, and never throws out of the loop.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DdnsConfigInput, DdnsConfigView, DdnsStatus, DdnsUpnpStatus } from "@jarvis/shared-types";
import { getLocalIpv4s, getPublicIp, isIpv4, primaryLanIpv4 } from "./ip.ts";
import { DDNS_PROVIDER_KINDS, makeProvider } from "./providers/index.ts";
import { httpText } from "./http.ts";
import { mapPort } from "./upnp.ts";

const DEFAULT_INTERVAL = 300;
const MIN_INTERVAL = 60;

/** The on-disk config shape (includes secrets). */
interface PersistedConfig {
  provider: DdnsConfigInput["provider"];
  hostname: string;
  port: number;
  recordType: "A" | "AAAA";
  intervalSeconds: number;
  upnpEnabled: boolean;
  credentials: Record<string, string>;
}

export interface DdnsRuntimeOptions {
  /** Absolute path to persist config at (0600). Omit for in-memory (tests). */
  configPath?: string;
  /** Seed config (e.g. from env) when no persisted file exists. */
  seed?: DdnsConfigInput;
  logger?: (msg: string) => void;
  /** Injectable for tests — defaults to the real IP/HTTP/UPnP helpers. */
  deps?: Partial<RuntimeDeps>;
}

interface RuntimeDeps {
  getPublicIp: typeof getPublicIp;
  mapPort: typeof mapPort;
  probeReachable: (hostname: string, port: number) => Promise<boolean | null>;
  now: () => string;
}

function normalize(input: DdnsConfigInput): PersistedConfig {
  if (!DDNS_PROVIDER_KINDS.includes(input.provider)) {
    throw new Error(`unknown DDNS provider "${input.provider}"`);
  }
  const hostname = input.hostname?.trim();
  if (!hostname) throw new Error("hostname is required");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1..65535");
  return {
    provider: input.provider,
    hostname,
    port,
    recordType: input.record_type ?? "A",
    intervalSeconds: Math.max(MIN_INTERVAL, Math.floor(input.interval_seconds ?? DEFAULT_INTERVAL)),
    upnpEnabled: input.upnp_enabled ?? false,
    credentials: { ...(input.credentials ?? {}) },
  };
}

/** Default reachability probe: GET the external origin's /health. Best-effort —
 * a failure is reported as `null` (unknown), since hairpin-NAT can make a
 * working external mapping look unreachable from inside the LAN. */
async function defaultProbeReachable(hostname: string, port: number): Promise<boolean | null> {
  for (const scheme of ["https", "http"]) {
    try {
      const res = await httpText(`${scheme}://${hostname}:${port}/health`, {}, 4_000);
      if (res.ok) return true;
    } catch {
      /* try next scheme / give up */
    }
  }
  return null;
}

export class DdnsRuntime {
  #config: PersistedConfig | undefined;
  readonly #configPath: string | undefined;
  readonly #log: (msg: string) => void;
  readonly #deps: RuntimeDeps;

  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #publicIp: string | undefined;
  #lastUpdate: string | undefined;
  #lastResult: { ok: boolean; message: string } | undefined;
  #upnp: DdnsUpnpStatus | undefined;
  #reachable: boolean | null = null;

  private constructor(opts: DdnsRuntimeOptions, config: PersistedConfig | undefined) {
    this.#configPath = opts.configPath;
    this.#config = config;
    this.#log = opts.logger ?? (() => {});
    this.#deps = {
      getPublicIp: opts.deps?.getPublicIp ?? getPublicIp,
      mapPort: opts.deps?.mapPort ?? mapPort,
      probeReachable: opts.deps?.probeReachable ?? defaultProbeReachable,
      now: opts.deps?.now ?? (() => new Date().toISOString()),
    };
  }

  /** Construct, loading persisted config (or applying the seed) if present. */
  static async create(opts: DdnsRuntimeOptions = {}): Promise<DdnsRuntime> {
    let config: PersistedConfig | undefined;
    if (opts.configPath) {
      try {
        config = JSON.parse(await readFile(opts.configPath, "utf8")) as PersistedConfig;
      } catch {
        /* no persisted config yet */
      }
    }
    if (config === undefined && opts.seed) {
      config = normalize(opts.seed);
    }
    return new DdnsRuntime(opts, config);
  }

  isConfigured(): boolean {
    return this.#config !== undefined;
  }

  /** Begin the periodic update loop (idempotent). Runs one cycle immediately. */
  start(): void {
    if (this.#timer !== undefined) return;
    const interval = (this.#config?.intervalSeconds ?? DEFAULT_INTERVAL) * 1000;
    this.#timer = setInterval(() => void this.#tick(), interval);
    // Don't keep the process alive solely for the DDNS poll.
    this.#timer.unref?.();
    void this.#tick();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Replace the config, persist it (0600), and restart the loop. */
  async setConfig(input: DdnsConfigInput): Promise<void> {
    const next = normalize(input);
    this.#config = next;
    if (this.#configPath) {
      await mkdir(path.dirname(this.#configPath), { recursive: true });
      await writeFile(this.#configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
      // writeFile honours `mode` only on create; force it for an overwrite.
      await chmod(this.#configPath, 0o600).catch(() => {});
    }
    const wasRunning = this.#timer !== undefined;
    this.stop();
    if (wasRunning) this.start();
  }

  /** Run one update cycle now and return the resulting status. */
  async updateNow(): Promise<DdnsStatus> {
    await this.#tick();
    return this.status();
  }

  async #tick(): Promise<void> {
    const config = this.#config;
    if (config === undefined || this.#running) return;
    this.#running = true;
    try {
      const ip = await this.#deps.getPublicIp();
      if (ip === undefined || !isIpv4(ip)) {
        this.#lastResult = { ok: false, message: "could not detect a public IPv4 address" };
        return;
      }
      this.#publicIp = ip;

      try {
        const provider = makeProvider(config.provider);
        const result = await provider.update({
          hostname: config.hostname,
          ip,
          recordType: config.recordType,
          credentials: config.credentials,
        });
        this.#lastResult = { ok: result.ok, message: result.message };
        if (result.ok) this.#lastUpdate = this.#deps.now();
        this.#log(`[ddns] ${result.message}`);
      } catch (e) {
        this.#lastResult = { ok: false, message: e instanceof Error ? e.message : String(e) };
        this.#log(`[ddns] update failed: ${this.#lastResult.message}`);
      }

      if (config.upnpEnabled) {
        const client = primaryLanIpv4();
        if (client) {
          this.#upnp = await this.#deps.mapPort({
            externalPort: config.port,
            internalPort: config.port,
            internalClient: client,
            description: "jarvis remote access",
          });
        } else {
          this.#upnp = { mapped: false, message: "no LAN IPv4 to map to" };
        }
      } else {
        this.#upnp = undefined;
      }

      this.#reachable = await this.#deps.probeReachable(config.hostname, config.port);
    } finally {
      this.#running = false;
    }
  }

  /** Scrubbed config view (never returns secret values). */
  configView(): DdnsConfigView | undefined {
    const c = this.#config;
    if (c === undefined) return undefined;
    return {
      provider: c.provider,
      hostname: c.hostname,
      port: c.port,
      record_type: c.recordType,
      interval_seconds: c.intervalSeconds,
      upnp_enabled: c.upnpEnabled,
      credential_keys: Object.keys(c.credentials).sort(),
    };
  }

  status(): DdnsStatus {
    const c = this.#config;
    const status: DdnsStatus = {
      enabled: true,
      configured: c !== undefined,
      lan_addrs: getLocalIpv4s(),
      reachable: this.#reachable,
    };
    if (c) {
      status.provider = c.provider;
      status.hostname = c.hostname;
    }
    if (this.#publicIp) status.public_ip = this.#publicIp;
    if (this.#lastUpdate) status.last_update = this.#lastUpdate;
    if (this.#lastResult) status.last_result = this.#lastResult;
    if (this.#upnp) status.upnp = this.#upnp;
    return status;
  }

  /** Current external origin (for QR/pairing), or undefined when unconfigured. */
  externalOrigin(): string | undefined {
    const c = this.#config;
    if (c === undefined) return undefined;
    const scheme = c.port === 443 ? "https" : "http";
    const portPart = c.port === 443 || c.port === 80 ? "" : `:${c.port}`;
    return `${scheme}://${c.hostname}${portPart}`;
  }
}
