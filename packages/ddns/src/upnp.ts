// Best-effort UPnP IGD port-mapping, implemented with Node built-ins only
// (dgram SSDP discovery + a SOAP POST over fetch) — no native/NAT dependency,
// so the package always builds. Every entry point is failure-tolerant: a router
// without UPnP, a blocked multicast, or a SOAP fault all resolve to
// `{ mapped: false, message }` rather than throwing, because the user opted into
// UPnP as a *best-effort* convenience over manual port-forwarding.
import { createSocket } from "node:dgram";
import { httpText } from "./http.ts";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const WAN_SERVICE_RE = /urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d/;

export interface PortMapResult {
  mapped: boolean;
  externalPort?: number;
  internalPort?: number;
  gatewayExternalIp?: string;
  message: string;
}

interface IgdService {
  controlUrl: string;
  serviceType: string;
}

/** SSDP M-SEARCH for IGD WAN-connection services; returns descriptor LOCATIONs. */
async function discoverLocations(timeoutMs: number): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const locations = new Set<string>();
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const targets = [
      "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];
    const done = (): void => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...locations]);
    };
    sock.on("error", () => done());
    sock.on("message", (msg) => {
      const m = /\r\nLOCATION:\s*(\S+)/i.exec(msg.toString("utf8"));
      if (m && m[1]) locations.add(m[1].trim());
    });
    sock.on("listening", () => {
      for (const st of targets) {
        const search =
          "M-SEARCH * HTTP/1.1\r\n" +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          "MX: 2\r\n" +
          `ST: ${st}\r\n\r\n`;
        sock.send(Buffer.from(search), SSDP_PORT, SSDP_ADDR);
      }
    });
    sock.bind();
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

/** Fetch a device descriptor and find the WAN-connection control URL. */
async function resolveService(location: string): Promise<IgdService | undefined> {
  let xml: string;
  try {
    const res = await httpText(location, {}, 5_000);
    if (!res.ok) return undefined;
    xml = res.text;
  } catch {
    return undefined;
  }
  const base = new URL(location);
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/g) ?? []) {
    const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/.exec(block)?.[1];
    if (!type || !WAN_SERVICE_RE.test(type)) continue;
    const ctrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/.exec(block)?.[1];
    if (!ctrl) continue;
    return { serviceType: type, controlUrl: new URL(ctrl, base).toString() };
  }
  return undefined;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

/** POST a SOAP action to an IGD control URL; returns the response body. */
async function soap(
  svc: IgdService,
  action: string,
  args: Record<string, string>,
): Promise<{ ok: boolean; text: string }> {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join("");
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${svc.serviceType}">${inner}</u:${action}>` +
    "</s:Body></s:Envelope>";
  const res = await httpText(
    svc.controlUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPAction: `"${svc.serviceType}#${action}"`,
      },
      body,
    },
    8_000,
  );
  return { ok: res.ok, text: res.text };
}

/** Discover the gateway WAN service, or `undefined` if none found. */
export async function discoverGateway(timeoutMs = 3_000): Promise<IgdService | undefined> {
  const locations = await discoverLocations(timeoutMs);
  for (const loc of locations) {
    const svc = await resolveService(loc);
    if (svc) return svc;
  }
  return undefined;
}

export interface MapPortOptions {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  protocol?: "TCP" | "UDP";
  description?: string;
  /** Lease seconds; 0 = permanent (some routers require a non-zero value). */
  leaseDuration?: number;
  discoverTimeoutMs?: number;
}

/**
 * Add (idempotently refresh) a port mapping on the LAN gateway. Returns the
 * gateway's external IP when reachable. Never throws.
 */
export async function mapPort(opts: MapPortOptions): Promise<PortMapResult> {
  const svc = await discoverGateway(opts.discoverTimeoutMs ?? 3_000);
  if (!svc) {
    return {
      mapped: false,
      externalPort: opts.externalPort,
      internalPort: opts.internalPort,
      message: "no UPnP gateway found on the LAN — forward the port manually on your router",
    };
  }
  const protocol = opts.protocol ?? "TCP";
  try {
    const add = await soap(svc, "AddPortMapping", {
      NewRemoteHost: "",
      NewExternalPort: String(opts.externalPort),
      NewProtocol: protocol,
      NewInternalPort: String(opts.internalPort),
      NewInternalClient: opts.internalClient,
      NewEnabled: "1",
      NewPortMappingDescription: opts.description ?? "jarvis",
      NewLeaseDuration: String(opts.leaseDuration ?? 0),
    });
    if (!add.ok) {
      const fault = /<errorDescription>([^<]+)<\/errorDescription>/.exec(add.text)?.[1];
      return {
        mapped: false,
        externalPort: opts.externalPort,
        internalPort: opts.internalPort,
        message: `gateway rejected AddPortMapping${fault ? `: ${fault}` : ""} — forward the port manually`,
      };
    }
    let gatewayExternalIp: string | undefined;
    try {
      const ext = await soap(svc, "GetExternalIPAddress", {});
      gatewayExternalIp = /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/.exec(ext.text)?.[1] || undefined;
    } catch {
      /* external IP is a nice-to-have */
    }
    const result: PortMapResult = {
      mapped: true,
      externalPort: opts.externalPort,
      internalPort: opts.internalPort,
      message: `mapped ${protocol} ${opts.externalPort} → ${opts.internalClient}:${opts.internalPort} via UPnP`,
    };
    if (gatewayExternalIp) result.gatewayExternalIp = gatewayExternalIp;
    return result;
  } catch (e) {
    return {
      mapped: false,
      externalPort: opts.externalPort,
      internalPort: opts.internalPort,
      message: `UPnP mapping failed (${e instanceof Error ? e.message : String(e)}) — forward the port manually`,
    };
  }
}

/** Remove a previously-added mapping. Best-effort; never throws. */
export async function unmapPort(externalPort: number, protocol: "TCP" | "UDP" = "TCP"): Promise<boolean> {
  const svc = await discoverGateway();
  if (!svc) return false;
  try {
    const del = await soap(svc, "DeletePortMapping", {
      NewRemoteHost: "",
      NewExternalPort: String(externalPort),
      NewProtocol: protocol,
    });
    return del.ok;
  } catch {
    return false;
  }
}
