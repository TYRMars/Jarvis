// DDNS + remote-access REST surface — backs the iOS app's "Remote Access"
// screen (and the web "Remote Access" settings section).
//
//   GET  /v1/ddns/status        — live runtime snapshot (public ip, last update, upnp, reachability)
//   GET  /v1/ddns/config        — SCRUBBED config (never returns secret values)
//   PUT  /v1/ddns/config        — set provider + hostname + credentials, persist, re-run
//   POST /v1/ddns/update        — force one update cycle now
//   POST /v1/ddns/upnp/test     — best-effort UPnP port-map probe
//   GET  /v1/remote/info        — connect-screen info (lan addrs, external origin, requires_auth)
//
// The DDNS routes 503 when `state.ddnsRuntime` is absent (DDNS not enabled).
// `/v1/remote/info` always answers — it just omits the external block when DDNS
// isn't configured. These mutating routes are NOT approval-gated at the REST
// layer: the operator/owner driving the UI IS the approval (mirrors
// memory-sync-routes).
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import { getLocalIpv4s, primaryLanIpv4, mapPort, type DdnsRuntime } from "@jarvis/ddns";
import type { DdnsConfigInput } from "@jarvis/shared-types";
import type { AppState } from "./state.ts";
import { isLoopback } from "./auth.ts";

/** Return the runtime, or send 503 and `undefined`. */
function runtimeOr503(state: AppState, reply: FastifyReply): DdnsRuntime | undefined {
  if (state.ddnsRuntime === undefined) {
    reply.code(503).send({ error: "DDNS not enabled — set JARVIS_DDNS_ENABLE=1 and restart" });
    return undefined;
  }
  return state.ddnsRuntime;
}

/** Parse `host:port` (the listen addr) → port; defaults to 7001. */
function listenPort(state: AppState): number {
  const addr = state.serverInfo?.listen_addr ?? "";
  const idx = addr.lastIndexOf(":");
  const port = idx === -1 ? NaN : Number.parseInt(addr.slice(idx + 1), 10);
  return Number.isFinite(port) ? port : 7001;
}

function validateConfigInput(body: unknown): { ok: true; value: DdnsConfigInput } | { ok: false; error: string } {
  if (body === null || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b["provider"] !== "string") return { ok: false, error: "`provider` is required" };
  if (typeof b["hostname"] !== "string" || b["hostname"].trim() === "") {
    return { ok: false, error: "`hostname` is required" };
  }
  if (typeof b["port"] !== "number") return { ok: false, error: "`port` (number) is required" };
  const creds = b["credentials"];
  if (creds !== undefined && (creds === null || typeof creds !== "object")) {
    return { ok: false, error: "`credentials` must be an object of string keys" };
  }
  return { ok: true, value: body as DdnsConfigInput };
}

export function registerDdnsRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/ddns/status", async (_req, reply) => {
    const rt = runtimeOr503(state, reply);
    if (rt === undefined) return reply;
    return reply.send(rt.status());
  });

  app.get("/v1/ddns/config", async (_req, reply) => {
    const rt = runtimeOr503(state, reply);
    if (rt === undefined) return reply;
    const view = rt.configView();
    return reply.send(view ?? { configured: false });
  });

  app.put("/v1/ddns/config", async (req, reply) => {
    const rt = runtimeOr503(state, reply);
    if (rt === undefined) return reply;
    const parsed = validateConfigInput(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      await rt.setConfig(parsed.value);
    } catch (e) {
      return reply.code(400).send({ error: errorText(e) });
    }
    return reply.send(rt.configView());
  });

  app.post("/v1/ddns/update", async (_req, reply) => {
    const rt = runtimeOr503(state, reply);
    if (rt === undefined) return reply;
    if (!rt.isConfigured()) return reply.code(400).send({ error: "DDNS is not configured yet" });
    try {
      return reply.send(await rt.updateNow());
    } catch (e) {
      return reply.code(400).send({ error: errorText(e) });
    }
  });

  app.post("/v1/ddns/upnp/test", async (req, reply) => {
    const rt = runtimeOr503(state, reply);
    if (rt === undefined) return reply;
    const body = (req.body ?? {}) as { port?: number };
    const port = typeof body.port === "number" ? body.port : listenPort(state);
    const client = primaryLanIpv4();
    if (client === undefined) {
      return reply.send({ mapped: false, message: "no LAN IPv4 interface found" });
    }
    const result = await mapPort({
      externalPort: port,
      internalPort: port,
      internalClient: client,
      description: "jarvis remote access (test)",
    });
    return reply.send(result);
  });

  // Connect-screen info. Always answers (DDNS-independent). Under `/v1`, so the
  // auth hook protects it for remote callers — the client presents its paired
  // token; pre-pairing reachability uses the open `/health`.
  app.get("/v1/remote/info", async (_req, reply) => {
    const rt = state.ddnsRuntime;
    const view = rt?.configView();
    const status = rt?.status();
    const external: { hostname?: string; public_ip?: string; reachable?: boolean | null } = {};
    if (view) external.hostname = view.hostname;
    if (status?.public_ip) external.public_ip = status.public_ip;
    if (status) external.reachable = status.reachable ?? null;
    return reply.send({
      device_name: state.deviceName ?? "jarvis",
      lan_addrs: getLocalIpv4s(),
      port: listenPort(state),
      external,
      requires_auth: state.accessToken !== undefined && state.accessToken !== "",
      version: state.serverInfo?.version ?? null,
    });
  });

  // Pairing payload for the home-side UI (web "Remote Access" section): the LAN
  // + external origins, the access token, and ready-made `jarvis://pair` links
  // to render as a QR / share to the phone. LOOPBACK-ONLY — it returns the
  // secret token, so a remote caller (even with a valid bearer) gets 403; only
  // the local operator (who already has filesystem access) may read it.
  app.get("/v1/remote/pairing", async (req, reply) => {
    if (!(isLoopback(req.ip) || isLoopback(req.socket.remoteAddress ?? undefined))) {
      return reply.code(403).send({ error: "pairing info is available from loopback only" });
    }
    const port = listenPort(state);
    const name = state.deviceName ?? "jarvis";
    const token = state.accessToken ?? null;
    const origins: string[] = getLocalIpv4s().map((a) => `http://${a}:${port}`);
    const ext = state.ddnsRuntime?.externalOrigin();
    if (ext) origins.push(ext);
    const link = (origin: string): string => {
      const params = new URLSearchParams({ origin, name });
      if (token) params.set("token", token);
      return `jarvis://pair?${params.toString()}`;
    };
    return reply.send({
      device_name: name,
      token,
      origins,
      pairing_links: origins.map((o) => ({ origin: o, link: link(o) })),
    });
  });
}
