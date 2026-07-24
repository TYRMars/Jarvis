// Best-effort mDNS / Bonjour advertisement of `_jarvis._tcp` for zero-config
// LAN discovery (the iOS app browses for it via NWBrowser).
//
// Implemented over an OPTIONAL `bonjour-service` dependency, loaded with a
// defensive dynamic import so the package always typechecks and builds even
// when the module isn't installed (offline CI). When it's absent the advertiser
// simply no-ops — connection still works via QR pairing, manual entry, and the
// LAN-address list in `/v1/remote/info`. The specifier is cast to `string` so
// TS doesn't try to resolve the optional module at compile time.

export interface MdnsOptions {
  /** Service instance name (the friendly device name). */
  name: string;
  /** The port the server listens on. */
  port: number;
  /** TXT record key/values (e.g. version, requires_auth). */
  txt?: Record<string, string>;
  logger?: (msg: string) => void;
}

// Minimal structural shims for the bits of `bonjour-service` we touch (avoids
// an `any` and a hard type dependency on the optional module).
interface BonjourPublishOpts {
  name: string;
  type: string;
  protocol: "tcp" | "udp";
  port: number;
  txt?: Record<string, string>;
}
interface BonjourInstance {
  publish(opts: BonjourPublishOpts): unknown;
  unpublishAll?(cb?: () => void): void;
  destroy?(): void;
}
type BonjourCtor = new () => BonjourInstance;
interface BonjourModule {
  Bonjour?: BonjourCtor;
  default?: BonjourCtor | { Bonjour?: BonjourCtor };
}

export class MdnsAdvertiser {
  #bonjour: BonjourInstance | undefined;
  #log: (msg: string) => void = () => {};

  /** Publish the service. Returns true if advertising actually started. */
  async start(opts: MdnsOptions): Promise<boolean> {
    this.#log = opts.logger ?? (() => {});
    try {
      const mod = (await import("bonjour-service" as string)) as BonjourModule;
      const fromDefault = typeof mod.default === "function" ? mod.default : mod.default?.Bonjour;
      const Bonjour = mod.Bonjour ?? fromDefault;
      if (typeof Bonjour !== "function") {
        this.#log("[mdns] bonjour-service present but no Bonjour export — skipping");
        return false;
      }
      const instance = new Bonjour();
      instance.publish({
        name: opts.name,
        // bonjour-service prepends `_` and appends `._tcp` → `_jarvis._tcp`.
        type: "jarvis",
        protocol: "tcp",
        port: opts.port,
        ...(opts.txt ? { txt: opts.txt } : {}),
      });
      this.#bonjour = instance;
      this.#log(`[mdns] advertising _jarvis._tcp as "${opts.name}" on :${opts.port}`);
      return true;
    } catch (e) {
      this.#log(
        `[mdns] discovery unavailable (${e instanceof Error ? e.message : String(e)}) — ` +
          "install `bonjour-service` for zero-config LAN discovery; QR/manual pairing still work",
      );
      return false;
    }
  }

  /** Unpublish + tear down. Safe to call when never started. */
  stop(): void {
    try {
      this.#bonjour?.unpublishAll?.(() => {});
      this.#bonjour?.destroy?.();
    } catch {
      /* best-effort */
    }
    this.#bonjour = undefined;
  }
}
