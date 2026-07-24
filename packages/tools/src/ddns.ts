// Agent-facing `ddns.*` tools — read DDNS status, force an update, or
// (re)configure the provider. Thin wrappers over a `DdnsRuntime` supplied by
// the composition root (registered only when DDNS is enabled). `update` /
// `configure` are approval-gated: they change external network state / persist
// secrets. Mirrors the `memory.*` conditional-registration precedent.
import type { JsonValue, Tool, ToolRegistry } from "@jarvis/core";
import type { DdnsConfigInput, DdnsRuntime } from "@jarvis/ddns";

const EMPTY_OBJECT_SCHEMA: JsonValue = { type: "object", properties: {}, additionalProperties: false };

export class DdnsStatusTool implements Tool {
  readonly name = "ddns.status";
  readonly description =
    "Report dynamic-DNS / remote-access status: provider, hostname, detected public IP, last update, UPnP mapping, external reachability, and this machine's LAN addresses.";
  readonly parameters = EMPTY_OBJECT_SCHEMA;
  readonly category = "read" as const;
  readonly #rt: DdnsRuntime;
  constructor(rt: DdnsRuntime) {
    this.#rt = rt;
  }
  invoke(): Promise<string> {
    return Promise.resolve(JSON.stringify(this.#rt.status()));
  }
}

export class DdnsUpdateTool implements Tool {
  readonly name = "ddns.update";
  readonly description =
    "Force a dynamic-DNS update now: detect the current public IP, push it to the configured provider, refresh the UPnP port mapping (if enabled), and re-probe reachability. Returns the new status.";
  readonly parameters = EMPTY_OBJECT_SCHEMA;
  readonly category = "network" as const;
  readonly requiresApproval = true;
  readonly #rt: DdnsRuntime;
  constructor(rt: DdnsRuntime) {
    this.#rt = rt;
  }
  async invoke(): Promise<string> {
    if (!this.#rt.isConfigured()) return "ddns error: not configured yet — call ddns.configure first";
    return JSON.stringify(await this.#rt.updateNow());
  }
}

export class DdnsConfigureTool implements Tool {
  readonly name = "ddns.configure";
  readonly description =
    "Configure dynamic DNS for this machine: which provider, the hostname to keep pointed here, the public port, whether to attempt UPnP port-forwarding, and the provider credentials. Persisted securely (0600); secrets are never returned.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["cloudflare", "duckdns", "dyndns2", "aliyun", "dnspod"],
        description: "DDNS backend.",
      },
      hostname: { type: "string", description: "Fully-qualified hostname (e.g. home.example.com)." },
      port: { type: "number", description: "Public service port (the port the server listens on)." },
      record_type: { type: "string", enum: ["A", "AAAA"], description: "DNS record type (default A)." },
      interval_seconds: { type: "number", description: "Re-check cadence in seconds (min 60, default 300)." },
      upnp_enabled: { type: "boolean", description: "Attempt UPnP/NAT-PMP auto port-forwarding." },
      credentials: {
        type: "object",
        description:
          "Provider credentials. cloudflare: api_token(+zone_id); duckdns: token; dyndns2: username,password(+server); aliyun: access_key_id,access_key_secret; dnspod: id,token.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["provider", "hostname", "port", "credentials"],
    additionalProperties: false,
  };
  readonly category = "write" as const;
  readonly requiresApproval = true;
  readonly #rt: DdnsRuntime;
  constructor(rt: DdnsRuntime) {
    this.#rt = rt;
  }
  async invoke(args: JsonValue): Promise<string> {
    try {
      await this.#rt.setConfig(args as unknown as DdnsConfigInput);
      return JSON.stringify(this.#rt.configView());
    } catch (e) {
      return `ddns error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

/** Register the `ddns.*` family. Called by registerBuiltins when a runtime is present. */
export function registerDdnsTools(registry: ToolRegistry, rt: DdnsRuntime): void {
  registry.register(new DdnsStatusTool(rt));
  registry.register(new DdnsUpdateTool(rt));
  registry.register(new DdnsConfigureTool(rt));
}
